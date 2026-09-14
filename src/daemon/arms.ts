import { contextArm } from '../hooks/arms/context';
import { dispatchArm } from '../hooks/arms/dispatch';
import { failureArm } from '../hooks/arms/failure';
import { primerArm } from '../hooks/arms/primer';
import { promptArm } from '../hooks/arms/prompt';
import { fetchArm, researchArm } from '../hooks/arms/research';
import { stopArm } from '../hooks/arms/stop';
import { subagentStartArm } from '../hooks/arms/subagent-start';
import { subagentStopArm } from '../hooks/arms/subagent-stop';
import type { Arm } from '../hooks/types';

/**
 * The arms this daemon serves: the four lookup arms (prompt, research, fetch,
 * dispatch), PR D's `failure`, the two subagent arms, `stop`, `primer`, and
 * `context`, which asks nothing and only writes the marks the other arms read.
 * ORDER IS THE MAP: `selectArm` takes the first arm whose `on` matches, so a
 * later arm can be shadowed by an earlier one. These ten cannot shadow each
 * other: they key on disjoint (event, kind) pairs (`failure` takes
 * `tool.after/shell`, `context` takes `tool.before/shell` and `tool.after/read`),
 * and `context` is last regardless because it is the only one with more than
 * one. Every one of the eleven entries `install` writes now finds an arm.
 *
 * ITS OWN MODULE, not a const inside `main.ts`: `main.ts` runs the daemon on
 * import, so a test that wants the list the daemon actually serves could not
 * read it there and would have to keep a second copy. `delivery.test.ts`
 * imports this one, so an arm dropped from the daemon is an arm dropped from
 * that test's fixture too.
 */
export const ARMS: Arm[] = [
  promptArm,
  researchArm,
  fetchArm,
  dispatchArm,
  failureArm,
  subagentStartArm,
  subagentStopArm,
  stopArm,
  primerArm,
  contextArm,
];
