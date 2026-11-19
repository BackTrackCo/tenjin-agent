import { isModelWorkerProcess } from './model-worker-context';
import type { McpServer, ToolCallback } from '@modelcontextprotocol/sdk/server/mcp.js';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { ModelHandoff, type CaptureTiming, type ModelSession } from './model-handoff';
import { ModelJobStore, sweepModelRecords, type ModelJob, type NoOffer } from './model-job';
import { modelSettings } from './model-settings';
import {
  qualifiedModelWorker,
  runModelWorker,
  WorkerStartUnconfirmed,
  type EarlyWorkerAccept,
} from './model-worker';
import type { ModelTransport } from './model-transport';
import type { ModelInferenceSlot } from './model-channel';
import { hasModelRefundRecords, readModelRefundResult } from './model-refund';
import type { WorkerRequest } from './model-worker-web';
import type { Identities } from './identities';
import { ModelLifecycle } from './model-lifecycle';
import { claudeWorkerPermissionMode } from './claude-model-policy';
import { WORKER_ENDS, workerEnd, workerStop } from './model-worker-control';
import { unpaid } from './fee';
import { claudeWorkerConfigDir } from './claude-worker-session';
import { continuationRefusal, nativeBackground, ownedModelReference } from './model-continuation';
import { WorkerInbox } from './model-worker-inbox';
import {
  ModelConversationStore,
  type ModelConversation,
  type ModelConversationOwner,
} from './model-conversations';
import { savedClaudeWorkspace, sameClaudeWorkspace } from './claude-workspace';
import { realpath, rm } from 'node:fs/promises';
import {
  ModelWorkerActivity,
  activityAnswer,
  endedDisplay,
  partialHandback,
} from './model-worker-activity';
import { startWorkerProgress, workerProgressPath } from './model-worker-progress';
import { workerPermissionAnswer, workerPermissionForm } from './model-worker-prompt';
import { ModelWorkerViews } from './model-worker-views';
import {
  workerFailure,
  writeOfferTiming,
  writeWorkerFailure,
  writeWorkerPhases,
} from './model-worker-diagnostics';

type ActiveConversation = {
  handle: string;
  owner: ModelConversationOwner;
  continuationId: string;
};

type InferenceLease = { slot: ModelInferenceSlot; release: () => void };

type WarmWorker = {
  sdkSessionId: string;
  accept: (value: EarlyWorkerAccept, signal: AbortSignal) => void;
  stop: () => Promise<void>;
  result: Promise<{ value: string } | { error: unknown; canStartFresh: boolean }>;
};

const continuationExecution = (job: ModelJob, conversation: ModelConversation): ModelJob => ({
  ...conversation.originalJob,
  task: job.task,
  capAtomic: job.capAtomic,
  turnId: job.turnId,
  callId: job.callId,
  decision: {
    ...conversation.originalJob.decision,
    claudePermissionMode: job.decision.claudePermissionMode,
    claudeWorkspace: job.decision.claudeWorkspace,
    requireExistingBudget: true,
  },
});

/**
 * How long one `follow` read waits before it answers where the worker stands.
 * A host moves a tool call that runs past two minutes to a background task of
 * the parent session, so a viewer follows in short reads, never one long one.
 */
const FOLLOW_MS = 25_000;
const REFUND_RECOVERY_INTERVAL_MS = 60_000;

/** Who may read or end a job's worker: its parent session, its root and its Claude config. */
const jobOwner = (job: ModelJob): ModelConversationOwner => ({
  parentSessionId: job.sessionId,
  root: job.root,
  configDir:
    typeof job.decision.workerConfigDir === 'string'
      ? job.decision.workerConfigDir
      : claudeWorkerConfigDir(job.root),
});

/** What one fence ends: a Codex turn, one Claude job, and nothing for a Claude offer request. */
const turnWindow = (session: ModelSession) => JSON.stringify([session.sessionId, session.turnId]);
const jobWindow = (job: Pick<ModelJob, 'sessionId' | 'id'>) =>
  JSON.stringify([job.sessionId, 'job', job.id]);

/** A held Agent call that asked to run in the background: its worker does. */
const backgroundJob = (job: Pick<ModelJob, 'native'>) => nativeBackground(job.native) === true;
/** How long a permission question waits for the person: as long as an elicitation can wait (2^31 - 1 ms), with no job wall. */
const PROMPT_WAIT_MS = 2_147_483_647;

/** What the parent reads when a background worker has started, as a native background agent's launch reads. */
const BACKGROUND_STARTED =
  'The DeepSeek worker is running in the background. Its result arrives by itself when it ends, as a message from the Tenjin plugin. You know nothing about its result until that message arrives: do not report, assume or predict it, and do not wait for it or check on it. Continue other work or reply in the meantime. To stop it, call subagent with cancel and this offer_id. Only if the session was resumed or the plugin reloaded and no message came: accept this offer again, which returns the stored result once the worker has ended and starts nothing.';
const workerShutdown = new WeakMap<McpServer, () => Promise<void>>();
export async function stopModelWorkers(server: McpServer) {
  await workerShutdown.get(server)?.();
}

