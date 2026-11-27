import {
  MODEL_MINIMUM_CALL_ATOMIC,
  MODEL_ROUTE_BODY_BYTES,
  MODEL_ROUTE_ENVELOPE_BYTES,
} from './model-limits';
import { lockSupport } from '../lib/held-lock';
import { isModelWorkerProcess } from './model-worker-context';
import { qualifiedModelWorker } from './model-worker';
import { z } from 'zod';
import { mask } from '../lib/redact';
import { buildPromptPacket } from './context';
import { ModelJobStore, routingAuthorizedAtomic, type NoOffer } from './model-job';
import {
  modelSettings,
  NEON_ROUTER_ORIGIN,
  providerOf,
  type ModelSettings,
  type WorkerProvider,
} from './model-settings';
import { modelGithubRepositories } from './model-repositories';
import type { ModelTransport, WorkerTransport } from './model-transport';
import type { ModelJob } from './model-job';
import { claudeWorkerPermissionMode, type ClaudeWorkerPermissionMode } from './claude-model-policy';
import parentPolicy from './model-parent-policy.json';
import { RouteSkipped } from './decision';
import { FEE_ABOVE_CEILING, ROUTING_FEE_CEILING_ATOMIC } from './fee';
import { ModelConversationStore, workerHandleFor } from './model-conversations';
import { claudeWorkerConfigDir, prepareClaudeWorkerSession } from './claude-worker-session';
import {
  modelClaudeWorkspaceCovered,
  modelClaudeRepositories,
  savedClaudeWorkspace,
  sameClaudeWorkspace,
  type ClaudeWorkspace,
} from './claude-workspace';
import { homedir } from 'node:os';
import { realpath } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import {
  neonMinimumJobAtomic,
  NEON_DEFAULT_EFFORT,
  NEON_EFFORTS,
  NEON_TURN_MAX_TOKENS,
  type NeonEffort,
} from './neon-chat';
import { neonJobLabel, neonTermsSchema, workerNameOf, type NeonTerms } from './neon-terms';
import { toMoney } from '../lib/money';
import { resolveContextSettings } from '../lib/settings';
import { readSpendSummary, spentOf } from '../lib/spend-ledger';
import { NEON_CHANNEL_DEPOSIT_CAP_ATOMIC } from './neon-seller';
import { neonFirstCallApproval, neonRevisionApproval } from './neon-approve';
import {
  neonFirstCallNeedAtomic,
  neonNextCallNeedAtomic,
  neonRoomLeftAtomic,
} from './neon-transport';
import { resolve } from 'node:path';
import { requestToolAccess, setsOwnMode, WORKER_BUILTIN_AGENTS, workerAgent } from './agent-tools';
import { SUBAGENT_TOOL } from './names';
import {
  continuationRefusal,
  ownedModelReference,
  type ModelNativeTool,
  nativeBackground,
} from './model-continuation';
import { callLimitSchema } from './model-pace';

/**
 * A follow-up to a worker is not a new routing decision: the worker, its history and its
 * budget are the ones already accepted, as a native SendMessage resumes its subagent with
 * no confirmation. The parent runs it or cancels it, and does not judge whether the
 * worker suits it. What binds any assignment still binds this text, since it goes to
 * another model: the person's own restrictions, and planning, which stays native.
 */
const continuationPolicy = (name: string) =>
  `This follow-up continues a ${name} worker that was already accepted, with its history. It is not a new offer, and its suitability is not judged again. Binding restrictions apply to its text as to any assignment: an explicit instruction of the person that restricts this worker's model, privacy, disclosure or paid inference still binds, and plan authoring and substantive plan review stay native. Where the follow-up would break one of those, cancel it and do that work natively. It carries no permission: the worker keeps its permission mode, rules and sandbox, and only the person can approve what those ask about. Never retry a Tenjin worker handle through native tools; a fresh native assignment requires its own complete context.`;

export const MODEL_BRIEF_GUIDANCE =
  'Copy complete assignments verbatim, including the final line, literal commands and output format. Add only missing known context. Preserve all binding details, actors and scope; never truncate. Add no model/routing advice. Compare the full assignment with the source before calling.';
export const modelOfferSchema = z.object({
  schemaVersion: z.literal(1),
  action: z.literal('model'),
  jobId: z.uuid(),
  model: z.literal('deepseek-flash'),
  endpoint: z.literal('/api/model-proxy/messages'),
  thinking: z.boolean(),
  reason: z.string(),
  policyHash: z.string(),
  rateVersion: z.string(),
  routingFeeAtomic: z.string().regex(/^\d+$/),
  proxyFeePercent: z.literal(5),
  started: z.literal(false),
  /** The largest `maxResultBytes` this router honours on a Messages call, and the size the
   *  call states: the router's own floor is 2,000,000 bytes. */
  maxResultBytes: z.number().int().min(2_000_000),
  /** The largest `max_tokens` this router's Messages endpoint accepts. */
  maxOutputTokens: z.number().int().positive(),
  /** The wallet's model-call rate over all its jobs and processes, counted at the unpaid
   *  quote. */
  callLimit: callLimitSchema,
  /** The router's total deadline for one paid model call, in ms. */
  maxCallDurationMs: z.number().int().nonnegative(),
  /** The router's idle limit for one call, in ms. */
  callIdleLimitMs: z.number().int().nonnegative(),
  /** The version of the streamed Messages reply this router speaks. The router always sends
   *  it, so an offer without it, or with another value, is invalid and the call stays native. */
  messagesStream: z.literal(1),
});
export interface ModelSession {
  sessionId: string;
  turnId: string;
  cwd: string;
  transcript: string;
  claudePermissionMode?: ClaudeWorkerPermissionMode;
}

