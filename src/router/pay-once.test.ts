import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ElicitRequestSchema, type ElicitResult } from '@modelcontextprotocol/sdk/types.js';
import { CliError } from '../lib/errors';
import { evaluateSpendPolicy, type SpendPolicy } from '../lib/policy';
import { buildPaymentRequired, testWalletProvider } from '../lib/read-test-utils';
import { gateSpend, type SpendGateInput } from '../lib/spend-gate';
import { createLocalSpendAuthorizer } from '../lib/wallet/spend';
import type { CommandContext } from '../context';
import type { OfferSpec } from './decision';
import { buildRouterMcpServer } from './mcp';
import {
  PAY_ONCE_TIMEOUT_MS,
  payOnceAsker,
  payOnceMessage,
  type ElicitingServer,
} from './pay-once';
import { storeSpecs } from './specs';
import { runRequestTool, type OverLimitAsk } from './tool';

/**
 * PAY ONCE: one payment over `maxAutoSpend`, approved in an MCP elicitation at
 * the price shown, lifting that one check for that one call and nothing else.
 */

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'router-pay-once-'));
  await mkdir(join(dir, '.git'));
  await writeFile(
    join(dir, 'config.json'),
    JSON.stringify({ maxAutoSpend: '250000', sessionBudget: '5000000' }),
  );
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const POLICY: SpendPolicy = {
  maxAutoSpendAtomic: 250_000n,
  sessionBudgetAtomic: 5_000_000n,
  allowlistCreators: [],
};

function ctx(): CommandContext {
  const sink = () => ({ write: () => true }) as unknown as NodeJS.WritableStream;
  return {
    flags: { json: true, timeout: 5000, baseUrl: ROUTER },
    dataDir: dir,
    io: { stdout: sink(), stderr: sink(), isTTY: false },
  };
}

describe('the policy check Pay once lifts', () => {
  const over = { mode: 'automatic' as const, creator: 'api.exa.ai', sessionSpentAtomic: 0n };

  it('passes an amount over maxAutoSpend only when the approval equals it', () => {
    expect(evaluateSpendPolicy(POLICY, { ...over, amountAtomic: 420_000n }).reason).toBe(
      'above_auto_spend',
    );
    expect(
      evaluateSpendPolicy(POLICY, {
        ...over,
        amountAtomic: 420_000n,
        autoSpendApprovalAtomic: 420_000n,
      }).decision,
    ).toBe('allow');
    // A live quote that changed after the user answered is refused.
    expect(
      evaluateSpendPolicy(POLICY, {
        ...over,
        amountAtomic: 430_000n,
        autoSpendApprovalAtomic: 420_000n,
      }).reason,
    ).toBe('above_auto_spend');
  });

  it('lifts nothing else: the price cap, the allowlist and the daily budget still refuse', () => {
    const approved = { ...over, amountAtomic: 420_000n, autoSpendApprovalAtomic: 420_000n };
    expect(evaluateSpendPolicy(POLICY, { ...approved, maxPriceAtomic: 400_000n }).reason).toBe(
      'price_cap_exceeded',
    );
    expect(
      evaluateSpendPolicy({ ...POLICY, allowlistCreators: ['other.example'] }, approved).reason,
    ).toBe('not_allowlisted');
    expect(evaluateSpendPolicy({ ...POLICY, sessionBudgetAtomic: 400_000n }, approved).reason).toBe(
      'session_budget_exceeded',
    );
  });
});

