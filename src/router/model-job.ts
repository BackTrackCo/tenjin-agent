import { randomUUID } from 'node:crypto';
import { lstat, mkdir, opendir } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { pidAlive, withFileLock } from '../lib/lock';
import { canonicalHash } from '../lib/request-schema';
import { WORKER_ENDS } from './model-worker-control';
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
  /** The parent's model request that made the call, as the host numbers it. */
  step: z.string().optional(),
  /** The agent id of the native subagent that made the call and receives its offer; absent for the main loop. */
  caller: z.string().optional(),
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

/** What a later accept of a worker that died with its process answers. */
export const STRANDED_HANDBACK = {
  status: 'unknown',
  endedBy: 'session_ended',
  ended: WORKER_ENDS.session_ended,
  stopReason: { kind: 'interrupted', reason: 'session_ended' },
  nextStep:
    'This worker stopped when its session or Tenjin process ended, as a native subagent does. It cannot be continued. If the work is still needed, start a fresh assignment with the needed context.',
} as const;

/**
 * Removes every model record file not written for {@link MODEL_RECORD_TTL_MS}, EXCEPT the files
 * of a job that is still live: a job has no wall time, so one that waits for a permission
 * answer for days has an old record that its run still needs (its budget file holds what it
 * has spent). A live job is a record still `running` or `cancelling` (the caller ends the
 * records of dead processes first, see `strand`), and every file named for its id is kept.
 * Age alone never decides for such a job. Never throws.
 */
export async function sweepModelRecords(dataDir: string, now = Date.now()): Promise<void> {
  // A running continuation spends from its original job's files (budget, record, result,
  // conversation), which carry the original's id and the handle's, not its own.
  const live = new Set<string>();
  const uuid = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
  for (const job of await new ModelJobStore(dataDir).unfinished().catch(() => [] as ModelJob[])) {
    live.add(job.id.toLowerCase());
    for (const named of [job.decision.jobId, job.decision.workerHandle]) {
      const id = typeof named === 'string' ? uuid.exec(named)?.[0] : undefined;
      if (id) live.add(id.toLowerCase());
    }
  }
  const old = async (name: string, path: string) => {
    const id = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i.exec(name)?.[1];
    if (id && live.has(id.toLowerCase())) return false;
    return now - (await lstat(path)).mtimeMs > MODEL_RECORD_TTL_MS;
  };
  for (const store of ['model-jobs', 'model-conversations'])
    await sweep(join(dataDir, store), old, { limit: 50_000 });
}
type NewJob = Omit<ModelJob, 'id' | 'state' | 'expiresAt'>;
/** A held call whose offer never ran to completion: its unchanged repeat keeps it native. */
const REPEATABLE: readonly ModelJob['state'][] = ['offered', 'cancelled', 'unknown'];
/** How long an offer can be accepted, and how long after a worker stopped its call repeats free. */
const OFFER_MS = 15 * 60_000;
const unresolved = (job: ModelJob) =>
  job.state !== 'native' &&
  job.state !== 'completed' &&
  (job.expiresAt > Date.now() || ['running', 'cancelling'].includes(job.state));

/** Why a subagent call the hook saw got no offer. Codes only: never the assignment. */
/**
 * What a job's routing call was authorized to charge, as this client recorded it when the
 * call was made. Every job this client stores carries it; one that does not is invalid.
 */
