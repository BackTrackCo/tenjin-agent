import { ask, harvest } from '../capture';
import { getMark } from '../gates';
import type { Arm } from '../types';
import { lookupArm } from './lookup';

/**
 * The subagent-stop arm (13-pr-d-local-arms.md, "subagent-stop"): the child's
 * report is looked up log-only — was the shelf already holding what this
 * child found? — and a child with evidence is asked once to publish. The
 * report goes as written (decision 10); the answer turn after a block
 * (`stopFuse`) is not a report and is harvested instead.
 */

const ASKED = 'capture:asked';

export const subagentStopArm: Arm = lookupArm({
  id: 'subagent-stop',
  wait: 'tool',
  on: [{ event: 'agent.stop' }],
  trigger: 'subagent',
  enabled: (cfg) => cfg.hooks.push === 'on',
  text: (input) => (input.stopFuse === true ? null : (input.lastMessage ?? null)),
  shelves: ['team', 'public'],
  deliver: 'log',
  after(ctx) {
    // A disabled arm does nothing at all, the ask included.
    if (ctx.deps.config().hooks.push !== 'on') return null;
    if (getMark(ctx.deps.db, ctx.actor, ASKED) === null) return ask(ctx, 'child');
    harvest(ctx);
    return null;
  },
});