describe('gateSpend with an approver', () => {
  function gate(over: Partial<SpendGateInput> = {}): SpendGateInput {
    return {
      ctx: ctx(),
      mode: 'automatic',
      authorizer: createLocalSpendAuthorizer({ dir, policy: POLICY }),
      amountAtomic: 420_000n,
      creator: 'api.exa.ai',
      requestKey: 'exa-search:abc',
      yes: false,
      payeeLabel: 'api.exa.ai',
      allowlistSubject: 'this host',
      notConfirmedMessage: 'Payment not confirmed.',
      ...over,
    };
  }

  async function refusal(input: SpendGateInput): Promise<unknown> {
    const err = await gateSpend(input).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CliError);
    return (err as CliError).details;
  }

  it('asks with the exact amount refused, and an accept reserves it once', async () => {
    const approveOverLimit = vi.fn(async () => true);
    const reservation = await gateSpend(gate({ approveOverLimit }));
    expect(approveOverLimit).toHaveBeenCalledWith(420_000n);
    expect(typeof reservation).toBe('string');
    const ledger = JSON.parse(await readFile(join(dir, 'spend.json'), 'utf8')) as {
      reservations: { amountAtomic: string; requestKey: string }[];
    };
    expect(ledger.reservations).toEqual([
      expect.objectContaining({ amountAtomic: '420000', requestKey: 'exa-search:abc' }),
    ]);
  });

  it('keeps the refusal on a decline, a throw, or no approver at all', async () => {
    for (const approveOverLimit of [
      async () => false,
      async () => {
        throw new Error('timed out');
      },
      undefined,
    ]) {
      expect(
        await refusal(gate(approveOverLimit !== undefined ? { approveOverLimit } : {})),
      ).toMatchObject({ reason: 'above_auto_spend', amountAtomic: '420000' });
    }
  });

  it('is refused on the re-run by the daily budget spent while the user answered', async () => {
    const authorizer = createLocalSpendAuthorizer({
      dir,
      policy: { ...POLICY, sessionBudgetAtomic: 500_000n },
    });
    const approveOverLimit = async () => {
      // Another lookup settles while the dialog is open.
      await authorizer.commit(undefined, 200_000n);
      return true;
    };
    expect(await refusal(gate({ authorizer, approveOverLimit }))).toMatchObject({
      reason: 'session_budget_exceeded',
    });
  });

  it('is refused on the re-run by an identical request already in flight', async () => {
    const authorizer = createLocalSpendAuthorizer({ dir, policy: POLICY });
    const approveOverLimit = async () => {
      await authorizer.authorize({
        mode: 'automatic',
        amountAtomic: 1_000n,
        creator: 'api.exa.ai',
        requestKey: 'exa-search:abc',
      });
      return true;
    };
    expect(await refusal(gate({ authorizer, approveOverLimit }))).toMatchObject({
      reason: 'duplicate_in_flight',
    });
  });

  it('never asks for another reason, or in manual mode', async () => {
    const approveOverLimit = vi.fn(async () => true);
    expect(
      await refusal(
        gate({
          approveOverLimit,
          authorizer: createLocalSpendAuthorizer({
            dir,
            policy: { ...POLICY, sessionBudgetAtomic: 100_000n },
          }),
        }),
      ),
    ).toMatchObject({ reason: 'session_budget_exceeded' });
    expect(await refusal(gate({ approveOverLimit, maxPriceAtomic: 1n }))).toMatchObject({
      reason: 'price_cap_exceeded',
    });
    // Manual mode asks its own confirm, never the approver.
    expect(await refusal(gate({ approveOverLimit, mode: 'manual' }))).toMatchObject({
      reason: 'confirm_always',
    });
    expect(approveOverLimit).not.toHaveBeenCalled();
  });

  it('is never lifted by a file another process wrote under the data dir', async () => {
    for (const name of ['approval.json', 'pay-once.json', 'approvals/420000']) {
      await mkdir(join(dir, name, '..'), { recursive: true });
      await writeFile(join(dir, name), JSON.stringify({ amountAtomic: '420000', approved: true }));
    }
    expect(await refusal(gate())).toMatchObject({ reason: 'above_auto_spend' });
  });
});

