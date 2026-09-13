import { stop } from '../capture';
import type { Arm } from '../types';

/**
 * The stop arm (13-pr-d-local-arms.md, "stop"): the lead's turn ends. Once per
 * agent, with evidence, the lead is asked to publish and told what its children
 * published; every later turn end writes its row and says nothing. No lookup,
 * no transcript, no wait for children (decision 14).
 */

export const stopArm: Arm = {
  id: 'stop',
  wait: 'human',
  on: [{ event: 'turn.end' }],
  after: (ctx) => stop(ctx, 'lead'),
};