/**
 * What the offer tells the parent of its consent: under the wide scope the directories are
 * the worker's own, under the limited one the directories the person named.
 */
function offerConsent(
  settings: ModelSettings,
  nativeRepositories: readonly string[],
  provider: WorkerProvider = 'deepseek',
) {
  const repositories =
    settings.scope === 'native-workspace' ? [...nativeRepositories] : settings.repositories;
  return {
    version: settings.version,
    ...(settings.scope === 'native-workspace' ? { scope: settings.scope } : {}),
    repository: settings.root,
    repositories,
    githubRepositories: modelGithubRepositories(repositories),
    // A Neon job has no router and no consent record: its provider is the one its row names.
    ...(provider === 'neon'
      ? {}
      : {
          routerOrigin: settings.routerOrigin,
          // As the consent record names them: Exa reads a page the worker's WebFetch could not fetch.
          recipients: ['Tenjin', 'DeepSeek', 'Exa'],
        }),
  };
}

/** Native directories the worker will not get, so the parent can tell the person. */
function droppedNote(workspace: ClaudeWorkspace) {
  const dropped = savedClaudeWorkspace(workspace)?.droppedDirectories ?? [];
  return dropped.length
    ? {
        workspaceNote: `Outside model consent, so withheld from the worker: ${dropped.join(', ')}.`,
      }
    : {};
}

function nativeRepositories(workspace: ClaudeWorkspace): string[] {
  return [
    ...new Set([
      ...workspace.workingDirectories,
      ...workspace.readExceptions,
      ...workspace.writeExceptions,
    ]),
  ];
}

type Admission = {
  schemaVersion: 1;
  consent: true;
  accepts: ['deepseek-flash'];
  subagentTask: string;
  parentContext: { role: 'user' | 'assistant'; content: string }[];
};
/**
 * Fits a route request under the router's body limit by giving up parent
 * context, never the assignment: the oldest context message first, then the end
 * of the last one left. The router needs at least one context entry. A request
 * whose assignment alone is over the limit is returned as it is, still over.
 */
export function fitAdmission(admission: Admission): Admission {
  const over = (value: Admission) =>
    Buffer.byteLength(JSON.stringify(value)) + MODEL_ROUTE_ENVELOPE_BYTES - MODEL_ROUTE_BODY_BYTES;
  let next = admission;
  while (next.parentContext.length > 1 && over(next) > 0)
    next = { ...next, parentContext: next.parentContext.slice(1) };
  for (let last = next.parentContext[0]; last && last.content && over(next) > 0;) {
    // JSON escaping can make a character several bytes, so cut by at least the excess.
    last = {
      ...last,
      content: last.content.slice(0, Math.max(0, last.content.length - over(next))),
    };
    next = { ...next, parentContext: [last] };
  }
  return next;
}

/**
 * The native subagent whose loop made a held call, at any depth: the loop that
 * receives the offer and accepts it or keeps it native. Absent for the main loop.
 */
export type ModelCaller = {
  agentId: string;
  /** The type it runs as, as the host lists it; absent when the host did not list it. */
  agentType?: string;
  /** The types of the agents above it, nearest first; '' for one the host no longer lists. */
  parents?: string[];
  /** The folder it works in, as the host lists it. */
  cwd?: string;
};

/**
 * Why the subagent that made a call cannot take an offer for it, else null. `tools`:
 * its tool list leaves the accept tool out (or cannot be read), so an offer would buy
 * a routing fee it can only answer by sending the call again. `mode`: it or an agent
 * above it may run in a permission mode of its own, which its native child would
 * inherit and a worker accepted in the session's mode would not. `folder`: it works
 * in a folder of its own, such as a worktree, where its native child would work and
 * a worker, in the session's workspace, would not.
 */
async function callerUnqualified(
  caller: ModelCaller,
  cwd: string,
): Promise<'tools' | 'mode' | 'folder' | null> {
  const lookup = { cwd, homeDir: homedir() };
  if ((await requestToolAccess(caller.agentType, lookup, SUBAGENT_TOOL)) !== 'allowed')
    return 'tools';
  for (const type of [caller.agentType ?? '', ...(caller.parents ?? [])])
    if (await setsOwnMode(type, lookup)) return 'mode';
  return caller.cwd === undefined || resolve(caller.cwd) !== resolve(cwd) ? 'folder' : null;
}

