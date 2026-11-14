import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { withFileLock } from '../lib/lock';
import { canonicalHash } from '../lib/request-schema';
import { readJsonFile, writePrivate } from './store-files';

const jobSchema = z.object({
  id: z.uuid(),
  sessionId: z.string(),
  turnId: z.string(),
  callId: z.string(),
  root: z.string(),
  task: z.string(),
  native: z.record(z.string(), z.unknown()),
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
      await writePrivate(this.path(job.id), JSON.stringify(job));
      await writePrivate(
        this.window(input.sessionId, input.turnId),
        JSON.stringify({ id: job.id }),
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
  ): Promise<boolean> {
    return this.locked(async () => {
      const window = await readJsonFile(this.window(session, turn), 1000);
      if (typeof window?.id !== 'string') return false;
      const job = await this.read(window.id);
      if (
        !job ||
        !['awaiting_prompt', 'offered', 'unknown', 'cancelled'].includes(job.state) ||
        canonicalHash(comparable(job.native)) !== canonicalHash(comparable(native))
      )
        return false;
      job.state = 'native';
      await writePrivate(this.path(job.id), JSON.stringify(job));
      return true;
    });
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
