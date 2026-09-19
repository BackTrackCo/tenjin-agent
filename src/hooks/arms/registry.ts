import { contextArm } from './context';
import { dispatchArm } from './dispatch';
import { failureArm } from './failure';
import { primerArm } from './primer';
import { promptArm } from './prompt';
import { fetchArm, researchArm } from './research';
import { stopArm } from './stop';
import { subagentStartArm } from './subagent-start';
import { subagentStopArm } from './subagent-stop';
import type { Arm } from '../types';

/**
 * EVERY ARM THE KERNEL RUNS, in the one order it runs them.
 *
 * The four lookup arms (prompt, research, fetch, dispatch), PR D's `failure`,
 * the two subagent arms, `stop`, `primer`, and `context`, which asks nothing
 * and only writes the marks the other arms read. ORDER IS THE MAP —
 * `selectArm` takes the first arm whose `on` matches, so a later arm can be
 * shadowed by an earlier one. These ten cannot shadow each other: they key on
 * disjoint (event, kind) pairs (`failure` takes `tool.after/shell`, `context`
 * takes `tool.before/shell` and `tool.after/read`), and `context` is last
 * regardless because it is the only one with more than one. Every one of the
 * eleven entries `install` writes finds an arm.
 *
 * ITS OWN MODULE so the list has ONE copy. It used to live in `daemon/main.ts`,
 * which runs `main()` on import, so nothing could read it without starting a
 * daemon and both the hook-server suite and the one-call contract had to
 * restate it. A restated registry is a registry that drifts, and the thing the
 * contract pins — that no arm plans a second origin — is worth nothing if it
 * runs over a list an arm can be added without touching.
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
