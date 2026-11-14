import { qualifiedModelWorker } from './model-worker';
import { z } from 'zod';
import { mask } from '../lib/redact';
import { buildPromptPacket } from './context';
import { ModelJobStore } from './model-job';
import { modelSettings } from './model-settings';
import type { ModelTransport } from './model-transport';
import type { CodexModelPolicy } from './codex-model-gates';
import type { ModelJob } from './model-job';
import { assertInstructionMetadataCurrent, savedInstructionContext } from './model-instructions';
import { claudeWorkerPermissionMode, type ClaudeWorkerPermissionMode } from './claude-model-policy';
import parentPolicy from './model-parent-policy.json';
import { ModelConversationStore } from './model-conversations';
import { claudeWorkerConfigDir, prepareClaudeWorkerSession } from './claude-worker-session';
import {
  claudeWorkspaceCovered,
  savedClaudeWorkspace,
  sameClaudeWorkspace,
} from './claude-workspace';
import {
  continuationRefusal,
  ownedModelReference,
  type ModelNativeTool,
} from './model-continuation';

const continuationPolicy = parentPolicy.replace(
  'Pass offer_id only to accept; otherwise retry the original native Agent call unchanged.',
  'Pass offer_id only to accept. Otherwise cancel this continuation. Never retry a Tenjin worker handle through native tools; a fresh native assignment requires its own complete context.',
);

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

