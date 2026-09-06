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
 * else: Claude Code's `SubagentStart` carries no field naming the tool call
 * that spawned the child (hooks reference, checked 2026-09-06; `agent_type` is
 * shared by every child of one type), so a dispatch whose child never starts
 * hands its row to the next child of the turn (owner decision, 2026-09-06). A harness with no turn id parks
 * `promptId` undefined and claims with it undefined, which degrades to
 * arrival order across the session; a claim from a harness WITH turn ids never
 * crosses turns.
 */

export interface Handoff {
  session: string;
  promptId?: string;
  at: number;
  /** The masked work order, for the child's question key. */
  question: string;
  /** The team leg's search id; the child's `--search-id` on a miss. */
  searchId?: string;
  answer?: Answer;
}

export function park(db: LoopDb, row: Handoff): void {
  db.prepare(
    `INSERT INTO handoff (session, prompt_id, at, question, search_id, answer)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    row.session,
    row.promptId ?? null,
    row.at,
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
    question: String(row.question),
    ...(typeof row.search_id === 'string' ? { searchId: row.search_id } : {}),
    ...(answer !== undefined ? { answer } : {}),
  };
}
