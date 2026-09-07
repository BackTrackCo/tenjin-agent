import type { LoopDb } from './store';

/**
 * `facts`: the machine's key-value table on `loop.db` (13-pr-d-local-arms.md).
 * D writes `finding:<uid>`, the child finding queue; E moves the CLI's
 * `published:` and `agent_published:` writers here. A published fix note is not
 * a fact — the piece behind a pairing is the `pairings.post_id` column.
 */

export interface Fact {
  key: string;
  value: string;
  at: number;
}

export function getFact(db: LoopDb, key: string): string | null {
  const row = db.prepare('SELECT value FROM facts WHERE key = ?').get(key) as
    { value?: unknown } | undefined;
  return typeof row?.value === 'string' ? row.value : null;
}

export function setFact(db: LoopDb, key: string, value: string, at: number): void {
  db.prepare(
    `INSERT INTO facts (key, value, at) VALUES (?, ?, ?)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value, at = excluded.at`,
  ).run(key, value, at);
}

/** Every fact under `prefix`, oldest first. `substr`, not LIKE: a prefix is
 *  literal and needs no escaping. */
export function factsWithPrefix(db: LoopDb, prefix: string): Fact[] {
  return db
    .prepare('SELECT key, value, at FROM facts WHERE substr(key, 1, ?) = ? ORDER BY at, key')
    .all(prefix.length, prefix) as unknown as Fact[];
}

/** Take one fact away. Deleting a row that was never there is the same answer
 *  as deleting one that was: the fact is not held. */
export function deleteFact(db: LoopDb, key: string): void {
  db.prepare('DELETE FROM facts WHERE key = ?').run(key);
}
