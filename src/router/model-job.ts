import { randomUUID } from 'node:crypto';
import { lstat, mkdir, opendir } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { pidAlive, withFileLock } from '../lib/lock';
import { canonicalHash } from '../lib/request-schema';
import { WORKER_WALL_MS } from './model-worker-control';
import { readJsonFile, sweep, writePrivate } from './store-files';

const jobSchema = z.object({
  id: z.uuid(),
  sessionId: z.string(),
  turnId: z.string(),
  callId: z.string(),
  root: z.string(),
  task: z.string(),
  native: z.record(z.string(), z.unknown()),
  nativeTool: z.enum(['Agent', 'Task']).optional(),
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
  /** The process that accepted the job and runs its worker, and when. */
  runner: z.object({ pid: z.number().int(), acceptedAt: z.number() }).optional(),
});
export type ModelJob = z.infer<typeof jobSchema>;
export const modelJobSchema = jobSchema;

/**
 * A model store's lock. Its holder can be killed with the session mid-update,
 * and a lock nothing takes over would then time out every later operation.
 */
export const modelLock = <T>(path: string, fn: () => Promise<T>): Promise<T> =>
  withFileLock(path, fn, { takeOverDead: true });

/** Local job, conversation and budget records are removed this long after their last write. */
export const MODEL_RECORD_TTL_MS = 7 * 24 * 60 * 60_000;
/** No run is still going this long after its accept: the wall limit, and time to drain. */
const RUN_OVER_MS = WORKER_WALL_MS + 5 * 60_000;

/** What a later accept of a worker that died with its process answers. */
export const STRANDED_HANDBACK = {
  status: 'unknown',
  stopReason: { kind: 'interrupted', reason: 'session_ended' },
  nextStep:
    'This worker stopped when its session or Tenjin process ended, as a native subagent does. It cannot be continued. If the work is still needed, start a fresh assignment with the needed context.',
} as const;

/** Removes every model record file not written for {@link MODEL_RECORD_TTL_MS}. Never throws. */
export async function sweepModelRecords(dataDir: string, now = Date.now()): Promise<void> {
  const old = async (_name: string, path: string) =>
    now - (await lstat(path)).mtimeMs > MODEL_RECORD_TTL_MS;
  for (const store of ['model-jobs', 'model-conversations'])
    await sweep(join(dataDir, store), old, { limit: 50_000 });
}
type NewJob = Omit<ModelJob, 'id' | 'state' | 'expiresAt'>;
/** A held call whose offer never ran to completion: its unchanged repeat keeps it native. */
const REPEATABLE: readonly ModelJob['state'][] = ['offered', 'cancelled', 'unknown'];

/**
 * What "unchanged" means for a repeated Agent call. Every field counts and key
 * order does not. Whitespace around a top-level string is ignored; whitespace
 * inside it is not. A field set to null or false, and `subagent_type:
 * "general-purpose"`, mean the same as leaving the field out.
 */
