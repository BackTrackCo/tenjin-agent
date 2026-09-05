import { randomUUID } from 'node:crypto';
import type { Emit, HookInput } from '../adapters/types';
import { actorOf } from './actor';
import { ask } from './ask';
import { finish, firstSight, gates, release } from './gates';
import { record } from './ledger';
import type { FireRecord } from './ledger';
import type { Actor, Arm, Deps, FireClock, FireContext, LegRow, Outcome, Question } from './types';

/**
 * The one lifecycle (02-redesign.md §5). A fire is one hook event with one
 * absolute deadline, one abort every fetch inherits, and exactly one ledger
 * row written by one function.
 *
 * Time: the deadline is `human_wait_ms` or `tool_wait_ms` by the arm's `wait`.
 * The bail timer resolves the fire with whatever legs settled and the reason
 * `deadline`; the harness closing its socket aborts the same controller
 * (`server.ts` hands that in as `clientSignal`). The done-latch in `commit`
 * keeps the bail path and the main path from both writing the row.
 */

export interface FireResult {
  emit: Emit | null;
  /** Write the ledger row. Idempotent; call after the response has flushed. */
  commit(): void;
}

const NONE: FireResult = { emit: null, commit: () => undefined };

export function selectArm(input: HookInput, arms: Arm[]): Arm | null {
  const kind = input.tool?.kind;
  for (const arm of arms) {
    for (const on of arm.on) {
      if (on.event !== input.event) continue;
      if (on.kind !== undefined && on.kind !== kind) continue;
      return arm;
    }
  }
  return null;
}

function skip(reason: Outcome['reason'], detail?: string): Outcome {
  return detail === undefined ? { reason } : { reason, detail };
}

