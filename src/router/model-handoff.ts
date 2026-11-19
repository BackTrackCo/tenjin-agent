import {
  MODEL_CODEX_TASK_BYTES,
  MODEL_MINIMUM_JOB_ATOMIC,
  MODEL_ROUTE_BODY_BYTES,
  MODEL_ROUTE_ENVELOPE_BYTES,
} from './model-limits';
import { isModelWorkerProcess } from './model-worker-context';
import { qualifiedModelWorker } from './model-worker';
import { z } from 'zod';
import { mask } from '../lib/redact';
import { buildPromptPacket } from './context';
import { ModelJobStore, type NoOffer } from './model-job';
import { modelSettings, type ModelSettings } from './model-settings';
import { modelGithubRepositories } from './model-repositories';
import type { ModelTransport } from './model-transport';
import type { CodexModelPolicy } from './codex-model-gates';
import type { ModelJob } from './model-job';
import { assertInstructionMetadataCurrent, savedInstructionContext } from './model-instructions';
import { claudeWorkerPermissionMode, type ClaudeWorkerPermissionMode } from './claude-model-policy';
import parentPolicy from './model-parent-policy.json';
import { MODEL_ROUTING_FEE_CEILING_ATOMIC } from './model-channel';
import { ModelConversationStore } from './model-conversations';
import { claudeWorkerConfigDir, prepareClaudeWorkerSession } from './claude-worker-session';
import {
  modelClaudeRepositories,
  savedClaudeWorkspace,
  sameClaudeWorkspace,
  type ClaudeWorkspace,
} from './claude-workspace';
import { homedir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';
import { requestToolAccess, setsOwnMode, WORKER_BUILTIN_AGENTS, workerAgent } from './agent-tools';
import { SUBAGENT_TOOL } from './names';
import {
  continuationRefusal,
  ownedModelReference,
  type ModelNativeTool,
  nativeBackground,
} from './model-continuation';

/**
 * A follow-up to a worker is not a new routing decision: the worker, its history and its
 * budget are the ones already accepted, as a native SendMessage resumes its subagent with
 * no confirmation. The parent runs it or cancels it, and does not judge whether the
 * worker suits it. What binds any assignment still binds this text, since it goes to
 * another model: the person's own restrictions, and planning, which stays native.
 */
const continuationPolicy =
  "This follow-up continues a DeepSeek worker that was already accepted, with its history. It is not a new offer, and its suitability is not judged again. Binding restrictions apply to its text as to any assignment: an explicit instruction of the person that restricts this worker's model, privacy, disclosure or paid inference still binds, and plan authoring and substantive plan review stay native. Where the follow-up would break one of those, cancel it and do that work natively. It carries no permission: the worker keeps its permission mode, rules and sandbox, and only the person can approve what those ask about. Never retry a Tenjin worker handle through native tools; a fresh native assignment requires its own complete context.";

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
  /** The largest `maxResultBytes` this router honours on a Messages call. A router that
   *  does not say so refuses the field, so none is sent to it. */
  maxResultBytes: z.number().int().positive().optional().catch(undefined),
});
export interface ModelSession {
  sessionId: string;
  turnId: string;
  cwd: string;
  transcript: string;
  harness?: 'claude' | 'codex';
  codexPolicy?: CodexModelPolicy;
  claudePermissionMode?: ClaudeWorkerPermissionMode;
}

const codexOptions = (native: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(native).filter(([key]) => key !== 'message'));
const held = (reason: string) => ({
  hookSpecificOutput: {
    hookEventName: 'PreToolUse',
    permissionDecision: 'deny',
    permissionDecisionReason: reason,
  },
});

/** What the offer tells the parent of its consent: the directories are the worker's own. */
function offerConsent(settings: ModelSettings, workerDirectories: readonly string[]) {
  const repositories = [...workerDirectories];
  return {
    version: settings.version,
    repository: settings.root,
    repositories,
    githubRepositories: modelGithubRepositories(repositories),
    routerOrigin: settings.routerOrigin,
    // As the consent record names them: a worker's web searches go to Exa.
    recipients: ['Tenjin', 'DeepSeek', 'Exa'],
  };
}

/** Native directories the worker will not get, so the parent can tell the person. */
function droppedNote(workspace: ClaudeWorkspace) {
  const dropped = savedClaudeWorkspace(workspace)?.droppedDirectories ?? [];
  return dropped.length
    ? {
        workspaceNote: `Not a directory now, so withheld from the worker: ${dropped.join(', ')}.`,
      }
    : {};
}

