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
  constructor(private options: { dataDir: string; transport: ModelTransport }) {
    this.store = new ModelJobStore(options.dataDir);
  }
  async captureCodex(
    session: ModelSession,
    callId: string,
    native: Record<string, unknown>,
    signal?: AbortSignal,
  ) {
    signal?.throwIfAborted();
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
  ) {
    signal?.throwIfAborted();
    const { dataDir, transport } = this.options;
    const settings = await modelSettings(dataDir, session.cwd);
    if (
      !settings ||
      settings.routerOrigin !== transport.origin ||
      process.env.TENJIN_MODEL_WORKER === '1'
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
    );
    if (!worker) return { action: 'native' };
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
        decision: { routerOrigin: transport.origin },
        capAtomic: settings.maxJobAtomic.toString(),
      },
      'routing',
    );
    return this.route(session, job, signal);
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
    await this.store.decided(job.id, {
      ...parsed.data,
      routerOrigin: transport.origin,
      ...(instructions ? { instructionContext: instructions } : {}),
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
      instruction:
        'No worker started. Accept with subagent({offer_id}) or retry the original native Agent call unchanged. You retain the final veto.',
    };
  }
}
