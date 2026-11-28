import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { testWalletProvider, buildPaymentRequired } from '../lib/read-test-utils';
import { httpRequest } from '../lib/http';
import { resolveSpendAuthorizer } from '../lib/wallet';
import { createQuote } from '../lib/spend-quotes';
import type { CommandContext } from '../context';
import {
  DEADLINE_AFTER_PAYMENT_SENT,
  PAYMENT_FAILED,
  ROUTE_PAID_PATH,
  ROUTER_PATH,
  RouteSkipped,
  acceptsFor,
  type DecisionRoute,
} from './decision';
import { runApproveTool, runRequestTool, type RequestToolDeps } from './tool';
import { runRequestCommand } from './operation-command';
import { checkOperationAnswer, requestRefusedOffer } from './operation-request';
import { storeSpecs } from './specs';
import { readRun, storeOperationRead } from './operation-store';
import { CliError } from '../lib/errors';
import { readRouterMemo } from './router-memo';

/**
 * A ROUTED OPERATION, END TO END AGAINST A SCRIPTED ROUTER AND TWO SCRIPTED
 * SERVICES. The operation, the services' specs and bodies are small invented
 * fixtures; nothing here reads a recorded body. No test opens a socket. A run
 * returns the service's own result, so the two services' results differ.
 */

const ROUTER = 'https://tenjin.sh';
const SERVICE_A = 'https://service-a.example.test/v1/search';
const SERVICE_B = 'https://service-b.example.test/v1/run/search';
const PAYEE_A = '0x1111111111111111111111111111111111111111';
const PAYEE_B = '0x2222222222222222222222222222222222222222';
const OP = 'x-post-search';
const INPUT = { query: 'x402 min_faves:5' };
const OFFER_ID = '0195f3a1-6c4d-7a2b-9e10-5f6a7b8c9d01';

let dir: string;
let allowlist: string[] = [];
beforeEach(async () => {
  allowlist = [];
  dir = await mkdtemp(join(tmpdir(), 'router-operation-'));
  await mkdir(join(dir, '.git'));
  await writeFile(
    join(dir, 'config.json'),
    JSON.stringify({ maxAutoSpend: '250000', sessionBudget: '5000000' }),
  );
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function ctx(): CommandContext {
  const sink = () => ({ write: () => true }) as unknown as NodeJS.WritableStream;
  return {
    flags: { json: true, timeout: 5000, baseUrl: ROUTER },
    dataDir: dir,
    io: { stdout: sink(), stderr: sink(), isTTY: false },
  };
}

/** The read: the lead service's input schema and the price, nothing else. */
const OPERATION = {
  id: OP,
  label: 'X post search',
  does: 'finds public posts that match search words',
  input: {
    type: 'object',
    properties: { query: { type: 'string', minLength: 1, maxLength: 200 } },
    required: ['query'],
    additionalProperties: false,
  },
  price: { expectedAtomic: '5000', maxAtomic: '5500', feeAtomic: '750' },
  free: false,
  kind: 'search',
};

function serviceSpec(
  url: string,
  payTo: string,
  label: string,
  over: Record<string, unknown> = {},
  price = '5000',
  max = '5500',
) {
  return {
    capabilityId: `service-${label}`,
    provider: `Provider ${label}`,
    label,
    description: 'searches posts',
    priceAtomic: price,
    priceVaries: false,
    maxAmountAtomic: max,
    payTo,
    network: 'eip155:8453',
    asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    request: { method: 'POST', url, fields: {}, location: 'body' },
    input: {
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
      additionalProperties: false,
    },
    pinned: {},
    // The fields this service promises: the result is cut to them.
    outputSchema: {
      type: 'object',
      properties: {
        tweets: {
          type: 'array',
          items: {
            type: 'object',
            properties: { url: { type: 'string' }, text: { type: 'string' } },
          },
        },
      },
    },
    ...over,
  };
}

const SPEC_A = () => serviceSpec(SERVICE_A, PAYEE_A, 'service-a');
const SPEC_B = () =>
  serviceSpec(SERVICE_B, PAYEE_B, 'service-b', {
    outputSchema: {
      type: 'object',
      properties: { output: { type: 'object', properties: { found: { type: 'boolean' } } } },
    },
  });

const BODY_A = {
  tweets: [
    {
      url: 'https://posts.example.test/ana/1',
      text: 'first invented post',
      author: { username: 'ana' },
    },
  ],
  next_cursor: 'c1',
};
const BODY_B = { output: { found: true, data: { items: [{ text: 'second invented post' }] } } };

interface ServiceScript {
  url: string;
  /** The live price its 402 asks. */
  live: string;
  payTo: string;
  body: unknown;
  /** The paid leg's reply never arrives. */
  dropsReply?: boolean;
  /** The status of the paid answer (a job's submit answers 202). */
  status?: number;
  /** Bytes sent as is in place of the JSON body (a file). */
  raw?: Uint8Array;
  contentType?: string;
}
const A: ServiceScript = { url: SERVICE_A, live: '5000', payTo: PAYEE_A, body: BODY_A };
const B: ServiceScript = { url: SERVICE_B, live: '1500', payTo: PAYEE_B, body: BODY_B };

interface Answer {
  /** The spec the run serves. Change it between calls to rotate the service. */
  lead: Record<string, unknown>;
  free?: 'offer' | 'fee_required';
  /** Fields added to the free route's offer (choices, rows, bound). */
  offerExtra?: Record<string, unknown>;
  /** The members a `choice: "all"` or `count` run is served as. */
  set?: { key?: string; spec: Record<string, unknown> }[];
  /** The router refuses the run, at $0, with this code. */
  noRun?: string;
  /** Other operations, by id, each with its own read. */
  operationsById?: Record<string, Record<string, unknown>>;
}

/** A router and its services, on one fetch, with every call recorded. */
class Stub {
  calls: { url: string; body?: Record<string, unknown>; signed: boolean }[] = [];
  runs = new Map<string, { settled: boolean }>();
  feePayments = 0;
  signatures = new Map<string, number>();
  constructor(
    public answer: Answer,
    private readonly services: ServiceScript[],
  ) {}

  fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = String(input);
    const signed = new Headers(init?.headers).has('payment-signature');
    const body =
      typeof init?.body === 'string'
        ? (JSON.parse(init.body) as Record<string, unknown>)
        : undefined;
    this.calls.push({ url, ...(body !== undefined ? { body } : {}), signed });
    const json = (value: unknown, status = 200, headers: Record<string, string> = {}) =>
      new Response(JSON.stringify(value), {
        status,
        headers: { 'content-type': 'application/json', ...headers },
      });
    const expiresAt = new Date(Date.now() + 15 * 60_000).toISOString();
    if (url === `${ROUTER}${ROUTER_PATH}`) {
      if (body?.operation !== undefined) {
        return json({
          schemaVersion: 1,
          routerVersion: 'v',
          operation: this.answer.operationsById?.[String(body.operation)] ?? OPERATION,
        });
      }
      if (this.answer.free === 'fee_required') {
        return json({
          schemaVersion: 1,
          routerVersion: 'v',
          decision: {
            action: 'native',
            reason: 'This route no longer routes.',
            diagnostics: {
              reasonCode: 'fee_required',
              stage: 'capability',
              missing: [],
              nextAction: 'Update.',
            },
          },
        });
      }
      if (body?.status !== undefined) return json({});
      return json({
        schemaVersion: 1,
        routerVersion: 'v',
        decision: {
          action: 'offer',
          id: OFFER_ID,
          task: 'x post search',
          operations: [
            {
              operation: OP,
              label: 'X post search',
              does: OPERATION.does,
              price: '$0.0058',
              input: { query: 'X search terms' },
            },
          ],
          hint: `Call request(${JSON.stringify({ operation: OP, input: { query: '<query>' } })}) alone and wait for its result.`,
          ...this.answer.offerExtra,
        },
      });
    }
    if (url === `${ROUTER}${ROUTE_PAID_PATH}`) {
      const run = String(body?.run);
      if (this.answer.noRun !== undefined) {
        return json({
          schemaVersion: 1,
          routerVersion: 'v',
          decision: {
            action: 'no_run',
            code: this.answer.noRun,
            reason: 'The router will not run it.',
          },
        });
      }
      if (this.answer.set !== undefined && (body?.choice === 'all' || body?.count !== undefined)) {
        const members =
          body?.count !== undefined
            ? Array.from({ length: Number(body.count) }, () => this.answer.set![0]!)
            : this.answer.set;
        this.feePayments += 1;
        this.runs.set(run, { settled: true });
        return json({
          schemaVersion: 1,
          routerVersion: 'v',
          decision: {
            action: 'run_set',
            run,
            operation: String(body?.operation ?? OP),
            expiresAt,
            routingFeeAtomic: String(750 * members.length),
            calls: members.map((m, i) => ({
              ...(m.key !== undefined ? { key: m.key } : {}),
              label: `member ${i}`,
              spec: m.spec,
            })),
          },
        });
      }
      const known = this.runs.get(run);
      const fee = known?.settled === true ? '0' : '750';
      if (known === undefined || !known.settled) this.feePayments += 1;
      this.runs.set(run, { settled: true });
      return json({
        schemaVersion: 1,
        routerVersion: 'v',
        decision: {
          action: 'run',
          run,
          operation: String(body?.operation ?? OP),
          expiresAt,
          routingFeeAtomic: fee,
          spec: this.answer.lead,
        },
      });
    }
    const service = this.services.find((s) => s.url === url);
    if (service === undefined) throw new Error(`unscripted request to ${url}`);
    if (!signed) {
      return json({}, 402, {
        'PAYMENT-REQUIRED': buildPaymentRequired({ amount: service.live, payTo: service.payTo })
          .header,
      });
    }
    this.signatures.set(url, (this.signatures.get(url) ?? 0) + 1);
    if (service.dropsReply === true) throw new TypeError('fetch failed');
    if (service.raw !== undefined) {
      return new Response(service.raw, {
        status: service.status ?? 200,
        headers: { 'content-type': service.contentType ?? 'application/octet-stream' },
      });
    }
    return json(service.body, service.status ?? 200);
  }) as typeof fetch;

  serviceRequests(): number {
    return this.calls.filter((c) => c.url.startsWith('https://service-')).length;
  }
  paidRouteRequests(): number {
    return this.calls.filter((c) => c.url === `${ROUTER}${ROUTE_PAID_PATH}`).length;
  }
  runBodies() {
    return this.calls.filter((c) => c.url === `${ROUTER}${ROUTE_PAID_PATH}`).map((c) => c.body!);
  }
  totalSignatures(): number {
    return [...this.signatures.values()].reduce((sum, n) => sum + n, 0);
  }
}