export function routingAuthorizedAtomic(decision: Record<string, unknown>): bigint {
  const value = decision.routingAuthorizedAtomic;
  if (typeof value !== 'string' || !/^\d{1,30}$/.test(value))
    throw new Error('The job has no routing authorization');
  return BigInt(value);
}
export const NO_OFFER_CODES = [
  'kept_native',
  'no_session',
  'host_unqualified',
  'no_consent',
  'permission_mode',
  'worker_unqualified',
  'input_filter',
  'caller_unqualified',
  'scope_not_covered',
  'parent_context_unavailable',
  'over_size_limit',
  'job_cap_too_low',
  'job_cap_lowered',
  'capture_error',
  'route_error',
  'fee_above_ceiling',
  'server_declined',
  'invalid_offer',
  'superseded',
  'expired',
  'interrupted',
] as const;
const noOfferSchema = z.object({
  at: z.number(),
  sessionId: z.string(),
  tool: z.string(),
  code: z.enum(NO_OFFER_CODES),
  /** A field name, a mode or the server's own code. */
  detail: z
    .string()
    .regex(/^[A-Za-z0-9_.:-]{1,64}$/)
    .optional(),
  bytes: z.number().optional(),
  limit: z.number().optional(),
  offerId: z.uuid().optional(),
  /** Set when a native subagent made the call, not the main loop. */
  from: z.literal('subagent').optional(),
});
export type NoOffer = z.infer<typeof noOfferSchema>;
const NO_OFFERS_KEPT = 200;
const NO_OFFERS_FILE = 'no-offers.json';
/** Open offers one assignment text can have at once before the oldest stops repeating free. */
const REPEATS_KEPT = 16;

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

