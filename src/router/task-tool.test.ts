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
import { checkTaskAnswer } from './task-request';
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
beforeEach(async () => {
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
        return json({ schemaVersion: 1, routerVersion: 'v', task: TASK });
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
        },
      });
    }
    if (url === `${ROUTER}${ROUTE_PAID_PATH}`) {
      const run = String(body?.run);
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
          task: TASK_ID,
          expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
          routingFeeAtomic: fee,
          spec: this.answer.lead.spec,
          ...(this.answer.lead.convert !== undefined ? { convert: this.answer.lead.convert } : {}),
          output: SHAPE,
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
    return json(seller.body);
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
  const authorizer = resolveSpendAuthorizer(ctx(), {
    maxAutoSpendAtomic: 250_000n,
    sessionBudgetAtomic: 5_000_000n,
    allowlistCreators: [],
  } as never);
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
