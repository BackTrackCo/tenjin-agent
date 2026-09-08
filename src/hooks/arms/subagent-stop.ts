import { stop } from '../capture';
import type { Arm } from '../types';

/**
 * The subagent-stop arm (13-pr-d-local-arms.md, "subagent-stop"): a child
 * with evidence is asked once to publish, and the answer turn after the ask
 * (`stopFuse`) is harvested. It asks no shelf: the log-only report lookup
 * that used to ride here was deleted in review (owner, 2026-09-06) because
 * nothing read its rows and a slow shelf could cost the child its ask.
 */

export const subagentStopArm: Arm = {
  id: 'subagent-stop',
  wait: 'tool',
  on: [{ event: 'agent.stop' }],
  // The ask's own switch: a machine with `hooks.publish` off says nothing to a
  // child either.
  after: (ctx) => (ctx.deps.config().hooks.publish ? stop(ctx, 'child') : null),
};
