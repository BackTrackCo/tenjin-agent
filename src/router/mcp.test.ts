import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildPaymentRequired, testWalletProvider } from '../lib/read-test-utils';
import type { SpendAuthorization, SpendAuthorizer } from '../lib/wallet';
import { buildRouterMcpServer } from './mcp';
import { RequirementsCache } from './decision';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'router-mcp-'));
  await writeFile(
    join(dir, 'config.json'),
    JSON.stringify({ bazaarPay: true, maxAutoSpend: '100000', baseUrl: 'https://tenjin.sh' }),
  );
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function authorizer(): SpendAuthorizer {
  return {
    policyEnforcement: 'client-only',
    authorize: vi.fn(async (req): Promise<SpendAuthorization> => ({
      decision: 'allow',
      reason: 'within_policy',
      message: 'test',
      amountAtomic: req.amountAtomic,
      sessionSpentAtomic: 0n,
      sessionBudgetAtomic: 0n,
      policyEnforcement: 'client-only',
      reservationId: 'rsv',
    })),
    commit: vi.fn(async () => undefined),
    release: vi.fn(async () => undefined),
  };
}

/** Every leg answers 402 unpaid, then the scripted paid body. */
function router(paidBody: unknown): typeof fetch {
  return (async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    if (!new Headers(init?.headers ?? {}).has('payment-signature')) {
      return new Response('{}', {
        status: 402,
        headers: {
          'content-type': 'application/json',
          'PAYMENT-REQUIRED': buildPaymentRequired({ amount: '1000' }).header,
        },
      });
    }
    return new Response(JSON.stringify(paidBody), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
}

describe('the router MCP server', () => {
  it('advertises one request tool and answers it, then closes cleanly', async () => {
    const fetchImpl = router({
      schemaVersion: 1,
      routerVersion: '2026-09-22.1',
      requestId: 'r-1',
      decision: { action: 'native', reason: 'Your own tools cover this.' },
    });
    const server = buildRouterMcpServer({
      dataDir: dir,
      handlerDeps: {
        signer: await testWalletProvider().getSigner(),
        authorizer: authorizer(),
        cache: new RequirementsCache(),
        fetchImpl,
        payDeps: { fetchImpl },
      },
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '0.0.0' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const tools = await client.listTools();
      expect(tools.tools.map((t) => t.name)).toEqual(['request']);
      const called = await client.callTool({ name: 'request', arguments: { query: 'weather' } });
      expect(called.isError).toBe(true);
      expect(called.structuredContent).toMatchObject({
        status: 'native',
        reason: 'Your own tools cover this.',
      });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('never opens the wallet when a handler signer is supplied', async () => {
    const server = buildRouterMcpServer({
      dataDir: dir,
      handlerDeps: {
        signer: await testWalletProvider().getSigner(),
        authorizer: authorizer(),
        cache: new RequirementsCache(),
      },
    });
    // No wallet exists under this data dir, so a background unlock would throw.
    await expect(server.close()).resolves.toBeUndefined();
  });
});