export function registerModelTool(
  server: McpServer,
  options: {
    dataDir: string;
    harness: 'claude' | 'codex';
    session: () => ModelSession | undefined;
    /**
     * The host said this session closed while the process goes on (`/clear` in Claude
     * Code): its record is dropped, so the next session's first event is taken up.
     */
    sessionEnded?: (sessionId: string) => void;
    transport: () => Promise<ModelTransport>;
    /** This process was started inside a model worker. Default: read from the environment. */
    modelWorker?: boolean;
    /** `tenjin mcp`'s request executor, which pays for a Claude worker's web searches. */
    web?: WorkerRequest;
    /** The router's identities read, which the person's rules for those searches are checked against. */
    webIdentities?: () => Promise<Identities | undefined>;
  },
) {
  const lifecycle = new ModelLifecycle();
  const controllers = new Map<
    string,
    {
      abort: AbortController;
      done: Promise<unknown>;
      /** The session and turn the job was accepted in: a later parent turn still cancels it. */
      session: ModelSession;
      conversation?: ActiveConversation;
    }
  >();
  const views = new ModelWorkerViews();
  const jobs = new ModelJobStore(options.dataDir);
  const conversations = new ModelConversationStore(options.dataDir);
  /** Accept calls of this process still going, by job: such a job's worker is not stranded. */
  const accepting = new Map<string, number>();
  const warming = new Map<string, WarmWorker>();
  /** What a parent writes to each running worker of this process, by the worker's handle. */
  const inboxes = new Map<
    string,
    { inbox: WorkerInbox; owner: ModelConversationOwner; jobId: string }
  >();
  const runsHere = (id: string) => accepting.has(id) || controllers.has(id);
  /** Who asked for a job to be cancelled, so its end says who or what ended it. */
  const cancelledBy = new Map<string, 'parent_cancel' | 'agent_stopped' | 'session_ended'>();
  let sessionEnding = false;
  const conversationOf = (job: ModelJob) =>
    typeof job.decision.workerHandle === 'string'
      ? conversations.lookup(job.decision.workerHandle, jobOwner(job))
      : conversations.findByJob(job.id, jobOwner(job));
  /**
   * Ends a job, and its conversation, that the process running it left behind.
   * The job as it now stands, or null while its worker may still be running.
   */
  const strand = async (job: ModelJob): Promise<ModelJob | null> => {
    if (runsHere(job.id)) return null;
    const ended = await jobs.strand(job.id);
    if (!ended || ['running', 'cancelling'].includes(ended.state)) return null;
    const conversation = await conversationOf(job).catch(() => null);
    if (conversation)
      await conversations
        .finish(conversation.handle, jobOwner(job), job.id, 'unknown')
        .catch(() => false);
    await rm(workerProgressPath(options.dataDir, job.sessionId, job.id), { force: true }).catch(
      () => undefined,
    );
    return ended;
  };
  /**
   * What accepting a job that is no longer on offer answers: its stored
   * handback, for the session that owns it. It starts no worker and adds no
   * charge. Null for a state that keeps no handback.
   */
  const handback = async (
    job: ModelJob,
    signal: AbortSignal,
  ): Promise<{ value: unknown } | { refused: string } | null> => {
    const conversation = await conversationOf(job);
    const completed = conversation
      ? await conversations.handback(conversation.handle, jobOwner(job), job.id)
      : null;
    if (completed !== null || job.state === 'completed') {
      let envelope: { status?: unknown; worker_handle?: unknown } | null = null;
      try {
        envelope = completed === null ? null : JSON.parse(completed);
      } catch {
        // Refused below.
      }
      if (envelope?.status !== 'completed' || envelope.worker_handle !== conversation?.handle)
        return { refused: 'Stored worker completion is unavailable' };
      // The stored result stands. A local job update that failed earlier is repaired here.
      await jobs.finish(job.id, 'completed').catch(() => undefined);
      return { value: envelope };
    }
    // An offer that was cancelled or expired before any accept has no worker to report.
    if (!job.runner) return null;
    const ended = ['running', 'cancelling'].includes(job.state) ? await strand(job) : job;
    if (!ended)
      return {
        refused: backgroundJob(job)
          ? 'This offer is already accepted and its worker is still running in the background. Its result arrives by itself as a notification when it ends. No second worker started.'
          : 'This offer is already accepted and its worker is still running. Its result returns from the accept call that started it. No second worker started.',
      };
    if (ended.state !== 'cancelled' && ended.state !== 'unknown') return null;
    let stopped: Record<string, unknown> = {};
    try {
      stopped = JSON.parse(ended.result ?? '{}');
    } catch {
      // A record with no readable handback still reports how it ended.
    }
    // The run is over, so what it left uncertain is settled before it is reported.
    const budget = conversation?.originalJob ?? ended;
    const transport = await options.transport();
    await transport.reconcile(budget, signal);
    const spend = await transport.summary(budget).catch(() => ({ accounting: 'unknown' }));
    return { value: { status: ended.state, ...stopped, spend } };
  };
  // At start, once: nothing this process runs can be among what an earlier one left.
  const repaired = isModelWorkerProcess()
    ? Promise.resolve()
    : (async () => {
        // Records of dead processes end first, so the sweep keeps only a live job's files.
        for (const job of await jobs.unfinished()) await strand(job).catch(() => null);
        await sweepModelRecords(options.dataDir);
      })().catch(() => undefined);
  const refundRecovery = new AbortController();
  const refundsRecovered =
    options.harness === 'claude' && !isModelWorkerProcess()
      ? repaired.then(async () => {
          const { signal } = refundRecovery;
          while (!signal.aborted) {
            try {
              if ((await hasModelRefundRecords(options.dataDir)) && !signal.aborted) {
                const transport = await options.transport();
                await transport.recoverInferenceRefunds(
                  AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
                );
              }
            } catch {
              // The next pass can retry, including when the signer is available again.
            }
            // Retry while the session is open without keeping the process alive.
            await delay(REFUND_RECOVERY_INTERVAL_MS, undefined, { signal, ref: false }).catch(
              () => undefined,
            );
          }
        })
      : Promise.resolve();
  let handoff: ModelHandoff | undefined;
  const getHandoff = async () =>
    (handoff ??= new ModelHandoff({
      dataDir: options.dataDir,
      transport: await options.transport(),
    }));
  // The capture request may finish while its worker warms. A separate operation in
  // the job window gives a veto, cancel, expiry or shutdown ownership of that child.
  const warmOffer = async (id: string, parentSessionId: string, captureSignal: AbortSignal) => {
    const job = await jobs.owned(id, parentSessionId);
    const permissionMode = claudeWorkerPermissionMode(job?.decision.claudePermissionMode);
    if (
      !job ||
      job.state !== 'offered' ||
      !permissionMode ||
      sessionEnding ||
      captureSignal.aborted
    )
      return;
    const resume =
      typeof job.decision.workerHandle === 'string'
        ? await conversations.lookup(job.decision.workerHandle, jobOwner(job))
        : null;
    if (job.decision.workerHandle && !resume) return;
    if (
      warming.has(id) ||
      accepting.has(id) ||
      job.expiresAt <= Date.now() ||
      sessionEnding ||
      captureSignal.aborted
    )
      return;
    const abort = new AbortController();
    const sdkSessionId = resume?.sdkSessionId ?? randomUUID();
    let accept!: (value: EarlyWorkerAccept) => void;
    const accepted = new Promise<EarlyWorkerAccept>((resolve) => {
      accept = resolve;
    });
    let released = false;
    const result = lifecycle
      .run(jobWindow(job), abort.signal, async (signal) => {
        const transport = await options.transport();
        signal.throwIfAborted();
        return runModelWorker(resume ? continuationExecution(job, resume) : job, {
          dataDir: options.dataDir,
          transport,
          signal,
          early: {
            accept: accepted,
            onRelease: () => {
              released = true;
            },
          },
          ...(options.web ? { web: options.web } : {}),
          ...(options.webIdentities ? { webIdentities: options.webIdentities } : {}),
          claudePermissionMode: permissionMode,
          currentClaudePermissionMode: () => {
            const current = options.session();
            return current?.sessionId === parentSessionId
              ? current.claudePermissionMode
              : undefined;
          },
          claudeSession: {
            ...(resume ? { resume: sdkSessionId } : { sessionId: sdkSessionId }),
            onSession: async (id) => {
              if (id !== sdkSessionId) throw new Error('Native Claude changed the owned session');
            },
          },
          permission: async () => false,
        });
      })
      .then(
        (value) => ({ value }),
        (error: unknown) => ({
          error,
          canStartFresh: !released && !(error instanceof WorkerStartUnconfirmed),
        }),
      );
    let detachFromAccept: (() => void) | undefined;
    const stop = async () => {
      clearTimeout(expiry);
      abort.abort();
      await result;
      detachFromAccept?.();
      if (warming.get(id)?.result === result) warming.delete(id);
    };
    const expiry = setTimeout(() => void stop(), Math.max(0, job.expiresAt - Date.now()));
    expiry.unref();
    warming.set(id, {
      sdkSessionId,
      accept: (value, signal) => {
        clearTimeout(expiry);
        const cancel = () => abort.abort(signal.reason);
        signal.addEventListener('abort', cancel, { once: true });
        detachFromAccept = () => signal.removeEventListener('abort', cancel);
        if (signal.aborted) cancel();
        accept(value);
      },
      stop,
      result,
    });
  };
  const answer = (value: unknown) => ({
    content: [{ type: 'text' as const, text: JSON.stringify(value) }],
  });
  /** Ends one window: its operations in flight, its job and that job's conversation. */
  const fenceWindow = async (
    key: string,
    mark: (state: 'cancelling' | 'cancelled') => Promise<void>,
    current: () => Promise<ModelJob | null>,
  ) => {
    const draining = lifecycle.fence(key);
    await mark('cancelling');
    const model = await getHandoff();
    const pending = await current();
    const fenceConversation = async () => {
      if (options.harness !== 'claude' || !pending) return;
      const active = controllers.get(pending.id)?.conversation;
      const owner = active?.owner ?? jobOwner(pending);
      const conversation = active
        ? { handle: active.handle }
        : typeof pending.decision.workerHandle === 'string'
          ? await model.conversations.lookup(pending.decision.workerHandle, owner)
          : await model.conversations.findByJob(pending.id, owner);
      if (conversation) await model.conversations.fence(conversation.handle, owner, pending.id);
    };
    await fenceConversation();
    await draining;
    await fenceConversation();
    await mark('cancelled');
  };
  const fence = (session: ModelSession) =>
    fenceWindow(
      turnWindow(session),
      (state) => jobs.fence(session.sessionId, session.turnId, state),
      () => jobs.pending(session.sessionId, session.turnId),
    );
  /** One Claude job by its own id: its session's other offers and workers go on. */
  const fenceJob = (job: ModelJob) =>
    Promise.all([
      fenceWindow(
        jobWindow(job),
        (state) => jobs.fenceOwned(job.id, job.sessionId, state),
        () => jobs.owned(job.id, job.sessionId),
      ),
      warming.get(job.id)?.stop(),
    ]);
  /**
   * A SESSION THAT CLOSED WHILE THIS PROCESS GOES ON. Its background workers and the
   * workers warming for its open offers end here, as they would have with the process: a
   * closed session can be handed no result. A foreground worker ends with its accept call.
   */
  const endSession = async (sessionId: string) => {
    const ids = new Set([...controllers.keys(), ...warming.keys()]);
    await Promise.allSettled(
      [...ids].map(async (id) => {
        const job = await jobs.owned(id, sessionId);
        if (!job || (controllers.has(id) && !backgroundJob(job))) return;
        cancelledBy.set(id, 'session_ended');
        await fenceJob(job);
      }),
    );
  };
  // A `tenjin mcp` STARTED INSIDE A MODEL WORKER has neither tool, under whatever name the
  // worker's host registered it: a worker starts no DeepSeek worker and reads none (operator
  // ruling 2026-11-17). It once listed both under a second registration's name.
  const inWorker = options.modelWorker ?? isModelWorkerProcess();
  if (options.harness === 'claude' && !inWorker)
    server.registerTool(
      'subagent_activity',
      {
        title: 'DeepSeek worker activity',
        // Worded so the parent model has no reason to call it: it once polled a running
        // worker with it and read 75,000 characters of activity into its own context.
        description:
          "Called by the Tenjin plugin's own DeepSeek worker viewer, not by you. A worker's result arrives by itself, as the result of your `subagent` call or as that task's notification, so never check on a worker with this. Display only; it starts no work.",
        annotations: { title: 'DeepSeek worker activity', readOnlyHint: true },
        inputSchema: {
          offer_id: z.string().uuid(),
          follow: z.boolean().optional(),
          // With follow: answer once the activity moves past this sequence, with the rows
          // that changed since, so a viewer shows the run as it goes.
          after: z.number().int().nonnegative().optional(),
        },
      },
      async (args, extra) => {
        const session = options.session();
        if (!session || isModelWorkerProcess()) return answer({ status: 'unavailable' });
        const [root, configDir] = await Promise.all([
          realpath(session.cwd).catch(() => null),
          realpath(claudeWorkerConfigDir(session.cwd)).catch(() => null),
        ]);
        const existing = views.get(args.offer_id)?.snapshot();
        if (
          existing &&
          (existing.binding.parentSessionId !== session.sessionId ||
            existing.binding.root !== root ||
            existing.binding.configDir !== configDir)
        )
          return answer({ status: 'unavailable' });
        // HOW AN ENDED JOB ENDED, from its own record, for the session that owns it: its
        // row ends with the job's real status and time even where no live view of it is
        // held (a restarted process, a resumed session). No assignment and no result.
        const ended = async () => {
          const job = await jobs.owned(args.offer_id, session.sessionId);
          if (!job?.runner || job.root !== root) return undefined;
          const conversation =
            job.state === 'completed' ? await conversationOf(job).catch(() => null) : null;
          const kept = conversation
            ? await conversations.handback(conversation.handle, jobOwner(job), job.id)
            : job.result;
          return endedDisplay(job.state, kept);
        };
        if (!existing) {
          const end = await ended().catch(() => undefined);
          if (end) return answer({ status: 'ended', ended: end });
        }
        if (args.follow && !existing) {
          // By its own id: the offer may have been accepted in a later turn than it was made in.
          const pending = await jobs.owned(args.offer_id, session.sessionId);
          if (pending?.root !== root) return answer({ status: 'unavailable' });
        }
        let activity = args.follow ? null : views.get(args.offer_id)?.snapshot();
        if (args.follow) {
          const bound = new AbortController();
          const timer = setTimeout(() => bound.abort(), FOLLOW_MS);
          timer.unref();
          try {
            activity = await views.follow(
              args.offer_id,
              AbortSignal.any([extra.signal, bound.signal]),
              args.after,
            );
          } finally {
            clearTimeout(timer);
          }
          // Still going: the caller reads again. Only an ended worker ends the following.
          if (!activity && bound.signal.aborted && !extra.signal.aborted) {
            activity = views.get(args.offer_id)?.snapshot();
            if (!activity) return answer({ status: 'waiting' });
          }
        }
        if (
          !activity ||
          activity.binding.parentSessionId !== session.sessionId ||
          activity.binding.root !== root ||
          activity.binding.configDir !== configDir
        )
          return answer({ status: 'unavailable' });
        const delta = args.follow === true && args.after !== undefined;
        const shown = activityAnswer(activity, {
          rows: !args.follow || delta,
          result: !args.follow,
          ...(delta ? { after: args.after } : {}),
        });
        // The live view does not hold the job's own time.
        const end = ['completed', 'cancelled', 'unknown'].includes(activity.state)
          ? await ended().catch(() => undefined)
          : undefined;
        return answer(end ? { ...shown, ended: end } : shown);
      },
    );
  const subagentInput = {
    offer_id: z.string().uuid().optional(),
    cancel: z.string().uuid().optional(),
    // From the plugin alone, at the end of its session: the id of the session that closed.
    end_session: z.string().min(1).max(200).optional(),
    // Mod transport only. The same MCP process has already seen the owned root hook.
    capture: z
      .object({
        session_id: z.string(),
        tool_use_id: z.string(),
        tool: z.enum(['Agent', 'Task', 'SendMessage']).optional(),
        input: z.record(z.string(), z.unknown()),
        // The parent's model request that made the held call, as the host numbers it.
        step: z.string().max(200).optional(),
        // The native subagent whose loop made the call, as the host lists it; absent
        // for the main loop. It receives the offer and accepts it or keeps it native.
        agent: z
          .object({
            id: z.string().min(1).max(200),
            type: z.string().max(200).optional(),
            // The types of the agents above it, nearest first.
            parents: z.array(z.string().max(200)).max(32).optional(),
            cwd: z.string().max(4096).optional(),
          })
          .optional(),
      })
      .optional(),
    delegation_id: z.string().uuid().optional(),
    task: z.string().optional(),
    // With cancel, from the plugin alone: the person stopped the worker's agent, or the
    // session ended (`/clear` too) with a background worker still running. A label for the
    // job's record, never a permission.
    reason: z.enum(['agent_stopped', 'session_ended']).optional(),
    ...(options.harness === 'claude'
      ? { offer_ids: z.array(z.string().uuid()).min(2).optional() }
      : {}),
  };
  type SubagentOperation = Parameters<ToolCallback<typeof subagentInput>>;
  const registerSubagent = (
    inWorker ? () => undefined : server.registerTool.bind(server)
  ) as typeof server.registerTool;
  // THE TWO INFERENCE CHANNELS, for every worker of this process: a batch's workers and
  // background workers that outlive their accept call run side by side, so each takes
  // the channel fewer workers hold. Allocated only when a freshly accepted job is ready
  // to run: a refused offer or a stored handback never funds another channel.
  const occupied: [number, number] = [0, 0];
  const leaseInferenceSlot = (): InferenceLease => {
    const slot = occupied[0] <= occupied[1] ? 0 : 1;
    occupied[slot]++;
    return {
      slot,
      release: () => {
        occupied[slot]--;
      },
    };
  };
  const withBatchAccepts =
    (
      run: (
        args: Omit<SubagentOperation[0], 'offer_ids'>,
        extra: SubagentOperation[1],
      ) => Promise<ReturnType<typeof answer>>,
    ): ToolCallback<typeof subagentInput> =>
    async ({ offer_ids, ...args }, extra) => {
      if (offer_ids === undefined) return run(args, extra);
      if (Object.values(args).some((value) => value !== undefined))
        return answer({ action: 'native', reason: 'Use one subagent operation' });
      if (new Set(offer_ids.map((id) => id.toLowerCase())).size !== offer_ids.length)
        return answer({ action: 'native', reason: 'Use distinct offer ids' });
      // Keep one live host request for permission prompts and interruption. Each
      // offer still goes through its own claim, worker, budget and handback.
      const outcomes = await Promise.allSettled(
        offer_ids.map((offer_id) =>
          run({ ...args, offer_id }, { ...extra, signal: AbortSignal.any([extra.signal]) }),
        ),
      );
      return answer({
        results: outcomes.map((outcome, index) => ({
          offer_id: offer_ids[index],
          outcome:
            outcome.status === 'fulfilled'
              ? JSON.parse(outcome.value.content[0]!.text)
              : { status: 'unknown', reason: 'Could not confirm the result of this offer' },
        })),
      });
    };
  registerSubagent(
    'subagent',
    {
      title: 'Tenjin subagent',
      description:
        'Run or cancel a Tenjin DeepSeek subagent offer. Accept with offer_id, or on Claude accept selected offers together with offer_ids so the workers run in parallel. Cancel with cancel. Accepting the same offer again never starts a second worker or adds a charge: once its worker has ended, it returns the stored result in the same session. A held follow-up to a finished worker runs the same way, with no routing fee, on the budget that job has left. For a held Codex delegation, submit delegation_id and the complete plaintext task. The offer carries consent and the parent routing policy.',
      annotations: { title: 'DeepSeek subagent', readOnlyHint: false },
      ...(options.harness === 'claude' ? { _meta: { 'anthropic/alwaysLoad': true } } : {}),
      inputSchema: subagentInput,
    },
    withBatchAccepts(async (args, extra) => {
      // The start phases of an accept, timed from here for the worker's diagnostic record.
      const acceptedAt = Date.now();
      const startMarks: Record<string, number> = { cliProcess: Math.round(performance.timeOrigin) };
      let ownedContinuation = args.capture
        ? ownedModelReference(args.capture.input, args.capture.tool ?? 'Agent').owned
        : false;
      const unavailable = (reason: string) =>
        answer(ownedContinuation ? continuationRefusal(reason) : { action: 'native', reason });
      const session = options.session();
      // Why a held subagent call got no offer, for `tenjin config subagents why`.
      const noOffer = async (code: NoOffer['code'], more: Partial<NoOffer> = {}) => {
        const held = args.capture;
        if (held && held.tool !== 'SendMessage' && !ownedContinuation && !isModelWorkerProcess())
          await jobs.noOffer({
            sessionId: held.session_id,
            tool: held.tool ?? 'Agent',
            code,
            ...more,
            ...(held.agent ? { from: 'subagent' as const } : {}),
          });
      };
      const ownedSessionId = session?.sessionId;
      const ownedTurnId = session?.turnId;
      const currentClaudeMode = () => {
        const current = options.session();
        return current?.sessionId === ownedSessionId && current?.turnId === ownedTurnId
          ? current?.claudePermissionMode
          : undefined;
      };
      if (
        !session ||
        isModelWorkerProcess() ||
        (options.harness === 'codex' && extra._meta?.['threadId'] !== session.sessionId)
      ) {
        await noOffer(session ? 'host_unqualified' : 'no_session');
        return unavailable('Host worker permission bridge is not qualified');
      }
      if (
        [args.offer_id, args.cancel, args.capture, args.delegation_id, args.end_session].filter(
          (v) => v !== undefined,
        ).length !== 1
      )
        return unavailable('Use one subagent operation');
      await repaired;
      if (args.end_session) {
        // Only the session this process serves, and only from its own host.
        if (options.harness !== 'claude' || args.end_session !== session.sessionId)
          return answer({ status: 'not_owned' });
        await endSession(session.sessionId);
        options.sessionEnded?.(session.sessionId);
        return answer({ status: 'ended' });
      }
      if (args.cancel) {
        if (options.harness === 'claude') {
          // By its own id, in any turn and any process: the session's other jobs go on.
          const record = await jobs.owned(args.cancel, session.sessionId);
          if (!record) return answer({ status: 'not_owned' });
          cancelledBy.set(record.id, args.reason ?? 'parent_cancel');
          await fenceJob(record);
          return answer({ status: 'cancelled' });
        }
        // A worker outlives the parent turn it was accepted in, so it is found by its own turn.
        const running = controllers.get(args.cancel)?.session;
        const owned = running?.sessionId === session.sessionId ? running : session;
        const pending = await (await getHandoff()).store.pending(owned.sessionId, owned.turnId);
        if (pending?.id !== args.cancel) return answer({ status: 'not_owned' });
        cancelledBy.set(pending.id, 'parent_cancel');
        await fence(owned);
        return answer({ status: 'cancelled' });
      }
      // A Claude offer is found by its own id in any turn of its session, and its
      // operations run in its own window: a cancel ends that job and no other. A
      // Claude offer request has no window a fence could close.
      let window =
        options.harness === 'claude' ? JSON.stringify([session.sessionId]) : turnWindow(session);
      const offered = args.offer_id && options.harness === 'claude' ? args.offer_id : undefined;
      const refuseOffer = async (reason: string) => {
        if (offered) await warming.get(offered)?.stop();
        return unavailable(reason);
      };
      if (offered) {
        const record = await jobs.owned(offered, session.sessionId);
        // Another session's offer, a swept one and one that never was read the same.
        if (!record) return unavailable('No such offer in this session');
        ownedContinuation ||=
          typeof record.decision.workerHandle === 'string' ||
          (await conversations.findByJob(offered, jobOwner(record))) !== null;
        if (record.state !== 'offered') {
          const kept = await handback(record, extra.signal);
          if (kept) return 'value' in kept ? answer(kept.value) : unavailable(kept.refused);
        }
        window = jobWindow(record);
        accepting.set(offered, (accepting.get(offered) ?? 0) + 1);
      }
      return lifecycle
        .run(window, extra.signal, async (signal) => {
          if (args.capture) {
            if (
              options.harness !== 'claude' ||
              args.capture.session_id !== session.sessionId ||
              !server.server.getClientCapabilities()?.elicitation
            ) {
              await noOffer(
                args.capture.session_id === session.sessionId ? 'host_unqualified' : 'no_session',
              );
              return unavailable('Owned root or permission prompts unavailable');
            }
            const send =
              args.capture.tool === 'SendMessage'
                ? ownedModelReference(args.capture.input, 'SendMessage')
                : undefined;
            const sentTo = send && 'handle' in send ? send : undefined;
            const live = sentTo?.handle ? inboxes.get(sentTo.handle) : undefined;
            if (sentTo?.handle && sentTo.task && live) {
              // A WORKER THAT RUNS TAKES THE MESSAGE AT ITS NEXT TURN, as a native subagent does:
              // the same job and cap, no offer, no fee, no new consent. Only the session that
              // accepted it may write to it, and only while its consent still stands.
              const current = await modelSettings(options.dataDir, session.cwd);
              const transport = await options.transport();
              if (
                live.owner.parentSessionId !== session.sessionId ||
                live.owner.root !== (await realpath(session.cwd).catch(() => null)) ||
                !current ||
                current.root !== live.owner.root ||
                current.routerOrigin !== transport.origin
              )
                return unavailable(
                  'This worker belongs to another session or its consent changed; the message was not delivered',
                );
              if (live.inbox.push(sentTo.task) === 'closed')
                return unavailable(
                  'The DeepSeek worker has already reported, so the message was not delivered. Its result arrives next; send the message again after it.',
                );
              return answer({
                action: 'delivered',
                worker_handle: sentTo.handle,
                message: `Delivered to the DeepSeek worker ${sentTo.handle}: it reads your message at its next turn and its result will include the answer. It is the same job and budget; nothing was charged for the message.`,
              });
            }
            try {
              // Where the time before the offer went, for the job's diagnostic record.
              const timing: CaptureTiming = { marks: {}, routeFetchMs: [] };
              const outcome = await (
                await getHandoff()
              ).capture(
                session,
                args.capture.tool_use_id,
                args.capture.input,
                signal,
                args.capture.tool,
                args.capture.step,
                args.capture.agent && {
                  agentId: args.capture.agent.id,
                  agentType: args.capture.agent.type,
                  parents: args.capture.agent.parents,
                  cwd: args.capture.agent.cwd,
                },
                timing,
              );
              if ('settled' in outcome && typeof outcome.settled === 'string')
                await warming.get(outcome.settled)?.stop();
              if ('offer_id' in outcome && typeof outcome.offer_id === 'string') {
                await warmOffer(outcome.offer_id, session.sessionId, signal).catch(() => undefined);
                timing.marks.warm = Date.now();
              }
              if (timing.jobId) {
                timing.marks.returned = Date.now();
                await writeOfferTiming(options.dataDir, timing.jobId, {
                  at: acceptedAt,
                  action: String(outcome.action),
                  marks: timing.marks,
                  routeFetchMs: timing.routeFetchMs,
                });
              }
              return answer(outcome);
            } catch {
              await noOffer(signal.aborted ? 'interrupted' : 'capture_error');
              return unavailable('Model routing unavailable');
            }
          }
          if (args.delegation_id) {
            if (options.harness !== 'codex' || typeof args.task !== 'string')
              return answer({ action: 'native', reason: 'Complete plaintext assignment required' });
            try {
              return answer(
                await (
                  await getHandoff()
                ).submitCodex(session, args.delegation_id, args.task, signal),
              );
            } catch {
              return answer({
                action: 'native',
                reason: 'Routing unavailable; retry the original native call unchanged',
              });
            }
          }
          if (!args.offer_id)
            return answer({ action: 'native', reason: 'Unsupported submission on this host' });
          const model = await getHandoff();
          const pending = offered
            ? await model.store.owned(offered, session.sessionId)
            : await model.store.pending(session.sessionId, session.turnId);
          const owner: ModelConversationOwner = {
            parentSessionId: session.sessionId,
            root: session.cwd,
            configDir: claudeWorkerConfigDir(session.cwd),
          };
          let conversation: ModelConversation | null = null;
          const resumed =
            options.harness === 'claude' && typeof pending?.decision.workerHandle === 'string';
          ownedContinuation ||= resumed;
          if (options.harness === 'claude' && pending?.id === args.offer_id) {
            conversation = resumed
              ? await model.conversations.lookup(pending.decision.workerHandle as string, owner)
              : await model.conversations.findByJob(pending.id, owner);
            ownedContinuation ||= resumed || conversation !== null;
          }
          const current = await modelSettings(options.dataDir, session.cwd);
          const transport = await options.transport();
          if (!current || current.routerOrigin !== transport.origin)
            return refuseOffer('Inference consent revoked or endpoint changed');
          if (
            options.harness === 'claude' &&
            (!claudeWorkerPermissionMode(currentClaudeMode()) ||
              pending?.decision.claudePermissionMode !== currentClaudeMode())
          )
            return refuseOffer(
              ownedContinuation
                ? 'Owned permission mode changed'
                : 'Owned permission mode changed; retry native',
            );
          if (resumed) {
            if (
              !conversation ||
              conversation.originalJob.decision.routerOrigin !== current.routerOrigin ||
              conversation.root !== current.root ||
              pending?.id !== args.offer_id
            )
              return refuseOffer('Owned worker history, repository or endpoint changed');
            try {
              await transport.requireResumeBudget(conversation.originalJob);
            } catch {
              return refuseOffer(
                'Original conversation budget is missing, uncertain or unavailable',
              );
            }
          }
          startMarks.checked = Date.now();
          // The run's refund-support question waits for none of the checks below.
          const refundSupport =
            options.harness === 'claude' ? transport.askRefundSupport(signal) : undefined;
          const qualified = await qualifiedModelWorker(
            session.cwd,
            String(
              (resumed
                ? conversation?.originalJob.native.subagent_type
                : pending?.native.subagent_type) ?? 'general-purpose',
            ),
            session.codexPolicy,
            options.dataDir,
            signal,
            options.harness === 'claude' ? currentClaudeMode() : undefined,
          );
          startMarks.qualified = Date.now();
          const offeredWorkspace = savedClaudeWorkspace(pending?.decision.claudeWorkspace);
          if (
            !qualified ||
            (options.harness === 'claude' &&
              (!offeredWorkspace ||
                !qualified.claudeWorkspace ||
                qualified.windows?.fingerprint !== pending?.decision.windowsWorker ||
                !sameClaudeWorkspace(offeredWorkspace, qualified.claudeWorkspace))) ||
            (options.harness === 'codex' &&
              JSON.stringify(qualified.nativeSnapshot) !==
                JSON.stringify(pending?.decision.nativeSnapshot))
          )
            return refuseOffer(
              ownedContinuation
                ? 'Host permissions changed'
                : 'Host permissions changed; retry original native call',
            );
          signal.throwIfAborted();
          const job = await model.store.accept(
            args.offer_id,
            session.sessionId,
            offered ? undefined : session.turnId,
          );
          const warm = job && warming.get(job.id);
          if (job) warming.delete(job.id);
          if (
            !job ||
            job.root !== current.root ||
            job.decision.routerOrigin !== current.routerOrigin
          ) {
            // An offer nobody took in time: the call it held has run natively or not at all.
            if (!job && pending?.state === 'offered' && pending.expiresAt <= Date.now()) {
              if (offered) await warming.get(offered)?.stop();
              await jobs.noOffer({
                sessionId: pending.sessionId,
                tool: pending.nativeTool ?? 'Agent',
                code: 'expired',
                offerId: pending.id,
                ...(pending.caller ? { from: 'subagent' as const } : {}),
              });
            }
            await warm?.stop();
            return unavailable(
              ownedContinuation
                ? 'Continuation expired, changed, already selected or consent revoked'
                : 'Offer expired, changed, already selected or consent revoked; retry original native call unchanged',
            );
          }
          if (
            options.harness === 'claude' &&
            job.decision.claudePermissionMode !== currentClaudeMode()
          ) {
            await warm?.stop();
            await model.store.finish(job.id, 'cancelled');
            return unavailable(
              ownedContinuation
                ? 'Owned permission mode changed'
                : 'Owned permission mode changed; retry native',
            );
          }
          // The mode accepted with the job holds for the job's life. A later parent
          // prompt, mode switch or cd must not end a running worker.
          const acceptedClaudeMode =
            options.harness === 'claude'
              ? claudeWorkerPermissionMode(job.decision.claudePermissionMode)
              : null;
          const jobClaudeMode = () =>
            options.session()?.sessionId === ownedSessionId ? acceptedClaudeMode : undefined;
          let activeConversation: ActiveConversation | undefined;
          let executionJob = job;
          if (options.harness === 'claude') {
            try {
              if (!resumed) {
                conversation = await model.conversations.create({
                  job,
                  parentSessionId: session.sessionId,
                  sdkSessionId: warm?.sdkSessionId ?? randomUUID(),
                  configDir: owner.configDir,
                });
              }
              if (!conversation) throw new Error('Owned conversation unavailable');
              ownedContinuation = true;
              const accepted = await model.conversations.accept(conversation.handle, owner, job.id);
              if (accepted?.action !== 'start') throw new Error('Continuation already selected');
              conversation = accepted.conversation;
              activeConversation = { handle: conversation.handle, owner, continuationId: job.id };
              if (resumed) executionJob = continuationExecution(job, conversation);
            } catch {
              await warm?.stop();
              await model.store.finish(job.id, 'unknown');
              return unavailable('Owned conversation could not be selected; no worker started');
            }
          }
          const abort = new AbortController();
          // WHO OR WHAT ABORTED IT, read at the abort itself: a cancel call names its
          // sender, this process ending is the session's end, and any other abort is the
          // host ending the accept call. A job once read `cancelled` with no way to tell.
          let abortedBy: 'parent_cancel' | 'agent_stopped' | 'session_ended' | 'host_aborted' =
            'host_aborted';
          abort.signal.addEventListener(
            'abort',
            () => {
              abortedBy = cancelledBy.get(job.id) ?? (sessionEnding ? 'session_ended' : abortedBy);
              cancelledBy.delete(job.id);
            },
            { once: true },
          );
          const stop = () => abort.abort();
          signal.addEventListener('abort', stop, { once: true });
          if (signal.aborted) stop();
          const started = Date.now();
          let activity: ModelWorkerActivity | undefined;
          if (activeConversation && conversation) {
            try {
              const owned = activeConversation;
              const { parentSessionId, root, configDir, sdkSessionId } = conversation;
              // A custom agent type too; the binding refuses any other shape.
              const nativeProfile = String(executionJob.native.subagent_type ?? 'general-purpose');
              activity = views.begin(
                job.id,
                () =>
                  new ModelWorkerActivity({
                    dataDir: options.dataDir,
                    binding: {
                      parentSessionId,
                      root,
                      configDir,
                      offerId: job.id,
                      workerHandle: owned.handle,
                      nativeProfile,
                      continuationId: owned.continuationId,
                      sdkSessionId,
                      generation: randomUUID(),
                    },
                  }),
              );
            } catch {
              // Activity is optional display data, never execution authority.
            }
          }
          let progress: { stop: () => Promise<void> } | undefined;
          if (activity) {
            try {
              // The plugin draws the live row from this file, not from a second
              // MCP call on the connection this accept call holds.
              progress = startWorkerProgress({
                dataDir: options.dataDir,
                parentSessionId: session.sessionId,
                offerId: job.id,
                activity,
                spend: () => transport.summary(executionJob),
              });
            } catch {
              // Display only.
            }
          }
          // THE IMAGE OR DOCUMENT CONTENT THE WORKER DID NOT SEE: the router takes text
          // only, so Tenjin sends a placeholder. The parent needs the count to decide
          // whether to run the job natively.
          const omittedNote = (blocks: number) =>
            `The worker did not see ${blocks} image or document ${
              blocks === 1 ? 'block' : 'blocks'
            } that Tenjin replaced with a text placeholder, so run this job natively if it needed that content.`;
          const omittedBlocks = (omitted: Set<string>) =>
            omitted.size > 0
              ? { omitted: { blocks: omitted.size, note: omittedNote(omitted.size) } }
              : {};
          // What a native subagent's result reports, beside the time and spend.
          const counts = () => {
            try {
              const shown = activity?.snapshot();
              return shown ? { toolUses: shown.toolUses, tokens: shown.tokens } : {};
            } catch {
              return {};
            }
          };
          const refundOutcome = async () => {
            if (options.harness !== 'claude') return {};
            const refund = await readModelRefundResult(options.dataDir, transport.origin, job.id);
            return refund.state !== 'none' ? { refund } : {};
          };
          // The accept call's own steps after its worker returned, for the diagnostic record.
          const endMarks: Record<string, number> = {};
          const inbox = new WorkerInbox();
          if (activeConversation)
            inboxes.set(activeConversation.handle, {
              inbox,
              owner: activeConversation.owner,
              jobId: job.id,
            });
          const done = (async () => {
            let inference: InferenceLease | undefined;
            const omitted = new Set<string>();
            try {
              signal.throwIfAborted();
              // One worker alone keeps the first channel, as before.
              inference = options.harness === 'claude' ? leaseInferenceSlot() : undefined;
              const runOptions: Parameters<typeof runModelWorker>[1] = {
                dataDir: options.dataDir,
                accepted: { at: acceptedAt, marks: startMarks },
                transport: inference?.slot ? transport.forInferenceSlot(inference.slot) : transport,
                signal: abort.signal,
                omitted,
                ...(activeConversation ? { inbox } : {}),
                ...(activity ? { activity } : {}),
                ...(session.codexPolicy ? { codexPolicy: session.codexPolicy } : {}),
                ...(options.harness === 'claude'
                  ? {
                      ...(options.web ? { web: options.web } : {}),
                      ...(options.webIdentities ? { webIdentities: options.webIdentities } : {}),
                      claudePermissionMode: acceptedClaudeMode ?? undefined,
                      currentClaudePermissionMode: jobClaudeMode,
                      claudeSession: {
                        ...(resumed
                          ? { resume: conversation!.sdkSessionId }
                          : { sessionId: conversation!.sdkSessionId }),
                        onSession: async (id: string) => {
                          if (id !== conversation!.sdkSessionId)
                            throw new Error('Native Claude changed the owned session');
                        },
                      },
                    }
                  : {}),
                permission: async (tool, input, signal, ask) => {
                  if (!server.server.getClientCapabilities()?.elicitation || signal.aborted)
                    return false;
                  if (Buffer.byteLength(JSON.stringify(input)) > 12000) return false;
                  // A native prompt never resolves by itself while it waits: the dialog
                  // stays for as long as the job may run, not the MCP SDK's 60 seconds.
                  // A connection that closes, or the job's end, answers no.
                  return server.server
                    .elicitInput(
                      workerPermissionForm(tool, input, ask, {
                        jobChoice: options.harness === 'claude',
                      }),
                      { signal, timeout: PROMPT_WAIT_MS },
                    )
                    .then(workerPermissionAnswer, () => false);
                },
              };
              const run = async (workerTransport: ModelTransport) => {
                abort.signal.throwIfAborted();
                const workerOptions = { ...runOptions, transport: workerTransport };
                if (warm && warm.sdkSessionId === conversation?.sdkSessionId) {
                  warm.accept({ ...workerOptions, job: executionJob }, abort.signal);
                  const outcome = await warm.result;
                  if ('value' in outcome) return outcome.value;
                  if (!outcome.canStartFresh) throw outcome.error;
                } else await warm?.stop();
                abort.signal.throwIfAborted();
                return runModelWorker(executionJob, workerOptions);
              };
              // A continuation can spend from an earlier job but must close its own channel.
              const result =
                options.harness === 'claude'
                  ? await runOptions.transport.withInferenceRun(
                      job.id,
                      abort.signal,
                      run,
                      (name) => {
                        (name === 'refundProbed' ? startMarks : endMarks)[name] = Date.now();
                      },
                      refundSupport,
                    )
                  : await run(runOptions.transport);
              const envelope = {
                status: 'completed',
                label: 'DeepSeek V4.1 Flash 1017',
                elapsedMs: Date.now() - started,
                ...counts(),
                ...(await refundOutcome()),
                ...omittedBlocks(omitted),
                spend: await transport
                  .summary(executionJob)
                  .catch(() => ({ accounting: 'unknown' })),
                result,
                ...(activeConversation
                  ? {
                      worker_handle: activeConversation.handle,
                      continuation: `Continue with SendMessage({to:"${activeConversation.handle}",message:"<complete follow-up and current constraints>"}). Tenjin holds it until you run it with subagent({offer_id}); it charges no routing fee and spends this job's remaining budget.`,
                    }
                  : {}),
              };
              if (activeConversation) {
                const serialized = JSON.stringify(envelope);
                if (
                  !(await model.conversations.finish(
                    activeConversation.handle,
                    activeConversation.owner,
                    job.id,
                    'completed',
                    serialized,
                  ))
                )
                  throw new Error('Owned worker completion could not be persisted');
                // The conversation result is already durable. A failed local
                // job update is repaired by replay, never by another worker.
                await model.store.finish(job.id, 'completed').catch(() => undefined);
              } else await model.store.finish(job.id, 'completed', result);
              endMarks.handbackStored = Date.now();
              try {
                activity?.handback(result);
              } catch {
                // Display only.
              }
              activity?.finish(
                'completed',
                'reservedAtomic' in envelope.spend ? envelope.spend : undefined,
              );
              endMarks.answered = Date.now();
              await writeWorkerPhases(options.dataDir, job.id, acceptedAt, endMarks);
              return answer(envelope);
            } catch (error) {
              const state = abort.signal.aborted ? 'cancelled' : 'unknown';
              if (activeConversation)
                await model.conversations
                  .finish(activeConversation.handle, activeConversation.owner, job.id, state)
                  .catch(() => false);
              const spend = await transport
                .summary(executionJob)
                .catch(() => ({ accounting: 'unknown' }));
              activity?.finish(state, 'reservedAtomic' in spend ? spend : undefined);
              // What the stopped worker already did, so a retry starts from it.
              const partial = partialHandback(activity?.snapshot());
              const stop = workerStop(error);
              // Claude Code did not start in its window: nothing ran, no inference was bought,
              // and the unchanged repeat of the offered call runs native with no second fee.
              const notStarted = !abort.signal.aborted && stop?.kind === 'not_started';
              const endedBy = abort.signal.aborted ? abortedBy : workerEnd(stop);
              // The error itself, for the person: the handback carries fixed codes only. A
              // job somebody ended (a cancel, the session's end, the host) has no error to
              // keep, and its record still says who ended it: such a job once left no
              // record at all when it ended before its worker did anything.
              await writeWorkerFailure(
                options.dataDir,
                job.id,
                workerFailure(endedBy, abort.signal.aborted ? undefined : error),
              );
              const stopped = {
                // `stopped` with its cause in `endedBy`; `unknown` only when nothing said why.
                status: abort.signal.aborted
                  ? 'cancelled'
                  : notStarted
                    ? 'not_started'
                    : stop
                      ? 'stopped'
                      : 'unknown',
                endedBy,
                ended: WORKER_ENDS[endedBy],
                // A model call the payer could not complete: why, and what the person can do,
                // in the words Tenjin uses for an unpaid routing fee.
                ...(stop?.payer && unpaid(stop.payer) ? { payment: unpaid(stop.payer) } : {}),
                stopReason: stop,
                elapsedMs: Date.now() - started,
                ...counts(),
                ...(await refundOutcome()),
                ...omittedBlocks(omitted),
                ...(partial ? { partial } : {}),
                // An initial offer's held call has a free repeat. A continuation has none,
                // though it runs with the original job's fields.
                nextStep:
                  notStarted && !resumed && job.nativeTool
                    ? `No worker started: ${stop?.reason === 'router_unreachable' ? 'the Tenjin router did not answer when the job started' : 'Claude Code did not start within its start-up window'}. Keep it native: send the original ${job.nativeTool} call again unchanged; that repeat costs no second routing fee.`
                    : activeConversation
                      ? 'Inspect pending invocation receipts; do not rebuy an uncertain turn. This owned conversation is fenced. Do not pass its handle to native tools; explicitly create a fresh native assignment with the needed context if required.'
                      : 'Inspect pending invocation receipts; do not rebuy an uncertain turn. Once quiesced, retry the original native Agent call unchanged.',
              };
              // On Claude the stopped handback is kept with the job, without its spend: a
              // later accept in the owning session reads it and reports the spend as it then is.
              await model.store
                .finish(job.id, state, offered ? JSON.stringify(stopped) : undefined)
                .catch(() => undefined);
              return answer({ ...stopped, spend });
            } finally {
              if (activeConversation && inboxes.get(activeConversation.handle)?.inbox === inbox)
                inboxes.delete(activeConversation.handle);
              inbox.close();
              inference?.release();
              // Not awaited: removing a display file never delays the handback.
              void progress?.stop().catch(() => undefined);
              await warm?.stop();
              views.finished(job.id);
              controllers.delete(job.id);
              signal.removeEventListener('abort', stop);
            }
          })();
          controllers.set(job.id, {
            abort,
            done,
            session: { ...session, sessionId: job.sessionId, turnId: job.turnId },
            ...(activeConversation ? { conversation: activeConversation } : {}),
          });
          if (!backgroundJob(job) || resumed || !activeConversation) return done;
          // A BACKGROUND CALL'S WORKER OUTLIVES ITS ACCEPT CALL, as a native background
          // agent outlives the Agent call that started it. The accept answers at once; the
          // worker goes on as an operation of its own in the job's window, so a cancel, the
          // session's end and this process's stop still end it, and the end of the accept
          // call does not. Its handback is kept with the job, and the plugin hands it to
          // the parent when the worker ends.
          signal.removeEventListener('abort', stop);
          void lifecycle
            .run(window, undefined, async (own) => {
              own.addEventListener('abort', stop, { once: true });
              if (own.aborted) stop();
              await done;
            })
            .catch(stop);
          return answer({
            status: 'started',
            background: true,
            label: 'DeepSeek V4.1 Flash 1017',
            offer_id: job.id,
            worker_handle: activeConversation.handle,
            instruction: BACKGROUND_STARTED,
          });
        })
        .catch(async () => {
          await noOffer('interrupted');
          return unavailable('Delegation interrupted; no new worker may start from this offer');
        })
        .finally(() => {
          if (!offered) return;
          const left = (accepting.get(offered) ?? 1) - 1;
          if (left > 0) accepting.set(offered, left);
          else accepting.delete(offered);
        });
    }),
  );
  const shutdown = async () => {
    refundRecovery.abort();
    await repaired;
    sessionEnding = true;
    await Promise.all([lifecycle.stop(), ...[...warming.values()].map((warm) => warm.stop())]);
    for (const running of controllers.values()) running.abort.abort();
    await Promise.allSettled([...controllers.values()].map((c) => c.done));
    await refundsRecovered;
    await views.shutdown();
  };
  workerShutdown.set(server, shutdown);
  return {
    shutdown,
    fence,
    async codexHook(session: ModelSession, raw: Record<string, unknown>) {
      if (isModelWorkerProcess()) return null;
      if (
        !['collaborationspawn_agent', 'spawn_agent', 'Agent'].includes(String(raw.tool_name)) ||
        typeof raw.tool_use_id !== 'string' ||
        !raw.tool_input ||
        typeof raw.tool_input !== 'object' ||
        Array.isArray(raw.tool_input)
      )
        return null;
      return lifecycle
        .run(turnWindow(session), undefined, async (signal) =>
          (await getHandoff()).captureCodex(
            session,
            raw.tool_use_id as string,
            raw.tool_input as Record<string, unknown>,
            signal,
          ),
        )
        .catch(() => ({
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason: 'This delegation window was interrupted; start a new turn.',
          },
        }));
    },
  };
}
