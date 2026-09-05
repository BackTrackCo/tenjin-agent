import type { LoopDb } from './store';
import type { Actor, Answer, FireContext, Outcome, Plan } from './types';

/**
 * The gates: once-per-question (a claim on the question key with a cached
 * verdict) and once-per-piece (`seen:` marks). All of it is a few prepared
 * statements against `loop.db`, written synchronously per fire: the daemon is
 * the only writer, and `DatabaseSync` under WAL costs tens of microseconds a
 * statement (owner review decision, 07-pr-b-daemon-kernel.md).
 *
 * THERE IS NO CLIENT-SIDE RATE LIMIT. One research subagent fires 15 to 18 web
 * lookups a minute at peak, so a bucket that refused half of them would ration
 * exactly the panel the loop exists to capture. The runaway stop is the
 * server's own per-IP 429, which arrives as the reason `rate-server`.
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
  questionKey: string,
  now: number,
  waitMs: number,
  by?: string,
): Claim {
  const key = Q_PREFIX + questionKey;
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
  questionKey: string,
  answer: Answer | null,
  now: number,
  by?: string,
): void {
  const key = Q_PREFIX + questionKey;
  if (!owns(readQuestion(db, actor, key), by)) return;
  const next: QuestionMark =
    by === undefined
      ? { status: 'done', at: now, answer }
      : { status: 'done', at: now, answer, by };
  setMark(db, actor, key, JSON.stringify(next), now);
}

/** The fire ended without a verdict (deadline or error): free the question. */
export function release(db: LoopDb, actor: Actor, questionKey: string, by?: string): void {
  const key = Q_PREFIX + questionKey;
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
  const { db, clock } = ctx.deps;
  const now = clock();
  const c = claim(db, ctx.actor, plan.question.questionKey, now, ctx.fire.deadlineMs, ctx.fire.id);
  if (c.kind === 'asked') return { reason: 'asked' };
  if (c.kind === 'cached')
    return c.answer ? { reason: 'cached', answer: c.answer } : { reason: 'cached' };
  return null;
}
