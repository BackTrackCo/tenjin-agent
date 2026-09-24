import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { testWalletProvider } from '../lib/read-test-utils';
import type { SpendAuthorization, SpendAuthorizer } from '../lib/wallet';
import { buildRouterMcpServer } from './mcp';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'router-mcp-'));
  // Its own git root: `router.*` resolves from here, never from the suite's cwd.
  await mkdir(join(dir, '.git'));
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

/** The one free decision this server asks for; no 402, nothing signed. */
function router(body: unknown): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as typeof fetch;
}

describe('the router MCP server', () => {
  it('advertises one request tool and answers it, then closes cleanly', async () => {
    const fetchImpl = router({
      schemaVersion: 1,
      routerVersion: '2026-09-23.1',
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
    });
    const server = buildRouterMcpServer({
      dataDir: dir,
      handlerDeps: {
        cwd: dir,
        signer: await testWalletProvider().getSigner(),
        authorizer: authorizer(),
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
        cwd: dir,
        signer: await testWalletProvider().getSigner(),
        authorizer: authorizer(),
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
    const fetchImpl = (async (input: Parameters<typeof fetch>[0]) => {
      seen.push(String(input));
      return new Response(
        JSON.stringify({
          schemaVersion: 1,
          routerVersion: 'v',
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
          cwd: dir,
          signer: await testWalletProvider().getSigner(),
          authorizer: authorizer(),
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
 * ONE LOOKUP, AND THE MODEL'S OWN WORDS FOR IT. The rule used to demand the
 * user's whole request, and then grew a second half forbidding any rewording,
 * which is neither enforceable nor necessary now that the backend holds the
 * turn's packet and compares the query it gets with the one it prepared.
 */
describe('what the tool tells the model to send', () => {
  it('asks for one lookup, with the turn id beside it', async () => {
    const { SCOPE_RULE } = await import('./mcp');
    const server = buildRouterMcpServer({
      dataDir: dir,
      handlerDeps: {
        cwd: dir,
        signer: await testWalletProvider().getSigner(),
        authorizer: authorizer(),
      },
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '0.0.0' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const tools = await client.listTools();
      const request = tools.tools.find((t) => t.name === 'request')!;
      // ONE GENERIC SENTENCE, and no catalog here: the client is not a second
      // source of what services exist, and the hook line names the one that
      // fits the turn.
      expect(request.description?.startsWith("Paid lookups through Tenjin's router")).toBe(true);
      expect(request.description).toContain('a hook line names the service and how to call it');
      for (const name of ['Exa', 'Firecrawl', 'CoinMarketCap', 'Wolfram', 'Hunter', 'Minerva']) {
        expect(request.description).not.toContain(name);
      }
      expect(request.description).toContain(SCOPE_RULE);
      const schema = request.inputSchema as unknown as {
        properties: { query: { description: string }; id?: { description: string } };
        required?: string[];
      };
      // The query is always required; the id never is.
      expect(schema.properties.query.description).toContain(SCOPE_RULE);
      expect(schema.required).toEqual(['query']);
      expect(schema.properties.id?.description).toContain('names the service');
      // One lookup, not the whole turn, and no blanket ban on wording.
      expect(SCOPE_RULE).toContain('one concrete external lookup');
      expect(SCOPE_RULE).toContain('A mixed turn is not one lookup');
      expect(SCOPE_RULE).not.toContain("the user's request verbatim");
      // Deciding is free now, and the instructions say so.
      expect(request.description).toContain('Deciding what to route is free');
    } finally {
      await client.close();
      await server.close();
    }
  });
});

/**
 * ROUTING IS FREE, SO A WALLET IS THE PAYING LEG'S PROBLEM. The handler used to
 * open the wallet before the tool ran, which meant a machine with no wallet, or
 * a locked one, could not even be told that its own tools cover the task.
 */
describe('a free answer on a machine with no wallet', () => {
  it('delivers a native decision without ever opening one', async () => {
    const fetchImpl = router({
      schemaVersion: 1,
      routerVersion: '2026-09-23.1',
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
    });
    // No wallet under this data dir at all: `getSigner` throws WALLET_MISSING.
    const server = buildRouterMcpServer({
      dataDir: dir,
      handlerDeps: { cwd: dir, authorizer: authorizer(), fetchImpl },
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '0.0.0' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const called = await client.callTool({ name: 'request', arguments: { query: 'weather' } });
      expect(called.isError).toBe(false);
      expect(called.structuredContent).toMatchObject({ status: 'native' });
    } finally {
      await client.close();
      await server.close();
    }
  });
});
