import { stop } from '../capture';
import type { Arm } from '../types';

/**
 * The subagent-stop arm (13-pr-d-local-arms.md, "subagent-stop"): a child
 * with evidence is asked once to publish, and the answer turn after a block
 * (`stopFuse`) is harvested. It asks no shelf: the log-only report lookup
 * that used to ride here was deleted in review (owner, 2026-09-06) because
 * nothing read its rows and a slow shelf could cost the child its ask.
 */

export const subagentStopArm: Arm = {
  id: 'subagent-stop',
  wait: 'tool',
  on: [{ event: 'agent.stop' }],
  // Gated like every push arm: a push-off machine never blocks a child.
  after: (ctx) => (ctx.deps.config().hooks.push === 'on' ? stop(ctx, 'child') : null),
};
