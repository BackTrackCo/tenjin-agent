import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { testWalletProvider, buildPaymentRequired } from '../lib/read-test-utils';
import { httpRequest } from '../lib/http';
import { resolveSpendAuthorizer } from '../lib/wallet';
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
import { runRequestCommand } from './task-command';
import { checkTaskAnswer, requestRefusedOffer } from './task-request';
import { storeSpecs } from './specs';
import { CliError } from '../lib/errors';
import { storeTaskRead } from './task-store';
import { readRouterMemo } from './router-memo';

/**
 * A ROUTED TASK, END TO END AGAINST A SCRIPTED ROUTER AND TWO SCRIPTED
 * PROVIDERS. The router's task, its conversions and the two providers' bodies
 * are small invented fixtures with the field structure of the pilot's two real
 * providers; nothing here reads a recorded body. No test opens a socket.
 */

const ROUTER = 'https://tenjin.sh';
const SELLER_A = 'https://seller-a.example.test/v1/search';
const SELLER_B = 'https://seller-b.example.test/v1/run/search';
const PAYEE_A = '0x1111111111111111111111111111111111111111';
const PAYEE_B = '0x2222222222222222222222222222222222222222';
const TASK_ID = 'x-post-search';
const INPUT = { query: 'x402 min_faves:5' };

let dir: string;
let allowlist: string[] = [];
beforeEach(async () => {
  allowlist = [];
  dir = await mkdtemp(join(tmpdir(), 'router-task-'));
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

const SHAPE = {
  type: 'object',
  properties: {
    posts: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          url: { type: 'string' },
          text: { type: 'string' },
          author: { type: 'string' },
          likes: { type: 'integer' },
          reposts: { type: 'integer' },
          replies: { type: 'integer' },
        },
        required: ['url', 'text', 'author', 'likes', 'reposts', 'replies'],
        additionalProperties: false,
      },
    },
    nextCursor: { type: ['string', 'null'] },
  },
  required: ['posts', 'nextCursor'],
  additionalProperties: false,
};

const TASK = {
  id: TASK_ID,
  label: 'X post search',
  does: 'finds public posts that match search words',
  input: {
    type: 'object',
    properties: { query: { type: 'string', minLength: 1, maxLength: 200 } },
    required: ['query'],
    additionalProperties: false,
  },
  example: { query: 'x402' },
  output: SHAPE,
  price: { expectedAtomic: '5000', maxAtomic: '5500', feeAtomic: '750' },
  free: false,
  kind: 'search',
};

function sellerSpec(url: string, payTo: string, label: string, price = '5000', max = '5500') {
  return {
    capabilityId: `seller-${label}`,
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
  };
}

const CONVERT_A = {
  input: '{query: query}',
  output:
    '{posts: tweets[].{url: url, text: text, author: author.username, likes: public_metrics.like_count, reposts: public_metrics.retweet_count, replies: public_metrics.reply_count}, nextCursor: next_cursor}',
};
const CONVERT_B = {
  input: '{query: query}',
  output:
    '{posts: output.data.items[].{url: url, text: text, author: authorUsername, likes: likeCount, reposts: retweetCount, replies: replyCount}, nextCursor: output.data.nextCursor}',
};
const BODY_A = {
  tweets: [
    {
      url: 'https://posts.example.test/ana/1',
      text: 'first invented post',
      author: { username: 'ana' },
      public_metrics: { like_count: 7, retweet_count: 2, reply_count: 1 },
    },
  ],
  next_cursor: 'c1',
};
const BODY_B = {
  output: {
    found: true,
    data: {
      items: [
        {
          url: 'https://posts.example.test/ana/1',
          text: 'first invented post',
          authorUsername: 'ana',
          likeCount: 7,
          retweetCount: 2,
          replyCount: 1,
        },
      ],
      nextCursor: 'c1',
    },
  },
};
const EXPECTED_OUTPUT = {
  posts: [
    {
      url: 'https://posts.example.test/ana/1',
      text: 'first invented post',
      author: 'ana',
      likes: 7,
      reposts: 2,
      replies: 1,
    },
  ],
  nextCursor: 'c1',
};