/** Immutable held calls, atomic selection: a job a call on Claude, one delegation a turn on Codex. */
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
  private callPath(sessionId: string, callId: string) {
    return join(this.dir, `call-${canonicalHash({ sessionId, callId })}.json`);
  }
  /** The held Claude calls with this content in this session and root, oldest first. */
  private async repeatIds(path: string): Promise<string[]> {
    const index = await readJsonFile(path, 4000);
    return (Array.isArray(index?.ids) ? index.ids : []).filter(
      (id): id is string => z.uuid().safeParse(id).success,
    );
  }
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
  /**
   * `call` (Claude): every held call is its own job, whatever else its session
   * has open or running. `turn` (Codex): one unresolved delegation a turn.
   */
  async offer(
    input: NewJob,
    state: 'awaiting_prompt' | 'routing' | 'offered' = 'offered',
    scope: 'call' | 'turn' = 'call',
  ): Promise<ModelJob> {
    return this.locked(async () => {
      const index =
        scope === 'turn'
          ? this.window(input.sessionId, input.turnId)
          : this.callPath(input.sessionId, input.callId);
      const previous = await readJsonFile(index, 1000);
      const old = typeof previous?.id === 'string' ? await this.read(previous.id) : null;
      if (old && unresolved(old)) {
        // The same call seen twice is one job: no second route, no second fee.
        if (
          old.callId === input.callId &&
          canonicalHash(old.native) === canonicalHash(input.native)
        )
          return old;
        throw new Error(
          scope === 'turn'
            ? 'An unresolved delegation already owns this turn'
            : 'This call id already names another unresolved delegation',
        );
      }
      const job: ModelJob = {
        ...input,
        id: randomUUID(),
        state,
        expiresAt: Date.now() + OFFER_MS,
      };
      const serialized = JSON.stringify(job);
      if (Buffer.byteLength(serialized) > 1_000_000)
        throw new Error('Complete model assignment exceeds private record size limit');
      await writePrivate(this.path(job.id), serialized);
      await writePrivate(index, JSON.stringify({ id: job.id }));
      if (input.nativeTool) {
        const path = this.repeatPath(input.sessionId, input.root, input.nativeTool, input.native);
        const ids = [...(await this.repeatIds(path)), job.id].slice(-REPEATS_KEPT);
        await writePrivate(path, JSON.stringify({ ids }));
      }
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
    return this.locked(async () => this.fenced(await this.pending(session, turn), state));
  }
  /** Fences one job by its own id, for its session: nothing else of the session is touched. */
  async fenceOwned(
    id: string,
    session: string,
    state: 'cancelling' | 'cancelled' = 'cancelled',
  ): Promise<void> {
    return this.locked(async () => this.fenced(await this.owned(id, session), state));
  }
  private async fenced(job: ModelJob | null, state: 'cancelling' | 'cancelled') {
    if (!job || ['native', 'completed', 'cancelled', 'unknown'].includes(job.state)) return;
    await writePrivate(this.path(job.id), JSON.stringify({ ...job, state }));
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
   * process (which the caller knows runs no such worker). The record becomes `unknown` and is returned. Null
   * while another live process may still be running the worker.
   */
  async strand(
    id: string,
    o: { isAlive?: (pid: number) => boolean } = {},
  ): Promise<ModelJob | null> {
    return this.locked(async () => {
      const job = await this.read(id);
      if (!job || !['running', 'cancelling'].includes(job.state)) return job;
      const { runner } = job;
      // A live pid is alive: the start of a process is not compared with the accept, as the
      // job-folder sweep does not, since a clock step after a sleep makes a live runner read
      // as a later process.
      const gone = runner && (runner.pid === process.pid || !(o.isAlive ?? pidAlive)(runner.pid));
      if (!gone) return null;
      const ended: ModelJob = {
        ...job,
        state: 'unknown',
        expiresAt: Math.max(job.expiresAt, Date.now() + OFFER_MS),
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
   * in the same session, workspace root and agent loop (`caller`, the native
   * subagent that made the offered call, or none for the main loop) until the
   * offer expires, or for the same time after its accepted worker stopped. No
   * turn boundary is read.
   *
   * Several open offers can hold the same content. One repeat settles one of
   * them, the oldest first. A call made by the same model request (`step`) as
   * an offered call was written before that offer was read: it is a second
   * call, not its repeat, and is judged by itself.
   *
   * @returns the offer the repeat settled, else null.
   */
  async nativeRepeat(
    session: string,
    root: string,
    tool: 'Agent' | 'Task',
    native: Record<string, unknown>,
    step?: string,
    caller?: string,
  ): Promise<string | null> {
    return this.locked(async () => {
      for (const id of await this.repeatIds(this.repeatPath(session, root, tool, native))) {
        const job = await this.read(id);
        if (
          !job ||
          job.sessionId !== session ||
          job.root !== root ||
          job.nativeTool !== tool ||
          !REPEATABLE.includes(job.state) ||
          job.expiresAt <= Date.now() ||
          // An offer is kept native by the loop it was made to, not by another's same call.
          job.caller !== caller ||
          (step !== undefined && job.step === step) ||
          canonicalHash(repeatKey(job.native)) !== canonicalHash(repeatKey(native))
        )
          continue;
        await writePrivate(this.path(job.id), JSON.stringify({ ...job, state: 'native' }));
        return job.id;
      }
      return null;
    });
  }
  async finish(id: string, state: 'completed' | 'cancelled' | 'unknown', result?: string) {
    return this.locked(async () => {
      const job = await this.read(id);
      if (!job || !['running', 'cancelling'].includes(job.state)) return;
      await writePrivate(
        this.path(id),
        JSON.stringify({
          ...job,
          state,
          // A worker that stopped leaves its call a free native repeat, from now.
          ...(state === 'completed'
            ? {}
            : { expiresAt: Math.max(job.expiresAt, Date.now() + OFFER_MS) }),
          ...(result ? { result } : {}),
        }),
      );
    });
  }
  /** Records why a call got no offer, newest last, in one bounded private file. Never throws. */
  async noOffer(entry: Omit<NoOffer, 'at'>): Promise<void> {
    try {
      const parsed = noOfferSchema.safeParse({ ...entry, at: Date.now() });
      if (!parsed.success) return;
      await this.locked(async () => {
        const kept = (await this.noOffers()).filter(
          (old) => parsed.data.at - old.at < MODEL_RECORD_TTL_MS,
        );
        await writePrivate(
          join(this.dir, NO_OFFERS_FILE),
          JSON.stringify({ records: [...kept, parsed.data].slice(-NO_OFFERS_KEPT) }),
        );
      });
    } catch {
      // Diagnostics only: a failed write never changes what the call does.
    }
  }
  /** The kept no-offer records, oldest first. */
  async noOffers(): Promise<NoOffer[]> {
    const raw = await readJsonFile(join(this.dir, NO_OFFERS_FILE), 200_000).catch(() => null);
    return Array.isArray(raw?.records)
      ? raw.records.flatMap((entry) => {
          const parsed = noOfferSchema.safeParse(entry);
          return parsed.success ? [parsed.data] : [];
        })
      : [];
  }
}
