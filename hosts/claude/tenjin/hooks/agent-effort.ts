import type { EngineInterface, TurnStepInput } from 'claude-code';

/**
 * A ROUTED SUBAGENT'S EFFORT, the delegated task's part of `router.effort`.
 * `agents.tsx` names the effort an agent record decided once the spawn
 * settles; this names it for every `turn.step` of that subagent, a resumed
 * run's included, since a resume otherwise falls back to the effort first
 * asked for. Never above the effort the step would carry, and only for steps
 * that carry an `agentId`. The mod's one `turn.step` hook (`register.tsx`)
 * asks this for a subagent's step and `effort.ts` for a main-loop one.
 */

type Dollar = EngineInterface;

export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type Effort = (typeof EFFORTS)[number];

const RUNS = { plugin: 'tenjin', key: 'agentRuns' } as const;
/** How long a subagent's first step waits for its own spawn to settle. */
const SPAWN_WAIT_MS = 1_500;

/**
 * Each subagent's effort by its agent id, set the moment its spawn settles,
 * before its first step reads it; `null` for one left alone. `$.state` keeps
 * the same across a reload.
 */
const efforts = new Map<string, Effort | null>();
/** Spawns whose effort is about to be known. */
const settling = new Set<Promise<void>>();

/**
 * The effort a subagent's step is sent at, or undefined to send it as it came:
 * a main-loop step, a subagent left alone, a level this does not know, or one
 * already at or below it. Any failure is undefined.
 */
export async function subagentStepEffort($: Dollar, e: TurnStepInput): Promise<Effort | undefined> {
  if (e.agentId === undefined) return undefined;
  try {
    const effort = await effortOf($, e.agentId);
    if (effort === null || typeof e.effort !== 'string' || !below(effort, e.effort)) {
      return undefined;
    }
    return effort;
  } catch {
    return undefined;
  }
}

/**
 * Called before a spawn whose record names an effort: the returned function
 * names the started agent and its effort once the spawn settles (no agent id
 * when it started none), and only then may that agent's first step go on.
 */
export function awaitingEffort(): (agentId: string | undefined, effort: Effort | null) => void {
  let release: () => void = () => undefined;
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });
  settling.add(ready);
  return (agentId, effort) => {
    if (agentId !== undefined) efforts.set(agentId, effort);
    settling.delete(ready);
    release();
  };
}

/** The same, kept in `$.state` so a reload or a later resume still finds it. */
export async function keepEffort(
  $: Dollar,
  agentId: string,
  effort: Effort,
  toolUseId: string,
): Promise<void> {
  await $.state.set({ ...RUNS, id: agentId }, { effort, toolUseId });
}

/** The effort a subagent's step is set to, or null for one left alone. */
async function effortOf($: Dollar, agentId: string): Promise<Effort | null> {
  if (!efforts.has(agentId) && settling.size > 0) {
    await Promise.race([Promise.allSettled([...settling]), $.clock.sleep(SPAWN_WAIT_MS)]);
  }
  const known = efforts.get(agentId);
  if (known !== undefined) return known;
  const { value } = await $.state.get({ ...RUNS, id: agentId });
  const effort = EFFORTS.find((level) => level === value?.effort) ?? null;
  efforts.set(agentId, effort);
  return effort;
}

function below(effort: Effort, current: string): boolean {
  const now = EFFORTS.indexOf(current as Effort);
  return now !== -1 && EFFORTS.indexOf(effort) < now;
}
