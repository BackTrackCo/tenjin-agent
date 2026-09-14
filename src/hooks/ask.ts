import { RESERVE_MS } from './constants';
import type { Answer, FireContext, Leg, LegResult, LegRow, LegStatus, Plan, Shelf } from './types';

/**
 * Run a plan's stages on the fire's clock. Legs inside a stage run together;
 * a stage that yields an answer ends the plan; otherwise the next stage runs
 * with whatever time is left. Every answer is one the shelf vouched for — the
 * legs have no weaker grade to hand back — so the only thing left to decide
 * between two of them is which SET they came from, decided once, here
 * (02-redesign.md §5).
 *
 * A LEG IS ONE CALL AND A ROW IS ONE SET. The shelf search is a single signed
 * request that comes back carrying the shelf's candidates and the
 * marketplace's, so it yields two `LegResult`s and this writes two `legs` rows,
 * `team` and `public`, each with its own status, its own count and its own
 * outcome. Both rows carry the ONE call's `elapsed_ms`, so per-leg latency
 * comparisons across the two rows of one fire mean nothing from here on;
 * nothing queries that today.
 *
 * `team.publicFallback: off` no longer drops a planned leg on a machine with a
 * shelf: it sets `includePublic: false` on the request body, and the server
 * simply returns no public list. The filter below is kept for the NO-SHELF
 * case, where the single leg is `public` and dropping it is the only way to
 * honour the setting. A stage left with no legs is skipped and KEEPS ITS
 * INDEX, so the `stage` label on a `legs` row is the plan's own index whatever
 * was filtered before it.
 */

/** The whole ranking: a teammate's write-up beats a key match beats the
 *  marketplace (decision 13). Nothing else separates two answers now that a
 *  set has one grade to give. */
export const SHELF_RANK: Record<Shelf, number> = { team: 4, keys: 3, public: 1 };

function better(a: Answer | null, b: Answer): boolean {
  if (a === null) return true;
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
  /** Every set that ran, in `legs` row shape; `hit` marks the winner. */
  legs: LegRow[];
  /**
   * The credential failure a shelf call fell back to the public route over,
   * when one happened. It rides to the fire's `error` column: the answer was
   * still delivered, so this is not a reason, it is the thing doctor names.
   */
  authError?: string;
}

export async function ask(ctx: FireContext, plan: Plan): Promise<AskResult> {
  const { fire, deps } = ctx;
  const noPublic = deps.config().team.publicFallback === 'off';
  const rows: LegRow[] = [];
  let best: Answer | null = null;
  let bestRow: LegRow | null = null;
  let authError: string | undefined;

  for (let stage = 0; stage < plan.stages.length; stage += 1) {
    const planned = plan.stages[stage] ?? [];
    // Only a leg whose ONLY set is public can be dropped here: on a shelf call
    // the toggle already travelled in the body.
    const legs = noPublic
      ? planned.filter((leg) => !(leg.shelves.length === 1 && leg.shelves[0] === 'public'))
      : planned;
    if (legs.length === 0) continue;
    const budget = fire.remaining() - RESERVE_MS;
    if (budget <= 0) {
      for (const leg of legs) {
        for (const shelf of leg.shelves) {
          rows.push({ stage, shelf, status: 'timeout', outcome: 'no-answer', elapsed_ms: 0 });
        }
      }
      continue;
    }
    const signal = AbortSignal.any([fire.signal, AbortSignal.timeout(budget)]);
    const settled = await Promise.allSettled(
      legs.map((leg) => runLeg(leg, plan, budget, signal, deps)),
    );
    let stageAnswered = false;
    settled.forEach((s, i) => {
      const leg = legs[i];
      if (leg === undefined) return;
      if (s.status === 'rejected') {
        for (const shelf of leg.shelves) {
          rows.push({
            stage,
            shelf,
            status: statusOfError(s.reason, fire.signal),
            outcome: 'no-answer',
            elapsed_ms: 0,
          });
        }
        return;
      }
      const { results, elapsed } = s.value;
      for (const result of results) {
        if (result.authError !== undefined && authError === undefined) {
          authError = result.authError;
        }
        const row: LegRow = {
          stage,
          shelf: result.shelf,
          status: result.status,
          outcome: result.status === 'ok' ? (result.answer ? 'shadowed' : 'miss') : 'no-answer',
          elapsed_ms: elapsed,
          ...(result.searchId !== undefined ? { search_id: result.searchId } : {}),
          ...(result.title !== undefined ? { title: result.title } : {}),
          ...(result.url !== undefined ? { url: result.url } : {}),
          ...(result.form !== undefined ? { form: result.form } : {}),
          ...(result.calibration !== undefined ? { calibration: result.calibration } : {}),
        };
        rows.push(row);
        // ONLY AN `ok` SET CAN ANSWER. A leg that failed has nothing the server
        // vouched for, whatever it put in `answer`, and the row already says
        // `no-answer`; letting one through here would deliver on a refusal.
        const answer = result.status === 'ok' ? result.answer : null;
        if (answer !== null && better(best, answer)) {
          best = answer;
          bestRow = row;
        }
        if (answer !== null) stageAnswered = true;
      }
    });
    if (stageAnswered) break;
  }
  if (bestRow !== null) (bestRow as LegRow).outcome = 'hit';
  fire.legs.push(...rows);
  return { answer: best, legs: rows, ...(authError !== undefined ? { authError } : {}) };
}

async function runLeg(
  leg: Leg,
  plan: Plan,
  budget: number,
  signal: AbortSignal,
  deps: FireContext['deps'],
): Promise<{ results: LegResult[]; elapsed: number }> {
  const started = deps.clock();
  const results = await leg.request(plan.question, budget, signal, deps);
  const elapsed = deps.clock() - started;
  return { results, elapsed };
}