function repeatKey(native: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(native).flatMap(([key, raw]) => {
      const value = typeof raw === 'string' ? raw.trim() : raw;
      return value === null ||
        value === false ||
        (key === 'subagent_type' && value === 'general-purpose')
        ? []
        : [[key, value]];
    }),
  );
}

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
  /** The latest held Claude call with this content in this session and root, in any turn. */
  private repeatPath(
    sessionId: string,
    root: string,
    tool: string,
    native: Record<string, unknown>,
  ) {
    return join(
      this.dir,
      `repeat-${canonicalHash({ sessionId, root, tool, native: repeatKey(native) })}.json`,
    );
  }
  private async locked<T>(fn: () => Promise<T>) {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    return modelLock(join(this.dir, 'lock'), fn);
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
        JSON.stringify({ id: job.id }),
      );
      if (input.nativeTool)
        await writePrivate(
          this.repeatPath(input.sessionId, input.root, input.nativeTool, input.native),
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
  /**
   * A job by its own id, in any turn and from any process, for the session
   * that owns it. Another session gets nothing, as for an id that never was.
   */
  async owned(id: string, session: string): Promise<ModelJob | null> {
    if (!z.uuid().safeParse(id).success) return null;
    const job = await this.read(id);
    return job?.sessionId === session ? job : null;
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
    try {
      await lstat(this.window(session, turn));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
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
  /** Every record still `running` or `cancelling`, whichever session owns it. Never throws. */
  async unfinished(): Promise<ModelJob[]> {
    const found: ModelJob[] = [];
    try {
      let seen = 0;
      for await (const entry of await opendir(this.dir)) {
        if (++seen > 50_000) break;
        const id = /^(.+)\.json$/.exec(entry.name)?.[1];
        if (!entry.isFile() || !id || !z.uuid().safeParse(id).success) continue;
        const job = await this.read(id);
        if (job && ['running', 'cancelling'].includes(job.state)) found.push(job);
      }
    } catch {
      // No store yet, or not readable: nothing to repair.
    }
    return found;
  }
  /** Once, on disk. Without `turn` the offer is accepted from any turn of its session. */
  async accept(id: string, session: string, turn?: string): Promise<ModelJob | null> {
    return this.locked(async () => {
      const job = await this.read(id);
      if (
        !job ||
        job.sessionId !== session ||
        (turn !== undefined && job.turnId !== turn) ||
        job.expiresAt <= Date.now() ||
        job.state !== 'offered'
      )
        return null;
      job.state = 'running';
      job.runner = { pid: process.pid, acceptedAt: Date.now() };
      await writePrivate(this.path(id), JSON.stringify(job));
      return job;
    });
  }
  /**
   * Ends a record its process left `running`: that process is gone, it is this
   * process (which the caller knows runs no such worker), or the accept is
   * older than any run. The record becomes `unknown` and is returned. Null
   * while another live process may still be running the worker.
   */
  async strand(
    id: string,
    o: { isAlive?: (pid: number) => boolean; now?: number } = {},
  ): Promise<ModelJob | null> {
    return this.locked(async () => {
      const job = await this.read(id);
      if (!job || !['running', 'cancelling'].includes(job.state)) return job;
      const { runner } = job;
      const over = (o.now ?? Date.now()) - (runner?.acceptedAt ?? job.expiresAt) > RUN_OVER_MS;
      const gone = runner && (runner.pid === process.pid || !(o.isAlive ?? pidAlive)(runner.pid));
      if (!over && !gone) return null;
      const ended: ModelJob = {
        ...job,
        state: 'unknown',
        result: JSON.stringify(STRANDED_HANDBACK),
      };
      await writePrivate(this.path(id), JSON.stringify(ended));
      return ended;
    });
  }
  /** Codex: the held call retried unchanged in its own turn passes the hold once. */
  async nativeRetry(
    session: string,
    turn: string,
    native: Record<string, unknown>,
    comparable: (value: Record<string, unknown>) => unknown,
  ): Promise<boolean> {
    return this.locked(async () => {
      const window = await readJsonFile(this.window(session, turn), 1000);
      if (typeof window?.id !== 'string') return false;
      const job = await this.read(window.id);
      if (
        !job ||
        !['awaiting_prompt', ...REPEATABLE].includes(job.state) ||
        canonicalHash(comparable(job.native)) !== canonicalHash(comparable(native))
      )
        return false;
      await writePrivate(this.path(job.id), JSON.stringify({ ...job, state: 'native' }));
      return true;
    });
  }
  /**
   * Claude: the parent keeps an offered call native by sending it again
   * unchanged. Matched by content, never by call ID, so the host's permission
   * review sees the call that runs. Once per offer: a match ends the offer, so
   * it cannot be accepted after, and a later repeat is a new call. It matches
   * in the same session and workspace root, for the rest of the offer's turn,
   * and in a later turn until the offer expires.
   */
  async nativeRepeat(
    session: string,
    turn: string,
    root: string,
    tool: 'Agent' | 'Task',
    native: Record<string, unknown>,
  ): Promise<boolean> {
    return this.locked(async () => {
      const index = await readJsonFile(this.repeatPath(session, root, tool, native), 1000);
      const job = z.uuid().safeParse(index?.id).success
        ? await this.read(index!.id as string)
        : null;
      if (
        !job ||
        job.sessionId !== session ||
        job.root !== root ||
        job.nativeTool !== tool ||
        !REPEATABLE.includes(job.state) ||
        (job.turnId !== turn && job.expiresAt <= Date.now()) ||
        canonicalHash(repeatKey(job.native)) !== canonicalHash(repeatKey(native))
      )
        return false;
      await writePrivate(this.path(job.id), JSON.stringify({ ...job, state: 'native' }));
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