function deps(
  stub: Stub,
  over: Partial<RequestToolDeps> = {},
  route?: (send: DecisionRoute['send']) => DecisionRoute['send'],
): RequestToolDeps & { routed: { sent: number; limits: (bigint | undefined)[] } } {
  const routed = { sent: 0, limits: [] as (bigint | undefined)[] };
  const open = resolveSpendAuthorizer(ctx(), {
    maxAutoSpendAtomic: 250_000n,
    sessionBudgetAtomic: 5_000_000n,
    allowlistCreators: [],
  } as never);
  // A person's creator allowlist refuses every host it does not name.
  const authorizer =
    allowlist.length === 0
      ? open
      : {
          ...open,
          authorize: async (req: Parameters<typeof open.authorize>[0]) => ({
            ...(await open.authorize(req)),
            decision: 'deny' as const,
            reason: 'not_allowlisted' as const,
            message: 'the creator is not on the allowlist',
          }),
        };
  return {
    ctx: ctx(),
    cwd: dir,
    authorizer,
    fetchImpl: stub.fetch,
    payDeps: {
      readBalance: async () => 100_000_000n,
      fetchImpl: stub.fetch,
      provider: testWalletProvider(),
      authorizer,
      destination: { resolveHostname: async () => [{ address: '93.184.216.34', family: 4 }] },
    },
    route: (_baseUrl: string, limit?: bigint) => {
      routed.limits.push(limit);
      const send: DecisionRoute['send'] = async (url, options) => {
        routed.sent += 1;
        return httpRequest(url, { ...options, fetchImpl: stub.fetch });
      };
      return { send: route !== undefined ? route(send) : send };
    },
    ...over,
    routed,
  } as never;
}

/** Every string a result hands the model, which must not name a service's URL or host. */
function textOf(result: { summary: string; envelope: Record<string, unknown> }): string {
  return `${result.summary}\n${JSON.stringify(result.envelope)}`;
}
const NAMES = ['service-a.example.test', 'service-b.example.test', 'https://service-'];
const PROJECTED_A = {
  tweets: [{ url: 'https://posts.example.test/ana/1', text: 'first invented post' }],
};