interface SellerScript {
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

/** A router and its providers, on one fetch, with every call recorded. */
class Stub {
  calls: { url: string; body?: Record<string, unknown>; signed: boolean }[] = [];
  runs = new Map<string, { fee: string; settled: boolean }>();
  feePayments = 0;
  signatures = new Map<string, number>();
  constructor(
    private readonly answer: {
      lead: { spec: Record<string, unknown>; convert?: unknown };
      fallback?: { spec: Record<string, unknown>; convert?: unknown };
      free?: 'offer' | 'fee_required';
      /** Fields added to the free route's offer (choices, rows, bound). */
      offerExtra?: Record<string, unknown>;
      /** The members a `choice: "all"` or `count` run is served as. */
      set?: { key?: string; spec: Record<string, unknown>; convert?: unknown }[];
      /** The router refuses the run, at $0, with this code. */
      noRun?: string;
      /** The lead has no conversion and no output shape, as a listing's. */
      plain?: boolean;
      /** Other tasks of an offer, by id, each with its own read. */
      tasksById?: Record<string, Record<string, unknown>>;
    },
    private readonly sellers: SellerScript[],
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
    if (url === `${ROUTER}${ROUTER_PATH}`) {
      if (body?.task !== undefined) {
        return json({
          schemaVersion: 1,
          routerVersion: 'v',
          task: this.answer.tasksById?.[String(body.task)] ?? TASK,
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
          id: '0195f3a1-6c4d-7a2b-9e10-5f6a7b8c9d01',
          need: 'x post search',
          tasks: [{ task: TASK_ID, label: 'X post search', does: TASK.does, price: '$0.0058' }],
          hint: `Call request(${JSON.stringify({ task: TASK_ID, input: { query: '<query>' } })}) alone and wait for its result.`,
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
        this.runs.set(run, { fee: String(750 * members.length), settled: true });
        return json({
          schemaVersion: 1,
          routerVersion: 'v',
          decision: {
            action: 'run_set',
            run,
            task: String(body?.task ?? TASK_ID),
            expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
            routingFeeAtomic: String(750 * members.length),
            calls: members.map((m, i) => ({
              ...(m.key !== undefined ? { key: m.key } : {}),
              label: `member ${i}`,
              spec: m.spec,
              ...(m.convert !== undefined ? { convert: m.convert } : {}),
              output: SHAPE,
            })),
          },
        });
      }
      const known = this.runs.get(run);
      const fee = known?.settled === true ? '0' : '750';
      if (known === undefined || !known.settled) this.feePayments += 1;
      this.runs.set(run, { fee: '750', settled: true });
      return json({
        schemaVersion: 1,
        routerVersion: 'v',
        decision: {
          action: 'run',
          run,
          task: String(body?.task ?? TASK_ID),
          expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
          routingFeeAtomic: fee,
          spec: this.answer.lead.spec,
          ...(this.answer.lead.convert !== undefined ? { convert: this.answer.lead.convert } : {}),
          ...(this.answer.plain === true ? {} : { output: SHAPE }),
          ...(this.answer.fallback !== undefined
            ? {
                fallback: {
                  spec: this.answer.fallback.spec,
                  ...(this.answer.fallback.convert !== undefined
                    ? { convert: this.answer.fallback.convert }
                    : {}),
                },
              }
            : {}),
        },
      });
    }
    const seller = this.sellers.find((s) => s.url === url);
    if (seller === undefined) throw new Error(`unscripted request to ${url}`);
    if (!signed) {
      return json({}, 402, {
        'PAYMENT-REQUIRED': buildPaymentRequired({ amount: seller.live, payTo: seller.payTo })
          .header,
      });
    }
    this.signatures.set(url, (this.signatures.get(url) ?? 0) + 1);
    if (seller.dropsReply === true) throw new TypeError('fetch failed');
    if (seller.raw !== undefined) {
      return new Response(seller.raw, {
        status: seller.status ?? 200,
        headers: { 'content-type': seller.contentType ?? 'application/octet-stream' },
      });
    }
    return json(seller.body, seller.status ?? 200);
  }) as typeof fetch;

  providerRequests(): number {
    return this.calls.filter((c) => c.url.startsWith('https://seller-')).length;
  }
  paidRouteRequests(): number {
    return this.calls.filter((c) => c.url === `${ROUTER}${ROUTE_PAID_PATH}`).length;
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

function lead(): Stub['answer'] extends never ? never : ConstructorParameters<typeof Stub>[0] {
  return {
    lead: { spec: sellerSpec(SELLER_A, PAYEE_A, 'glim-like'), convert: CONVERT_A },
    fallback: {
      spec: sellerSpec(SELLER_B, PAYEE_B, 'api-like', '1500', '1650'),
      convert: CONVERT_B,
    },
  };
}

const A: SellerScript = { url: SELLER_A, live: '5000', payTo: PAYEE_A, body: BODY_A };
const B: SellerScript = { url: SELLER_B, live: '1500', payTo: PAYEE_B, body: BODY_B };

/** Every string a result hands the model, which must not name a provider's URL or host. */
function textOf(result: { summary: string; envelope: Record<string, unknown> }): string {
  return `${result.summary}\n${JSON.stringify(result.envelope)}`;
}
const NAMES = ['seller-a.example.test', 'seller-b.example.test', 'https://seller-'];

describe('a routed task run', () => {
  it('gives the same output from either provider, with both payments on the receipt', async () => {
    const asA = new Stub({ lead: lead().lead }, [A]);
    const first = await runRequestTool({ task: TASK_ID, input: INPUT }, deps(asA));
    expect(first.isError).toBe(false);
    expect(first.envelope).toMatchObject({
      status: 'fulfilled',
      task: TASK_ID,
      service: 'glim-like',
      output: EXPECTED_OUTPUT,
      receipt: {
        routingFee: { amount: '$0.00075', paid: true },
        provider: { state: 'paid', amount: '$0.005', payee: PAYEE_A },
      },
    });
    const asB = new Stub(
      {
        lead: {
          spec: sellerSpec(SELLER_B, PAYEE_B, 'api-like', '1500', '1650'),
          convert: CONVERT_B,
        },
      },
      [B],
    );
    const second = await runRequestTool({ task: TASK_ID, input: INPUT }, deps(asB));
    expect(second.envelope.output).toEqual(EXPECTED_OUTPUT);
    expect(second.envelope.output).toEqual(first.envelope.output);
    for (const result of [first, second]) {
      for (const name of NAMES) expect(textOf(result)).not.toContain(name);
    }
    // The input stays here: the run request carries none of it.
    const run = asA.calls.find((c) => c.url.endsWith(ROUTE_PAID_PATH))!;
    expect(JSON.stringify(run.body)).not.toContain('min_faves');
    expect(run.body).toMatchObject({ task: TASK_ID, caps: { fee: '750', seller: '5500' } });
    expect((run.body!.accepts as string[]).includes('task')).toBe(true);
  });

  it('sends nothing for an input the task does not take', async () => {
    const stub = new Stub(lead(), [A, B]);
    await storeTaskRead(dir, TASK as never, undefined);
    const result = await runRequestTool(
      { task: TASK_ID, input: { query: '', extra: 1 } },
      deps(stub),
    );
    expect(result.envelope).toMatchObject({ status: 'needs_input' });
    expect(stub.calls).toEqual([]);
  });

  it('reads a task for free and pays nothing', async () => {
    const stub = new Stub(lead(), [A]);
    const d = deps(stub);
    const read = await runRequestTool({ task: TASK_ID }, d);
    expect(read.envelope).toMatchObject({ status: 'task', task: TASK_ID });
    expect(stub.calls.map((c) => c.url)).toEqual([`${ROUTER}${ROUTER_PATH}`]);
    expect(d.routed.sent).toBe(0);
    for (const name of NAMES) expect(textOf(read)).not.toContain(name);
  });

  it('uses the fallback when the lead provider is live over the approved cap', async () => {
    const stub = new Stub(lead(), [{ ...A, live: '9000' }, B]);
    const result = await runRequestTool({ task: TASK_ID, input: INPUT }, deps(stub));
    expect(result.envelope).toMatchObject({ status: 'fulfilled', output: EXPECTED_OUTPUT });
    expect(stub.signatures.get(SELLER_A) ?? 0).toBe(0);
    expect(stub.signatures.get(SELLER_B)).toBe(1);
  });

  it('stops with no provider payment when no provider is within the cap, and a repeat pays no second fee', async () => {
    const stub = new Stub(lead(), [
      { ...A, live: '9000' },
      { ...B, live: '9000' },
    ]);
    const d = deps(stub);
    const result = await runRequestTool({ task: TASK_ID, input: INPUT }, d);
    expect(result.isError).toBe(true);
    expect(stub.signatures.size).toBe(0);
    expect(stub.feePayments).toBe(1);
    for (const name of NAMES) expect(textOf(result)).not.toContain(name);
    await runRequestTool({ task: TASK_ID, input: INPUT }, d);
    expect(stub.paidRouteRequests()).toBe(1);
    expect(stub.feePayments).toBe(1);
  });

  it('passes the approved fee to the payer as its limit', async () => {
    const stub = new Stub({ lead: lead().lead }, [A]);
    const d = deps(stub);
    await runRequestTool({ task: TASK_ID, input: INPUT }, d);
    expect(d.routed.limits).toEqual([750n]);
  });
});

describe('one quote for both payments', () => {
  it('keeps a plan over the limits as one quote, sends nothing paid, and runs it on a yes', async () => {
    await writeFile(
      join(dir, 'config.json'),
      JSON.stringify({ maxAutoSpend: '4000', sessionBudget: '5000000' }),
    );
    const stub = new Stub({ lead: lead().lead }, [A]);
    const d = deps(stub, { approves: true });
    const stopped = await runRequestTool({ task: TASK_ID, input: INPUT }, d);
    expect(stopped.envelope).toMatchObject({ status: 'needs_approval' });
    // The fee and the provider's allowed maximum, as one total: $0.00075 + $0.0055.
    const quote = stopped.envelope.quote as { id: string; total: string; what: string };
    expect(quote.total).toBe('$0.00625');
    expect(stopped.summary).toContain('about $0.00575');
    expect(stub.paidRouteRequests()).toBe(0);
    expect(stub.providerRequests()).toBe(0);
    expect(d.routed.sent).toBe(0);
    const ran = await runApproveTool({ quote: quote.id, total: quote.total, what: quote.what }, d);
    expect(ran.envelope).toMatchObject({ status: 'fulfilled', output: EXPECTED_OUTPUT });
    expect(stub.feePayments).toBe(1);
    expect(stub.signatures.get(SELLER_A)).toBe(1);
  });
});

describe('a provider reply lost after the payment was signed', () => {
  it('stops with a receipt and signs a second payment only on a yes', async () => {
    const stub = new Stub({ lead: lead().lead }, [{ ...A, dropsReply: true }]);
    const d = deps(stub, { approves: true });
    const lost = await runRequestTool({ task: TASK_ID, input: INPUT }, d);
    expect(lost.isError).toBe(true);
    expect(lost.envelope).toMatchObject({
      possiblyPaid: true,
      receipt: {
        routingFee: { amount: '$0.00075', paid: true },
        provider: { state: 'possibly_paid', payee: PAYEE_A },
      },
    });
    expect(stub.signatures.get(SELLER_A)).toBe(1);
    for (const name of NAMES) expect(textOf(lost)).not.toContain(name);
    const quote = lost.envelope.quote as { id: string; total: string; what: string };
    expect(quote).toBeDefined();
    // Nothing more is signed until the person's yes.
    expect(stub.signatures.get(SELLER_A)).toBe(1);
    // The reply arrives this time.
    stub.fetch = new Stub({ lead: lead().lead }, [A]).fetch;
    const rerun = await runApproveTool(
      { quote: quote.id, total: quote.total, what: quote.what },
      deps(stub, { approves: true }),
    );
    expect(rerun.envelope).toMatchObject({ status: 'fulfilled', output: EXPECTED_OUTPUT });
    expect(stub.feePayments).toBe(1);
  });
});

describe('a run answer lost on the way back', () => {
  it('re-sends the same run id and pays the Tenjin fee once when the first payment settled', async () => {
    const stub = new Stub({ lead: lead().lead }, [A]);
    let first = true;
    const d = deps(stub, {}, (send) => async (url, options) => {
      if (first) {
        first = false;
        await send(url, options);
        throw new RouteSkipped(DEADLINE_AFTER_PAYMENT_SENT);
      }
      return send(url, options);
    });
    const result = await runRequestTool({ task: TASK_ID, input: INPUT }, d);
    expect(result.envelope).toMatchObject({ status: 'fulfilled' });
    const runs = stub.calls.filter((c) => c.url.endsWith(ROUTE_PAID_PATH)).map((c) => c.body!.run);
    expect(new Set(runs).size).toBe(1);
    expect(stub.feePayments).toBe(1);
    expect(result.envelope).toMatchObject({ receipt: { routingFee: { amount: '$0.00075' } } });
  });

  it('is asked to pay again when the first payment never settled, and pays the fee once in total', async () => {
    const stub = new Stub({ lead: lead().lead }, [A]);
    let first = true;
    const d = deps(stub, {}, (send) => async (url, options) => {
      if (first) {
        first = false;
        // The payment failed before the router served the run.
        throw new RouteSkipped(PAYMENT_FAILED);
      }
      return send(url, options);
    });
    const result = await runRequestTool({ task: TASK_ID, input: INPUT }, d);
    expect(result.envelope).toMatchObject({ status: 'fulfilled' });
    expect(stub.feePayments).toBe(1);
    expect(stub.signatures.get(SELLER_A)).toBe(1);
  });
});

describe('an offer of tasks', () => {
  it('comes from the free route with no payer, and runs by its id', async () => {
    const stub = new Stub({ lead: lead().lead }, [A]);
    const d = deps(stub);
    const offered = await runRequestTool({ query: 'search X for x402 posts' }, d);
    expect(offered.envelope).toMatchObject({ status: 'offer', tasks: [{ task: TASK_ID }] });
    expect(d.routed.sent).toBe(0);
    expect(stub.calls.map((c) => c.url)).toEqual([`${ROUTER}${ROUTER_PATH}`]);
    expect((stub.calls[0]!.body!.accepts as string[]).includes('task')).toBe(true);
    const ran = await runRequestTool({ id: offered.envelope.id as string, input: INPUT }, d);
    expect(ran.envelope).toMatchObject({ status: 'fulfilled', output: EXPECTED_OUTPUT });
    expect(stub.calls.find((c) => c.url.endsWith(ROUTE_PAID_PATH))!.body).toMatchObject({
      offer: offered.envelope.id,
    });
  });

  it('is never skipped behind a busy channel', async () => {
    const stub = new Stub({ lead: lead().lead }, [A]);
    const d = deps(stub, {}, () => async () => {
      throw new RouteSkipped('channel_busy');
    });
    const offered = await runRequestTool({ query: 'search X for x402 posts' }, d);
    expect(offered.envelope.status).toBe('offer');
    expect(d.routed.sent).toBe(0);
  });
});

describe('a router that predates routed tasks', () => {
  it("gets today's paid call, with no task in accepts, after one free try", async () => {
    const stub = new Stub({ lead: lead().lead, free: 'fee_required' }, []);
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
    expect((paid.accepts as string[]).includes('task')).toBe(false);
    expect(d.routed.sent).toBe(1);
    // The router is remembered as one that predates routed tasks.
    expect(await readRouterMemo(dir, 'task-absent', ROUTER, Date.now())).not.toBeNull();
    await runRequestTool({ query: 'BTC price again' }, d);
    expect(stub.calls.map((c) => c.url).slice(2)).toEqual([`${ROUTER}${ROUTE_PAID_PATH}`]);
  });

  it('reads a task id with the old tool read when the router does not know the form', async () => {
    const calls: string[] = [];
    const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      calls.push(String(init?.body));
      return new Response(
        JSON.stringify({ error: { code: 'validation_failed', message: 'Invalid request body' } }),
        { status: 400, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof fetch;
    const result = await runRequestTool(
      { task: 'some-service' },
      { ...deps(new Stub(lead(), []), {}), fetchImpl },
    );
    expect(calls).toHaveLength(2);
    expect(JSON.parse(calls[0]!)).toHaveProperty('task', 'some-service');
    expect(JSON.parse(calls[1]!)).toHaveProperty('tool', 'some-service');
    expect(result.envelope).toBeDefined();
  });
});

describe('tenjin request, for scripts', () => {
  it('prints the envelope of a fulfilled run', async () => {
    const stub = new Stub({ lead: lead().lead }, [A]);
    const seams = { ...deps(stub), provider: testWalletProvider() };
    const done = await runRequestCommand(
      ctx(),
      { task: TASK_ID, input: JSON.stringify(INPUT) },
      seams,
    );
    expect(done.data).toMatchObject({ status: 'fulfilled', output: EXPECTED_OUTPUT });
    expect(stub.feePayments).toBe(1);
  });

  it('obeys the spend limits: over them nothing is paid, and the exit code says refused', async () => {
    await writeFile(
      join(dir, 'config.json'),
      JSON.stringify({ maxAutoSpend: '4000', sessionBudget: '5000000' }),
    );
    const stub = new Stub({ lead: lead().lead }, [A]);
    const seams = deps(stub);
    const refused = await runRequestCommand(
      ctx(),
      { task: TASK_ID, input: JSON.stringify(INPUT) },
      seams,
    ).catch((err: unknown) => err);
    expect(refused).toBeInstanceOf(CliError);
    expect((refused as CliError).exitCode).toBe(3);
    expect(stub.paidRouteRequests()).toBe(0);
    expect(stub.providerRequests()).toBe(0);
  });

  it('refuses an input that is not one JSON object, with the usage exit code', async () => {
    const stub = new Stub(lead(), []);
    const seams = deps(stub);
    const refused = await runRequestCommand(ctx(), { task: TASK_ID, input: '[1]' }, seams).catch(
      (err: unknown) => err,
    );
    expect((refused as CliError).exitCode).toBe(2);
    expect(stub.calls).toEqual([]);
  });
});

describe('tenjin doctor, the routed-task answer', () => {
  const answer = (status: number, body: unknown): typeof fetch =>
    (async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch;
  const base = () => ({ ctx: ctx(), baseUrl: ROUTER });

  it('reads a decision about an unknown task as a router that serves tasks', async () => {
    const needsInput = {
      schemaVersion: 1,
      routerVersion: 'v',
      decision: {
        action: 'needs_input',
        reason: 'No such task.',
        diagnostics: {
          reasonCode: 'capability_unresolved',
          stage: 'capability',
          missing: [],
          nextAction: 'Browse.',
        },
      },
    };
    expect(await checkTaskAnswer({ ...base(), fetchImpl: answer(200, needsInput) })).toMatchObject({
      status: 'ok',
      detail: expect.stringContaining('offers are free'),
    });
  });

  it('reads a refused form as a router that predates tasks, with nothing to fix', async () => {
    const refused = { error: { code: 'validation_failed', message: 'Invalid request body' } };
    expect(await checkTaskAnswer({ ...base(), fetchImpl: answer(400, refused) })).toMatchObject({
      status: 'ok',
      detail: expect.stringContaining('predates routed tasks'),
    });
  });

  it('says not checked on any other answer', async () => {
    expect(await checkTaskAnswer({ ...base(), fetchImpl: answer(503, {}) })).toMatchObject({
      status: 'warn',
      checked: false,
    });
  });
});

const OPTIONS = {
  group: 'x search',
  default: 'a',
  options: [
    { key: 'a', label: 'Option A', strength: 'broad', task: TASK_ID },
    { key: 'b', label: 'Option B', strength: 'cheap', task: TASK_ID },
  ],
  all: { totalAtomic: '11500' },
};
const SET = [
  { key: 'a', spec: sellerSpec(SELLER_A, PAYEE_A, 'glim-like'), convert: CONVERT_A },
  { key: 'b', spec: sellerSpec(SELLER_B, PAYEE_B, 'api-like', '1500', '1650'), convert: CONVERT_B },
];

describe('a set of runs', () => {
  it('runs every choice as one quote and one fee, each provider paid once, each payment on the receipt', async () => {
    const stub = new Stub({ lead: lead().lead, offerExtra: { choices: OPTIONS }, set: SET }, [
      A,
      B,
    ]);
    const d = deps(stub);
    const offered = await runRequestTool({ query: 'search X' }, d);
    expect(offered.summary).toContain('Choices (x search)');
    const result = await runRequestTool(
      { id: offered.envelope.id as string, choice: 'all', input: INPUT },
      d,
    );
    expect(result.envelope).toMatchObject({
      status: 'fulfilled',
      receipt: { routingFee: { amount: '$0.0015' } },
    });
    const members = result.envelope.results as { output: unknown; payment: { state: string } }[];
    expect(members.map((m) => m.output)).toEqual([EXPECTED_OUTPUT, EXPECTED_OUTPUT]);
    expect(members.map((m) => m.payment.state)).toEqual(['paid', 'paid']);
    expect(stub.feePayments).toBe(1);
    expect(stub.signatures.get(SELLER_A)).toBe(1);
    expect(stub.signatures.get(SELLER_B)).toBe(1);
    const run = stub.calls.find((c) => c.url.endsWith(ROUTE_PAID_PATH))!;
    expect(run.body).toMatchObject({ choice: 'all', caps: { fee: '1500', seller: '5500' } });
    expect(JSON.stringify(run.body)).not.toContain('min_faves');
    for (const name of NAMES) expect(textOf(result)).not.toContain(name);
    expect(d.routed.limits.at(-1)).toBe(1500n);
  });

  it('holds a set over the limits as one quote with the fees summed, and signs nothing before the yes', async () => {
    await writeFile(
      join(dir, 'config.json'),
      JSON.stringify({ maxAutoSpend: '4000', sessionBudget: '5000000' }),
    );
    const stub = new Stub({ lead: lead().lead, set: [SET[0]!] }, [A]);
    const d = deps(stub, { approves: true });
    const stopped = await runRequestTool({ task: TASK_ID, count: 2, input: INPUT }, d);
    expect(stopped.envelope).toMatchObject({ status: 'needs_approval' });
    // Two fees ($0.0015) and two provider maximums ($0.011).
    expect((stopped.envelope.quote as { total: string }).total).toBe('$0.0125');
    expect(stub.paidRouteRequests()).toBe(0);
    expect(stub.providerRequests()).toBe(0);
    const quote = stopped.envelope.quote as { id: string; total: string; what: string };
    const ran = await runApproveTool({ quote: quote.id, total: quote.total, what: quote.what }, d);
    expect(ran.envelope).toMatchObject({ status: 'fulfilled' });
    // Two takes: two claims, so two provider payments, one fee.
    expect(stub.signatures.get(SELLER_A)).toBe(2);
    expect(stub.feePayments).toBe(1);
  });

  it('pays a member once even when its reply is lost, and the others still run', async () => {
    const stub = new Stub({ lead: lead().lead, offerExtra: { choices: OPTIONS }, set: SET }, [
      { ...A, dropsReply: true },
      B,
    ]);
    const d = deps(stub);
    await runRequestTool({ query: 'search X' }, d);
    const result = await runRequestTool(
      { task: TASK_ID, id: '0195f3a1-6c4d-7a2b-9e10-5f6a7b8c9d01', choice: 'all', input: INPUT },
      d,
    );
    expect(result.envelope).toMatchObject({ status: 'partial', possiblyPaid: true });
    expect(stub.signatures.get(SELLER_A)).toBe(1);
    expect(stub.signatures.get(SELLER_B)).toBe(1);
  });

  it.each(['unknown_choice', 'count_over_max', 'offer_expired'])(
    'says %s plainly and pays nothing',
    async (code) => {
      const stub = new Stub({ lead: lead().lead, noRun: code }, [A]);
      const result = await runRequestTool({ task: TASK_ID, count: 2, input: INPUT }, deps(stub));
      expect(result.envelope).toMatchObject({ status: 'needs_input' });
      expect(result.summary).toContain('Nothing was paid');
      expect(stub.signatures.size).toBe(0);
    },
  );
});

describe('offer picks and open-Bazaar rows', () => {
  it('runs the option a choice names, sending its key and task', async () => {
    const stub = new Stub({ lead: lead().lead, offerExtra: { choices: OPTIONS } }, [A]);
    const d = deps(stub);
    const offered = await runRequestTool({ query: 'search X' }, d);
    const ran = await runRequestTool(
      { id: offered.envelope.id as string, choice: 'b', input: INPUT },
      d,
    );
    expect(ran.envelope).toMatchObject({ status: 'fulfilled' });
    expect(stub.calls.find((c) => c.url.endsWith(ROUTE_PAID_PATH))!.body).toMatchObject({
      task: TASK_ID,
      choice: 'b',
    });
  });

  it('runs a listing row through the same checkout, with its offer row sent back and no provider named', async () => {
    const row = {
      task: 'listing-1',
      label: 'A listed search',
      does: 'finds things',
      price: '$0.005',
      offer: '0195f3a1-6c4d-7a2b-9e10-5f6a7b8c9d77',
    };
    const stub = new Stub(
      {
        lead: { spec: sellerSpec(SELLER_A, PAYEE_A, 'listing') },
        plain: true,
        offerExtra: { tasks: [row] },
      },
      [A],
    );
    const d = deps(stub);
    const offered = await runRequestTool({ query: 'search X' }, d);
    for (const name of NAMES) expect(textOf(offered)).not.toContain(name);
    const ran = await runRequestTool(
      { task: 'listing-1', id: offered.envelope.id as string, input: { query: 'x402' } },
      d,
    );
    expect(ran.envelope).toMatchObject({
      status: 'fulfilled',
      receipt: { routingFee: { paid: true } },
    });
    const run = stub.calls.find((c) => c.url.endsWith(ROUTE_PAID_PATH))!;
    expect(run.body).toMatchObject({ task: 'listing-1', offer: row.offer });
    // The caps are the row's price with the router's headroom, and the fee 15%.
    expect(run.body).toMatchObject({ caps: { fee: '750', seller: '5500' } });
    for (const name of NAMES) expect(textOf(ran)).not.toContain(name);
  });
});

describe('the re-ask after an account refuses', () => {
  it('asks the free route first and falls back to the paid route for a router that predates tasks', async () => {
    const urls: string[] = [];
    const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      urls.push(String(input));
      const body = JSON.parse(String(init?.body)) as { accepts: string[] };
      const reason = String(input).endsWith(ROUTER_PATH) ? 'fee_required' : 'native_sufficient';
      void body;
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
      '0195f3a1-6c4d-7a2b-9e10-5f6a7b8c9d01',
      { ctx: ctx(), baseUrl: ROUTER, fetchImpl },
      Date.now(),
    );
    expect(urls).toEqual([`${ROUTER}${ROUTER_PATH}`, `${ROUTER}${ROUTE_PAID_PATH}`]);
    expect(answer.status).toBe('decided');
    await requestRefusedOffer(
      '0195f3a1-6c4d-7a2b-9e10-5f6a7b8c9d01',
      { ctx: ctx(), baseUrl: ROUTER, fetchImpl },
      Date.now(),
    );
    expect(urls.slice(2)).toEqual([`${ROUTER}${ROUTE_PAID_PATH}`]);
  });
});

describe("the person's creator allowlist", () => {
  it('refuses a provider it does not name at signing: the fee is paid, the provider is not', async () => {
    allowlist = ['tenjin.sh'];
    const stub = new Stub({ lead: lead().lead }, [A]);
    const result = await runRequestTool({ task: TASK_ID, input: INPUT }, deps(stub));
    expect(result.envelope.status).toBe('needs_approval');
    expect(result.envelope).toMatchObject({
      receipt: { routingFee: { paid: true }, provider: { state: 'not_paid' } },
    });
    expect(stub.signatures.size).toBe(0);
    expect(stub.feePayments).toBe(1);
  });
});

describe('what a person approved is what runs', () => {
  it('runs the option that was quoted, after approve, not the default', async () => {
    const stub = new Stub({ lead: lead().lead, offerExtra: { choices: OPTIONS } }, [A]);
    const d = deps(stub, { approves: true });
    const offered = await runRequestTool({ query: 'search X' }, d);
    await writeFile(
      join(dir, 'config.json'),
      JSON.stringify({ maxAutoSpend: '4000', sessionBudget: '5000000' }),
    );
    const stopped = await runRequestTool(
      { id: offered.envelope.id as string, choice: 'b', input: INPUT },
      d,
    );
    expect(stopped.envelope).toMatchObject({ status: 'needs_approval' });
    expect(stub.paidRouteRequests()).toBe(0);
    const quote = stopped.envelope.quote as { id: string; total: string; what: string };
    const ran = await runApproveTool({ quote: quote.id, total: quote.total, what: quote.what }, d);
    expect(ran.envelope).toMatchObject({ status: 'fulfilled' });
    expect(stub.calls.find((c) => c.url.endsWith(ROUTE_PAID_PATH))!.body).toMatchObject({
      choice: 'b',
      offer: offered.envelope.id,
    });
  });
});

describe('a paid job never loses its result', () => {
  const JOB = {
    pollUrl: { field: 'statusUrl' },
    pollMethod: 'GET',
    running: { field: 'status', values: ['running'] },
    everyS: 1,
    maxWaitS: 30,
    keepH: 1,
  };
  const SUBMITTED = { status: 'running', statusUrl: 'https://seller-a.example.test/jobs/1' };

  function jobDeps(stub: Stub, answers: unknown[]) {
    let clock = Date.now();
    const seen: string[] = [];
    const pollTransport = (async (target: { url: URL }) => {
      seen.push(target.url.toString());
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
    return {
      seen,
      deps: deps(stub, {
        pollTransport,
        now: () => clock,
        sleep: async (ms: number) => {
          clock += ms;
        },
      }),
    };
  }

  const jobbed = () => ({
    lead: { spec: { ...sellerSpec(SELLER_A, PAYEE_A, 'glim-like'), job: JOB }, convert: CONVERT_A },
  });

  it('keeps the job id when the provider is still working, and finishes it as a run does', async () => {
    const stub = new Stub(jobbed(), [{ ...A, status: 202, body: SUBMITTED }]);
    const { deps: d, seen } = jobDeps(stub, [{ status: 'running' }]);
    const first = await runRequestTool({ task: TASK_ID, input: INPUT }, d);
    expect(first.envelope).toMatchObject({ status: 'running' });
    const run = String(first.envelope.job);
    expect(run.length).toBeGreaterThan(8);
    expect(stub.signatures.get(SELLER_A)).toBe(1);
    for (const name of NAMES) expect(textOf(first)).not.toContain(name);
    // The provider finishes: the resume converts and checks the body.
    const { deps: later } = jobDeps(stub, [{ status: 'done', ...BODY_A }]);
    const done = await runRequestTool({ job: run }, later);
    expect(done.envelope).toMatchObject({
      status: 'fulfilled',
      task: TASK_ID,
      output: EXPECTED_OUTPUT,
      receipt: { routingFee: { paid: true }, provider: { state: 'paid' } },
    });
    expect(stub.signatures.get(SELLER_A)).toBe(1);
    expect(seen.length).toBeGreaterThan(0);
    // Asked again, the kept result is still the task's output.
    const again = await runRequestTool({ job: run }, later);
    expect(again.envelope).toMatchObject({ status: 'fulfilled', output: EXPECTED_OUTPUT });
    for (const name of NAMES) expect(textOf(done)).not.toContain(name);
  });

  it('converts a job that finishes inside the call', async () => {
    const stub = new Stub(jobbed(), [{ ...A, status: 202, body: SUBMITTED }]);
    const { deps: d } = jobDeps(stub, [{ status: 'done', ...BODY_A }]);
    const result = await runRequestTool({ task: TASK_ID, input: INPUT }, d);
    expect(result.envelope).toMatchObject({ status: 'fulfilled', output: EXPECTED_OUTPUT });
    expect(stub.signatures.get(SELLER_A)).toBe(1);
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
  const SUBMITTED = { status: 'running', statusUrl: 'https://seller-a.example.test/jobs/1' };
  const jobbed = () => ({
    lead: { spec: { ...sellerSpec(SELLER_A, PAYEE_A, 'glim-like'), job: JOB }, convert: CONVERT_A },
  });
  const MANY = {
    tweets: Array.from({ length: 80 }, (_, i) => ({
      url: `https://posts.example.test/ana/${i}`,
      text: `an invented post number ${i} with some words to make it long enough`,
      author: { username: 'ana' },
      public_metrics: { like_count: i, retweet_count: 1, reply_count: 0 },
    })),
    next_cursor: 'c9',
  };

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

  /** What a result must carry to be collected. */
  const means = (envelope: Record<string, unknown>) =>
    ['output', 'result', 'job', 'savedFiles', 'fullResultPath'].filter(
      (key) => envelope[key] !== undefined,
    );

  it('a set member with no conversion keeps its result, and a running one its job', async () => {
    const plain = [{ key: 'a', spec: sellerSpec(SELLER_A, PAYEE_A, 'glim-like') }];
    const stub = new Stub({ lead: lead().lead, set: plain }, [A]);
    const result = await runRequestTool({ task: TASK_ID, count: 2, input: INPUT }, deps(stub));
    const members = result.envelope.results as Record<string, unknown>[];
    expect(members).toHaveLength(2);
    for (const member of members) {
      expect(member.status).toBe('fulfilled');
      expect(member.result).toBe(JSON.stringify(BODY_A));
    }
    expect(stub.signatures.get(SELLER_A)).toBe(2);
  });

  it('a set member whose job is still running keeps its job id and next step', async () => {
    const running = [
      { key: 'a', spec: { ...sellerSpec(SELLER_A, PAYEE_A, 'glim-like'), job: JOB } },
    ];
    const stub = new Stub({ lead: lead().lead, set: running }, [
      { ...A, status: 202, body: SUBMITTED },
    ]);
    const result = await runRequestTool(
      { task: TASK_ID, count: 2, input: INPUT },
      jobDeps(stub, [{ status: 'running' }]),
    );
    expect(result.envelope.status).toBe('running');
    const members = result.envelope.results as Record<string, unknown>[];
    for (const member of members) {
      expect(member.status).toBe('running');
      expect(member.job).toBeDefined();
      expect(member.nextStep).toBeDefined();
    }
  });

  it('a finished job whose conversion failed stays unverified on a later read', async () => {
    const stub = new Stub(jobbed(), [{ ...A, status: 202, body: SUBMITTED }]);
    const d = jobDeps(stub, [{ status: 'done', junk: true }]);
    const first = await runRequestTool({ task: TASK_ID, input: INPUT }, d);
    expect(first.envelope.status).toBe('unverified');
    const run = String(first.envelope.job);
    const again = await runRequestTool({ job: run }, d);
    expect(again.envelope.status).toBe('unverified');
    expect(again.envelope.output).toBeUndefined();
    expect(again.envelope.resultCaveat).toBeDefined();
    expect(again.envelope.fullResultPath).toBeDefined();
    expect(stub.signatures.get(SELLER_A)).toBe(1);
  });

  it('a finished job with a long output returns all of it on a later read', async () => {
    const stub = new Stub(jobbed(), [{ ...A, status: 202, body: SUBMITTED }]);
    const d = jobDeps(stub, [{ status: 'done', ...MANY }]);
    const first = await runRequestTool({ task: TASK_ID, input: INPUT }, d);
    expect(first.envelope.status).toBe('fulfilled');
    expect(JSON.stringify(first.envelope.output).length).toBeGreaterThan(8_000);
    const again = await runRequestTool({ job: String(first.envelope.job) }, d);
    expect(again.envelope.status).toBe('fulfilled');
    expect(again.envelope.output).toEqual(first.envelope.output);
    expect(stub.signatures.get(SELLER_A)).toBe(1);
  });

  const ENDINGS: {
    name: string;
    run: () => Promise<{ envelope: Record<string, unknown>; stub: Stub }>;
    status: string;
    carries: string[];
  }[] = [
    {
      name: 'a converted run',
      status: 'fulfilled',
      carries: ['output', 'fullResultPath'],
      run: async () => {
        const stub = new Stub({ lead: lead().lead }, [A]);
        return {
          stub,
          envelope: (await runRequestTool({ task: TASK_ID, input: INPUT }, deps(stub))).envelope,
        };
      },
    },
    {
      name: 'a run with no conversion',
      status: 'fulfilled',
      carries: ['result'],
      run: async () => {
        const stub = new Stub(
          { lead: { spec: sellerSpec(SELLER_A, PAYEE_A, 'plain') }, plain: true },
          [A],
        );
        return {
          stub,
          envelope: (await runRequestTool({ task: TASK_ID, input: INPUT }, deps(stub))).envelope,
        };
      },
    },
    {
      name: 'a conversion that fails',
      status: 'unverified',
      carries: ['fullResultPath'],
      run: async () => {
        const stub = new Stub({ lead: lead().lead }, [{ ...A, body: { nothing: 'useful' } }]);
        return {
          stub,
          envelope: (await runRequestTool({ task: TASK_ID, input: INPUT }, deps(stub))).envelope,
        };
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
              { task: TASK_ID, input: INPUT },
              jobDeps(stub, [{ status: 'running' }]),
            )
          ).envelope,
        };
      },
    },
    {
      name: 'a job read later, converted',
      status: 'fulfilled',
      carries: ['output', 'fullResultPath'],
      run: async () => {
        const stub = new Stub(jobbed(), [{ ...A, status: 202, body: SUBMITTED }]);
        const first = await runRequestTool(
          { task: TASK_ID, input: INPUT },
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
      name: 'a job read later, over the preview limit',
      status: 'fulfilled',
      carries: ['output'],
      run: async () => {
        const stub = new Stub(jobbed(), [{ ...A, status: 202, body: SUBMITTED }]);
        const first = await runRequestTool(
          { task: TASK_ID, input: INPUT },
          jobDeps(stub, [{ status: 'done', ...MANY }]),
        );
        const later = await runRequestTool(
          { job: String(first.envelope.job) },
          jobDeps(stub, [{ status: 'done', ...MANY }]),
        );
        return { stub, envelope: later.envelope };
      },
    },
    {
      name: 'a file result with no conversion',
      status: 'fulfilled',
      carries: ['savedFiles'],
      run: async () => {
        const media = { ...sellerSpec(SELLER_A, PAYEE_A, 'media'), output: 'media' };
        const stub = new Stub({ lead: { spec: media }, plain: true }, [
          {
            ...A,
            body: { files: [] },
            raw: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
            contentType: 'image/png',
          },
        ]);
        return {
          stub,
          envelope: (await runRequestTool({ task: TASK_ID, input: INPUT }, deps(stub))).envelope,
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
      expect(stub.signatures.get(SELLER_A) ?? 0).toBeLessThanOrEqual(1);
    },
  );
});

describe('a legacy paid call is unchanged', () => {
  it('returns the envelope it always did, with no task fields', async () => {
    const legacy = {
      id: '0195f3a1-6c4d-7a2b-9e10-5f6a7b8c9d55',
      ...sellerSpec(SELLER_A, PAYEE_A, 'legacy'),
    };
    await storeSpecs(dir, [legacy as never]);
    const stub = new Stub({ lead: lead().lead }, [A]);
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
      supplier: 'seller-a.example.test',
      cost: ['provider price 0.005 USD'],
      result: JSON.stringify(BODY_A),
    });
    expect(result.summary).toBe('Fulfilled by seller-a.example.test · provider price 0.005 USD');
  });
});

describe('an offer of the whole need', () => {
  const rows = Array.from({ length: 16 }, (_, i) => ({
    task: i === 0 ? TASK_ID : `other-task-${i}`,
    label: `Task ${i}`,
    does: `does the number ${i} job on posts ${'and more words '.repeat(i % 3)}`,
    price: '$0.005',
  }));
  const OTHER = {
    ...TASK,
    id: 'other-task-5',
    label: 'Task 5',
    input: {
      type: 'object',
      properties: { handle: { type: 'string', minLength: 1 } },
      required: ['handle'],
      additionalProperties: false,
    },
  };

  it('lists sixteen rows, each with its label, price and what it does, and no provider', async () => {
    const stub = new Stub({ lead: lead().lead, offerExtra: { tasks: rows } }, []);
    const offered = await runRequestTool({ query: 'search X' }, deps(stub));
    expect(offered.envelope.status).toBe('offer');
    expect((offered.envelope.tasks as unknown[]).length).toBe(16);
    for (const row of rows)
      expect(offered.summary).toContain(`${row.label} (task ${row.task}, $0.005)`);
    expect(offered.summary).toContain('To run a task other than the first');
    for (const name of NAMES) expect(textOf(offered)).not.toContain(name);
    // The line a person's agent reads stays small.
    expect(offered.summary.length).toBeLessThan(4_000);
  });

  it('cuts an offer of more than sixteen rows to sixteen and keeps the answer', async () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ ...rows[i % 16]!, task: `t-${i}` }));
    const stub = new Stub({ lead: lead().lead, offerExtra: { tasks: many } }, []);
    const offered = await runRequestTool({ query: 'search X' }, deps(stub));
    expect(offered.envelope.status).toBe('offer');
    expect((offered.envelope.tasks as unknown[]).length).toBe(16);
  });

  it('runs a task other than the lead, checking the input against that task', async () => {
    const stub = new Stub(
      {
        lead: {
          spec: sellerSpec(SELLER_A, PAYEE_A, 'other'),
          convert: { input: '{query: handle}', output: CONVERT_A.output },
        },
        offerExtra: { tasks: rows },
        tasksById: { 'other-task-5': OTHER },
      },
      [A],
    );
    const d = deps(stub);
    const offered = await runRequestTool({ query: 'search X' }, d);
    const id = offered.envelope.id as string;
    // The lead's input is not this task's: nothing is sent to the paid route.
    const wrong = await runRequestTool({ task: 'other-task-5', id, input: INPUT }, d);
    expect(wrong.envelope.status).toBe('needs_input');
    expect(stub.paidRouteRequests()).toBe(0);
    const ran = await runRequestTool({ task: 'other-task-5', id, input: { handle: 'ana' } }, d);
    expect(ran.envelope).toMatchObject({ status: 'fulfilled' });
    expect(stub.calls.find((c) => c.url.endsWith(ROUTE_PAID_PATH))!.body).toMatchObject({
      task: 'other-task-5',
      offer: id,
    });
  });
});
