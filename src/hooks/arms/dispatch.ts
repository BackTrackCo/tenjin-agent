import { park } from '../handoff';
import type { Arm, LegRow } from '../types';
import { lookupArm } from './lookup';

/**
 * The dispatch arm (13-pr-d-local-arms.md, "dispatch"): the work order an
 * agent hands the Agent tool, looked up on both shelves at once and PARKED for
 * the child, which claims it at its start (`subagent-start.ts`). The parent
 * never saw that answer before writing the child's prompt, which is why this
 * handoff stays where the prompt-answer fallback went (decision 5).
 *
 * THE WORK ORDER GOES AS TYPED (decision 10): `tool_input.prompt`, masked, cut
 * at 512 by the leg. The description is a label, not a question, and is not
 * sent.
 *
 * `deliver: 'log'` (decision D): the child gets the piece whole and the parent
 * is not told. If the parent is ever told, it is one sentence in `prose.ts`
 * rendered through `deliver()`, never a third builder.
 */

/** The team leg's search id, the child's `--search-id` on a miss; any leg's
 *  when the team leg had none. */
function searchIdOf(legs: LegRow[]): string | undefined {
  const team = legs.find((l) => l.shelf === 'team' && l.search_id !== undefined);
  return (team ?? legs.find((l) => l.search_id !== undefined))?.search_id;
}

export const dispatchArm: Arm = lookupArm({
  id: 'dispatch',
  wait: 'tool',
  on: [{ event: 'tool.before', kind: 'dispatch' }],
  trigger: 'dispatch',
  enabled: (cfg) => cfg.hooks.subagent,
  text: (input) => {
    const prompt = input.tool?.input.prompt;
    return typeof prompt === 'string' ? prompt.trim() : null;
  },
  shelves: ['team', 'public'],
  deliver: 'log',
  after(ctx, result, question) {
    if (question === null) return null;
    // A hit parks the answer; a definite miss (no-hit, or a cached miss) parks
    // the search id alone. A deadline or an error never reaches here: the child
    // then finds nothing and the fire's row says why.
    const definite =
      result.answer !== undefined || result.reason === 'no-hit' || result.reason === 'cached';
    if (!definite) return null;
    const searchId = result.answer?.searchId ?? searchIdOf(ctx.fire.legs);
    park(ctx.deps.db, {
      session: ctx.actor.session,
      ...(ctx.input.turn !== undefined ? { promptId: ctx.input.turn } : {}),
      at: ctx.deps.clock(),
      question: question.text,
      ...(searchId !== undefined ? { searchId } : {}),
      ...(result.answer !== undefined ? { answer: result.answer } : {}),
    });
    return null;
  },
});