describe("an operation run returns the service's own result", () => {
  it('cuts it to the fields the spec promises, saves the whole body, and shows both payments', async () => {
    const stub = new Stub({ lead: SPEC_A() }, [A]);
    const result = await runRequestTool({ operation: OP, input: INPUT }, deps(stub));
    expect(result.isError).toBe(false);
    expect(result.envelope).toMatchObject({
      status: 'fulfilled',
      operation: OP,
      service: 'service-a',
      receipt: {
        routingFee: { amount: '$0.00075', paid: true },
        service: { state: 'paid', amount: '$0.005', payee: PAYEE_A },
      },
    });
    expect(JSON.parse(String(result.envelope.result))).toEqual(PROJECTED_A);
    // No fixed output shape and no conversion: the whole body is on the machine.
    expect(result.envelope.output).toBeUndefined();
    const saved = JSON.parse(await readFile(String(result.envelope.fullResultPath), 'utf8'));
    expect(saved).toEqual(BODY_A);
    for (const name of NAMES) expect(textOf(result)).not.toContain(name);
    // The input stays here: the run request carries none of it.
    const run = stub.runBodies()[0]!;
    expect(JSON.stringify(run)).not.toContain('min_faves');
    expect(run).toMatchObject({ operation: OP, caps: { fee: '750', service: '5500' } });
    expect((run.accepts as string[]).includes('operation')).toBe(true);
  });

  it("after a rotation, returns the new service's own result with status fulfilled", async () => {
    const stub = new Stub({ lead: SPEC_A() }, [A, B]);
    const d = deps(stub);
    const first = await runRequestTool({ operation: OP, input: INPUT }, d);
    stub.answer.lead = SPEC_B();
    const second = await runRequestTool({ operation: OP, input: INPUT }, d);
    expect(second.envelope).toMatchObject({ status: 'fulfilled', service: 'service-b' });
    expect(JSON.parse(String(second.envelope.result))).toEqual({ output: { found: true } });
    expect(JSON.parse(String(first.envelope.result))).toEqual(PROJECTED_A);
  });

  it('sends nothing for an input the operation does not take', async () => {
    const stub = new Stub({ lead: SPEC_A() }, [A]);
    await storeOperationRead(dir, OPERATION as never, undefined);
    const result = await runRequestTool(
      { operation: OP, input: { query: '', extra: 1 } },
      deps(stub),
    );
    expect(result.envelope).toMatchObject({ status: 'needs_input' });
    expect(stub.calls).toEqual([]);
  });

  it('reads an operation for free and pays nothing', async () => {
    const stub = new Stub({ lead: SPEC_A() }, [A]);
    const d = deps(stub);
    const read = await runRequestTool({ operation: OP }, d);
    expect(read.envelope).toMatchObject({ status: 'operation', operation: OP });
    expect(read.envelope.output).toBeUndefined();
    expect(stub.calls.map((c) => c.url)).toEqual([`${ROUTER}${ROUTER_PATH}`]);
    expect(d.routed.sent).toBe(0);
    for (const name of NAMES) expect(textOf(read)).not.toContain(name);
  });

  it('passes the approved fee to the payer as its limit', async () => {
    const stub = new Stub({ lead: SPEC_A() }, [A]);
    const d = deps(stub);
    await runRequestTool({ operation: OP, input: INPUT }, d);
    expect(d.routed.limits).toEqual([750n]);
  });
});

describe("the input is checked against the run answer's own spec", () => {
  it('stops with the new fields when the service changed, pays the fee, pays no service, and pays again next time', async () => {
    const changed = serviceSpec(SERVICE_A, PAYEE_A, 'service-a', {
      input: {
        type: 'object',
        properties: { handle: { type: 'string', description: 'the account handle' } },
        required: ['handle'],
        additionalProperties: false,
      },
    });
    const stub = new Stub({ lead: changed }, [A]);
    const d = deps(stub);
    const stopped = await runRequestTool({ operation: OP, input: INPUT }, d);
    expect(stopped.envelope).toMatchObject({
      status: 'needs_input',
      receipt: { routingFee: { paid: true }, service: { state: 'not_paid' } },
    });
    expect(String(stopped.summary)).toContain('handle');
    expect(stopped.envelope.input).toEqual([expect.stringContaining('handle')]);
    expect(stub.totalSignatures()).toBe(0);
    expect(stub.serviceRequests()).toBe(0);
    expect(stub.feePayments).toBe(1);
    for (const name of NAMES) expect(textOf(stopped)).not.toContain(name);
    // The next call, with the new fields, is a new run: a second fee.
    await storeOperationRead(dir, { ...OPERATION, input: changed.input } as never, undefined);
    const again = await runRequestTool({ operation: OP, input: { handle: 'ana' } }, d);
    expect(again.envelope).toMatchObject({ status: 'fulfilled' });
    expect(stub.feePayments).toBe(2);
  });
});

describe('every call is a new run', () => {
  it('pays two fees and two service payments for two equal calls', async () => {
    const stub = new Stub({ lead: SPEC_A() }, [A]);
    const d = deps(stub);
    const one = await runRequestTool({ operation: OP, input: INPUT }, d);
    const two = await runRequestTool({ operation: OP, input: INPUT }, d);
    expect(one.envelope.status).toBe('fulfilled');
    expect(two.envelope.status).toBe('fulfilled');
    expect(one.envelope.run).not.toBe(two.envelope.run);
    expect(stub.feePayments).toBe(2);
    expect(stub.signatures.get(SERVICE_A)).toBe(2);
  });

  it('pays two fees for two equal calls that stopped before the service', async () => {
    const stub = new Stub({ lead: SPEC_A() }, [{ ...A, live: '9000' }]);
    const d = deps(stub);
    await runRequestTool({ operation: OP, input: INPUT }, d);
    await runRequestTool({ operation: OP, input: INPUT }, d);
    expect(stub.feePayments).toBe(2);
    expect(stub.totalSignatures()).toBe(0);
  });

  it('closes a run whose result was delivered, and never serves it again', async () => {
    const stub = new Stub({ lead: SPEC_A() }, [A]);
    const d = deps(stub, { approves: true });
    const done = await runRequestTool({ operation: OP, input: INPUT }, d);
    const run = String(done.envelope.run);
    expect((await readRun(dir, run))?.closedAt).toBeDefined();
    // A second attempt on that run, even with a quote, is refused.
    const made = await createQuote(dir, {
      what: 'a second attempt',
      sentence: 'A second attempt.',
      payments: [{ amountAtomic: 5500n, creator: 'service-a.example.test' }],
      call: { kind: 'operation_retry', run, operation: OP, label: 'X post search', input: INPUT },
    });
    const ran = await runApproveTool({ quote: made.id, total: '$0.0055', what: made.what }, d);
    expect(ran.envelope.status).toBe('needs_input');
    expect(stub.signatures.get(SERVICE_A)).toBe(1);
  });

  it('stops with nothing paid to a service when the live price is over the cap: no second service is tried', async () => {
    const stub = new Stub({ lead: SPEC_A() }, [{ ...A, live: '9000' }, B]);
    const result = await runRequestTool({ operation: OP, input: INPUT }, deps(stub));
    expect(result.envelope.status).not.toBe('fulfilled');
    expect(stub.totalSignatures()).toBe(0);
    expect(stub.feePayments).toBe(1);
    expect(stub.calls.some((c) => c.url === SERVICE_B)).toBe(false);
  });
});

describe('one quote for both payments', () => {
  it('keeps a plan over the limits as one quote, sends nothing paid, and runs it on a yes', async () => {
    await writeFile(
      join(dir, 'config.json'),
      JSON.stringify({ maxAutoSpend: '4000', sessionBudget: '5000000' }),
    );
    const stub = new Stub({ lead: SPEC_A() }, [A]);
    const d = deps(stub, { approves: true });
    const stopped = await runRequestTool({ operation: OP, input: INPUT }, d);
    expect(stopped.envelope).toMatchObject({ status: 'needs_approval' });
    const quote = stopped.envelope.quote as { id: string; total: string; what: string };
    expect(quote.total).toBe('$0.00625');
    expect(stopped.summary).toContain('about $0.00575');
    expect(stub.paidRouteRequests()).toBe(0);
    expect(stub.serviceRequests()).toBe(0);
    expect(d.routed.sent).toBe(0);
    const ran = await runApproveTool({ quote: quote.id, total: quote.total, what: quote.what }, d);
    expect(ran.envelope).toMatchObject({ status: 'fulfilled' });
    expect(stub.feePayments).toBe(1);
    expect(stub.signatures.get(SERVICE_A)).toBe(1);
  });
});

