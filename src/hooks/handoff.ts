import type { LoopDb } from './store';
import type { Answer } from './types';

/**
 * The dispatch handoff (13-pr-d-local-arms.md): the parent's dispatch fire
 * parks what its lookup found, and the child's start claims it. Two
 * statements, no TTL and no `claimed_by`: a claim DELETES the row, so a
 * claimed row is gone, and an unclaimed one is swept by retention with
 * everything else (decision 14).
 *
 * Oldest first within a turn, so two dispatches in one turn hand their rows
 * to two children in dispatch order. The claim is positional and nothing
 * else: a `SubagentStart` carries nothing to match a row on, so a dispatch
 * whose child never starts (a denied permission prompt) hands its row to the
 * next child of the turn (decision 14). A harness with no turn id parks
 * `promptId` undefined and claims with it undefined, which degrades to
 * arrival order across the session; a claim from a harness WITH turn ids never
 * crosses turns.
 */

export interface Handoff {
  session: string;
  promptId?: string;
  at: number;
  outcome: 'hit' | 'miss';
  /** The masked work order, for the child's question key. */
  question: string;
  /** The team leg's search id; the child's `--search-id` on a miss. */
  searchId?: string;
  answer?: Answer;
}

export function park(db: LoopDb, row: Handoff): void {
  db.prepare(
    `INSERT INTO handoff (session, prompt_id, at, outcome, question, search_id, answer)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.session,
    row.promptId ?? null,
    row.at,
    row.outcome,
    row.question,
    row.searchId ?? null,
    row.answer === undefined ? null : JSON.stringify(row.answer),
  );
}

export function claim(db: LoopDb, session: string, promptId: string | undefined): Handoff | null {
  const row = db
    .prepare(
      `DELETE FROM handoff WHERE id = (
         SELECT id FROM handoff WHERE session = ? AND (prompt_id = ? OR ? IS NULL)
         ORDER BY at LIMIT 1
       ) RETURNING *`,
    )
    .get(session, promptId ?? null, promptId ?? null) as Record<string, unknown> | undefined;
  if (row === undefined) return null;
  let answer: Answer | undefined;
  if (typeof row.answer === 'string') {
    try {
      answer = JSON.parse(row.answer) as Answer;
    } catch {
      // A row this build cannot read is a miss, not a crash on the hook path.
    }
  }
  return {
    session: String(row.session),
    ...(typeof row.prompt_id === 'string' ? { promptId: row.prompt_id } : {}),
    at: Number(row.at),
    outcome: row.outcome === 'hit' ? 'hit' : 'miss',
    question: String(row.question),
    ...(typeof row.search_id === 'string' ? { searchId: row.search_id } : {}),
    ...(answer !== undefined ? { answer } : {}),
  };
}
