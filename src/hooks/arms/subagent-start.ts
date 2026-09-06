import { STARTED_MARK } from '../actor';
import { HANDOFF_MISS } from '../capture';
import { deliver } from '../deliver';
import { setMark } from '../gates';
import { claim } from '../handoff';
import { localLeg } from '../legs/local';
import { questionKeyOf } from '../question';
import type { Arm } from '../types';

/**
 * The subagent-start arm (13-pr-d-local-arms.md, "subagent-start"): the child
 * starts, and its first turn opens with the piece its parent's dispatch found,
 * whole if free, through the kernel exactly like a shelf answer — one row,
 * `delivered`, the child's own `seen:` mark, the lead's form (proposal A: no
 * ladder, no outcome ask, no marker).
 *
 * `before` writes `started` whatever else happens: it is what `actorOf`
 * requires at `agent.stop`, and a stop with no start is a phantom.
 */

export const subagentStartArm: Arm = {
  id: 'subagent-start',
  wait: 'tool',
  on: [{ event: 'agent.start' }],
  before(ctx) {
    const { db, clock } = ctx.deps;
    setMark(db, ctx.actor, STARTED_MARK, ctx.input.agentType ?? '', clock());
  },
  plan(ctx) {
    const { db, clock } = ctx.deps;
    const row = claim(db, ctx.actor.session, ctx.input.turn);
    if (row === null) return null;
    // The claim consumed the row, so a miss is recorded here, as the child's
    // capture evidence, with the search id its own publish should close.
    if (row.answer === undefined) setMark(db, ctx.actor, HANDOFF_MISS, row.searchId ?? '', clock());
    const answer = row.answer ?? null;
    return {
      question: { text: row.question, questionKey: questionKeyOf(row.question) },
      stages: [[localLeg(answer?.shelf ?? 'team', () => answer)]],
    };
  },
  deliver(answer) {
    return deliver(answer, answer.shelf);
  },
};
