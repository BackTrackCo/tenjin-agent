import { httpRequest, type HttpResult } from '../lib/http';
import {
  isFeeRequired,
  NO_PAYER,
  readDecision,
  requestDecision,
  requestRefused,
  ROUTE_PAID_PATH,
  ROUTER_PATH,
  RouteSkipped,
  DEADLINE_AFTER_PAYMENT_SENT,
  PAYMENT_FAILED,
  type DecisionDeps,
  type DecisionOutcome,
  type HookResponse,
  type ToolResponse,
} from './decision';
import type { Packet } from './context';
import { readRouterMemo, TASK_ABSENT_MS, writeRouterMemo } from './router-memo';
import {
  buildRunBody,
  buildTaskReadBody,
  RunResponseSchema,
  TaskReadResponseSchema,
  type RunResponse,
} from './task-wire';

/**
 * THE NETWORK SIDE OF A ROUTED TASK: the free read, the free offer with its
 * fall back to today's paid flow, and the paid run.
 *
 * AN OFFER NEVER PAYS. A task client sends a hook line, a `{query}` and a
 * `{refused}` to the free route as a plain request: no payer, no wallet, no
 * turn on the routing channel, no 402 and no top-up wait. A router that
 * predates routed tasks answers `native` with `fee_required`; the same call
 * then goes to the paid route exactly as this CLI has always sent it (no
 * `task` in `accepts`, the payer, the quote checks), and the router is
 * remembered as one that predates them for {@link TASK_ABSENT_MS}, so a
 * session on it asks for each offer once, not twice.
 *
 * ONLY A RUN USES THE PAYER. Its body carries the task, the run id this client
 * picked, the amounts it approved and nothing of the input.
 */

/** Whether the router at `baseUrl` was found to predate routed tasks. */
export async function routerPredatesTasks(
  dataDir: string,
  baseUrl: string,
  now: number,
): Promise<boolean> {
  return (await readRouterMemo(dataDir, 'task-absent', baseUrl, now)) !== null;
}

/**
 * ONE OFFER REQUEST FOR A HOOK LINE, free first. `free` is the first attempt's
 * transport (the free route, no payer); the fallback is today's paid call, sent
 * with the caller's own deps. A free answer that is anything but the old
 * router's `fee_required` is the answer.
 */
export async function requestOffer(
  kind: 'hook',
  request: { packet: Packet; sessionId?: string },
  deps: DecisionDeps,
  now: number,
): Promise<DecisionOutcome<HookResponse>>;
export async function requestOffer(
  kind: 'tool',
  request: { query: string; id?: string },
  deps: DecisionDeps,
  now: number,
): Promise<DecisionOutcome<ToolResponse>>;
export async function requestOffer(
  kind: 'hook' | 'tool',
  request: { packet?: Packet; sessionId?: string; query?: string; id?: string },
  deps: DecisionDeps,
  now: number,
): Promise<DecisionOutcome<HookResponse | ToolResponse>> {
  if (!(await routerPredatesTasks(deps.ctx.dataDir, deps.baseUrl, now))) {
    const free = await (kind === 'hook'
      ? requestDecision(
          'hook',
          { packet: request.packet as Packet, ...sessionOf(request) },
          { ...withoutRoute(deps), free: true },
        )
      : requestDecision(
          'tool',
          { query: request.query as string, ...idOf(request) },
          { ...withoutRoute(deps), free: true },
        ));
    if (free.status !== 'decided' || !isFeeRequired(free.decision.decision)) return free;
    await writeRouterMemo(deps.ctx.dataDir, 'task-absent', deps.baseUrl, {
      now,
      ttlMs: TASK_ABSENT_MS,
      detail: 'the free route answered fee_required',
    });
  }
  return kind === 'hook'
    ? requestDecision('hook', { packet: request.packet as Packet, ...sessionOf(request) }, deps)
    : requestDecision('tool', { query: request.query as string, ...idOf(request) }, deps);
}

/** `{refused}`, free first, with the same fall back. */
export async function requestRefusedOffer(
  refused: string,
  deps: DecisionDeps,
  now: number,
): Promise<DecisionOutcome<ToolResponse>> {
  if (!(await routerPredatesTasks(deps.ctx.dataDir, deps.baseUrl, now))) {
    const free = await requestRefused(refused, { ...withoutRoute(deps), free: true });
    if (free.status !== 'decided' || !isFeeRequired(free.decision.decision)) return free;
    await writeRouterMemo(deps.ctx.dataDir, 'task-absent', deps.baseUrl, {
      now,
      ttlMs: TASK_ABSENT_MS,
      detail: 'the free route answered fee_required',
    });
  }
  return requestRefused(refused, deps);
}

function withoutRoute(deps: DecisionDeps): DecisionDeps {
  const rest = { ...deps };
  delete rest.route;
  return rest;
}

const sessionOf = (request: { sessionId?: string }) =>
  request.sessionId !== undefined ? { sessionId: request.sessionId } : {};
const idOf = (request: { id?: string }) => (request.id !== undefined ? { id: request.id } : {});

