import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ElicitRequestSchema, type ElicitResult } from '@modelcontextprotocol/sdk/types.js';
import { quotesDir } from '../lib/paths';
import type { SpendPolicy } from '../lib/policy';
import { buildPaymentRequired, testWalletProvider } from '../lib/read-test-utils';
import { readSpendSummary } from '../lib/spend-ledger';
import { createLocalSpendAuthorizer } from '../lib/wallet/spend';
import type { CommandContext } from '../context';
import type { OfferSpec } from './decision';
import { buildRouterMcpServer } from './mcp';
import { PAY_ONCE_TIMEOUT_MS, payOnceAsker, type ElicitingServer } from './pay-once';
import { storeSpecs } from './specs';
import { runRequestTool } from './tool';

/**
 * PAY ONCE: the in-place front end of the one approval gate. A call over the
 * automatic limits is asked about in an MCP elicitation where the client shows
 * one; a yes keeps and runs the same quote `approve` runs, a no pays nothing
 * and keeps nothing, and a client without the dialog gets the `approve` path.
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

/** The quotes kept on disk, parsed. */
async function quotes(): Promise<Record<string, unknown>[]> {
  const names = await readdir(quotesDir(dir)).catch(() => [] as string[]);
  return Promise.all(
    names
      .filter((name) => name.endsWith('.json'))
      .map(
        async (name) =>
          JSON.parse(await readFile(join(quotesDir(dir), name), 'utf8')) as Record<string, unknown>,
      ),
  );
}