describe('a service reply lost after the payment was signed', () => {
  it('stops with a receipt and signs a second payment only on a yes', async () => {
    const stub = new Stub({ lead: SPEC_A() }, [{ ...A, dropsReply: true }]);
    const d = deps(stub, { approves: true });
    const lost = await runRequestTool({ operation: OP, input: INPUT }, d);
    expect(lost.isError).toBe(true);
    expect(lost.envelope).toMatchObject({
      possiblyPaid: true,
      receipt: {
        routingFee: { amount: '$0.00075', paid: true },
        service: { state: 'possibly_paid', payee: PAYEE_A },
      },
    });
    expect(stub.signatures.get(SERVICE_A)).toBe(1);
    for (const name of NAMES) expect(textOf(lost)).not.toContain(name);
    const quote = lost.envelope.quote as { id: string; total: string; what: string };
    expect(quote).toBeDefined();
    expect(stub.signatures.get(SERVICE_A)).toBe(1);
    stub.fetch = new Stub({ lead: SPEC_A() }, [A]).fetch;
    const rerun = await runApproveTool(
      { quote: quote.id, total: quote.total, what: quote.what },
      deps(stub, { approves: true }),
    );
    expect(rerun.envelope).toMatchObject({ status: 'fulfilled' });
    expect(stub.feePayments).toBe(1);
  });
});

describe('a run answer lost on the way back', () => {
  it('re-sends the same run id once and pays the fee once when the first payment settled', async () => {
    const stub = new Stub({ lead: SPEC_A() }, [A]);
    let first = true;
    const d = deps(stub, {}, (send) => async (url, options) => {
      if (first) {
        first = false;
        await send(url, options);
        throw new RouteSkipped(DEADLINE_AFTER_PAYMENT_SENT);
      }
      return send(url, options);
    });
    const result = await runRequestTool({ operation: OP, input: INPUT }, d);
    expect(result.envelope).toMatchObject({ status: 'fulfilled' });
    const runs = stub.runBodies().map((b) => b.run);
    expect(new Set(runs).size).toBe(1);
    expect(runs).toHaveLength(2);
    expect(stub.feePayments).toBe(1);
    expect(result.envelope).toMatchObject({ receipt: { routingFee: { amount: '$0.00075' } } });
  });

  it('is asked to pay again when the first payment never settled, and pays the fee once in total', async () => {
    const stub = new Stub({ lead: SPEC_A() }, [A]);
    let first = true;
    const d = deps(stub, {}, (send) => async (url, options) => {
      if (first) {
        first = false;
        throw new RouteSkipped(PAYMENT_FAILED);
      }
      return send(url, options);
    });
    const result = await runRequestTool({ operation: OP, input: INPUT }, d);
    expect(result.envelope).toMatchObject({ status: 'fulfilled' });
    expect(stub.feePayments).toBe(1);
    expect(stub.signatures.get(SERVICE_A)).toBe(1);
  });
});

describe('an offer of operations', () => {
  it("comes from the free route with no payer, shows each row's input fields, and runs by its id", async () => {
    const stub = new Stub({ lead: SPEC_A() }, [A]);
    const d = deps(stub);
    const offered = await runRequestTool({ query: 'search X for x402 posts' }, d);
    expect(offered.envelope).toMatchObject({
      status: 'offer',
      task: 'x post search',
      operations: [{ operation: OP, input: { query: 'X search terms' } }],
    });
    expect(offered.summary).toContain('Input fields: query (X search terms)');
    expect(d.routed.sent).toBe(0);
    expect(stub.calls.map((c) => c.url)).toEqual([`${ROUTER}${ROUTER_PATH}`]);
    expect((stub.calls[0]!.body!.accepts as string[]).includes('operation')).toBe(true);
    const ran = await runRequestTool(
      { operation: OP, id: offered.envelope.id as string, input: INPUT },
      d,
    );
    expect(ran.envelope).toMatchObject({ status: 'fulfilled' });
    expect(stub.runBodies()[0]).toMatchObject({ offer: OFFER_ID });
  });

  it('is never skipped behind a busy channel', async () => {
    const stub = new Stub({ lead: SPEC_A() }, [A]);
    const d = deps(stub, {}, () => async () => {
      throw new RouteSkipped('channel_busy');
    });
    const offered = await runRequestTool({ query: 'search X for x402 posts' }, d);
    expect(offered.envelope.status).toBe('offer');
    expect(d.routed.sent).toBe(0);
  });

  const rows = Array.from({ length: 16 }, (_, i) => ({
    operation: i === 0 ? OP : `other-operation-${i}`,
    label: `Operation ${i}`,
    does: `does the number ${i} job on posts ${'and more words '.repeat(i % 3)}`,
    price: '$0.005',
    input: { query: 'search terms' },
  }));

  it('lists sixteen rows, each with its label, price and input fields, and no service', async () => {
    const stub = new Stub({ lead: SPEC_A(), offerExtra: { operations: rows } }, []);
    const offered = await runRequestTool({ query: 'search X' }, deps(stub));
    expect(offered.envelope.status).toBe('offer');
    expect((offered.envelope.operations as unknown[]).length).toBe(16);
    for (const row of rows) {
      expect(offered.summary).toContain(`${row.label} (operation ${row.operation}, $0.005)`);
    }
    expect(offered.summary).toContain('To run an operation other than the first');
    for (const name of NAMES) expect(textOf(offered)).not.toContain(name);
    expect(offered.summary.length).toBeLessThan(5_000);
  });

  it('cuts an offer of more than sixteen rows to sixteen and keeps the answer', async () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ ...rows[i % 16]!, operation: `t-${i}` }));
    const stub = new Stub({ lead: SPEC_A(), offerExtra: { operations: many } }, []);
    const offered = await runRequestTool({ query: 'search X' }, deps(stub));
    expect((offered.envelope.operations as unknown[]).length).toBe(16);
  });

  it('runs an operation other than the lead, checking the input against that operation', async () => {
    const other = {
      ...OPERATION,
      id: 'other-operation-5',
      label: 'Operation 5',
      input: {
        type: 'object',
        properties: { handle: { type: 'string', minLength: 1 } },
        required: ['handle'],
        additionalProperties: false,
      },
    };
    const stub = new Stub(
      {
        lead: serviceSpec(SERVICE_A, PAYEE_A, 'service-a', { input: other.input }),
        offerExtra: { operations: rows },
        operationsById: { 'other-operation-5': other },
      },
      [A],
    );
    const d = deps(stub);
    const offered = await runRequestTool({ query: 'search X' }, d);
    const id = offered.envelope.id as string;
    const wrong = await runRequestTool({ operation: 'other-operation-5', id, input: INPUT }, d);
    expect(wrong.envelope.status).toBe('needs_input');
    expect(stub.paidRouteRequests()).toBe(0);
    const ran = await runRequestTool(
      { operation: 'other-operation-5', id, input: { handle: 'ana' } },
      d,
    );
    expect(ran.envelope).toMatchObject({ status: 'fulfilled' });
    expect(stub.runBodies()[0]).toMatchObject({ operation: 'other-operation-5', offer: id });
  });
});

