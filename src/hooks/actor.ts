import type { HookInput } from '../adapters/types';
import { getMark } from './gates';
import type { LoopDb } from './store';
import type { Actor } from './types';

/** The mark SubagentStart writes and SubagentStop requires. */
export const STARTED_MARK = 'started';

/**
 * `actor = (session, agent ?? '')`. Three answers, kept from `identityOf`
 * (`hook-scripts.ts`): absent agent is the lead; a valid one is a child; a
 * present-but-invalid one never reaches here (the adapter's `decode` returns
 * null and the fire is dropped, so a child's work is never filed under the
 * lead).
 *
 * One addition: an `agent.stop` needs a `started` mark from that actor's
 * `agent.start`. A stop with no start is a phantom (68% of last week's
 * SubagentStop rows had no SubagentStart row) and exits before any row.
 */
export function actorOf(input: HookInput, db: LoopDb): Actor | null {
  const actor: Actor = { session: input.session, agent: input.agent ?? '' };
  if (input.event === 'agent.stop' && getMark(db, actor, STARTED_MARK) === null) return null;
  return actor;
}
