import type { EngineInterface, On, TurnStartInput, TurnStepInput } from 'claude-code';

import type { Level } from './effort-rules';
import { mainStepEffort } from './effort-step';
import {
  createTurns,
  keepRecord,
  settingsOf,
  type EffortCounts,
  type TurnPlan,
} from './effort-turn';
import { showStatus, type Status } from './shared';

/**
 * MAIN-AGENT EFFORT: with `router.effort` at `shadow` or `apply` in the global
 * config, each main-session turn is classed by fixed rules (`effort-rules.ts`)
 * at its start, decided once at its first model request (`effort-turn.ts`) and
 * sent at that level (`effort-step.ts`). At `off`, the default, every hook here
 * passes its event on as it came and nothing is drawn or written.
 *
 * `router.effort` is one switch with a delegated task's effort (`agents.tsx`):
 * neither `router.subagents` nor the agent leg turns this on, and this never
 * touches a step that carries an `agentId`.
 *
 * SHOWN: a turn run at another level than the session's gets one dim line,
 * `Tenjin ran this turn at medium; the session is on high` (`would have run`
 * in shadow), and the plugin's status entry keeps the session's counts as its
 * `turns` part (`shared.ts`). A kept turn shows nothing.
 *
 * KEPT: one 0600 record per turn the rules touched, under
 * `<data dir>/effort/`, with no message text (`effort-turn.ts`).
 */

/** The session's effort memory, shared by the hooks below and the mod's one
 *  `turn.start` and `turn.step` hooks. */
export function createEffort(status: Status) {
  return { turns: createTurns(), status };
}

export type Effort = ReturnType<typeof createEffort>;

export function registerEffort(on: On, effort: Effort): void {
  const { turns } = effort;
  on('prompt.submit', async (_$, e, next) => {
    try {
      turns.submitted(e);
    } catch {
      // Observing a prompt never stands in its way.
    }
    return next(e);
  });

  on('turn.complete', async ($, e, next) => {
    const answered = await next(e);
    if (e.agentId === undefined) {
      try {
        const plan = turns.completed(e);
        if (plan !== undefined) await keepRecord($, plan, e);
      } catch {
        // The record is best effort; the answer is already shown.
      }
    }
    return answered;
  });
}

/**
 * The level a main-loop step is sent at, or undefined to send it as the engine
 * would; the line and the status entry at the turn's decision. Called by the
 * mod's one `turn.step` hook for a step with no `agentId`.
 */
export function effortStepLevel(
  $: EngineInterface,
  effort: Effort,
  e: TurnStepInput,
): Level | undefined {
  const step = mainStepEffort(e, effort.turns);
  if (step.decidedNow !== undefined) showDecision($, effort, step.decidedNow);
  return step.level;
}

/**
 * A main-loop turn's start: its class and settings. Called first by the mod's
 * one `turn.start` hook, since a module registers each event once.
 */
export async function effortTurnStarted(
  $: EngineInterface,
  effort: Effort,
  e: TurnStartInput,
): Promise<void> {
  if (e.agentId !== undefined) return;
  try {
    const plan = await effort.turns.started(e, await settingsOf($), await $.session.id());
    if (plan.settings.mode === 'off') showStatus($, effort.status, 'turns', undefined);
  } catch {
    // A turn whose start cannot be read runs as the engine would send it.
  }
}

/** The line and the status entry, once per turn, at its decision. */
function showDecision($: EngineInterface, effort: Effort, plan: TurnPlan): void {
  const line = lineOf(plan);
  if (line !== undefined) $.ui.log(line);
  const status = statusOf(plan.settings.mode, effort.turns.counts);
  if (status !== undefined) showStatus($, effort.status, 'turns', status);
}

/** The line for a turn whose level differs from the session's; none for a kept one. */
function lineOf(plan: TurnPlan): string | undefined {
  const d = plan.decision;
  if (d == null || d.floor !== undefined || d.isHoldout) return undefined;
  if (d.target === undefined || d.sessionEffort === undefined || d.target === d.sessionEffort) {
    return undefined;
  }
  return plan.settings.mode === 'apply'
    ? `Tenjin ran this turn at ${d.target}; the session is on ${d.sessionEffort}`
    : `Tenjin would have run this turn at ${d.target}; the session is on ${d.sessionEffort}`;
}

/** The status entry's `turns` part, once anything is counted. */
function statusOf(mode: string, c: EffortCounts): string | undefined {
  if (mode === 'off') return undefined;
  const total = c.lowered + c.raised + c.heldOut + c.floored + c.byHand + c.askedToThink;
  if (total === 0) return undefined;
  const moved =
    mode === 'apply'
      ? `${c.lowered} lower · ${c.raised} higher`
      : `${c.lowered} would lower · ${c.raised} would raise`;
  return `effort ${mode === 'apply' ? 'on' : 'shadow'} · ${moved} · ${c.heldOut} held out · ${c.byHand} set by hand · ${c.askedToThink} asked to think`;
}