/** `{task}`: what one task takes, returns and costs, free, with no seller. */
export async function requestTaskRead(
  task: string,
  deps: Omit<DecisionDeps, 'route'>,
  opts: { anonymous?: boolean } = {},
) {
  return readDecision(
    await httpRequest(new URL(ROUTER_PATH, deps.baseUrl).toString(), {
      method: 'POST',
      timeoutMs: deps.timeoutMs ?? deps.ctx.flags.timeout,
      blockRedirects: true,
      ...(opts.anonymous === true ? { anonymous: true } : {}),
      jsonBody: buildTaskReadBody({
        task,
        bazaar: deps.acceptsBazaar === true,
        harness: deps.harness ?? 'claude',
        ...(deps.settings !== undefined ? { settings: deps.settings } : {}),
      }),
      ...(deps.fetchImpl !== undefined ? { fetchImpl: deps.fetchImpl } : {}),
    }),
    TaskReadResponseSchema,
  );
}

/**
 * ONE RUN ON THE PAID ROUTE, paid its routing fee by the payer, or skipped
 * when the payer cannot pay it ({@link RouteSkipped}). The run id is the
 * caller's: re-sent within the router's 15 minutes it is served the answer it
 * already paid for, at $0 and with no 402.
 */
export async function requestRun(
  request: {
    task: string;
    run: string;
    caps: { fee: bigint; seller: bigint };
    offer?: string;
    host?: string;
    choice?: string;
  },
  deps: DecisionDeps,
): Promise<DecisionOutcome<RunResponse>> {
  const url = new URL(ROUTE_PAID_PATH, deps.baseUrl).toString();
  const options = {
    method: 'POST' as const,
    timeoutMs: deps.timeoutMs ?? deps.ctx.flags.timeout,
    blockRedirects: true,
    jsonBody: buildRunBody({
      ...request,
      bazaar: deps.acceptsBazaar === true,
      harness: deps.harness ?? 'claude',
      improve: deps.improve === true,
      ...(deps.settings !== undefined ? { settings: deps.settings } : {}),
    }),
    ...(deps.fetchImpl !== undefined ? { fetchImpl: deps.fetchImpl } : {}),
  };
  let response: HttpResult;
  try {
    response = await (deps.route?.send ?? httpRequest)(url, options);
  } catch (err) {
    if (!(err instanceof RouteSkipped)) throw err;
    if (err.unreached !== undefined) return readDecision(err.unreached, RunResponseSchema);
    return {
      status: 'skipped',
      why: err.why,
      ...(err.quotedAtomic !== undefined ? { quotedAtomic: err.quotedAtomic } : {}),
      ...(err.answered ? { answered: true as const } : {}),
    };
  }
  if (deps.route === undefined && response.ok && response.status === 402) {
    return { status: 'skipped', why: NO_PAYER, answered: true };
  }
  return readDecision(response, RunResponseSchema);
}

/**
 * THE RUN, SENT AGAIN WITH ITS OWN ID AFTER A LOST ANSWER. The router serves a
 * run id it already answered the same answer at $0, so a reply lost after the
 * fee was signed costs no second fee: the payer waits out the first request
 * (`tail`), and a re-send finds the stored answer. One re-send only, and only
 * for an outcome that may have lost the answer: a payment sent with the call's
 * time over, a payment that failed on the wire, or no answer at all.
 */
export async function requestRunOnce(
  request: Parameters<typeof requestRun>[0],
  deps: DecisionDeps,
): Promise<DecisionOutcome<RunResponse> & { resent?: true }> {
  const first = await requestRun(request, deps);
  const mayHaveLostIt =
    (first.status === 'skipped' &&
      (first.why === DEADLINE_AFTER_PAYMENT_SENT || first.why === PAYMENT_FAILED)) ||
    (first.status === 'failed' && first.noAnswer === true && first.unreachable !== true);
  if (!mayHaveLostIt) return first;
  return { ...(await requestRun(request, deps)), resent: true };
}

/**
 * DOCTOR'S CHECK OF THE ROUTED-TASK ANSWER: one free read of a task id nobody
 * has. A router that knows routed tasks answers it with a decision (`needs_input`);
 * one that predates them refuses the unknown form (`validation_failed`), and
 * this CLI then sends offers to the paid route as it always did. Nothing is
 * paid and no gate runs; the request does not count this machine as an install.
 */
export async function checkTaskAnswer(deps: Omit<DecisionDeps, 'route'>): Promise<{
  status: 'ok' | 'warn';
  detail: string;
  fix?: string;
  checked?: false;
}> {
  const read = await requestTaskRead('doctor-check-no-such-task', deps, { anonymous: true });
  if (read.status === 'decided') {
    return { status: 'ok', detail: 'the router answers a task read, and offers are free' };
  }
  if (read.status === 'failed' && read.errorCode === 'validation_failed') {
    // Nothing to fix: the paid route serves every offer, as it always did.
    return {
      status: 'ok',
      detail: 'the router predates routed tasks, so offers still go to its paid route as before',
    };
  }
  return {
    status: 'warn',
    detail: `the task read was not checked (${read.status === 'failed' ? read.reason : 'no answer'})`,
    checked: false,
  };
}
