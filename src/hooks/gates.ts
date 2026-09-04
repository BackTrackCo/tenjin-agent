import type { LoopDb } from './store';
import type { Actor, Answer, FireContext, Outcome, Plan } from './types';

/**
 * The gates: rate (GCRA per (session, agent, arm)), once-per-question (a claim
 * on the fingerprint with a cached verdict), once-per-piece (`seen:` marks).
 * All of it is a few prepared statements against `loop.db`, written
 * synchronously per fire: the daemon is the only writer, and `DatabaseSync`
 * under WAL costs tens of microseconds a statement (owner review decision,
 * 07-pr-b-daemon-kernel.md).
 *
 * ORDER: claim before charge, so a busy question cannot spend a unit and then
 * deny the lookup, and a cached verdict never reaches the charge at all.
 */

const Q_PREFIX = 'q:';
const SEEN_PREFIX = 'seen:';

interface QuestionMark {
  status: 'asking' | 'done';
  at: number;
  answer?: Answer | null;
  /** The fire that wrote it; `finish` and `release` from another fire are no-ops. */
  by?: string;
}

function readQuestion(db: LoopDb, actor: Actor, key: string): QuestionMark | null {
  const raw = getMark(db, actor, key);
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as QuestionMark;
  } catch {
    return null;
  }
}

/**
 * May `by` change this question's mark? A fire that lost the deadline race
 * keeps running in the background; once a newer fire has retaken the claim,
 * the old fire's late `release` or `finish` must not touch it.
 */
function owns(mark: QuestionMark | null, by: string | undefined): boolean {
  return by === undefined || mark === null || mark.by === undefined || mark.by === by;
}

export function getMark(db: LoopDb, actor: Actor, key: string): string | null {
  const row = db
    .prepare('SELECT value FROM marks WHERE session = ? AND agent = ? AND key = ?')
    .get(actor.session, actor.agent, key) as { value?: unknown } | undefined;
  return typeof row?.value === 'string' ? row.value : null;
}

export function setMark(db: LoopDb, actor: Actor, key: string, value: string, at: number): void {
  db.prepare(
    `INSERT INTO marks (session, agent, key, value, at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (session, agent, key) DO UPDATE SET value = excluded.value, at = excluded.at`,
  ).run(actor.session, actor.agent, key, value, at);
}

export function deleteMark(db: LoopDb, actor: Actor, key: string): void {
  db.prepare('DELETE FROM marks WHERE session = ? AND agent = ? AND key = ?').run(
    actor.session,
    actor.agent,
    key,
  );
}

/**
 * GCRA. `tat` is the theoretical arrival time of the next conforming request.
 * With emission interval T = 60000 / rate and burst b, a request at `now` is
 * allowed when `max(tat, now) - now <= T * (b - 1)`, and then `tat` advances by
 * T from `max(tat, now)`. A fresh actor (no row) starts at tat = 0 and gets its
 * full burst; the upsert is what keeps a first request from being denied
 * forever (critique C1-M3).
 */
export function charge(
  db: LoopDb,
  actor: Actor,
  arm: string,
  now: number,
  ratePerMin: number,
  burst: number,
): boolean {
  const interval = 60_000 / ratePerMin;
  const row = db
    .prepare('SELECT tat FROM actors WHERE session = ? AND agent = ? AND arm = ?')
    .get(actor.session, actor.agent, arm) as { tat?: unknown } | undefined;
  const tat = typeof row?.tat === 'number' ? row.tat : 0;
  const base = Math.max(tat, now);
  if (base - now > interval * (burst - 1)) return false;
  db.prepare(
    `INSERT INTO actors (session, agent, arm, tat) VALUES (?, ?, ?, ?)
     ON CONFLICT (session, agent, arm) DO UPDATE SET tat = excluded.tat`,
  ).run(actor.session, actor.agent, arm, base + interval);
  return true;
}

export type Claim =
  { kind: 'fresh' } | { kind: 'asked' } | { kind: 'cached'; answer: Answer | null };

/**
 * Once-per-question. `asking` younger than `waitMs` is someone else's live
 * fire (`asked`); an older `asking` is stale (its fire hit its deadline or
 * crashed) and is retaken; `done` returns the stored verdict without a fetch.
 */
export function claim(
  db: LoopDb,
  actor: Actor,
  fingerprint: string,
  now: number,
  waitMs: number,
  by?: string,
): Claim {
  const key = Q_PREFIX + fingerprint;
  const mark = readQuestion(db, actor, key);
  if (mark?.status === 'done') return { kind: 'cached', answer: mark.answer ?? null };
  if (mark?.status === 'asking' && now - mark.at < waitMs) return { kind: 'asked' };
  const next: QuestionMark =
    by === undefined ? { status: 'asking', at: now } : { status: 'asking', at: now, by };
  setMark(db, actor, key, JSON.stringify(next), now);
  return { kind: 'fresh' };
}

/** The fire ended with a verdict (hit or a definite miss): cache it. */
export function finish(
  db: LoopDb,
  actor: Actor,
  fingerprint: string,
  answer: Answer | null,
  now: number,
  by?: string,
): void {
  const key = Q_PREFIX + fingerprint;
  if (!owns(readQuestion(db, actor, key), by)) return;
  const next: QuestionMark =
    by === undefined
      ? { status: 'done', at: now, answer }
      : { status: 'done', at: now, answer, by };
  setMark(db, actor, key, JSON.stringify(next), now);
}

/** The fire ended without a verdict (deadline, error, rate): free the question. */
export function release(db: LoopDb, actor: Actor, fingerprint: string, by?: string): void {
  const key = Q_PREFIX + fingerprint;
  if (!owns(readQuestion(db, actor, key), by)) return;
  deleteMark(db, actor, key);
}

/** Once-per-piece, per actor. Returns false when this actor already saw it. */
export function firstSight(db: LoopDb, actor: Actor, resourceId: string, now: number): boolean {
  const key = SEEN_PREFIX + resourceId;
  if (getMark(db, actor, key) !== null) return false;
  setMark(db, actor, key, String(now), now);
  return true;
}

/**
 * Run the gates for a plan. Returns the skip outcome, or null when the fire
 * may ask. On `cached` the answer rides in the outcome; `runFire` still runs
 * `deliver` on it (the piece may be new to THIS actor even if the question is
 * not).
 */
export function gates(ctx: FireContext, plan: Plan): Outcome | null {
  const { db, clock, config } = ctx.deps;
  const now = clock();
  const c = claim(db, ctx.actor, plan.question.fingerprint, now, ctx.fire.deadlineMs, ctx.fire.id);
  if (c.kind === 'asked') return { reason: 'asked' };
  if (c.kind === 'cached')
    return c.answer ? { reason: 'cached', answer: c.answer } : { reason: 'cached' };
  const { rate_per_min, burst } = config().loop;
  if (!charge(db, ctx.actor, ctx.arm.id, now, rate_per_min, burst)) {
    release(db, ctx.actor, plan.question.fingerprint, ctx.fire.id);
    return { reason: 'rate' };
  }
  return null;
}