function reasonOf(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`.slice(0, 500);
  return String(err).slice(0, 500);
}

function mergeEmit(delivery: Outcome['delivery'], after: Emit | null): Emit | null {
  const context = [delivery?.mode === 'inject' ? delivery.text : undefined, after?.context].filter(
    (t): t is string => typeof t === 'string' && t.length > 0,
  );
  const out: Emit = {};
  if (context.length > 0) out.context = context.join('\n\n');
  if (after?.block) out.block = after.block;
  return Object.keys(out).length === 0 ? null : out;
}

export async function runFire(
  input: HookInput,
  deps: Deps,
  clientSignal?: AbortSignal,
): Promise<FireResult> {
  const arm = selectArm(input, deps.arms);
  const actor = actorOf(input, deps.db);
  if (actor === null) return NONE; // phantom stop: quiet, no row
  const startedAt = deps.clock();
  const wait = arm?.wait ?? 'tool';
  const loop = deps.config().loop;
  const deadlineMs = wait === 'human' ? loop.human_wait_ms : loop.tool_wait_ms;
  const legs: LegRow[] = [];
  const controller = new AbortController();
  if (clientSignal) {
    if (clientSignal.aborted) controller.abort();
    else clientSignal.addEventListener('abort', () => controller.abort(), { once: true });
  }
  const fire: FireClock = {
    id: randomUUID(),
    startedAt,
    deadlineMs,
    remaining: () => Math.max(0, deadlineMs - (deps.clock() - startedAt)),
    signal: controller.signal,
    legs,
  };

  let outcome: Outcome;
  let emit: Emit | null = null;
  let questionKey: string | undefined;
  let question: string | undefined;
  /** The Question this fire built, for `after`: what was asked, never what a
   *  second look at the same input would ask now. */
  let asked: Question | null = null;

  if (arm === null) {
    outcome = skip('no-question');
  } else {
    const ctx: FireContext = { actor, input, arm, fire, deps };
    let timer: NodeJS.Timeout | undefined;
    const bail = new Promise<Outcome>((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve(skip('deadline'));
      }, deadlineMs);
    });
    // The question claim is released only while THIS fire holds it as
    // `asking`: never a `done` verdict `finish` just cached, and never a claim
    // an earlier fire made (the `cached` path claims nothing).
    let holdsClaim = false;
    const main = async (): Promise<Outcome> => {
      try {
        arm.before?.(ctx);
        const planned = arm.plan?.(ctx) ?? null;
        if (planned === null) return skip('no-question');
        if ('reason' in planned) {
          // The arm had text and refused it. The row keeps both, because the
          // skipped prompts are what a "/clear", a "yes" and a one-line
          // correction leave behind, and something has to read them.
          question = planned.text;
          return skip(planned.reason);
        }
        const plan = planned;
        asked = plan.question;
        questionKey = plan.question.questionKey;
        question = plan.question.text;
        const gated = gates(ctx, plan);
        let result: Outcome;
        if (gated !== null) {
          result = gated;
        } else {
          holdsClaim = true;
          const asked = await ask(ctx, plan);
          if (controller.signal.aborted) {
            release(deps.db, actor, plan.question.questionKey, fire.id);
            holdsClaim = false;
            return skip('deadline');
          }
          const definite = asked.legs.length > 0 && asked.legs.every((l) => l.status === 'ok');
          if (asked.answer === null && !definite) {
            release(deps.db, actor, plan.question.questionKey, fire.id);
            holdsClaim = false;
            return skip(
              asked.legs.some((l) => l.status === 'http_429') ? 'rate-server' : 'no-answer',
            );
          }
          finish(deps.db, actor, plan.question.questionKey, asked.answer, deps.clock(), fire.id);
          holdsClaim = false;
          result = asked.answer ? { reason: 'hit', answer: asked.answer } : skip('no-hit');
        }
        if (result.answer) {
          const delivery = arm.deliver?.(result.answer, ctx) ?? null;
          if (delivery === null) return { reason: 'no-hit', answer: result.answer };
          // ONCE-PER-PIECE IS ABOUT WHAT AN AGENT WAS SHOWN, so only an
          // injection burns the mark. A log-only arm looks a piece up to earn a
          // precision number and says nothing; burning the mark there would let
          // a silent lookup silence the real injection a prompt asks for a
          // second later (00-principles.md, principle 4).
          if (
            delivery.mode === 'inject' &&
            !firstSight(deps.db, actor, result.answer.resourceId, deps.clock())
          ) {
            return { reason: 'seen', answer: result.answer };
          }
          return { ...result, delivery };
        }
        return result;
      } catch (err) {
        if (holdsClaim && questionKey !== undefined) release(deps.db, actor, questionKey, fire.id);
        return skip('error', reasonOf(err));
      }
    };
    outcome = await Promise.race([main(), bail]);
    clearTimeout(timer);
    if (clientSignal?.aborted) {
      // The harness gave up on this fire: nothing we send will be read. BEFORE
      // `after`, because `after` is where an arm spends a local mark on the
      // question it asked — and a fire nobody is listening to must not spend
      // one, least of all while its own row says `deadline`.
      outcome = outcome.reason === 'deadline' ? outcome : { ...outcome, reason: 'deadline' };
    }
    if (outcome.reason !== 'deadline') {
      try {
        emit = mergeEmit(outcome.delivery, arm.after?.(ctx, outcome, asked) ?? null);
      } catch (err) {
        outcome = skip('error', reasonOf(err));
        emit = null;
      }
    }
  }

  let done = false;
  const row: FireRecord = {
    id: fire.id,
    at: startedAt,
    actor,
    arm: arm?.id ?? 'none',
    harness: input.harness,
    event: input.event,
    ...(input.turn !== undefined ? { promptId: input.turn } : {}),
    cwd: input.cwd,
    wait,
    deadlineMs,
    elapsedMs: deps.clock() - startedAt,
    outcome,
    ...(questionKey !== undefined ? { questionKey } : {}),
    ...(question !== undefined ? { question } : {}),
    emit,
    legs,
  };
  return {
    emit,
    commit() {
      if (done) return;
      done = true;
      row.elapsedMs = deps.clock() - startedAt;
      record(deps.db, deps.log, row);
    },
  };
}

export type { Actor };