/** A mode's name for a record: one of the host's own, never free text. */
const modeName = (mode: unknown) =>
  typeof mode === 'string' && /^[A-Za-z]{1,32}$/.test(mode) ? mode : 'unobserved';

/**
 * The first field of a held Agent call that keeps it native, else null. A
 * call that names its agent starts a teammate, which a worker is not. A
 * background call (`run_in_background`) is offered as a foreground one is, and
 * its worker runs in the background. The mod sends the loop that made a call
 * as `caller`, never in the input, so an `agentId` there is the call's own
 * field, and keeps it native.
 */
function blockedField(native: Record<string, unknown>): string | null {
  if (typeof native.prompt !== 'string' || !native.prompt) return 'prompt';
  if (nativeBackground(native) === null) return 'run_in_background';
  const set = ['agentId', 'agent_id', 'resume', 'name', 'team_name', 'isolation'].find(
    (key) => native[key],
  );
  return set ?? null;
}

/** Where a held call's time went before its offer, for the job's diagnostic record. */
export type CaptureTiming = {
  jobId?: string;
  marks: Record<string, number>;
  routeFetchMs: number[];
};

export class ModelHandoff {
  readonly store: ModelJobStore;
  readonly conversations: ModelConversationStore;
  constructor(
    private options: {
      dataDir: string;
      transport: ModelTransport;
      /** The Neon worker's transport, made when a Neon job's follow-up needs it. */
      neonTransport?: () => Promise<WorkerTransport>;
      /** The door's one free lookup of the Neon provider row. A failure fails the job. */
      neonTerms?: (signal?: AbortSignal) => Promise<NeonTerms>;
    },
  ) {
    this.store = new ModelJobStore(options.dataDir);
    this.conversations = new ModelConversationStore(options.dataDir);
  }
  private async currentConsent(cwd: string, provider: WorkerProvider = 'deepseek') {
    const settings = await modelSettings(this.options.dataDir, cwd, provider);
    return settings?.routerOrigin ===
      (provider === 'neon' ? NEON_ROUTER_ORIGIN : this.options.transport.origin)
      ? settings
      : null;
  }
  /** Records why a call got no offer and answers that it runs natively. Codes only. */
  private async stay(
    session: ModelSession,
    tool: string,
    code: NoOffer['code'],
    more: Pick<NoOffer, 'detail' | 'bytes' | 'limit' | 'offerId' | 'from'> = {},
  ) {
    await this.store.noOffer({ sessionId: session.sessionId, tool, code, ...more });
    return { action: 'native' as const };
  }
  /**
   * One held call, judged by itself: what else its session has on offer or
   * running does not count. `step` names the parent's model request that made
   * the call, where the host says. `caller` is the native subagent that made
   * it, at any depth, absent for the main loop: its call is judged as the main
   * loop's is, and it receives the offer. A worker's own calls get none.
   */
  async capture(
    session: ModelSession,
    callId: string,
    native: Record<string, unknown>,
    signal?: AbortSignal,
    nativeTool: ModelNativeTool = 'Agent',
    step?: string,
    caller?: ModelCaller,
    /** Diagnostics only: filled with the job's id and when each step before the offer ended. */
    timing?: CaptureTiming,
    /**
     * A follow-up the parent addressed to a worker this process accepted: the choice is made, so
     * the offer is marked to run at once in the background, as a native agent resumed by a message is.
     */
    direct = false,
  ) {
    signal?.throwIfAborted();
    const settings = await this.currentConsent(session.cwd);
    const reference = ownedModelReference(native, nativeTool);
    if (reference.owned) {
      if (reference.error || !reference.handle || !reference.task)
        return continuationRefusal(reference.error ?? 'Unavailable worker continuation');
      try {
        return await this.continue(
          session,
          callId,
          native,
          reference.handle,
          reference.task,
          signal,
          direct,
        );
      } catch {
        return continuationRefusal('Worker continuation is unavailable or interrupted');
      }
    }
    if (nativeTool === 'SendMessage' || isModelWorkerProcess()) return { action: 'native' };
    // A native subagent's own call is judged as the main loop's is, and its record says so.
    const stay = (code: NoOffer['code'], more?: Parameters<ModelHandoff['stay']>[3]) =>
      this.stay(session, nativeTool, code, { ...more, ...(caller ? { from: 'subagent' } : {}) });
    const { dataDir, transport } = this.options;
    if (!settings) return stay('no_consent');
    if (!claudeWorkerPermissionMode(session.claudePermissionMode))
      return stay('permission_mode', { detail: modeName(session.claudePermissionMode) });
    signal?.throwIfAborted();
    // A Linux Node without node:sqlite cannot take the job store's lock, which the repeat check
    // just below needs: this comes first, so the reason is the one that is kept. No offer, no fee.
    if (!lockSupport().ok) return stay('worker_unqualified', { detail: 'linux_needs_node_22_13' });
    // The parent kept a held call native by sending it again unchanged: no new routing, no fee.
    const kept = await this.store.nativeRepeat(
      session.sessionId,
      settings.root,
      nativeTool,
      native,
      step,
      caller?.agentId,
    );
    if (kept) return { ...(await stay('kept_native', { offerId: kept })), settled: kept };
    const blocked = blockedField(native);
    if (blocked) return stay('input_filter', { detail: blocked });
    // The subagent that made the call accepts its offer, and a worker stands in for its
    // native child: so it must be able to call the accept tool, and its child must be
    // one that would run in the session's mode and folder, as a worker does.
    const unable = caller && (await callerUnqualified(caller, session.cwd));
    if (unable) return stay('caller_unqualified', { detail: unable });
    // A custom agent is offered when the project or the person wrote its definition and a
    // worker can run as it: read in the job's root, where the worker will read it. A
    // plugin's agent and the host's other built-ins are never offered.
    const agentType = String(native.subagent_type ?? 'general-purpose');
    const custom = WORKER_BUILTIN_AGENTS.has(agentType)
      ? null
      : await workerAgent(agentType, {
          root: settings.root,
          cwd: session.cwd,
          homeDir: homedir(),
        });
    if (custom && 'unmatched' in custom) return stay('input_filter', { detail: custom.unmatched });
    const worker = await qualifiedModelWorker(
      session.cwd,
      agentType,
      dataDir,
      signal,
      session.claudePermissionMode,
    );
    if (!worker?.claudeWorkspace) return stay('worker_unqualified');
    const job = await this.store.offer(
      {
        sessionId: session.sessionId,
        turnId: session.turnId,
        callId,
        root: settings.root,
        task: native.prompt as string,
        native,
        nativeTool,
        ...(step === undefined ? {} : { step }),
        ...(caller ? { caller: caller.agentId } : {}),
        decision: {
          routerOrigin: transport.origin,
          claudePermissionMode: session.claudePermissionMode,
          claudeWorkspace: worker.claudeWorkspace,
          ...(worker.windows ? { windowsWorker: worker.windows.fingerprint } : {}),
        },
        capAtomic: settings.maxJobAtomic.toString(),
      },
      'routing',
    );
    if (timing) {
      timing.jobId = job.id;
      timing.marks.job = Date.now();
    }
    return this.route(session, job, signal, timing);
  }
  /**
   * THE EXPLICIT DOOR to a Neon worker: the parent chose it, so there is no held call, no
   * routing and no offer to judge. The person, or a skill the person runs, asks for Neon by
   * calling it; the router never offers it, and no setting (the DeepSeek subagent switch, on or
   * off, included) gates it. It reads its provider row once, free, and saves the row's terms
   * with the job: its model, seller, payee and price rule. A lookup that fails fails the job
   * with nothing sent. It makes the job's record, the way a held call's offer does, and answers
   * with the offer the accept then runs. It refuses in every case the DeepSeek worker would
   * also stay out: no permission mode, a Windows host, a worker that does not qualify, a job
   * ceiling with no room for one call. It sends nothing and pays nothing.
   */
  async neon(
    session: ModelSession,
    input: { prompt: string; description?: string; subagent_type?: string; effort?: string },
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const refuse = (reason: string) => ({ action: 'refused' as const, reason, charged: false });
    if (isModelWorkerProcess()) return refuse('A worker starts no other worker.');
    const settings = await this.currentConsent(session.cwd, 'neon');
    if (!settings)
      return refuse('Tenjin is switched off here. Nothing was sent and nothing was charged.');
    if (!claudeWorkerPermissionMode(session.claudePermissionMode))
      return refuse(
        `A Neon worker cannot run in this session's permission mode (${modeName(session.claudePermissionMode)}).`,
      );
    if (!lockSupport().ok)
      return refuse('A Neon worker needs Node 22.13 or later on Linux; this one cannot run it.');
    const effort = input.effort ?? NEON_DEFAULT_EFFORT;
    if (!(NEON_EFFORTS as readonly string[]).includes(effort))
      return refuse(`The effort is one of ${NEON_EFFORTS.join(', ')}. Nothing was sent.`);
    const agentType = input.subagent_type ?? 'general-purpose';
    signal?.throwIfAborted();
    if (!this.options.neonTerms)
      return refuse('The provider of a Neon job cannot be looked up here. Nothing was sent.');
    let terms: NeonTerms;
    try {
      terms = await this.options.neonTerms(signal);
    } catch (error) {
      if (signal?.aborted) throw error;
      return refuse(
        `The Tenjin router did not give the provider for this job${error instanceof Error && error.message ? ` (${error.message})` : ''}. Nothing was sent and nothing was charged.`,
      );
    }
    signal?.throwIfAborted();
    const worker = await qualifiedModelWorker(
      session.cwd,
      agentType,
      this.options.dataDir,
      signal,
      session.claudePermissionMode,
      'neon',
    );
    if (!worker?.claudeWorkspace)
      return refuse(
        'This Claude Code, its login, policy, sandbox or the subagent type does not qualify for a worker here.',
      );
    if (settings.maxJobAtomic < neonMinimumJobAtomic(terms))
      return refuse('The job ceiling has no room for one Neon call. Raise the per-call limit.');
    // A DRAFT THE JOB CEILING CANNOT CARRY IS ASKED ABOUT, NOT SENT: its first call is sized from
    // the draft and the row's price rule, against the person's per-call limit, before any request
    // to the seller. Where one approved ceiling can carry it, the answer is the quote and the
    // `approve` call, with the job kept; where none can (more than one channel deposit holds), it
    // is refused with the reason. Either way nothing of the draft is sent.
    const need = neonFirstCallNeedAtomic(terms, Buffer.byteLength(input.prompt));
    if (need > NEON_CHANNEL_DEPOSIT_CAP_ATOMIC)
      return refuse(
        'This draft is larger than one Neon call can carry (more than one channel deposit holds). Nothing was sent and nothing was charged. Send a shorter draft.',
      );
    // The same two limits the tool payer asks about: the per-call limit (which is the job's
    // ceiling) and what the rolling day's budget has left.
    const policy = (
      await resolveContextSettings({ dataDir: this.options.dataDir, flags: {} } as never)
    ).policy;
    const spent = await readSpendSummary(this.options.dataDir);
    const dayLeft =
      policy.sessionBudgetAtomic === null
        ? null
        : policy.sessionBudgetAtomic > (spent === null ? 0n : spentOf(spent))
          ? policy.sessionBudgetAtomic - (spent === null ? 0n : spentOf(spent))
          : 0n;
    const usd = (atomic: bigint) => `$${toMoney(atomic.toString()).usd}`;
    const over =
      need > settings.maxJobAtomic
        ? `more than the ${usd(settings.maxJobAtomic)} this machine pays for one call without asking`
        : dayLeft !== null && need > dayLeft
          ? `more than today's automatic budget has left (${usd(dayLeft)})`
          : null;
    const native = {
      prompt: input.prompt,
      ...(input.description !== undefined ? { description: input.description } : {}),
      subagent_type: agentType,
    };
    const job = await this.store.offer({
      sessionId: session.sessionId,
      turnId: session.turnId,
      // A door call is no held call: its id is its own, so a repeat is a second job.
      callId: `neon-${randomUUID()}`,
      root: settings.root,
      task: input.prompt,
      native,
      decision: {
        action: 'model',
        provider: 'neon',
        model: terms.model,
        routerOrigin: NEON_ROUTER_ORIGIN,
        // The row's terms, saved: every call, revision and refund of this job uses these.
        neonTerms: terms,
        neonEffort: effort as NeonEffort,
        // No routing call was paid: the job starts with nothing spent.
        routingAuthorizedAtomic: '0',
        maxOutputTokens: NEON_TURN_MAX_TOKENS,
        claudePermissionMode: session.claudePermissionMode,
        claudeWorkspace: worker.claudeWorkspace,
      },
      capAtomic: settings.maxJobAtomic.toString(),
    });
    if (over)
      return neonFirstCallApproval(
        this.options.dataDir,
        job,
        workerHandleFor(job.id),
        terms,
        need,
        need,
        over,
      );
    return {
      action: 'offer',
      started: false,
      offer_id: job.id,
      label: terms.label,
      capAtomic: job.capAtomic,
      workspace: worker.claudeWorkspace,
      consent: offerConsent(settings, nativeRepositories(worker.claudeWorkspace), 'neon'),
      worker_handle: workerHandleFor(job.id),
    };
  }
  private async continue(
    session: ModelSession,
    callId: string,
    native: Record<string, unknown>,
    handle: string,
    task: string,
    signal?: AbortSignal,
    direct = false,
  ) {
    const { dataDir } = this.options;
    const here = await realpath(session.cwd).catch(() => null);
    if (
      !here ||
      isModelWorkerProcess() ||
      !claudeWorkerPermissionMode(session.claudePermissionMode)
    )
      return continuationRefusal('Current model consent or Claude permission mode is unavailable');
    const owner = {
      parentSessionId: session.sessionId,
      root: here,
      configDir: claudeWorkerConfigDir(here),
    };
    const conversation = await this.conversations.lookup(handle, owner);
    if (!conversation || !['idle', 'offered'].includes(conversation.state))
      return continuationRefusal('Worker history is foreign, unavailable or already active');
    const original = conversation.originalJob;
    // A follow-up runs under the consent of the provider its worker began under.
    const provider = providerOf(original);
    const settings = await this.currentConsent(session.cwd, provider);
    if (!settings || settings.root !== here)
      return continuationRefusal('Current model consent or Claude permission mode is unavailable');
    const transport =
      provider === 'neon' && this.options.neonTransport
        ? await this.options.neonTransport()
        : this.options.transport;
    if (
      native.subagent_type !== undefined &&
      native.subagent_type !== (original.native.subagent_type ?? 'general-purpose')
    )
      return continuationRefusal('A continuation cannot change its native worker profile');
    if (original.decision.routerOrigin !== transport.origin)
      return continuationRefusal('Original worker endpoint changed');
    // No run is going (the conversation is idle), so what an earlier run left
    // uncertain is settled with the server before it counts against this one.
    await transport.reconcile(original, signal ?? new AbortController().signal);
    await transport.requireResumeBudget(original);
    // A NEON REVISION PAST THE JOB CEILING is asked about, not refused: nothing is sent, and the
    // answer is the quote of one more ceiling for the same worker (`approve` grants it).
    if (provider === 'neon') {
      const terms = neonTermsSchema.safeParse(original.decision.neonTerms);
      if (!terms.success) return continuationRefusal('Original Neon seller terms are unavailable');
      const left = await neonRoomLeftAtomic(dataDir, original, settings.maxJobAtomic);
      const need = await neonNextCallNeedAtomic(dataDir, original, terms.data);
      const needed =
        need > neonMinimumJobAtomic(terms.data) ? need : neonMinimumJobAtomic(terms.data);
      if (left < needed) {
        // The grant is at least one ceiling, and enough for what the next call measured it needs.
        if (needed > NEON_CHANNEL_DEPOSIT_CAP_ATOMIC)
          return continuationRefusal(
            'The next call is larger than one Neon call can carry (more than one channel deposit holds). Nothing was sent.',
          );
        return neonRevisionApproval(
          dataDir,
          original,
          handle,
          terms.data,
          needed - left > settings.maxJobAtomic ? needed - left : settings.maxJobAtomic,
          left,
        );
      }
    }
    await prepareClaudeWorkerSession(
      { resume: conversation.sdkSessionId, onSession: async () => {} },
      settings.root,
    );
    const worker = await qualifiedModelWorker(
      settings.root,
      String(original.native.subagent_type ?? 'general-purpose'),
      dataDir,
      signal,
      session.claudePermissionMode,
      provider,
    );
    const originalWorkspace = savedClaudeWorkspace(original.decision.claudeWorkspace);
    if (
      !worker?.claudeWorkspace ||
      worker.windows?.fingerprint !== original.decision.windowsWorker ||
      !originalWorkspace ||
      !sameClaudeWorkspace(originalWorkspace, worker.claudeWorkspace)
    )
      return continuationRefusal(
        'Current native workspace scope changed or its original disclosure is unavailable',
      );
    signal?.throwIfAborted();
    const latest = await this.currentConsent(session.cwd, provider);
    if (
      !latest ||
      latest.root !== settings.root ||
      !modelClaudeWorkspaceCovered(originalWorkspace, latest)
    )
      return continuationRefusal('Current model consent changed during qualification');
    signal?.throwIfAborted();
    const cap =
      latest.maxJobAtomic < BigInt(original.capAtomic)
        ? latest.maxJobAtomic.toString()
        : original.capAtomic;
    const job = await this.store.offer({
      sessionId: session.sessionId,
      turnId: session.turnId,
      callId,
      root: settings.root,
      task,
      native: direct ? { ...native, run_in_background: true } : native,
      decision: {
        ...original.decision,
        workerHandle: handle,
        workerConfigDir: conversation.configDir,
        claudePermissionMode: session.claudePermissionMode,
        claudeWorkspace: worker.claudeWorkspace,
      },
      capAtomic: cap,
    });
    const offered = await this.conversations.offer(handle, owner, {
      id: job.id,
      parentTurnId: session.turnId,
      callId,
      task,
    });
    if (!offered || offered.state !== 'offered') {
      await this.store.fenceOwned(job.id, session.sessionId);
      return continuationRefusal('This continuation cannot be selected again');
    }
    signal?.throwIfAborted();
    return {
      action: 'offer',
      started: false,
      offer_id: job.id,
      worker_handle: handle,
      continuation: true,
      ...(direct ? { direct: true } : {}),
      label: provider === 'neon' ? neonJobLabel(original.decision) : 'DeepSeek V4.1 Flash 1017',
      routingFeeAtomic: '0',
      proxyFeePercent: 5,
      capAtomic: cap,
      reason: `Continue the owned ${provider === 'neon' ? 'Neon' : 'DeepSeek'} worker with its history and remaining original budget`,
      parentPolicy: continuationPolicy(workerNameOf(original.decision)),
      workspace: worker.claudeWorkspace,
      ...droppedNote(worker.claudeWorkspace),
      consent: offerConsent(
        latest,
        modelClaudeRepositories(worker.claudeWorkspace, latest),
        provider,
      ),
      instruction: `Run this follow-up with subagent({offer_id}) as one call; to stop it, subagent({cancel: offer_id}). It charges no routing fee, and its inference is charged to the original job's remaining budget. Cancel it where the parentPolicy's binding restrictions forbid this text for a ${workerNameOf(original.decision)} worker. Do not send a Tenjin handle to native tools. No assignment has been sent.`,
    };
  }
  private async route(
    session: ModelSession,
    job: ModelJob,
    signal?: AbortSignal,
    timing?: CaptureTiming,
  ) {
    const { transport } = this.options;
    const native = async (code: NoOffer['code'], more?: Parameters<ModelHandoff['stay']>[3]) => {
      await this.store.decided(job.id, { action: 'native' });
      return this.stay(session, job.nativeTool ?? 'Agent', code, {
        ...more,
        ...(job.caller ? { from: 'subagent' } : {}),
      });
    };
    const settings = await this.currentConsent(session.cwd);
    if (!settings) return native('no_consent');
    if (settings.root !== job.root) return native('scope_not_covered');
    const task = job.task;
    const claudeWorkspace = savedClaudeWorkspace(job.decision.claudeWorkspace);
    if (!claudeWorkspace || !modelClaudeWorkspaceCovered(claudeWorkspace, settings))
      return native('scope_not_covered');
    const disclosureRepositories = nativeRepositories(claudeWorkspace);
    const packet = await buildPromptPacket(
      session.transcript,
      session.sessionId,
      task,
      'claude',
      // A subagent's call is judged with that subagent's own conversation after the session's.
      job.caller ? { agentId: job.caller } : {},
    );
    if (packet.historyStatus !== 'ok' || !packet.history.length)
      return native('parent_context_unavailable');
    const history =
      settings.context === 'turn'
        ? packet.history.slice(Math.max(0, packet.history.map((m) => m.role).lastIndexOf('user')))
        : packet.history;
    const admission = fitAdmission({
      schemaVersion: 1,
      consent: true,
      accepts: ['deepseek-flash'],
      subagentTask: mask(task),
      parentContext: history.slice(-6).map((m) => ({ role: m.role, content: mask(m.text) })),
    });
    const bytes = Buffer.byteLength(JSON.stringify(admission)) + MODEL_ROUTE_ENVELOPE_BYTES;
    if (bytes > MODEL_ROUTE_BODY_BYTES)
      return native('over_size_limit', { bytes, limit: MODEL_ROUTE_BODY_BYTES });
    if (settings.maxJobAtomic <= MODEL_MINIMUM_CALL_ATOMIC) return native('job_cap_too_low');
    const input = { ...admission, jobId: job.id };
    // What a consent read later must still say for this job, or the code that says why not.
    // A cap under the one the job was held at is the person lowering their per-call limit,
    // or naming a lower ceiling, in between: its own reason, not a scope one.
    const covered = (consent: ModelSettings) =>
      modelClaudeWorkspaceCovered(claudeWorkspace, consent);
    const uncovered = (consent: ModelSettings): NoOffer['code'] | null =>
      consent.root !== job.root || consent.context !== settings.context || !covered(consent)
        ? 'scope_not_covered'
        : consent.maxJobAtomic < BigInt(job.capAtomic)
          ? 'job_cap_lowered'
          : null;
    let raw: unknown;
    // What the routing call's own payment could charge, as this client measured it.
    let authorizedAtomic: bigint;
    // What the router's 402 stated for this call, and the most the person's own job cap leaves
    // for it beside one model call: the fee ceiling is the tool router's, with no cap of its own.
    const capAtomic =
      BigInt(job.capAtomic) < settings.maxJobAtomic ? BigInt(job.capAtomic) : settings.maxJobAtomic;
    const roomAtomic = capAtomic - MODEL_MINIMUM_CALL_ATOMIC;
    const limitAtomic =
      roomAtomic < ROUTING_FEE_CEILING_ATOMIC ? roomAtomic : ROUTING_FEE_CEILING_ATOMIC;
    // Consent read again just before the routing fee is paid: what it then lacked.
    let changedBeforeFee: NoOffer['code'] | null = null;
    try {
      signal?.throwIfAborted();
      // By its own id: another call of the session never stands in its way.
      const pending = await this.store.owned(job.id, session.sessionId);
      signal?.throwIfAborted();
      if (pending?.id !== job.id || !['routing', 'offered'].includes(pending.state))
        return native('superseded');
      const consent = await this.currentConsent(session.cwd);
      if (!consent) return native('no_consent');
      const changed = uncovered(consent);
      if (changed) return native(changed);
      signal?.throwIfAborted();
      if (timing) timing.marks.routeSent = Date.now();
      const answered =
        job.state === 'offered'
          ? { json: job.decision, authorizedAtomic: routingAuthorizedAtomic(job.decision) }
          : await transport.route(
              input,
              signal,
              async () => {
                const worker = await qualifiedModelWorker(
                  session.cwd,
                  String(job.native.subagent_type ?? 'general-purpose'),
                  this.options.dataDir,
                  signal,
                  session.claudePermissionMode,
                );
                if (
                  !worker?.claudeWorkspace ||
                  !sameClaudeWorkspace(claudeWorkspace, worker.claudeWorkspace) ||
                  worker.windows?.fingerprint !== job.decision.windowsWorker
                )
                  throw new Error('Native Claude workspace scope changed');
                const current = await this.currentConsent(session.cwd);
                changedBeforeFee = current ? uncovered(current) : 'no_consent';
                if (changedBeforeFee)
                  throw new Error('Model routing consent or workspace scope changed');
              },
              timing?.routeFetchMs,
              limitAtomic,
            );
      raw = answered.json;
      authorizedAtomic = answered.authorizedAtomic;
      if (timing) timing.marks.routeAnswered = Date.now();
      signal?.throwIfAborted();
    } catch (error) {
      // A fee stated above what may be paid is skipped, as the tool router skips such an answer.
      if (error instanceof RouteSkipped && error.why === FEE_ABOVE_CEILING) {
        // Within the fee ceiling, the fee is skipped for want of room in the job's cap.
        if (error.quotedAtomic !== undefined && error.quotedAtomic <= ROUTING_FEE_CEILING_ATOMIC)
          await native('job_cap_too_low');
        else
          await native('fee_above_ceiling', {
            ...(error.quotedAtomic !== undefined ? { detail: error.quotedAtomic.toString() } : {}),
          });
      } else await native(signal?.aborted ? 'interrupted' : (changedBeforeFee ?? 'route_error'));
      return { action: 'native', reason: 'Routing failed or interrupted; retry native unchanged' };
    }
    const parsed = modelOfferSchema.safeParse(raw);
    if (
      !parsed.success ||
      parsed.data.jobId !== job.id ||
      BigInt(parsed.data.routingFeeAtomic) > authorizedAtomic
    ) {
      // The server's own answer that the work stays native names its reason as a code.
      const declined = z.object({ action: z.literal('native'), reason: z.string() }).safeParse(raw);
      return declined.success
        ? native('server_declined', {
            ...(/^[A-Za-z0-9_.:-]{1,64}$/.test(declined.data.reason)
              ? { detail: declined.data.reason }
              : {}),
          })
        : native('invalid_offer');
    }
    const consent = await this.currentConsent(session.cwd);
    const changed = consent ? uncovered(consent) : 'no_consent';
    if (!consent || changed) return native(changed ?? 'no_consent');
    await this.store.decided(job.id, {
      ...parsed.data,
      // Measured here, never taken from the offer: the job's budget starts from it.
      routingAuthorizedAtomic: authorizedAtomic.toString(),
      routerOrigin: transport.origin,
      claudeWorkspace,
      ...(job.decision.windowsWorker ? { windowsWorker: job.decision.windowsWorker } : {}),
      claudePermissionMode: job.decision.claudePermissionMode,
    });
    if (timing) timing.marks.decided = Date.now();
    return {
      action: 'offer',
      started: false,
      offer_id: job.id,
      label: 'DeepSeek V4.1 Flash 1017',
      routingFeeAtomic: parsed.data.routingFeeAtomic,
      proxyFeePercent: 5,
      capAtomic: job.capAtomic,
      reason: parsed.data.reason,
      parentPolicy,
      workspace: claudeWorkspace,
      ...droppedNote(claudeWorkspace),
      consent: offerConsent(consent, disclosureRepositories),
      instruction: `The user has installed Tenjin and turned DeepSeek subagents on. Routing goes through Tenjin/TypeSafe; after acceptance, the assignment, applicable instructions and tool results may reach Tenjin/DeepSeek, and its web searches run inside the DeepSeek call, while the address of a public page its WebFetch could not fetch goes to Exa. Accept this qualified recommendation with subagent({offer_id}) unless the complete assignment or binding instructions require native work or forbid disclosure. ${
        job.nativeTool
          ? `To keep it native, send the original ${job.nativeTool} call again unchanged; that repeat costs no second routing fee.`
          : 'Otherwise retry the original native Agent call unchanged.'
      } This offer is for this one call: each held call gets its own offer, its own offer_id and its own routing fee, within the person's spend limits and each job's cap. When accepting several offers together, put only the chosen ids into one subagent({offer_ids: [id1, id2, ...]}) call so their workers run in parallel. Claude Code runs separate acceptance calls in order.${
        nativeBackground(job.native) === true
          ? " This call asked to run in the background, so its worker does: the accept call returns at once, and the worker's result arrives later as a notification, as a native background agent's does. Sent again unchanged, the call runs natively in the background."
          : ''
      } Do either as one call with no comment on the choice: the call itself shows it. You retain the final veto. Once accepted, the worker's address is ${workerHandleFor(job.id)}: to tell it something while it runs, call SendMessage({to:"${workerHandleFor(job.id)}",message:"<complete message>"}); it reaches the worker at its next turn, as a native subagent's message does. Such a message goes to DeepSeek at once, with no held offer to cancel, so apply this offer's parentPolicy to its text before you send it.`,
      worker_handle: workerHandleFor(job.id),
      ...(nativeBackground(job.native) === true ? { background: true } : {}),
    };
  }
}
