import { stop } from '../capture';
import type { Arm } from '../types';

/**
 * The stop arm (13-pr-d-local-arms.md, "stop"): the lead's turn ends. Once per
 * session, with evidence, the lead is asked to publish and told what its
 * children queued; the turn after the ask harvests the lead's own fence. No
 * lookup, no transcript, no wait for children (decision 14): a late child's
 * finding re-arms the ask at the next stop.
 */

export const stopArm: Arm = {
  id: 'stop',
  wait: 'human',
  on: [{ event: 'turn.end' }],
  after: (ctx) => stop(ctx, 'lead'),
};
