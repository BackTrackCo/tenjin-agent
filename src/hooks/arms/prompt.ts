import { promptSkip } from '../question';
import { lookupArm } from './lookup';
import type { Arm } from '../types';

/**
 * The prompt arm: what the person just typed, asked while they are still
 * reading their own sentence (09-pr-c-lookup-arms.md).
 *
 * `wait: 'human'` is the only place the shorter deadline is used, and it is the
 * reason this is ONE CALL: a question is charged once however many shelves
 * answer it, and the shelf route returns the shelf's candidates and the
 * marketplace's from one round trip (owner decision 2026-09-04, and the
 * one-call contract in shelves/02-server.md).
 *
 * THE QUESTION IS THE PROMPT. It is masked and it is not rewritten: the shelf
 * ranks the sentence better than this machine's summary of it, and the three
 * skips below are the only text rules the arm has.
 */
export const promptArm: Arm = lookupArm({
  id: 'prompt',
  wait: 'human',
  on: [{ event: 'prompt' }],
  trigger: 'prompt',
  // The entry is permanent now, so the switch is here rather than in the
  // installed file: `hooks.prompt` takes effect on the next prompt.
  enabled: (cfg) => cfg.hooks.prompt,
  text: (input) => input.prompt ?? null,
  skip: promptSkip,
  deliver: 'inject',
});
