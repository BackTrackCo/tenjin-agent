import {
  FIRES_ROW_CAP,
  RETENTION_BATCH,
  RETENTION_DAYS,
  RETENTION_MAX_MS,
} from '../hooks/constants';
import type { LoopDb } from '../hooks/store';

/**
 * Retention (02-redesign.md §10, owner Q8): `fires` older than
 * `RETENTION_DAYS` or beyond `FIRES_ROW_CAP`, whichever bites first, and their
 * `legs` by cascade; `marks` older than 30 days; then a WAL checkpoint and
 * `incremental_vacuum`.
 *
 * WHERE: the daemon's idle exit, after the listener has closed, and `tenjin
 * doctor --prune` (PR E). Never on a hook path and never at SessionEnd: a
 * daemon serves many sessions, and one ending is not the machine going quiet.
 *
 * Batched, because node 24's `node:sqlite` is built without
 * `SQLITE_ENABLE_UPDATE_DELETE_LIMIT`, so `DELETE ... LIMIT` is a syntax error
 * (probed 2026-09-03). Bounded by `RETENTION_MAX_MS` so a successor daemon is
 * never refused the port for longer than a shim will wait.
 */

export interface RetentionReport {
  fires: number;
  marks: number;
  /** True when the time bound stopped it before it was done. */
  truncated: boolean;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function loop(
  db: LoopDb,
  sql: string,
  params: Array<number | string>,
  deadline: () => boolean,
): { n: number; truncated: boolean } {
  const stmt = db.prepare(sql);
  let n = 0;
  for (;;) {
    if (deadline()) return { n, truncated: true };
    const changes = Number(stmt.run(...params).changes);
    n += changes;
    if (changes < RETENTION_BATCH) return { n, truncated: false };
  }
}

export function runRetention(
  db: LoopDb,
  now: number,
  clock: () => number = () => Date.now(),
): RetentionReport {
  const started = clock();
  const deadline = () => clock() - started > RETENTION_MAX_MS;
  const cutoff = now - RETENTION_DAYS * DAY_MS;
  const report: RetentionReport = { fires: 0, marks: 0, truncated: false };

  const byAge = loop(
    db,
    `DELETE FROM fires WHERE id IN (SELECT id FROM fires WHERE at < ? ORDER BY at LIMIT ${RETENTION_BATCH})`,
    [cutoff],
    deadline,
  );
  report.fires += byAge.n;
  report.truncated ||= byAge.truncated;

  if (!report.truncated) {
    const count = db.prepare('SELECT COUNT(*) AS n FROM fires').get() as { n?: unknown };
    const excess = Number(count?.n ?? 0) - FIRES_ROW_CAP;
    if (excess > 0) {
      // Oldest first, in batches, until the cap holds.
      const stmt = db.prepare(
        `DELETE FROM fires WHERE id IN (SELECT id FROM fires ORDER BY at LIMIT ?)`,
      );
      let left = excess;
      while (left > 0) {
        if (deadline()) {
          report.truncated = true;
          break;
        }
        const changes = Number(stmt.run(Math.min(left, RETENTION_BATCH)).changes);
        report.fires += changes;
        if (changes === 0) break;
        left -= changes;
      }
    }
  }

  if (!report.truncated) {
    const marks = loop(
      db,
      `DELETE FROM marks WHERE rowid IN (SELECT rowid FROM marks WHERE at < ? LIMIT ${RETENTION_BATCH})`,
      [cutoff],
      deadline,
    );
    report.marks = marks.n;
    report.truncated ||= marks.truncated;
  }

  try {
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    db.exec('PRAGMA incremental_vacuum');
  } catch {
    // Housekeeping; a busy CLI reader is not a reason to fail the exit.
  }
  return report;
}
