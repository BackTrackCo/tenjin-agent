import type { Emit } from '../adapters/types';
import type { LoopDb } from './store';
import type { Actor, LegRow, Outcome, Wait } from './types';

/**
 * The single writer of `fires` and `legs`. Exactly one row per fire that
 * passed `actorOf`, for every outcome including "ran out of time"; the latch
 * that guarantees the "exactly" lives in `fire.ts` (`commit`). Called after
 * the response has flushed, so the write is never on the harness's clock.
 *
 * NEVER THROWS INTO THE REQUEST. A failed write is a log line: the response
 * has already gone, and a throw here would be an `uncaughtException` that
 * takes the daemon down for every session on the machine.
 */

export interface FireRecord {
  id: string;
  at: number;
  actor: Actor;
  arm: string;
  harness: string;
  event: string;
  promptId?: string;
  cwd: string;
  wait: Wait;
  deadlineMs: number;
  elapsedMs: number;
  outcome: Outcome;
  questionKey?: string;
  question?: string;
  emit: Emit | null;
  legs: LegRow[];
}

export function record(db: LoopDb, log: (line: string) => void, r: FireRecord): boolean {
  try {
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare(
        `INSERT INTO fires (id, at, session, agent, arm, harness, event, prompt_id, cwd, wait,
           deadline_ms, elapsed_ms, reason, question_key, question, delivered, emit)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        r.id,
        r.at,
        r.actor.session,
        r.actor.agent,
        r.arm,
        r.harness,
        r.event,
        r.promptId ?? null,
        r.cwd,
        r.wait,
        r.deadlineMs,
        r.elapsedMs,
        r.outcome.reason,
        r.questionKey ?? null,
        r.question ?? r.outcome.detail ?? null,
        r.outcome.delivery
          ? `${r.outcome.delivery.mode}:${r.outcome.delivery.resourceId ?? ''}`
          : null,
        r.emit === null ? null : JSON.stringify(r.emit),
      );
      const leg = db.prepare(
        `INSERT INTO legs (fire_id, stage, shelf, status, outcome, elapsed_ms, search_id, title, url,
           form, calibration)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (fire_id, stage, shelf) DO NOTHING`,
      );
      for (const l of r.legs) {
        leg.run(
          r.id,
          l.stage,
          l.shelf,
          l.status,
          l.outcome,
          l.elapsed_ms,
          l.search_id ?? null,
          l.title ?? null,
          l.url ?? null,
          l.form ?? null,
          l.calibration ?? null,
        );
      }
      db.exec('COMMIT');
      return true;
    } catch (err) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // Already rolled back by the failure itself.
      }
      throw err;
    }
  } catch (err) {
    log(`ledger: fire ${r.id} not recorded: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}