export class ModelHandoff {
  readonly store: ModelJobStore;
  readonly conversations: ModelConversationStore;
  constructor(private options: { dataDir: string; transport: ModelTransport }) {
    this.store = new ModelJobStore(options.dataDir);
    this.conversations = new ModelConversationStore(options.dataDir);
  }
  async captureCodex(
    session: ModelSession,
    callId: string,
    native: Record<string, unknown>,
    signal?: AbortSignal,
  ) {
    signal?.throwIfAborted();
    if (process.env.TENJIN_MODEL_WORKER === '1') return null;
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
    const settings = await modelSettings(this.options.dataDir, session.cwd);
    if (
      !settings ||
      settings.routerOrigin !== this.options.transport.origin ||
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
    if (!worker?.instructionContext) return null;
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
        },
        capAtomic: settings.maxJobAtomic.toString(),
      },
      'awaiting_prompt',
    );
    return held(
      `The native child has NOT started. Submit the SAME COMPLETE PLAINTEXT assignment through the Tenjin subagent tool with delegation_id=${job.id} and task=<the full assignment text>. ${MODEL_BRIEF_GUIDANCE} Tenjin attaches parent context itself. This obtains a recommendation only. Accept its offer_id or keep native by retrying the original native call unchanged; it bypasses this hold once. Ignoring this launches neither worker.`,
    );
  }
  async submitCodex(session: ModelSession, id: string, task: string, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const settings = await modelSettings(this.options.dataDir, session.cwd);
    if (
      !settings ||
      settings.routerOrigin !== this.options.transport.origin ||
      !session.codexPolicy ||
      !task.trim() ||
      Buffer.byteLength(task) > 16000
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
  async capture(
    session: ModelSession,
    callId: string,
    native: Record<string, unknown>,
    signal?: AbortSignal,
    nativeTool: ModelNativeTool = 'Agent',
  ) {
    signal?.throwIfAborted();
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
    if (nativeTool === 'SendMessage') return { action: 'native' };
    const { dataDir, transport } = this.options;
    const settings = await modelSettings(dataDir, session.cwd);
    if (
      !settings ||
      settings.routerOrigin !== transport.origin ||
      process.env.TENJIN_MODEL_WORKER === '1' ||
      !claudeWorkerPermissionMode(session.claudePermissionMode)
    )
      return { action: 'native' };
    signal?.throwIfAborted();
    if (await this.store.nativeRetry(session.sessionId, session.turnId, native))
      return { action: 'native' };
    const worker = await qualifiedModelWorker(
      session.cwd,
      String(native.subagent_type ?? 'general-purpose'),
      undefined,
      dataDir,
      signal,
      session.claudePermissionMode,
    );
    if (!worker?.claudeWorkspace || !claudeWorkerPermissionMode(session.claudePermissionMode))
      return { action: 'native' };
    const task = native.prompt;
    if (
      typeof task !== 'string' ||
      !task ||
      native.agentId ||
      native.agent_id ||
      native.run_in_background ||
      native.resume ||
      native.name ||
      native.team_name ||
      native.isolation ||
      (native.subagent_type !== undefined &&
        !['general-purpose', 'Explore'].includes(String(native.subagent_type)))
    )
      return { action: 'native' };
    const job = await this.store.offer(
      {
        sessionId: session.sessionId,
        turnId: session.turnId,
        callId,
        root: settings.root,
        task,
        native,
        decision: {
          routerOrigin: transport.origin,
          claudePermissionMode: session.claudePermissionMode,
          claudeWorkspace: worker.claudeWorkspace,
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
    const settings = await modelSettings(dataDir, session.cwd);
    if (
      session.harness === 'codex' ||
      !settings ||
      settings.routerOrigin !== transport.origin ||
      process.env.TENJIN_MODEL_WORKER === '1' ||
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
      !originalWorkspace ||
      !sameClaudeWorkspace(originalWorkspace, worker.claudeWorkspace)
    )
      return continuationRefusal(
        'Current native workspace scope changed or its original disclosure is unavailable',
      );
    signal?.throwIfAborted();
    const latest = await modelSettings(dataDir, session.cwd);
    if (
      !latest ||
      latest.root !== settings.root ||
      latest.routerOrigin !== transport.origin ||
      !claudeWorkspaceCovered(originalWorkspace, latest.repositories)
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
      await this.store.fence(session.sessionId, session.turnId);
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
      consent: {
        version: 2,
        repository: settings.root,
        repositories: latest.repositories,
        routerOrigin: settings.routerOrigin,
        recipients: ['Tenjin', 'DeepSeek'],
      },
      instruction:
        'Assess the complete follow-up against the full parent policy and current repository constraints. Accept with offer_id only if it remains suitable for this DeepSeek worker. You retain the final veto. This reuses the original history and budget, with no new routing fee. Otherwise cancel the offer; do not send a Tenjin handle to native tools. No worker started.',
    };
  }
  private async route(session: ModelSession, job: ModelJob, signal?: AbortSignal) {
    const { dataDir, transport } = this.options;
    const native = async () => {
      await this.store.decided(job.id, { action: 'native' });
      return { action: 'native' };
    };
    const settings = await modelSettings(dataDir, session.cwd);
    if (!settings || settings.root !== job.root || settings.routerOrigin !== transport.origin)
      return native();
    const task = job.task;
    const instructions = savedInstructionContext(job.decision.instructionContext);
    const claudeWorkspace = savedClaudeWorkspace(job.decision.claudeWorkspace);
    if (
      session.harness !== 'codex' &&
      (!claudeWorkspace || !claudeWorkspaceCovered(claudeWorkspace, settings.repositories))
    )
      return native();
    if (
      session.harness === 'codex' &&
      (!instructions || instructions.root !== settings.root || instructions.harness !== 'codex')
    )
      return native();
    const packet = await buildPromptPacket(
      session.transcript,
      session.sessionId,
      task,
      session.harness ?? 'claude',
    );
    if (packet.historyStatus !== 'ok' || !packet.history.length) return native();
    const history =
      settings.context === 'turn'
        ? packet.history.slice(Math.max(0, packet.history.map((m) => m.role).lastIndexOf('user')))
        : packet.history;
    const parentContext = history.slice(-6).map((m) => ({ role: m.role, content: mask(m.text) }));
    const admission = {
      schemaVersion: 1,
      consent: true,
      accepts: ['deepseek-flash'],
      subagentTask: mask(task),
      parentContext,
      expectedSpendAtomic: '20000',
    };
    if (Buffer.byteLength(JSON.stringify(admission)) + 64 > 16384 || settings.maxJobAtomic < 3000n)
      return native();
    const input = { ...admission, jobId: job.id };
    let raw: unknown;
    try {
      signal?.throwIfAborted();
      const pending = await this.store.pending(session.sessionId, session.turnId);
      signal?.throwIfAborted();
      if (pending?.id !== job.id || !['routing', 'offered'].includes(pending.state))
        return native();
      if (instructions) await assertInstructionMetadataCurrent(instructions);
      signal?.throwIfAborted();
      raw = job.state === 'offered' ? job.decision : await transport.route(input, signal);
      signal?.throwIfAborted();
    } catch {
      await this.store.decided(job.id, { action: 'native' });
      return { action: 'native', reason: 'Routing failed or interrupted; retry native unchanged' };
    }
    const parsed = modelOfferSchema.safeParse(raw);
    if (
      !parsed.success ||
      parsed.data.jobId !== job.id ||
      BigInt(parsed.data.routingFeeAtomic) > 3000n
    ) {
      await this.store.decided(job.id, { action: 'native' });
      return { action: 'native' };
    }
    const consent = await modelSettings(dataDir, session.cwd);
    if (
      !consent ||
      consent.root !== job.root ||
      consent.routerOrigin !== transport.origin ||
      consent.maxJobAtomic < BigInt(job.capAtomic) ||
      (claudeWorkspace && !claudeWorkspaceCovered(claudeWorkspace, consent.repositories))
    )
      return native();
    await this.store.decided(job.id, {
      ...parsed.data,
      routerOrigin: transport.origin,
      ...(instructions ? { instructionContext: instructions } : {}),
      ...(job.decision.nativeSnapshot ? { nativeSnapshot: job.decision.nativeSnapshot } : {}),
      ...(claudeWorkspace ? { claudeWorkspace } : {}),
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
        ? { workspace: claudeWorkspace }
        : {
            workspace: {
              root: settings.root,
              workingDirectories: session.codexPolicy?.parent?.runtimeWorkspaceRoots ?? [
                settings.root,
              ],
            },
          }),
      consent: {
        version: 2,
        repository: consent.root,
        repositories: consent.repositories,
        routerOrigin: consent.routerOrigin,
        recipients: ['Tenjin', 'DeepSeek'],
      },
      instruction:
        'Routing goes through Tenjin/TypeSafe; after acceptance, the assignment, applicable instructions and tool results may reach Tenjin/DeepSeek. Accept this qualified recommendation with subagent({offer_id}) unless the complete assignment or binding instructions require native work or forbid disclosure. Otherwise retry the original native Agent call unchanged. You retain the final veto. No worker started.',
    };
  }
}
