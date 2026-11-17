import { isModelWorkerProcess } from './model-worker-context';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { ModelHandoff, type ModelSession } from './model-handoff';
import { ModelJobStore, sweepModelRecords, type ModelJob, type NoOffer } from './model-job';
import { modelSettings } from './model-settings';
import { qualifiedModelWorker, runModelWorker } from './model-worker';
import type { ModelTransport } from './model-transport';
import { ModelLifecycle } from './model-lifecycle';
import { claudeWorkerPermissionMode } from './claude-model-policy';
import { WORKER_ENDS, WORKER_WALL_MS, workerEnd, workerStop } from './model-worker-control';
import { claudeWorkerConfigDir } from './claude-worker-session';
import { continuationRefusal, ownedModelReference } from './model-continuation';
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

type ActiveConversation = {
  handle: string;
  owner: ModelConversationOwner;
  continuationId: string;
};

/**
 * How long one `follow` read waits before it answers where the worker stands.
 * A host moves a tool call that runs past two minutes to a background task of
 * the parent session, so a viewer follows in short reads, never one long one.
 */
const FOLLOW_MS = 25_000;

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
    transport: () => Promise<ModelTransport>;
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
  const runsHere = (id: string) => accepting.has(id) || controllers.has(id);
  /** Who asked for a job to be cancelled, so its end says who or what ended it. */
  const cancelledBy = new Map<string, 'parent_cancel' | 'agent_stopped'>();
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
        refused:
          'This offer is already accepted and its worker is still running. Its result returns from the accept call that started it. No second worker started.',
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
        await sweepModelRecords(options.dataDir);
        for (const job of await jobs.unfinished()) await strand(job).catch(() => null);
      })().catch(() => undefined);
  let handoff: ModelHandoff | undefined;
  const getHandoff = async () =>
    (handoff ??= new ModelHandoff({
      dataDir: options.dataDir,
      transport: await options.transport(),
    }));
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
    fenceWindow(
      jobWindow(job),
      (state) => jobs.fenceOwned(job.id, job.sessionId, state),
      () => jobs.owned(job.id, job.sessionId),
    );
  if (options.harness === 'claude')
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
  server.registerTool(
    'subagent',
    {
      title: 'Tenjin subagent',
      description:
        'Run or cancel a Tenjin DeepSeek subagent offer. Accept with offer_id; cancel with cancel. Accepting the same offer again never starts a second worker or adds a charge: once its worker has ended it returns the stored result, in the same session. A held follow-up to a finished worker runs the same way, with no routing fee, on the budget that job has left. For a held Codex delegation, submit delegation_id and the complete plaintext task. The offer carries consent and the parent routing policy.',
      annotations: { title: 'DeepSeek subagent', readOnlyHint: false },
      ...(options.harness === 'claude' ? { _meta: { 'anthropic/alwaysLoad': true } } : {}),
      inputSchema: {
        offer_id: z.string().uuid().optional(),
        cancel: z.string().uuid().optional(),
        // Mod transport only. The same MCP process has already seen the owned root hook.
        capture: z
          .object({
            session_id: z.string(),
            tool_use_id: z.string(),
            tool: z.enum(['Agent', 'Task', 'SendMessage']).optional(),
            input: z.record(z.string(), z.unknown()),
            // The parent's model request that made the held call, as the host numbers it.
            step: z.string().max(200).optional(),
          })
          .optional(),
        delegation_id: z.string().uuid().optional(),
        task: z.string().optional(),
        // With cancel, from the plugin alone: the person stopped the worker's agent. A
        // label for the job's record, never a permission.
        reason: z.enum(['agent_stopped']).optional(),
      },
    },
    async (args, extra) => {
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
        [args.offer_id, args.cancel, args.capture, args.delegation_id].filter(
          (v) => v !== undefined,
        ).length !== 1
      )
        return unavailable('Use one subagent operation');
      await repaired;
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
            try {
              return answer(
                await (
                  await getHandoff()
                ).capture(
                  session,
                  args.capture.tool_use_id,
                  args.capture.input,
                  signal,
                  args.capture.tool,
                  args.capture.step,
                ),
              );
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
            return unavailable('Inference consent revoked or endpoint changed');
          if (
            options.harness === 'claude' &&
            (!claudeWorkerPermissionMode(currentClaudeMode()) ||
              pending?.decision.claudePermissionMode !== currentClaudeMode())
          )
            return unavailable(
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
              return unavailable('Owned worker history, repository or endpoint changed');
            try {
              await transport.requireResumeBudget(conversation.originalJob);
            } catch {
              return unavailable(
                'Original conversation budget is missing, uncertain or unavailable',
              );
            }
          }
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
          const offeredWorkspace = savedClaudeWorkspace(pending?.decision.claudeWorkspace);
          if (
            !qualified ||
            (options.harness === 'claude' &&
              (!offeredWorkspace ||
                !qualified.claudeWorkspace ||
                !sameClaudeWorkspace(offeredWorkspace, qualified.claudeWorkspace))) ||
            (options.harness === 'codex' &&
              JSON.stringify(qualified.nativeSnapshot) !==
                JSON.stringify(pending?.decision.nativeSnapshot))
          )
            return unavailable(
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
          if (
            !job ||
            job.root !== current.root ||
            job.decision.routerOrigin !== current.routerOrigin
          ) {
            // An offer nobody took in time: the call it held has run natively or not at all.
            if (!job && pending?.state === 'offered' && pending.expiresAt <= Date.now())
              await jobs.noOffer({
                sessionId: pending.sessionId,
                tool: pending.nativeTool ?? 'Agent',
                code: 'expired',
                offerId: pending.id,
              });
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
                  sdkSessionId: randomUUID(),
                  configDir: owner.configDir,
                });
              }
              if (!conversation) throw new Error('Owned conversation unavailable');
              ownedContinuation = true;
              const accepted = await model.conversations.accept(conversation.handle, owner, job.id);
              if (accepted?.action !== 'start') throw new Error('Continuation already selected');
              conversation = accepted.conversation;
              activeConversation = { handle: conversation.handle, owner, continuationId: job.id };
              if (resumed)
                executionJob = {
                  ...conversation.originalJob,
                  task: job.task,
                  capAtomic: job.capAtomic,
                  turnId: job.turnId,
                  callId: job.callId,
                  decision: {
                    ...conversation.originalJob.decision,
                    claudePermissionMode: acceptedClaudeMode,
                    claudeWorkspace: job.decision.claudeWorkspace,
                    requireExistingBudget: true,
                  },
                };
            } catch {
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
          // What a native subagent's result reports, beside the time and spend.
          const counts = () => {
            try {
              const shown = activity?.snapshot();
              return shown ? { toolUses: shown.toolUses, tokens: shown.tokens } : {};
            } catch {
              return {};
            }
          };
          const done = (async () => {
            try {
              signal.throwIfAborted();
              const result = await runModelWorker(executionJob, {
                dataDir: options.dataDir,
                transport,
                signal: abort.signal,
                ...(activity ? { activity } : {}),
                ...(session.codexPolicy ? { codexPolicy: session.codexPolicy } : {}),
                ...(options.harness === 'claude'
                  ? {
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
                      { signal, timeout: Math.max(1, started + WORKER_WALL_MS - Date.now()) },
                    )
                    .then(workerPermissionAnswer, () => false);
                },
              });
              const envelope = {
                status: 'completed',
                label: 'DeepSeek V4.1 Flash 1017',
                elapsedMs: Date.now() - started,
                ...counts(),
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
              try {
                activity?.handback(result);
              } catch {
                // Display only.
              }
              activity?.finish(
                'completed',
                'reservedAtomic' in envelope.spend ? envelope.spend : undefined,
              );
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
                stopReason: stop,
                elapsedMs: Date.now() - started,
                ...counts(),
                ...(partial ? { partial } : {}),
                // An initial offer's held call has a free repeat. A continuation has none,
                // though it runs with the original job's fields.
                nextStep:
                  notStarted && !resumed && job.nativeTool
                    ? `No worker started: Claude Code did not start within its start-up window. Keep it native: send the original ${job.nativeTool} call again unchanged; that repeat costs no second routing fee.`
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
              // Not awaited: removing a display file never delays the handback.
              void progress?.stop().catch(() => undefined);
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
          return done;
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
    },
  );
  const shutdown = async () => {
    await repaired;
    sessionEnding = true;
    await lifecycle.stop();
    for (const running of controllers.values()) running.abort.abort();
    await Promise.allSettled([...controllers.values()].map((c) => c.done));
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
