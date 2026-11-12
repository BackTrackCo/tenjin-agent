import type { TurnStepInput } from 'claude-code';

import type { Level } from './effort-rules';
import { levelFor, type TurnPlan, type Turns } from './effort-turn';

/**
 * MAIN-AGENT EFFORT, APPLIED: what the mod's `turn.step` hook sends a
 * main-loop request (no `agentId`) at. The turn's level is decided once, at
 * its first request, and every request of the turn is sent at it. A subagent's
 * request is never touched, nor is anything but `effort`: not the model, the
 * system prompt, the tools or the messages. Undefined sends the request as the
 * engine would.
 *
 * `decidedNow` is the plan when this request made the turn's decision, for
 * the line and the status entry.
 */
export function mainStepEffort(
  e: TurnStepInput,
  turns: Turns,
): { level: Level | undefined; decidedNow?: TurnPlan } {
  if (e.agentId !== undefined) return { level: undefined };
  try {
    const firstStep = turns.isUndecided(e.turnId);
    const plan = turns.decided(e.turnId, e.effort, e.model);
    const level = levelFor(plan);
    return plan !== undefined && firstStep ? { level, decidedNow: plan } : { level };
  } catch {
    return { level: undefined };
  }
}
