import { randomUUID } from 'node:crypto';
import { lstat, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { withFileLock } from '../lib/lock';
import { canonicalHash } from '../lib/request-schema';
import { readJsonFile, writePrivate } from './store-files';
import { nativeRetryReference } from './model-native-retry';

const jobSchema = z.object({
  id: z.uuid(),
  sessionId: z.string(),
  turnId: z.string(),
  callId: z.string(),
  root: z.string(),
  task: z.string(),
  native: z.record(z.string(), z.unknown()),
  nativeTool: z.enum(['Agent', 'Task']).optional(),
  nativeReplaySupported: z.literal(true).optional(),
  nativeReplay: z
    .object({
      callId: z.string().min(1),
      tool: z.enum(['Agent', 'Task']),
      inputHash: z.string().regex(/^[0-9a-f]{64}$/),
      epoch: z.uuid(),
      consumed: z.boolean(),
    })
    .optional(),
  decision: z.record(z.string(), z.unknown()),
  capAtomic: z.string().regex(/^\d+$/),
  state: z.enum([
    'awaiting_prompt',
    'routing',
    'offered',
    'native',
    'running',
    'cancelling',
    'completed',
    'cancelled',
    'unknown',
  ]),
  expiresAt: z.number(),
  result: z.string().optional(),
});
export type ModelJob = z.infer<typeof jobSchema>;
export const modelJobSchema = jobSchema;
type NewJob = Omit<ModelJob, 'id' | 'state' | 'expiresAt'>;

/** One active foreground delegation per root turn; immutable calls, atomic selection. */
export class ModelJobStore {
  private dir: string;
  constructor(dataDir: string) {
    this.dir = join(dataDir, 'model-jobs');
  }
  private path(id: string) {
    if (!z.uuid().safeParse(id).success) throw new Error('Invalid model job');
    return join(this.dir, `${id}.json`);
  }
  private window(sessionId: string, turnId: string) {
    return join(this.dir, `window-${canonicalHash({ sessionId, turnId })}.json`);
  }
  private replayPath(callId: string) {
    return join(this.dir, `replay-${canonicalHash({ callId })}.json`);
  }
  private async replayIndex(callId: string) {
    const path = this.replayPath(callId);
    try {
      await lstat(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
    return (await readJsonFile(path, 1000)) ?? {};
  }
  private async locked<T>(fn: () => Promise<T>) {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    return withFileLock(join(this.dir, 'lock'), fn);
  }
  private async read(id: string) {
    const raw = await readJsonFile(this.path(id), 1_000_000);
    const p = jobSchema.safeParse(raw);
    return p.success ? p.data : null;
  }
  async offer(
    input: NewJob,
    state: 'awaiting_prompt' | 'routing' | 'offered' = 'offered',
  ): Promise<ModelJob> {
    return this.locked(async () => {
      const previous = await readJsonFile(this.window(input.sessionId, input.turnId), 1000);
      if (typeof previous?.id === 'string') {
        const old = await this.read(previous.id);
        if (
          old &&
          old.state !== 'native' &&
          old.state !== 'completed' &&
          (old.expiresAt > Date.now() || ['running', 'cancelling'].includes(old.state))
        ) {
          if (
            old.callId === input.callId &&
            canonicalHash(old.native) === canonicalHash(input.native)
          )
            return old;
          throw new Error('An unresolved delegation already owns this turn');
        }
      }
      const job: ModelJob = {
        ...input,
        id: randomUUID(),
        state,
        expiresAt: Date.now() + 15 * 60_000,
      };
      const serialized = JSON.stringify(job);
      if (Buffer.byteLength(serialized) > 1_000_000)
        throw new Error('Complete model assignment exceeds private record size limit');
      await writePrivate(this.path(job.id), serialized);
      await writePrivate(
        this.window(input.sessionId, input.turnId),
        JSON.stringify({
          id: job.id,
          replayEpoch: z.uuid().safeParse(previous?.replayEpoch).success
            ? previous!.replayEpoch
            : randomUUID(),
        }),
      );
      return job;
    });
  }
  async pending(session: string, turn: string): Promise<ModelJob | null> {
    const window = await readJsonFile(this.window(session, turn), 1000);
    if (typeof window?.id !== 'string') return null;
    const job = await this.read(window.id);
    return job?.sessionId === session && job.turnId === turn ? job : null;
  }
  /** Bind the one plaintext resubmission before paying. Replays must be exact. */
  async submit(id: string, session: string, turn: string, task: string): Promise<ModelJob | null> {
    return this.locked(async () => {
      const job = await this.read(id);
      if (!job || job.sessionId !== session || job.turnId !== turn || job.expiresAt <= Date.now())
        return null;
      if (job.state !== 'awaiting_prompt')
        return ['routing', 'offered'].includes(job.state) && job.task === task ? job : null;
      job.task = task;
      job.state = 'routing';
      await writePrivate(this.path(id), JSON.stringify(job));
      return job;
    });
  }
  /** Fence selection first. A running worker must be drained by its owner separately. */
  async fence(
    session: string,
    turn: string,
    state: 'cancelling' | 'cancelled' = 'cancelled',
  ): Promise<void> {
    return this.locked(async () => {
      const path = this.window(session, turn);
      const window = await readJsonFile(path, 1000);
      await writePrivate(
        path,
        JSON.stringify({
          ...(typeof window?.id === 'string' ? { id: window.id } : {}),
          replayEpoch: randomUUID(),
        }),
      );
      const job = await this.pending(session, turn);
      if (!job || ['native', 'completed', 'cancelled', 'unknown'].includes(job.state)) return;
      await writePrivate(this.path(job.id), JSON.stringify({ ...job, state }));
    });
  }
  async decided(id: string, decision: Record<string, unknown>) {
    return this.locked(async () => {
      const job = await this.read(id);
      if (!job || job.state !== 'routing') return;
      await writePrivate(
        this.path(id),
        JSON.stringify({
          ...job,
          decision,
          state: decision.action === 'model' ? 'offered' : 'native',
        }),
      );
    });
  }
  async accept(id: string, session: string, turn: string): Promise<ModelJob | null> {
    return this.locked(async () => {
      const job = await this.read(id);
      if (
        !job ||
        job.sessionId !== session ||
        job.turnId !== turn ||
        job.expiresAt <= Date.now() ||
        job.state !== 'offered'
      )
        return null;
      job.state = 'running';
      await writePrivate(this.path(id), JSON.stringify(job));
      return job;
    });
  }
  async nativeRetry(
    session: string,
    turn: string,
    native: Record<string, unknown>,
    comparable: (value: Record<string, unknown>) => unknown = (value) => value,
    tool?: 'Agent' | 'Task',
  ): Promise<boolean> {
    return this.locked(async () => {
      const window = await readJsonFile(this.window(session, turn), 1000);
      if (typeof window?.id !== 'string') return false;
      const job = await this.read(window.id);
      const selectedRetry =
        job?.state === 'native' &&
        job.sessionId === session &&
        job.turnId === turn &&
        job.nativeReplay !== undefined &&
        !job.nativeReplay.consumed &&
        tool !== undefined &&
        job.nativeTool === tool &&
        job.nativeReplay.tool === tool &&
        canonicalHash(job.native) === job.nativeReplay.inputHash;
      if (
        !job ||
        (!selectedRetry &&
          !['awaiting_prompt', 'offered', 'unknown', 'cancelled'].includes(job.state)) ||
        canonicalHash(comparable(job.native)) !== canonicalHash(comparable(native))
      )
        return false;
      job.state = 'native';
      if (selectedRetry) job.nativeReplay!.consumed = true;
      await writePrivate(this.path(job.id), JSON.stringify(job));
      return true;
    });
  }
  /** Select the saved initial native call once, competing with acceptance under the same lock. */
  async chooseNative(
    id: string,
    session: string,
    turn: string,
    root: string,
    tool: 'Agent' | 'Task',
    replayCallId: string,
    profile?: string,
  ): Promise<ModelJob | null> {
    return this.locked(async () => {
      const job = await this.pending(session, turn);
      const window = await readJsonFile(this.window(session, turn), 1000);
      if (
        !job ||
        job.id !== id ||
        job.root !== root ||
        job.nativeTool !== tool ||
        job.nativeReplaySupported !== true ||
        job.state !== 'offered' ||
        !replayCallId ||
        !z.uuid().safeParse(window?.replayEpoch).success ||
        job.expiresAt <= Date.now() ||
        job.decision.workerHandle !== undefined ||
        job.native.resume !== undefined ||
        typeof job.native.prompt !== 'string' ||
        !job.native.prompt.trim() ||
        nativeRetryReference(job.native, tool).owned ||
        ['tool', 'tool_use_id', 'agentId'].some((key) => key in job.native) ||
        (profile !== undefined && profile !== (job.native.subagent_type ?? 'general-purpose'))
      )
        return null;
      if (await this.replayIndex(replayCallId)) return null;
      const selected = {
        ...job,
        state: 'native' as const,
        nativeReplay: {
          callId: replayCallId,
          tool,
          inputHash: canonicalHash(job.native),
          epoch: window!.replayEpoch as string,
          consumed: false,
        },
      };
      await writePrivate(this.path(job.id), JSON.stringify(selected));
      await writePrivate(this.replayPath(replayCallId), JSON.stringify({ id: job.id }));
      return selected;
    });
  }
  /** Recognize saved call IDs before any failure path can fall through natively. */
  async ownsNativeReplay(session: string, turn: string, callId: string): Promise<boolean> {
    try {
      if (await this.replayIndex(callId)) return true;
      return (await this.pending(session, turn))?.nativeReplay?.callId === callId;
    } catch {
      return true;
    }
  }

  /** The expanded call still crosses every host hook; this only prevents another Tenjin lookup. */
  async consumeNativeReplay(
    session: string,
    turn: string,
    root: string,
    tool: 'Agent' | 'Task' | 'SendMessage',
    callId: string,
    native: Record<string, unknown>,
  ): Promise<'allow' | 'refused' | 'none'> {
    try {
      return await this.locked(async () => {
        if (!callId) return 'refused';
        const index = await this.replayIndex(callId);
        if (!index) {
          const pending = await this.pending(session, turn);
          return pending?.nativeReplay?.callId === callId ? 'refused' : 'none';
        }
        if (typeof index.id !== 'string') return 'refused';
        const job = await this.read(index.id);
        const replay = job?.nativeReplay;
        const window = await readJsonFile(this.window(session, turn), 1000);
        if (
          !job ||
          job.sessionId !== session ||
          job.turnId !== turn ||
          job.root !== root ||
          job.nativeTool !== tool ||
          job.state !== 'native' ||
          job.expiresAt <= Date.now() ||
          !replay ||
          !z.uuid().safeParse(window?.replayEpoch).success ||
          replay.epoch !== window?.replayEpoch ||
          replay.tool !== tool ||
          replay.callId !== callId ||
          replay.consumed ||
          canonicalHash(job.native) !== replay.inputHash ||
          canonicalHash(native) !== replay.inputHash
        )
          return 'refused';
        await writePrivate(
          this.path(job.id),
          JSON.stringify({ ...job, nativeReplay: { ...replay, consumed: true } }),
        );
        return 'allow';
      });
    } catch {
      return 'refused';
    }
  }
  async finish(id: string, state: 'completed' | 'cancelled' | 'unknown', result?: string) {
    return this.locked(async () => {
      const job = await this.read(id);
      if (!job || !['running', 'cancelling'].includes(job.state)) return;
      await writePrivate(
        this.path(id),
        JSON.stringify({ ...job, state, ...(result ? { result } : {}) }),
      );
    });
  }
}