describe('the elicitation', () => {
  function fake(
    capabilities: ReturnType<ElicitingServer['getClientCapabilities']>,
    answer: () => Promise<ElicitResult>,
  ) {
    const elicitInput = vi.fn<ElicitingServer['elicitInput']>(answer);
    const server: ElicitingServer = { getClientCapabilities: () => capabilities, elicitInput };
    return { server, elicitInput };
  }
  const ask: OverLimitAsk = { label: 'Exa search', amountAtomic: 420_000n };
  const limit = async () => 250_000n;

  it('says who wants how much, over which limit, and asks one boolean', async () => {
    const { server, elicitInput } = fake({ elicitation: { form: {} } }, async () => ({
      action: 'accept',
      content: { pay: true },
    }));
    expect(await payOnceAsker(server, limit)!(ask)).toBe(true);
    const [params, options] = elicitInput.mock.calls[0]!;
    expect(params.message).toBe(
      'Exa search wants $0.42 for this lookup, over your $0.25 automatic limit. Pay once?',
    );
    expect(params.requestedSchema).toMatchObject({
      properties: { pay: { type: 'boolean' } },
      required: ['pay'],
    });
    expect(options?.timeout).toBe(PAY_ONCE_TIMEOUT_MS);
    expect(PAY_ONCE_TIMEOUT_MS).toBe(300_000);
    expect(payOnceMessage(ask, 250_000n)).not.toMatch(/x402/i);
  });

  it('reads a decline, a cancel, an unticked box and a timeout as no', async () => {
    const answers: (() => Promise<ElicitResult>)[] = [
      async () => ({ action: 'decline' }),
      async () => ({ action: 'cancel' }),
      async () => ({ action: 'accept', content: { pay: false } }),
      async () => {
        throw new Error('Request timed out');
      },
    ];
    for (const answer of answers) {
      expect(
        await payOnceAsker(fake({ elicitation: { form: {} } }, answer).server, limit)!(ask),
      ).toBe(false);
    }
  });

  it('asks nothing of a client without form elicitation', () => {
    const none = async (): Promise<ElicitResult> => ({ action: 'accept', content: { pay: true } });
    expect(payOnceAsker(fake(undefined, none).server, limit)).toBeUndefined();
    expect(payOnceAsker(fake({}, none).server, limit)).toBeUndefined();
    expect(payOnceAsker(fake({ elicitation: { url: {} } }, none).server, limit)).toBeUndefined();
  });
});

const ROUTER = 'https://tenjin.sh';
const PROVIDER = 'https://api.exa.example.test/search';
const PAYEE = '0x1111111111111111111111111111111111111111';
const SPEC_ID = '0195f3a1-6c4d-7a2b-9e10-5f6a7b8c9d42';
const PUBLIC = { resolveHostname: async () => [{ address: '93.184.216.34', family: 4 }] };

function spec(over: Partial<OfferSpec> = {}): OfferSpec {
  return {
    id: SPEC_ID,
    capabilityId: 'exa-search',
    provider: 'Exa',
    description: 'web search',
    priceAtomic: '420000',
    priceVaries: false,
    maxAmountAtomic: '420000',
    payTo: PAYEE,
    network: 'eip155:8453',
    asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    request: { method: 'GET', url: PROVIDER, fields: { q: 'query' }, location: 'query' },
    input: {
      type: 'object',
      properties: { q: { type: 'string' } },
      required: ['q'],
      additionalProperties: false,
    },
    pinned: {},
    ...over,
  };
}

/** A provider that answers a 402 then the paid 200, any number of times. */
function network(): { fetchImpl: typeof fetch; paid: () => number } {
  let paid = 0;
  const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = String(input);
    const headers = new Headers(init?.headers ?? {});
    const json = (body: unknown, status = 200, extra: Record<string, string> = {}) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json', ...extra },
      });
    if (url.startsWith(ROUTER)) return json({});
    if (headers.get('payment-signature') !== null) {
      paid += 1;
      return json({ results: ['a'] });
    }
    return json({}, 402, {
      'PAYMENT-REQUIRED': buildPaymentRequired({ amount: '420000' }).header,
    });
  }) as typeof fetch;
  return { fetchImpl, paid: () => paid };
}

function toolDeps(
  fetchImpl: typeof fetch,
  approveOverLimit?: (ask: OverLimitAsk) => Promise<boolean>,
) {
  return {
    ctx: ctx(),
    cwd: dir,
    authorizer: createLocalSpendAuthorizer({ dir, policy: POLICY }),
    fetchImpl,
    payDeps: {
      readBalance: async () => 100_000_000n,
      fetchImpl,
      provider: testWalletProvider(),
      destination: PUBLIC,
    },
    ...(approveOverLimit !== undefined ? { approveOverLimit } : {}),
  };
}