function nativeRepositories(job: ModelJob, workspace: ClaudeWorkspace | null): string[] | null {
  if (workspace)
    return [
      ...new Set([
        ...workspace.workingDirectories,
        ...workspace.readExceptions,
        ...workspace.writeExceptions,
      ]),
    ];
  const parsed = z
    .array(z.string().refine(isAbsolute))
    .min(1)
    .safeParse(job.decision.disclosureRepositories);
  return parsed.success ? parsed.data : null;
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

export class ModelHandoff {
  readonly store: ModelJobStore;
  readonly conversations: ModelConversationStore;
  constructor(private options: { dataDir: string; transport: ModelTransport }) {
    this.store = new ModelJobStore(options.dataDir);
    this.conversations = new ModelConversationStore(options.dataDir);
  }
  private async currentConsent(cwd: string) {
    const settings = await modelSettings(this.options.dataDir, cwd);
    return settings?.routerOrigin === this.options.transport.origin ? settings : null;
  }
  async captureCodex(
    session: ModelSession,
    callId: string,
    native: Record<string, unknown>,
    signal?: AbortSignal,
  ) {
    signal?.throwIfAborted();
    if (isModelWorkerProcess()) return null;
    const old = await this.store.pending(session.sessionId, session.turnId);
    if (old) {
      // A completed foreground worker is quiescent. Do not hold later native
      // calls behind an already resolved offer in this turn.
      if (old.state === 'native' || old.state === 'completed') return null;
      if (await this.store.nativeRetry(session.sessionId, session.turnId, native, codexOptions))
        return null;
      return held(
        'This turn already has a held or selected delegation. No additional child started. Cancel or finish it before continuing.',
      );
    }
    const settings = await this.currentConsent(session.cwd);
    if (
      !settings ||
      !session.codexPolicy ||
      typeof native.message !== 'string' ||
      native.fork_turns !== 'none' ||
      Object.keys(native).some((key) => !['message', 'task_name', 'fork_turns'].includes(key))
    )
      return null;
    const worker = await qualifiedModelWorker(
      session.cwd,
      'general-purpose',
      session.codexPolicy,
      this.options.dataDir,
      signal,
    );
    if (!worker?.instructionContext || !worker.disclosureRepositories?.length) return null;
    signal?.throwIfAborted();
    const job = await this.store.offer(
      {
        sessionId: session.sessionId,
        turnId: session.turnId,
        callId,
        root: settings.root,
        task: '',
        native,
        decision: {
          routerOrigin: this.options.transport.origin,
          instructionContext: worker.instructionContext,
          ...(worker.nativeSnapshot ? { nativeSnapshot: worker.nativeSnapshot } : {}),
          ...(worker.disclosureRepositories
            ? { disclosureRepositories: worker.disclosureRepositories }
            : {}),
        },
        capAtomic: settings.maxJobAtomic.toString(),
      },
      'awaiting_prompt',
      'turn',
    );
    return held(
      `The native child has not started. Submit the same complete plaintext assignment through the Tenjin subagent tool with delegation_id=${job.id} and task=<the full assignment text>. ${MODEL_BRIEF_GUIDANCE} Tenjin attaches parent context itself. This obtains a recommendation only. Accept its offer_id or keep native by retrying the original native call unchanged; it bypasses this hold once. Ignoring this launches neither worker.`,
    );
  }
  async submitCodex(session: ModelSession, id: string, task: string, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const settings = await this.currentConsent(session.cwd);
    if (
      !settings ||
      !session.codexPolicy ||
      !task.trim() ||
      Buffer.byteLength(task) > MODEL_CODEX_TASK_BYTES
    )
      return {
        action: 'native',
        reason:
          'Host policy or complete assignment unavailable; retry the original native call unchanged',
      };
    const worker = await qualifiedModelWorker(
      session.cwd,
      'general-purpose',
      session.codexPolicy,
      this.options.dataDir,
      signal,
    );
    const pending = await this.store.pending(session.sessionId, session.turnId);
    if (
      !worker?.instructionContext ||
      JSON.stringify(worker.nativeSnapshot) !== JSON.stringify(pending?.decision.nativeSnapshot) ||
      worker.instructionContext.fingerprint !==
        savedInstructionContext(pending?.decision.instructionContext)?.fingerprint
    )
      return {
        action: 'native',
        reason: 'Initial instructions changed or are unavailable; retry native unchanged',
      };
    signal?.throwIfAborted();
    const job = await this.store.submit(id, session.sessionId, session.turnId, task);
    if (!job) return { action: 'native', reason: 'Stale, changed or foreign delegation' };
    return this.route(session, job, signal);
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
  ) {
    signal?.throwIfAborted();
    const settings = await this.currentConsent(session.cwd);
    const reference = ownedModelReference(native, nativeTool);
    if (reference.owned) {
      if (reference.error || !reference.handle || !reference.task)
        return continuationRefusal(reference.error ?? 'Unavailable DeepSeek continuation');
      try {
        return await this.continue(
          session,
          callId,
          native,
          reference.handle,
          reference.task,
          signal,
        );
      } catch {
        return continuationRefusal('DeepSeek continuation is unavailable or interrupted');
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
      undefined,
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
    return this.route(session, job, signal);
  }
  private async continue(
    session: ModelSession,
    callId: string,
    native: Record<string, unknown>,
    handle: string,
    task: string,
    signal?: AbortSignal,
  ) {
    const { dataDir, transport } = this.options;
    const settings = await this.currentConsent(session.cwd);
    if (
      session.harness === 'codex' ||
      !settings ||
      isModelWorkerProcess() ||
      !claudeWorkerPermissionMode(session.claudePermissionMode)
    )
      return continuationRefusal('Current model consent or Claude permission mode is unavailable');
    const owner = {
      parentSessionId: session.sessionId,
      root: settings.root,
      configDir: claudeWorkerConfigDir(settings.root),
    };
    const conversation = await this.conversations.lookup(handle, owner);
    if (!conversation || !['idle', 'offered'].includes(conversation.state))
      return continuationRefusal('Worker history is foreign, unavailable or already active');
    const original = conversation.originalJob;
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
    await prepareClaudeWorkerSession(
      { resume: conversation.sdkSessionId, onSession: async () => {} },
      settings.root,
    );
    const worker = await qualifiedModelWorker(
      settings.root,
      String(original.native.subagent_type ?? 'general-purpose'),
      undefined,
      dataDir,
      signal,
      session.claudePermissionMode,
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
    const latest = await this.currentConsent(session.cwd);
    if (!latest || latest.root !== settings.root)
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
      native,
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
      label: 'DeepSeek V4.1 Flash 1017',
      routingFeeAtomic: '0',
      proxyFeePercent: 5,
      capAtomic: cap,
      reason: 'Continue the owned DeepSeek worker with its history and remaining original budget',
      parentPolicy: continuationPolicy,
      workspace: worker.claudeWorkspace,
      ...droppedNote(worker.claudeWorkspace),
      consent: offerConsent(latest, modelClaudeRepositories(worker.claudeWorkspace)),
      instruction:
        "Run this follow-up with subagent({offer_id}) as one call; to stop it, subagent({cancel: offer_id}). It charges no routing fee, and its inference is charged to the original job's remaining budget. Cancel it where the parentPolicy's binding restrictions forbid this text for a DeepSeek worker. Do not send a Tenjin handle to native tools. No assignment has been sent.",
    };
  }
  private async route(session: ModelSession, job: ModelJob, signal?: AbortSignal) {
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
    const instructions = savedInstructionContext(job.decision.instructionContext);
    const claudeWorkspace = savedClaudeWorkspace(job.decision.claudeWorkspace);
    if (session.harness !== 'codex' && !claudeWorkspace) return native('scope_not_covered');
    const disclosureRepositories = nativeRepositories(job, claudeWorkspace);
    if (!disclosureRepositories) return native('scope_not_covered');
    if (
      session.harness === 'codex' &&
      (!instructions || instructions.root !== settings.root || instructions.harness !== 'codex')
    )
      return native('worker_unqualified');
    const packet = await buildPromptPacket(
      session.transcript,
      session.sessionId,
      task,
      session.harness ?? 'claude',
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
    if (settings.maxJobAtomic < MODEL_MINIMUM_JOB_ATOMIC) return native('job_cap_too_low');
    const input = { ...admission, jobId: job.id };
    // What a consent read later must still say for this job, or the code that says why not.
    // A cap under the one the job was held at is the person lowering their per-call limit,
    // or naming a lower ceiling, in between: its own reason, not a scope one.
    const uncovered = (consent: ModelSettings): NoOffer['code'] | null =>
      consent.root !== job.root || consent.context !== settings.context
        ? 'scope_not_covered'
        : consent.maxJobAtomic < BigInt(job.capAtomic)
          ? 'job_cap_lowered'
          : null;
    let raw: unknown;
    // Consent read again just before the routing fee is paid: what it then lacked.
    let changedBeforeFee: NoOffer['code'] | null = null;
    try {
      signal?.throwIfAborted();
      // By its own id on Claude: another call of the session never stands in its way.
      const pending =
        session.harness === 'codex'
          ? await this.store.pending(session.sessionId, session.turnId)
          : await this.store.owned(job.id, session.sessionId);
      signal?.throwIfAborted();
      if (pending?.id !== job.id || !['routing', 'offered'].includes(pending.state))
        return native('superseded');
      if (instructions) await assertInstructionMetadataCurrent(instructions);
      const consent = await this.currentConsent(session.cwd);
      if (!consent) return native('no_consent');
      const changed = uncovered(consent);
      if (changed) return native(changed);
      signal?.throwIfAborted();
      raw =
        job.state === 'offered'
          ? job.decision
          : await transport.route(input, signal, async () => {
              if (claudeWorkspace) {
                const worker = await qualifiedModelWorker(
                  session.cwd,
                  String(job.native.subagent_type ?? 'general-purpose'),
                  undefined,
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
              } else if (instructions) await assertInstructionMetadataCurrent(instructions);
              const current = await this.currentConsent(session.cwd);
              changedBeforeFee = current ? uncovered(current) : 'no_consent';
              if (changedBeforeFee)
                throw new Error('Model routing consent or workspace scope changed');
            });
      signal?.throwIfAborted();
    } catch {
      await native(signal?.aborted ? 'interrupted' : (changedBeforeFee ?? 'route_error'));
      return { action: 'native', reason: 'Routing failed or interrupted; retry native unchanged' };
    }
    const parsed = modelOfferSchema.safeParse(raw);
    if (
      !parsed.success ||
      parsed.data.jobId !== job.id ||
      BigInt(parsed.data.routingFeeAtomic) > MODEL_ROUTING_FEE_CEILING_ATOMIC
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
      routerOrigin: transport.origin,
      ...(instructions ? { instructionContext: instructions } : {}),
      ...(job.decision.nativeSnapshot ? { nativeSnapshot: job.decision.nativeSnapshot } : {}),
      ...(disclosureRepositories ? { disclosureRepositories } : {}),
      ...(claudeWorkspace ? { claudeWorkspace } : {}),
      ...(job.decision.windowsWorker ? { windowsWorker: job.decision.windowsWorker } : {}),
      ...(session.harness !== 'codex'
        ? { claudePermissionMode: job.decision.claudePermissionMode }
        : {}),
    });
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
      ...(claudeWorkspace
        ? { workspace: claudeWorkspace, ...droppedNote(claudeWorkspace) }
        : {
            workspace: {
              root: settings.root,
              workingDirectories: session.codexPolicy?.parent?.runtimeWorkspaceRoots ?? [
                settings.root,
              ],
            },
          }),
      consent: offerConsent(consent, disclosureRepositories ?? []),
      instruction: `The user has installed Tenjin and enabled DeepSeek routing. Routing goes through Tenjin/TypeSafe; after acceptance, the assignment, applicable instructions and tool results may reach Tenjin/DeepSeek, and the worker's web searches go to Exa. Accept this qualified recommendation with subagent({offer_id}) unless the complete assignment or binding instructions require native work or forbid disclosure. ${
        job.nativeTool
          ? `To keep it native, send the original ${job.nativeTool} call again unchanged; that repeat costs no second routing fee.`
          : 'Otherwise retry the original native Agent call unchanged.'
      } This offer is for this one call: each held call gets its own offer, its own offer_id and its own routing fee, within the person's spend limits and each job's cap.${
        session.harness === 'claude'
          ? ' When accepting several offers together, put only the chosen ids into one subagent({offer_ids: [id1, id2, ...]}) call so their workers run in parallel. Claude Code runs separate acceptance calls in order.'
          : ''
      }${
        nativeBackground(job.native) === true
          ? " This call asked to run in the background, so its worker does: the accept call returns at once, and the worker's result arrives later as a notification, as a native background agent's does. Sent again unchanged, the call runs natively in the background."
          : ''
      } Do either as one call with no comment on the choice: the call itself shows it. You retain the final veto. No assignment has been sent to a worker.`,
      ...(nativeBackground(job.native) === true ? { background: true } : {}),
    };
  }
}
