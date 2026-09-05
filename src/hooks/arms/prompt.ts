import { condense } from '../../lib/query-condense';
import { mask } from '../../lib/redact';
import { promptSkip } from '../question';
import { lookupArm } from './lookup';
import type { Arm } from '../types';

/**
 * The prompt arm: what the person just typed, asked of both shelves while they
 * are still reading their own sentence (09-pr-c-lookup-arms.md).
 *
 * `wait: 'human'` is the only place the shorter deadline is used, and it is the
 * reason the two shelves are ONE stage: a question is charged once however many
 * shelves answer it, so a sequential plan bought nothing but a public leg with
 * a second left on its clock (owner decision 2026-09-04).
 *
 * `shape` is the only `[mask, condense]` in the build. A typed prompt is prose
 * and condensing measurably helps it (#255); a search query is already a query
 * and condensing damages it, which is why every other arm masks and stops.
 */
export const promptArm: Arm = lookupArm({
  id: 'prompt',
  wait: 'human',
  on: [{ event: 'prompt' }],
  trigger: 'prompt',
  // The entry is permanent now, so the switch is here rather than in the
  // installed file: `tenjin push off` takes effect on the next prompt.
  enabled: (cfg) => cfg.hooks.push === 'on',
  text: (input) => input.prompt ?? null,
  skip: promptSkip,
  shape: [mask, condense],
  shelves: ['team', 'public'],
  deliver: 'inject',
});