describe('the request tool over the automatic limit', () => {
  it('pays once at the shown price when the user accepts', async () => {
    await storeSpecs(dir, [spec()]);
    const { fetchImpl, paid } = network();
    const approve = vi.fn(async () => true);
    const result = await runRequestTool(
      { id: SPEC_ID, input: { q: 'rust' } },
      toolDeps(fetchImpl, approve),
    );
    expect(approve).toHaveBeenCalledWith({ label: 'Tenjin lookup', amountAtomic: 420_000n });
    expect(result.envelope).toMatchObject({
      status: 'fulfilled',
      cost: ['provider price 0.42 USD'],
    });
    expect(paid()).toBe(1);
  });

  it('returns needs_approval with the policy reason on a decline, and asks again next call', async () => {
    await storeSpecs(dir, [spec()]);
    const { fetchImpl, paid } = network();
    const approve = vi.fn(async () => false);
    for (let round = 1; round <= 2; round += 1) {
      const result = await runRequestTool(
        { id: SPEC_ID, input: { q: 'rust' } },
        toolDeps(fetchImpl, approve),
      );
      expect(result.envelope).toMatchObject({
        status: 'needs_approval',
        policyReason: 'above_auto_spend',
        cost: ['provider price 0 USD'],
      });
      // A second call for the same offer asks again: no approval is inherited.
      expect(approve).toHaveBeenCalledTimes(round);
    }
    expect(approve).toHaveBeenLastCalledWith({ label: 'Tenjin lookup', amountAtomic: 420_000n });
    expect(paid()).toBe(0);
  });

  it('asks nothing without an approver, and says which limit refused', async () => {
    await storeSpecs(dir, [spec()]);
    const { fetchImpl, paid } = network();
    const result = await runRequestTool({ id: SPEC_ID, input: { q: 'rust' } }, toolDeps(fetchImpl));
    expect(result.envelope).toMatchObject({
      status: 'needs_approval',
      policyReason: 'above_auto_spend',
    });
    expect(paid()).toBe(0);
  });

  it('forwards the daily budget as the reason, and never asks for it', async () => {
    await writeFile(
      join(dir, 'config.json'),
      JSON.stringify({ maxAutoSpend: '250000', sessionBudget: '300000' }),
    );
    await storeSpecs(dir, [spec()]);
    const { fetchImpl } = network();
    const approve = vi.fn(async () => true);
    const deps = {
      ...toolDeps(fetchImpl, approve),
      authorizer: createLocalSpendAuthorizer({
        dir,
        policy: { ...POLICY, sessionBudgetAtomic: 300_000n },
      }),
    };
    const result = await runRequestTool({ id: SPEC_ID, input: { q: 'rust' } }, deps);
    expect(result.envelope).toMatchObject({
      status: 'needs_approval',
      policyReason: 'session_budget_exceeded',
    });
    expect(approve).not.toHaveBeenCalled();
  });
});

describe('tenjin mcp asks through the client', () => {
  async function session(answer: ((message: string) => ElicitResult) | null) {
    await storeSpecs(dir, [spec()]);
    const { fetchImpl, paid } = network();
    const server = buildRouterMcpServer({
      dataDir: dir,
      handlerDeps: {
        cwd: dir,
        provider: testWalletProvider(),
        authorizer: createLocalSpendAuthorizer({ dir, policy: POLICY }),
        fetchImpl,
        payDeps: {
          readBalance: async () => 100_000_000n,
          fetchImpl,
          provider: testWalletProvider(),
          destination: PUBLIC,
        },
      },
    });
    const asked: string[] = [];
    const client = new Client(
      { name: 'test', version: '0.0.0' },
      answer === null ? {} : { capabilities: { elicitation: { form: {} } } },
    );
    if (answer !== null) {
      client.setRequestHandler(ElicitRequestSchema, async (request) => {
        const message = (request.params as { message: string }).message;
        asked.push(message);
        return answer(message);
      });
    }
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const called = await client.callTool({
      name: 'request',
      arguments: { id: SPEC_ID, input: { q: 'rust' } },
    });
    await client.close();
    await server.close();
    const blocks = called.content as { text: string }[];
    return { envelope: JSON.parse(blocks[1]!.text) as Record<string, unknown>, asked, paid };
  }

  it('shows the dialog with the price and pays on accept', async () => {
    const { envelope, asked, paid } = await session(() => ({
      action: 'accept',
      content: { pay: true },
    }));
    expect(asked).toEqual([
      'Tenjin lookup wants $0.42 for this lookup, over your $0.25 automatic limit. Pay once?',
    ]);
    expect(envelope).toMatchObject({ status: 'fulfilled' });
    expect(paid()).toBe(1);
  });

  it('keeps needs_approval on a decline', async () => {
    const { envelope, paid } = await session(() => ({ action: 'decline' }));
    expect(envelope).toMatchObject({ status: 'needs_approval', policyReason: 'above_auto_spend' });
    expect(paid()).toBe(0);
  });

  it('asks a client without the capability nothing', async () => {
    const { envelope, asked, paid } = await session(null);
    expect(asked).toEqual([]);
    expect(envelope).toMatchObject({ status: 'needs_approval', policyReason: 'above_auto_spend' });
    expect(paid()).toBe(0);
  });
});
