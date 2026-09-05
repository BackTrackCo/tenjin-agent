import { RESERVE_MS } from './constants';
import type { Answer, FireContext, Leg, LegResult, LegRow, LegStatus, Plan, Shelf } from './types';

/**
 * Run a plan's stages on the fire's clock. Legs inside a stage run together;
 * a stage that yields a strong verdict ends the plan; otherwise the next stage
 * runs with whatever time is left. Team strong beats public strong beats the
 * best short-of-strong, decided once, here (02-redesign.md §5).
 *
 * `team.publicFallback: off` is one filter: a stage whose legs are all public
 * is dropped, so `[[team], [public]]` becomes `[[team]]` (tenjin-agent#229).
 */

/** Higher wins among equal strength. */
const SHELF_RANK: Record<Shelf, number> = { team: 3, keys: 2, public: 1 };

function better(a: Answer | null, b: Answer): boolean {
  if (a === null) return true;
  if (a.strength !== b.strength) return b.strength === 'strong';
  return SHELF_RANK[b.shelf] > SHELF_RANK[a.shelf];
}

function statusOfError(err: unknown, fireSignal: AbortSignal): LegStatus {
  const name =
    typeof err === 'object' && err !== null ? (err as { name?: unknown }).name : undefined;
  if (name === 'TimeoutError') return 'timeout';
  if (name === 'AbortError') return fireSignal.aborted ? 'aborted' : 'timeout';
  return 'error';
}

export interface AskResult {
  answer: Answer | null;
  /** Every leg that ran, in `legs` row shape; `hit` marks the winner. */
  legs: LegRow[];
}

export async function ask(ctx: FireContext, plan: Plan): Promise<AskResult> {
  const { fire, deps } = ctx;
  const stages =
    deps.config().team.publicFallback === 'off'
      ? plan.stages.filter((stage) => stage.some((leg) => leg.shelf !== 'public'))
      : plan.stages;
  const rows: LegRow[] = [];
  let best: Answer | null = null;
  let bestRow: LegRow | null = null;

  for (let stage = 0; stage < stages.length; stage += 1) {
    const legs = stages[stage] ?? [];
    const budget = fire.remaining() - RESERVE_MS;
    if (budget <= 0) {
      for (const leg of legs) {
        rows.push({
          stage,
          shelf: leg.shelf,
          status: 'timeout',
          outcome: 'no-answer',
          elapsed_ms: 0,
        });
      }
      continue;
    }
    const signal = AbortSignal.any([fire.signal, AbortSignal.timeout(budget)]);
    const settled = await Promise.allSettled(
      legs.map((leg) => runLeg(leg, plan, budget, signal, deps.clock)),
    );
    let stageStrong = false;
    settled.forEach((s, i) => {
      const leg = legs[i];
      if (leg === undefined) return;
      if (s.status === 'rejected') {
        rows.push({
          stage,
          shelf: leg.shelf,
          status: statusOfError(s.reason, fire.signal),
          outcome: 'no-answer',
          elapsed_ms: 0,
        });
        return;
      }
      const { result, elapsed, answer } = s.value;
      const row: LegRow = {
        stage,
        shelf: leg.shelf,
        status: result.status,
        outcome: result.status === 'ok' ? (answer ? 'shadowed' : 'miss') : 'no-answer',
        elapsed_ms: elapsed,
        ...(result.searchId !== undefined ? { search_id: result.searchId } : {}),
        ...(result.title !== undefined ? { title: result.title } : {}),
        ...(result.url !== undefined ? { url: result.url } : {}),
        ...(result.form !== undefined ? { form: result.form } : {}),
        ...(result.calibration !== undefined ? { calibration: result.calibration } : {}),
      };
      rows.push(row);
      if (answer && better(best, answer)) {
        best = answer;
        bestRow = row;
      }
      if (answer?.strength === 'strong') stageStrong = true;
    });
    if (stageStrong) break;
  }
  if (bestRow !== null) (bestRow as LegRow).outcome = 'hit';
  fire.legs.push(...rows);
  return { answer: best, legs: rows };
}

async function runLeg(
  leg: Leg,
  plan: Plan,
  budget: number,
  signal: AbortSignal,
  clock: () => number,
): Promise<{ result: LegResult; elapsed: number; answer: Answer | null }> {
  const started = clock();
  const result = await leg.request(plan.question, budget, signal);
  const elapsed = clock() - started;
  const answer = result.status === 'ok' ? leg.verdict(result) : null;
  return { result, elapsed, answer };
}