describe('a router that predates routed operations', () => {
  it("gets today's paid call, with no operation in accepts, after one free try", async () => {
    const stub = new Stub({ lead: SPEC_A(), free: 'fee_required' }, []);
    const paidDecision = {
      schemaVersion: 1,
      routerVersion: 'v',
      decision: {
        action: 'native',
        reason: 'no',
        diagnostics: {
          reasonCode: 'native_sufficient',
          stage: 'capability',
          missing: [],
          nextAction: 'x',
        },
      },
    };
    const inner = stub.fetch;
    stub.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) =>
      String(input) === `${ROUTER}${ROUTE_PAID_PATH}`
        ? (stub.calls.push({
            url: String(input),
            body: JSON.parse(String(init?.body)) as Record<string, unknown>,
            signed: false,
          }),
          new Response(JSON.stringify(paidDecision), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }))
        : inner(input, init)) as typeof fetch;
    const d = deps(stub);
    await runRequestTool({ query: 'BTC price' }, d);
    expect(stub.calls.map((c) => c.url)).toEqual([
      `${ROUTER}${ROUTER_PATH}`,
      `${ROUTER}${ROUTE_PAID_PATH}`,
    ]);
    const paid = stub.calls[1]!.body!;
    expect(paid).toEqual({
      schemaVersion: 1,
      query: 'BTC price',
      accepts: acceptsFor(false, true),
      harness: 'claude',
      ...(paid.settings !== undefined ? { settings: paid.settings } : {}),
    });
    expect((paid.accepts as string[]).includes('operation')).toBe(false);
    expect(d.routed.sent).toBe(1);
    expect(await readRouterMemo(dir, 'operation-absent', ROUTER, Date.now())).not.toBeNull();
    await runRequestTool({ query: 'BTC price again' }, d);
    expect(stub.calls.map((c) => c.url).slice(2)).toEqual([`${ROUTER}${ROUTE_PAID_PATH}`]);
  });

  it('reads an operation id with the old tool read when the router does not know the form', async () => {
    const calls: string[] = [];
    const fetchImpl = (async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      calls.push(String(init?.body));
      return new Response(
        JSON.stringify({ error: { code: 'validation_failed', message: 'Invalid request body' } }),
        { status: 400, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof fetch;
    const result = await runRequestTool(
      { operation: 'some-service' },
      { ...deps(new Stub({ lead: SPEC_A() }, []), {}), fetchImpl },
    );
    expect(calls).toHaveLength(2);
    expect(JSON.parse(calls[0]!)).toHaveProperty('operation', 'some-service');
    expect(JSON.parse(calls[1]!)).toHaveProperty('tool', 'some-service');
    expect(result.envelope).toBeDefined();
  });
});

describe('tenjin request, for scripts', () => {
  it('prints the envelope of a fulfilled run', async () => {
    const stub = new Stub({ lead: SPEC_A() }, [A]);
    const seams = { ...deps(stub), provider: testWalletProvider() };
    const done = await runRequestCommand(
      ctx(),
      { operation: OP, input: JSON.stringify(INPUT) },
      seams,
    );
    expect(done.data).toMatchObject({ status: 'fulfilled', operation: OP });
    expect(stub.feePayments).toBe(1);
  });

  it('obeys the spend limits: over them nothing is paid, and the exit code says refused', async () => {
    await writeFile(
      join(dir, 'config.json'),
      JSON.stringify({ maxAutoSpend: '4000', sessionBudget: '5000000' }),
    );
    const stub = new Stub({ lead: SPEC_A() }, [A]);
    const refused = await runRequestCommand(
      ctx(),
      { operation: OP, input: JSON.stringify(INPUT) },
      deps(stub),
    ).catch((err: unknown) => err);
    expect(refused).toBeInstanceOf(CliError);
    expect((refused as CliError).exitCode).toBe(3);
    expect(stub.paidRouteRequests()).toBe(0);
    expect(stub.serviceRequests()).toBe(0);
  });

  it('exits 2 for an input the service does not take, with nothing paid to a service', async () => {
    const changed = serviceSpec(SERVICE_A, PAYEE_A, 'service-a', {
      input: {
        type: 'object',
        properties: { handle: { type: 'string' } },
        required: ['handle'],
        additionalProperties: false,
      },
    });
    const stub = new Stub({ lead: changed }, [A]);
    const refused = await runRequestCommand(
      ctx(),
      { operation: OP, input: JSON.stringify(INPUT) },
      { ...deps(stub), provider: testWalletProvider() },
    ).catch((err: unknown) => err);
    expect((refused as CliError).exitCode).toBe(2);
    expect(stub.totalSignatures()).toBe(0);
  });

  it('refuses an input that is not one JSON object, with the usage exit code', async () => {
    const stub = new Stub({ lead: SPEC_A() }, []);
    const refused = await runRequestCommand(
      ctx(),
      { operation: OP, input: '[1]' },
      deps(stub),
    ).catch((err: unknown) => err);
    expect((refused as CliError).exitCode).toBe(2);
    expect(stub.calls).toEqual([]);
  });
});

describe('tenjin doctor, the routed-operation answer', () => {
  const answer = (status: number, body: unknown): typeof fetch =>
    (async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch;
  const base = () => ({ ctx: ctx(), baseUrl: ROUTER });

  it('reads a decision about an unknown operation as a router that serves operations', async () => {
    const needsInput = {
      schemaVersion: 1,
      routerVersion: 'v',
      decision: {
        action: 'needs_input',
        reason: 'No such operation.',
        diagnostics: {
          reasonCode: 'capability_unresolved',
          stage: 'capability',
          missing: [],
          nextAction: 'Browse.',
        },
      },
    };
    expect(
      await checkOperationAnswer({ ...base(), fetchImpl: answer(200, needsInput) }),
    ).toMatchObject({ status: 'ok', detail: expect.stringContaining('offers are free') });
  });

  it('reads a refused form as a router that predates operations, with nothing to fix', async () => {
    const refused = { error: { code: 'validation_failed', message: 'Invalid request body' } };
    expect(
      await checkOperationAnswer({ ...base(), fetchImpl: answer(400, refused) }),
    ).toMatchObject({
      status: 'ok',
      detail: expect.stringContaining('predates routed operations'),
    });
  });

  it('says not checked on any other answer', async () => {
    expect(await checkOperationAnswer({ ...base(), fetchImpl: answer(503, {}) })).toMatchObject({
      status: 'warn',
      checked: false,
    });
  });
});

const OPTIONS = {
  group: 'x search',
  default: 'a',
  options: [
    { key: 'a', label: 'Option A', strength: 'broad', operation: OP },
    { key: 'b', label: 'Option B', strength: 'cheap', operation: OP },
  ],
  all: { totalAtomic: '11500' },
};
const SET = [
  { key: 'a', spec: SPEC_A() },
  { key: 'b', spec: SPEC_B() },
];

describe('a set of runs', () => {
  it('runs every choice as one quote and one fee, each service paid once, each with its own result', async () => {
    const stub = new Stub({ lead: SPEC_A(), offerExtra: { choices: OPTIONS }, set: SET }, [A, B]);
    const d = deps(stub);
    const offered = await runRequestTool({ query: 'search X' }, d);
    expect(offered.summary).toContain('Choices (x search)');
    const result = await runRequestTool(
      { operation: OP, id: offered.envelope.id as string, choice: 'all', input: INPUT },
      d,
    );
    expect(result.envelope).toMatchObject({
      status: 'fulfilled',
      receipt: { routingFee: { amount: '$0.0015' } },
    });
    const members = result.envelope.results as { result: string; payment: { state: string } }[];
    expect(JSON.parse(members[0]!.result)).toEqual(PROJECTED_A);
    expect(JSON.parse(members[1]!.result)).toEqual({ output: { found: true } });
    expect(members.map((m) => m.payment.state)).toEqual(['paid', 'paid']);
    expect(stub.feePayments).toBe(1);
    expect(stub.signatures.get(SERVICE_A)).toBe(1);
    expect(stub.signatures.get(SERVICE_B)).toBe(1);
    const run = stub.runBodies()[0]!;
    expect(run).toMatchObject({ choice: 'all', caps: { fee: '1500', service: '5500' } });
    expect(JSON.stringify(run)).not.toContain('min_faves');
    for (const name of NAMES) expect(textOf(result)).not.toContain(name);
    expect(d.routed.limits.at(-1)).toBe(1500n);
  });

  it('holds a set over the limits as one quote with the fees summed, and signs nothing before the yes', async () => {
    await writeFile(
      join(dir, 'config.json'),
      JSON.stringify({ maxAutoSpend: '4000', sessionBudget: '5000000' }),
    );
    const stub = new Stub({ lead: SPEC_A(), set: [SET[0]!] }, [A]);
    const d = deps(stub, { approves: true });
    const stopped = await runRequestTool({ operation: OP, count: 2, input: INPUT }, d);
    expect(stopped.envelope).toMatchObject({ status: 'needs_approval' });
    expect((stopped.envelope.quote as { total: string }).total).toBe('$0.0125');
    expect(stub.paidRouteRequests()).toBe(0);
    expect(stub.serviceRequests()).toBe(0);
    const quote = stopped.envelope.quote as { id: string; total: string; what: string };
    const ran = await runApproveTool({ quote: quote.id, total: quote.total, what: quote.what }, d);
    expect(ran.envelope).toMatchObject({ status: 'fulfilled' });
    expect(stub.signatures.get(SERVICE_A)).toBe(2);
    expect(stub.feePayments).toBe(1);
  });

  it('pays a member once even when its reply is lost, and the others still run', async () => {
    const stub = new Stub({ lead: SPEC_A(), offerExtra: { choices: OPTIONS }, set: SET }, [
      { ...A, dropsReply: true },
      B,
    ]);
    const d = deps(stub);
    await runRequestTool({ query: 'search X' }, d);
    const result = await runRequestTool(
      { operation: OP, id: OFFER_ID, choice: 'all', input: INPUT },
      d,
    );
    expect(result.envelope).toMatchObject({ status: 'partial', possiblyPaid: true });
    expect(stub.signatures.get(SERVICE_A)).toBe(1);
    expect(stub.signatures.get(SERVICE_B)).toBe(1);
  });

  it.each(['unknown_choice', 'count_over_max', 'offer_expired', 'run_id_taken', 'over_caps'])(
    'says %s plainly and pays nothing',
    async (code) => {
      const stub = new Stub({ lead: SPEC_A(), noRun: code }, [A]);
      const result = await runRequestTool({ operation: OP, count: 2, input: INPUT }, deps(stub));
      expect(result.envelope).toMatchObject({ status: 'needs_input' });
      expect(result.summary).toContain('Nothing was paid');
      expect(stub.totalSignatures()).toBe(0);
    },
  );
});

describe('offer picks and open-Bazaar rows', () => {
  it('runs the option a choice names, sending its key and operation', async () => {
    const stub = new Stub({ lead: SPEC_A(), offerExtra: { choices: OPTIONS } }, [A]);
    const d = deps(stub);
    const offered = await runRequestTool({ query: 'search X' }, d);
    const ran = await runRequestTool(
      { operation: OP, id: offered.envelope.id as string, choice: 'b', input: INPUT },
      d,
    );
    expect(ran.envelope).toMatchObject({ status: 'fulfilled' });
    expect(stub.runBodies()[0]).toMatchObject({ operation: OP, choice: 'b' });
  });

  it('runs a listing row through the same checkout, with its offer row sent back and no service named', async () => {
    const row = {
      operation: 'listing-1',
      label: 'A listed search',
      does: 'finds things',
      price: '$0.005',
      offer: '0195f3a1-6c4d-7a2b-9e10-5f6a7b8c9d77',
    };
    const stub = new Stub({ lead: SPEC_A(), offerExtra: { operations: [row] } }, [A]);
    const d = deps(stub);
    const offered = await runRequestTool({ query: 'search X' }, d);
    for (const name of NAMES) expect(textOf(offered)).not.toContain(name);
    const ran = await runRequestTool(
      { operation: 'listing-1', id: offered.envelope.id as string, input: { query: 'x402' } },
      d,
    );
    expect(ran.envelope).toMatchObject({
      status: 'fulfilled',
      receipt: { routingFee: { paid: true } },
    });
    const run = stub.runBodies()[0]!;
    expect(run).toMatchObject({ operation: 'listing-1', offer: row.offer });
    expect(run).toMatchObject({ caps: { fee: '750', service: '5500' } });
    for (const name of NAMES) expect(textOf(ran)).not.toContain(name);
  });

  it('runs the option that was quoted, after approve, not the default', async () => {
    const stub = new Stub({ lead: SPEC_A(), offerExtra: { choices: OPTIONS } }, [A]);
    const d = deps(stub, { approves: true });
    const offered = await runRequestTool({ query: 'search X' }, d);
    await writeFile(
      join(dir, 'config.json'),
      JSON.stringify({ maxAutoSpend: '4000', sessionBudget: '5000000' }),
    );
    const stopped = await runRequestTool(
      { operation: OP, id: offered.envelope.id as string, choice: 'b', input: INPUT },
      d,
    );
    expect(stopped.envelope).toMatchObject({ status: 'needs_approval' });
    expect(stub.paidRouteRequests()).toBe(0);
    const quote = stopped.envelope.quote as { id: string; total: string; what: string };
    const ran = await runApproveTool({ quote: quote.id, total: quote.total, what: quote.what }, d);
    expect(ran.envelope).toMatchObject({ status: 'fulfilled' });
    expect(stub.runBodies()[0]).toMatchObject({ choice: 'b', offer: offered.envelope.id });
  });
});

describe('the re-ask after an account refuses', () => {
  it('asks the free route first and falls back to the paid route for a router that predates operations', async () => {
    const urls: string[] = [];
    const fetchImpl = (async (input: Parameters<typeof fetch>[0]) => {
      urls.push(String(input));
      const reason = String(input).endsWith(ROUTER_PATH) ? 'fee_required' : 'native_sufficient';
      return new Response(
        JSON.stringify({
          schemaVersion: 1,
          routerVersion: 'v',
          decision: {
            action: 'native',
            reason: 'no',
            diagnostics: { reasonCode: reason, stage: 'capability', missing: [], nextAction: 'x' },
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof fetch;
    const answer = await requestRefusedOffer(
      OFFER_ID,
      { ctx: ctx(), baseUrl: ROUTER, fetchImpl },
      Date.now(),
    );
    expect(urls).toEqual([`${ROUTER}${ROUTER_PATH}`, `${ROUTER}${ROUTE_PAID_PATH}`]);
    expect(answer.status).toBe('decided');
    await requestRefusedOffer(OFFER_ID, { ctx: ctx(), baseUrl: ROUTER, fetchImpl }, Date.now());
    expect(urls.slice(2)).toEqual([`${ROUTER}${ROUTE_PAID_PATH}`]);
  });
});

describe("the person's creator allowlist", () => {
  it('refuses a service it does not name at signing: the fee is paid, the service is not', async () => {
    allowlist = ['tenjin.sh'];
    const stub = new Stub({ lead: SPEC_A() }, [A]);
    const result = await runRequestTool({ operation: OP, input: INPUT }, deps(stub));
    expect(result.envelope.status).toBe('needs_approval');
    expect(result.envelope).toMatchObject({
      receipt: { routingFee: { paid: true }, service: { state: 'not_paid' } },
    });
    expect(stub.totalSignatures()).toBe(0);
    expect(stub.feePayments).toBe(1);
  });
});

describe('every ending of a paid run keeps the result or the means to collect it', () => {
  const JOB = {
    pollUrl: { field: 'statusUrl' },
    pollMethod: 'GET',
    running: { field: 'status', values: ['running'] },
    everyS: 1,
    maxWaitS: 30,
    keepH: 1,
  };
  const SUBMITTED = { status: 'running', statusUrl: 'https://service-a.example.test/jobs/1' };

  function jobDeps(stub: Stub, answers: unknown[]) {
    let clock = Date.now();
    const pollTransport = (async () => {
      const next = answers.length > 1 ? answers.shift() : answers[0];
      return {
        status: 200,
        header: () => undefined,
        body: (async function* () {
          yield new TextEncoder().encode(JSON.stringify(next));
        })(),
        discard: () => undefined,
      };
    }) as never;
    return deps(stub, {
      pollTransport,
      now: () => clock,
      sleep: async (ms: number) => {
        clock += ms;
      },
    });
  }
  const jobbed = () => ({ lead: { ...SPEC_A(), job: JOB } });
  const means = (envelope: Record<string, unknown>) =>
    ['result', 'job', 'savedFiles', 'fullResultPath'].filter((key) => envelope[key] !== undefined);

  const ENDINGS: {
    name: string;
    run: () => Promise<{ envelope: Record<string, unknown>; stub: Stub }>;
    status: string;
    carries: string[];
  }[] = [
    {
      name: 'a run',
      status: 'fulfilled',
      carries: ['result', 'fullResultPath'],
      run: async () => {
        const stub = new Stub({ lead: SPEC_A() }, [A]);
        return {
          stub,
          envelope: (await runRequestTool({ operation: OP, input: INPUT }, deps(stub))).envelope,
        };
      },
    },
    {
      name: 'a run whose service has no promised fields',
      status: 'fulfilled',
      carries: ['result'],
      run: async () => {
        const plain = serviceSpec(SERVICE_A, PAYEE_A, 'plain');
        delete (plain as Record<string, unknown>).outputSchema;
        const stub = new Stub({ lead: plain }, [A]);
        return {
          stub,
          envelope: (await runRequestTool({ operation: OP, input: INPUT }, deps(stub))).envelope,
        };
      },
    },
    {
      name: 'a set member',
      status: 'fulfilled',
      carries: ['result'],
      run: async () => {
        const stub = new Stub({ lead: SPEC_A(), set: [{ key: 'a', spec: SPEC_A() }] }, [A]);
        const result = await runRequestTool({ operation: OP, count: 2, input: INPUT }, deps(stub));
        return { stub, envelope: (result.envelope.results as Record<string, unknown>[])[0]! };
      },
    },
    {
      name: 'a running job',
      status: 'running',
      carries: ['job'],
      run: async () => {
        const stub = new Stub(jobbed(), [{ ...A, status: 202, body: SUBMITTED }]);
        return {
          stub,
          envelope: (
            await runRequestTool(
              { operation: OP, input: INPUT },
              jobDeps(stub, [{ status: 'running' }]),
            )
          ).envelope,
        };
      },
    },
    {
      name: 'a job read later',
      status: 'fulfilled',
      carries: ['result'],
      run: async () => {
        const stub = new Stub(jobbed(), [{ ...A, status: 202, body: SUBMITTED }]);
        const first = await runRequestTool(
          { operation: OP, input: INPUT },
          jobDeps(stub, [{ status: 'running' }]),
        );
        const later = await runRequestTool(
          { job: String(first.envelope.job) },
          jobDeps(stub, [{ status: 'done', ...BODY_A }]),
        );
        return { stub, envelope: later.envelope };
      },
    },
    {
      name: 'a file result',
      status: 'fulfilled',
      carries: ['savedFiles'],
      run: async () => {
        const media = serviceSpec(SERVICE_A, PAYEE_A, 'media', { output: 'media' });
        delete (media as Record<string, unknown>).outputSchema;
        const stub = new Stub({ lead: media }, [
          {
            ...A,
            body: { files: [] },
            raw: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
            contentType: 'image/png',
          },
        ]);
        return {
          stub,
          envelope: (await runRequestTool({ operation: OP, input: INPUT }, deps(stub))).envelope,
        };
      },
    },
  ];

  it.each(ENDINGS)(
    '$name: status, the means to collect it, and no second payment',
    async (ending) => {
      const { stub, envelope } = await ending.run();
      expect(envelope.status).toBe(ending.status);
      for (const key of ending.carries) expect(envelope[key], key).toBeDefined();
      expect(means(envelope).length).toBeGreaterThan(0);
      expect(stub.signatures.get(SERVICE_A) ?? 0).toBeLessThanOrEqual(
        ending.name === 'a set member' ? 2 : 1,
      );
    },
  );

  it("a resumed job returns the service's own result, as main does", async () => {
    const stub = new Stub(jobbed(), [{ ...A, status: 202, body: SUBMITTED }]);
    const first = await runRequestTool(
      { operation: OP, input: INPUT },
      jobDeps(stub, [{ status: 'running' }]),
    );
    const later = await runRequestTool(
      { job: String(first.envelope.job) },
      jobDeps(stub, [{ status: 'done', ...BODY_A }]),
    );
    expect(later.envelope.status).toBe('fulfilled');
    expect(later.envelope.output).toBeUndefined();
    expect(JSON.parse(String(later.envelope.result))).toEqual(PROJECTED_A);
    expect(stub.signatures.get(SERVICE_A)).toBe(1);
  });

  it('a set member whose job is still running keeps its job id and next step', async () => {
    const stub = new Stub({ lead: jobbed().lead, set: [{ key: 'a', spec: jobbed().lead }] }, [
      { ...A, status: 202, body: SUBMITTED },
    ]);
    const result = await runRequestTool(
      { operation: OP, count: 2, input: INPUT },
      jobDeps(stub, [{ status: 'running' }]),
    );
    expect(result.envelope.status).toBe('running');
    for (const member of result.envelope.results as Record<string, unknown>[]) {
      expect(member.status).toBe('running');
      expect(member.job).toBeDefined();
      expect(member.nextStep).toBeDefined();
    }
  });
});

describe('a legacy paid call is unchanged', () => {
  it('returns the envelope it always did, with no operation fields', async () => {
    const legacy = {
      id: '0195f3a1-6c4d-7a2b-9e10-5f6a7b8c9d55',
      ...serviceSpec(SERVICE_A, PAYEE_A, 'legacy'),
    };
    delete (legacy as Record<string, unknown>).outputSchema;
    await storeSpecs(dir, [legacy as never]);
    const stub = new Stub({ lead: SPEC_A() }, [A]);
    const result = await runRequestTool({ id: legacy.id, input: INPUT }, deps(stub));
    expect(Object.keys(result.envelope).sort()).toEqual(
      [
        'cost',
        'label',
        'parameters',
        'providerContentUntrusted',
        'result',
        'status',
        'supplier',
      ].sort(),
    );
    expect(result.envelope).toMatchObject({
      status: 'fulfilled',
      supplier: 'service-a.example.test',
      cost: ['provider price 0.005 USD'],
      result: JSON.stringify(BODY_A),
    });
    expect(result.summary).toBe('Fulfilled by service-a.example.test · provider price 0.005 USD');
  });
});

describe('the files a run leaves', () => {
  it('saves the whole body at fullResultPath, which exists', async () => {
    const stub = new Stub({ lead: SPEC_A() }, [A]);
    const result = await runRequestTool({ operation: OP, input: INPUT }, deps(stub));
    await expect(stat(String(result.envelope.fullResultPath))).resolves.toBeDefined();
  });
});

/**
 * THE SERVER'S REAL ANSWERS, as its code produced them (fixtures copied, not
 * written from the plan). Each goes through the client's real parse path. A key
 * this build does not know (`holds`, `returnsExample`, `jev`) must not make it
 * drop the answer.
 */
describe("the router's real answers", () => {
  const real = (name: string) =>
    JSON.parse(
      readFileSync(
        fileURLToPath(new URL(`./fixtures/wire-operation-${name}.json`, import.meta.url)),
        'utf8',
      ),
    ) as Record<string, unknown>;
  const RUN = real('run');
  const GLIM = 'https://glim.sh/api/v1/twitter/search';

  /** The router's real answers on its own paths; the service stays scripted. */
  function realFetch(stub: Stub, noRun?: boolean): typeof fetch {
    const inner = stub.fetch;
    const wrapped = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = String(input);
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : {};
      const json = (v: unknown) =>
        new Response(JSON.stringify(v), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      if (url === `${ROUTER}${ROUTE_PAID_PATH}`) {
        stub.calls.push({ url, body, signed: false });
        stub.feePayments += 1;
        if (noRun === true) return json(real('no-run'));
        const decision = {
          ...(RUN.decision as Record<string, unknown>),
          run: body.run,
        };
        return json({ ...RUN, decision });
      }
      if (url === `${ROUTER}${ROUTER_PATH}`) {
        if (body.browse !== undefined) {
          return json({ schemaVersion: 1, routerVersion: 'local', rows: real('browse-rows') });
        }
        if (body.operation !== undefined) return json(real('read'));
        return json(real('offer'));
      }
      return inner(input, init);
    }) as typeof fetch;
    stub.fetch = wrapped;
    return wrapped;
  }
  const glim = (): ServiceScript => ({
    url: GLIM,
    live: '5000',
    payTo: '0xC751344Ee09B5159160173F77D4a1169bCd386A1',
    body: { count: 1, tweets: [{ id: '1', text: 'hi', author: { username: 'ana' } }] },
  });

  it("shows the real offer, with each row's input fields of any type", async () => {
    const stub = new Stub({ lead: SPEC_A() }, []);
    realFetch(stub);
    const d = deps(stub);
    const offered = await runRequestTool({ query: 'search X' }, d);
    expect(offered.envelope).toMatchObject({ status: 'offer', task: 'x post search' });
    expect((offered.envelope.operations as unknown[]).length).toBe(2);
    expect(offered.summary).toContain('Input fields: query (<X search terms>)');
    expect(offered.summary).toContain('expand_urls (false)');
  });

  it("accepts the server's full hint forms: the task offer's and the hook offer's", async () => {
    for (const name of ['offer', 'offer-hook']) {
      const stub = new Stub({ lead: SPEC_A() }, []);
      const answer = real(name);
      const inner = (() => {
        realFetch(stub);
        return stub.fetch;
      })();
      stub.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const body = typeof init?.body === 'string' ? JSON.parse(init.body) : {};
        if (String(input) === `${ROUTER}${ROUTER_PATH}` && body.operation === undefined) {
          return new Response(JSON.stringify(answer), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        return inner(input, init);
      }) as typeof fetch;
      const d = deps(stub);
      const offered = await runRequestTool({ query: 'search X' }, d);
      expect(offered.envelope.status, name).toBe('offer');
      expect(String(offered.envelope.hint ?? offered.summary)).toContain('request({');
    }
  });

  it('lists the real browse rows with their input fields', async () => {
    const stub = new Stub({ lead: SPEC_A() }, []);
    realFetch(stub);
    const d = deps(stub);
    const listed = await runRequestTool({ browse: 'x search' }, d);
    expect(listed.envelope.status).toBe('browse');
    expect(listed.summary).toContain('x-post-search');
    expect(listed.summary).toContain('query (<X search terms>)');
  });

  it('reads the real operation, and a real run answer runs end to end', async () => {
    const stub = new Stub({ lead: SPEC_A() }, [glim()]);
    realFetch(stub);
    const d = deps(stub);
    const read = await runRequestTool({ operation: 'x-post-search' }, d);
    expect(read.envelope).toMatchObject({ status: 'operation', operation: 'x-post-search' });
    const ran = await runRequestTool(
      { operation: 'x-post-search', input: { query: 'x402 from:coinbase' } },
      d,
    );
    expect(ran.envelope).toMatchObject({ status: 'fulfilled', operation: 'x-post-search' });
    expect(stub.signatures.get(GLIM)).toBe(1);
    expect(stub.runBodies()[0]).toMatchObject({ caps: { fee: '750', service: '5500' } });
    expect(textOf(ran)).not.toContain('glim.sh');
  });

  it('stops on the real over_caps answer with nothing paid to a service', async () => {
    const stub = new Stub({ lead: SPEC_A() }, [glim()]);
    realFetch(stub, true);
    const d = deps(stub);
    const stopped = await runRequestTool(
      { operation: 'x-post-search', input: { query: 'x402' } },
      d,
    );
    expect(stopped.envelope.status).not.toBe('fulfilled');
    expect(stopped.summary).toContain('Read the operation again');
    expect(stub.totalSignatures()).toBe(0);
  });
});