describe('the elicitation', () => {
  function fake(
    capabilities: ReturnType<ElicitingServer['getClientCapabilities']>,
    answer: () => Promise<ElicitResult>,
  ) {
    const elicitInput = vi.fn<ElicitingServer['elicitInput']>(answer);
    const server: ElicitingServer = { getClientCapabilities: () => capabilities, elicitInput };
    return { server, elicitInput };
  }
  const message = 'One call to Exa costs $0.42. Pay once?';

  it("shows the plan's sentence and asks one boolean, for five minutes", async () => {
    const { server, elicitInput } = fake({ elicitation: { form: {} } }, async () => ({
      action: 'accept',
      content: { pay: true },
    }));
    expect(await payOnceAsker(server)!(message)).toBe(true);
    const [params, options] = elicitInput.mock.calls[0]!;
    expect(params.message).toBe(message);
    expect(params.requestedSchema).toMatchObject({
      properties: { pay: { type: 'boolean' } },
      required: ['pay'],
    });
    expect(options?.timeout).toBe(PAY_ONCE_TIMEOUT_MS);
    expect(PAY_ONCE_TIMEOUT_MS).toBe(300_000);
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
      expect(await payOnceAsker(fake({ elicitation: { form: {} } }, answer).server)!(message)).toBe(
        false,
      );
    }
  });

  it('asks nothing of a client without form elicitation', () => {
    const none = async (): Promise<ElicitResult> => ({ action: 'accept', content: { pay: true } });
    expect(payOnceAsker(fake(undefined, none).server)).toBeUndefined();
    expect(payOnceAsker(fake({}, none).server)).toBeUndefined();
    expect(payOnceAsker(fake({ elicitation: { url: {} } }, none).server)).toBeUndefined();
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
  approveOverLimit?: (message: string) => Promise<boolean>,
  extra: { approves?: boolean } = {},
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
    ...extra,
  };
}

const OVER_CAP =
  'One call to Exa costs $0.42. That is over the $0.25 this machine pays for one call without asking. Pay once?';

describe('the request tool over the automatic limits', () => {
  it("asks with the plan's sentence, and a yes runs the same quote approve runs", async () => {
    await storeSpecs(dir, [spec({ label: 'Exa search' })]);
    const { fetchImpl, paid } = network();
    const approve = vi.fn(async () => true);
    const result = await runRequestTool(
      { id: SPEC_ID, input: { q: 'rust' } },
      toolDeps(fetchImpl, approve),
    );
    expect(approve).toHaveBeenCalledWith(OVER_CAP);
    expect(result.envelope).toMatchObject({
      status: 'fulfilled',
      cost: ['provider price 0.42 USD'],
    });
    expect(paid()).toBe(1);
    // ONE RECORD: the quote `approve` would have run, kept and used once.
    const kept = await quotes();
    expect(kept).toHaveLength(1);
    expect(kept[0]).toMatchObject({ totalAtomic: '420000', usedAt: expect.any(String) as string });
    // An approved payment is the user's own, outside the automatic budget.
    const ledger = await readSpendSummary(dir);
    expect(ledger?.automaticCommittedAtomic ?? '0').toBe('0');
    expect(ledger?.committedAtomic).toBe('420000');
  });

  it('pays nothing and keeps no quote on a no, and asks again next call', async () => {
    await storeSpecs(dir, [spec()]);
    const { fetchImpl, paid } = network();
    const approve = vi.fn(async () => false);
    for (let round = 1; round <= 2; round += 1) {
      const result = await runRequestTool(
        { id: SPEC_ID, input: { q: 'rust' } },
        toolDeps(fetchImpl, approve, { approves: true }),
      );
      expect(result.envelope).toMatchObject({
        status: 'needs_approval',
        cost: ['provider price 0 USD'],
      });
      // No second ask: no quote, so no approve call to make.
      expect(result.envelope.quote).toBeUndefined();
      expect(String(result.envelope.nextStep)).not.toContain('approve(');
      expect(approve).toHaveBeenCalledTimes(round);
    }
    expect(await quotes()).toEqual([]);
    expect(paid()).toBe(0);
  });

  it('takes the approve path without a dialog', async () => {
    await storeSpecs(dir, [spec()]);
    const { fetchImpl, paid } = network();
    const result = await runRequestTool(
      { id: SPEC_ID, input: { q: 'rust' } },
      toolDeps(fetchImpl, undefined, { approves: true }),
    );
    expect(result.envelope).toMatchObject({ status: 'needs_approval' });
    expect(String(result.envelope.nextStep)).toContain('approve({quote: ');
    const kept = await quotes();
    expect(kept).toHaveLength(1);
    expect(kept[0]!.usedAt).toBeUndefined();
    expect(paid()).toBe(0);
  });

  it("asks for the day's budget too, as approve does", async () => {
    await writeFile(
      join(dir, 'config.json'),
      JSON.stringify({ maxAutoSpend: '500000', sessionBudget: '300000' }),
    );
    await storeSpecs(dir, [spec()]);
    const { fetchImpl, paid } = network();
    const approve = vi.fn(async () => true);
    const result = await runRequestTool(
      { id: SPEC_ID, input: { q: 'rust' } },
      toolDeps(fetchImpl, approve),
    );
    expect(approve).toHaveBeenCalledWith(
      "One call to Exa costs $0.42. That is more than today's automatic budget has left ($0.3). Pay once?",
    );
    expect(result.envelope).toMatchObject({ status: 'fulfilled' });
    expect(paid()).toBe(1);
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
    expect(asked).toEqual([OVER_CAP]);
    expect(envelope).toMatchObject({ status: 'fulfilled' });
    expect(paid()).toBe(1);
  });

  it('keeps needs_approval on a decline', async () => {
    const { envelope, paid } = await session(() => ({ action: 'decline' }));
    expect(envelope).toMatchObject({ status: 'needs_approval' });
    expect(envelope.quote).toBeUndefined();
    expect(paid()).toBe(0);
  });

  it('asks a client without the capability nothing', async () => {
    const { envelope, asked, paid } = await session(null);
    expect(asked).toEqual([]);
    expect(envelope).toMatchObject({ status: 'needs_approval' });
    expect(paid()).toBe(0);
  });
});
