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
      routerVersion: '2026-09-23.1',
      requestId: 'r-1',
      decision: {
        action: 'native',
        reason: 'Your own tools cover this.',
        diagnostics: {
          reasonCode: 'native_sufficient',
          stage: 'capability',
          missing: [],
          nextAction: '',
        },
      },
      billing: {
        settled: false,
        amountAtomic: '0',
        asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
        network: 'eip155:8453',
        reasonCode: 'waived_native',
      },
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
      // A `native` decision is a routing outcome delivered, not a tool failure:
      // the MCP error flag stays down and the status carries the fact.
      expect(called.isError).toBe(false);
      expect(called.structuredContent).toMatchObject({
        status: 'native',
        reason: 'Your own tools cover this.',
        nextStep: 'Continue with your own tools. Nothing was bought.',
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

describe('the base URL the MCP server routes against', () => {
  it('honours TENJIN_BASE_URL over the config file, like every other command', async () => {
    const fs = await import('node:fs/promises');
    await fs.writeFile(
      join(dir, 'config.json'),
      JSON.stringify({
        bazaarPay: true,
        maxAutoSpend: '100000',
        baseUrl: 'https://file.example.test',
      }),
    );
    const seen: string[] = [];
    const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      seen.push(String(input));
      if (!new Headers(init?.headers ?? {}).has('payment-signature')) {
        return new Response('{}', {
          status: 402,
          headers: {
            'content-type': 'application/json',
            'PAYMENT-REQUIRED': buildPaymentRequired({ amount: '1000' }).header,
          },
        });
      }
      return new Response(
        JSON.stringify({
          schemaVersion: 1,
          routerVersion: 'v',
          requestId: 'r',
          decision: {
            action: 'native',
            reason: 'covered',
            diagnostics: {
              reasonCode: 'native_sufficient',
              stage: 'capability',
              missing: [],
              nextAction: '',
            },
          },
          billing: {
            settled: false,
            amountAtomic: '0',
            asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
            network: 'eip155:8453',
            reasonCode: 'waived_native',
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof fetch;

    const prior = process.env.TENJIN_BASE_URL;
    process.env.TENJIN_BASE_URL = 'https://env.example.test';
    try {
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
        await client.callTool({ name: 'request', arguments: { query: 'anything' } });
      } finally {
        await client.close();
        await server.close();
      }
    } finally {
      if (prior === undefined) delete process.env.TENJIN_BASE_URL;
      else process.env.TENJIN_BASE_URL = prior;
    }
    expect(seen[0]).toBe('https://env.example.test/api/x402-router');
    expect(seen.every((u) => !u.startsWith('https://file.example.test'))).toBe(true);
  });
});

/**
 * TWO RULES, AND THE ORDER MATTERS. What to send is one concrete lookup, which
 * is what lets a mixed turn route at all; how to write it is verbatim, because
 * the router binds the query text and a provider parses it. The live smoke lost
 * a Wolfram turn when the model sent "Evaluate the definite integral ∫₀¹ ..."
 * for a user who wrote "Evaluate ∫₀¹ ...": zero pods, and billed.
 */
describe('the tool tells the model what to send and not to rephrase', () => {
  it('puts the scope rule then the verbatim rule, in the instructions and on the parameter', async () => {
    const { SCOPE_RULE, VERBATIM_RULE } = await import('./mcp');
    const server = buildRouterMcpServer({
      dataDir: dir,
      handlerDeps: {
        signer: await testWalletProvider().getSigner(),
        authorizer: authorizer(),
        cache: new RequirementsCache(),
      },
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '0.0.0' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const tools = await client.listTools();
      const request = tools.tools.find((t) => t.name === 'request')!;
      expect(request.description?.startsWith(SCOPE_RULE)).toBe(true);
      expect(request.description).toContain(VERBATIM_RULE);
      const schema = request.inputSchema as unknown as {
        properties: { query: { description: string } };
      };
      expect(schema.properties.query.description).toContain(SCOPE_RULE);
      expect(schema.properties.query.description).toContain(VERBATIM_RULE);
      // One lookup, not the whole turn: neither rule may ask for the latter.
      for (const phrase of ['one concrete external lookup', 'A mixed turn is not one lookup']) {
        expect(SCOPE_RULE).toContain(phrase);
      }
      for (const text of [SCOPE_RULE, VERBATIM_RULE]) {
        expect(text).not.toContain("the user's request verbatim");
        expect(text).not.toContain('whole request');
      }
      // And the verbatim rule still names the failure it exists to prevent.
      for (const phrase of ['VERBATIM', 'no paraphrase', 'Evaluate the definite integral']) {
        expect(VERBATIM_RULE).toContain(phrase);
      }
    } finally {
      await client.close();
      await server.close();
    }
  });
});
