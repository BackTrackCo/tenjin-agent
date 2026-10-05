import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { testWalletProvider } from '../lib/read-test-utils';
import type { SpendAuthorization, SpendAuthorizer } from '../lib/wallet';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { writeFeeState } from './fee-state';
import { FakeRouter, testSigner } from './fee-test-utils';
import { hookToolInput } from './hook-tool';
import { buildRouterMcpServer, MAX_RESULT_SIZE_CHARS, MAX_RESULT_SIZE_KEY } from './mcp';
import { RoutingPayer } from './routing-payer';

/** The envelope a call returned: the JSON text block after the summary line. */
function envelopeOf(called: Record<string, unknown>): unknown {
  const blocks = called['content'] as { type: string; text: string }[];
  expect(blocks).toHaveLength(2);
  return JSON.parse(blocks[1]!.text);
}

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'router-mcp-'));
  // Its own git root: `router.*` resolves from here, never from the suite's cwd.
  await mkdir(join(dir, '.git'));
  await writeFile(
    join(dir, 'config.json'),
    JSON.stringify({ maxAutoSpend: '100000', baseUrl: 'https://tenjin.sh' }),
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
      expect(tools.tools.map((t) => t.name)).toEqual(['request', 'hook']);
      // The harness reads its inline-result threshold from the listed tool.
      expect(tools.tools[0]!._meta).toEqual({
        [MAX_RESULT_SIZE_KEY]: MAX_RESULT_SIZE_CHARS,
      });
      const called = await client.callTool({ name: 'request', arguments: { query: 'weather' } });
      // A `native` decision is a routing outcome delivered, not a tool failure:
      // the MCP error flag stays down and the status carries the fact.
      expect(called.isError).toBe(false);
      // The envelope rides once, as the JSON text block after the summary.
      expect(called.structuredContent).toBeUndefined();
      expect(envelopeOf(called)).toMatchObject({
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

/**
 * THE HOOK ENTRIES' TOOL. Claude Code substitutes the event's fields into the
 * entry's `input` as strings (objects as JSON text, absent fields empty), so
 * these calls send exactly that shape.
 */
describe('the hook tool', () => {
  /** The `input` Claude Code would send for `kind`, from one harness event. */
  function substituted(kind: Parameters<typeof hookToolInput>[0], event: Record<string, unknown>) {
    return Object.fromEntries(
      Object.entries(hookToolInput(kind)).map(([key, value]) => {
        const path = /^\$\{(.+)\}$/.exec(value)?.[1];
        if (path === undefined) return [key, value];
        const field = event[path];
        return [
          key,
          field === undefined ? '' : typeof field === 'string' ? field : JSON.stringify(field),
        ];
      }),
    );
  }

  async function connect(server: ReturnType<typeof buildRouterMcpServer>) {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '0.0.0' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    return client;
  }

  /** A home laid out as Claude Code keeps it, with `session`'s transcript in it. */
  async function home(session: string): Promise<{ homeDir: string; transcript: string }> {
    const homeDir = join(dir, 'home');
    const project = join(homeDir, '.claude', 'projects', '-repo');
    await mkdir(project, { recursive: true });
    const transcript = join(project, `${session}.jsonl`);
    await writeFile(transcript, '');
    return { homeDir: await realpath(homeDir), transcript: await realpath(transcript) };
  }

  const promptEvent = (session: string, transcript: string) => ({
    hook_event_name: 'UserPromptSubmit',
    session_id: session,
    transcript_path: transcript,
    cwd: dir,
    prompt: 'what is the current price of ETH in USD',
  });

  it('runs the prompt leg in this process and answers in the hook format', async () => {
    await writeFeeState(dir, { paidPath: 'available', checkedAtMs: Date.now() });
    const { homeDir, transcript } = await home('sess-hook');
    const fake = new FakeRouter();
    const server = buildRouterMcpServer({
      dataDir: dir,
      homeDir,
      handlerDeps: { cwd: dir, signer: await testWalletProvider().getSigner() },
      hookDeps: { baseUrl: 'https://router.test', fetchImpl: fake.fetch, warn: () => undefined },
    });
    const client = await connect(server);
    try {
      const called = await client.callTool({
        name: 'hook',
        arguments: substituted('prompt', promptEvent('sess-hook', transcript)),
      });
      const text = (called.content as { text: string }[])[0]!.text;
      // The fee is not approved, so the free path ran and the pause was said.
      expect(fake.log).toEqual(['POST /api/x402-router unpaid']);
      expect(JSON.parse(text)).toMatchObject({
        hookSpecificOutput: { hookEventName: 'UserPromptSubmit' },
      });
      expect(text).toContain('routing is paused');
      // Said once: the same session's next prompt gets no output at all.
      const again = await client.callTool({
        name: 'hook',
        arguments: substituted('prompt', promptEvent('sess-hook', transcript)),
      });
      expect((again.content as { text: string }[])[0]!.text).toBe('');
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("pays the routing fee through this process's payer once the fee is approved", async () => {
    await writeFile(join(dir, 'config.json'), JSON.stringify({ routingFee: 'approved' }));
    const { homeDir, transcript } = await home('sess-paid');
    const fake = new FakeRouter();
    const wallet = privateKeyToAccount(generatePrivateKey());
    const payer = new RoutingPayer({
      dataDir: dir,
      getSigner: async () => testSigner(wallet),
      policy: async () => ({
        maxAutoSpendAtomic: 250_000n,
        sessionBudgetAtomic: 5_000_000n,
        allowlistCreators: [],
      }),
      walletBalance: async () => 10_000_000n,
      readContract: fake.readContract as never,
      fetchImpl: fake.fetch,
      pid: 1,
      isAlive: () => true,
      warn: () => undefined,
    });
    const server = buildRouterMcpServer({
      dataDir: dir,
      homeDir,
      payer,
      handlerDeps: { cwd: dir, signer: await testWalletProvider().getSigner() },
      hookDeps: { baseUrl: 'https://router.test', fetchImpl: fake.fetch, warn: () => undefined },
    });
    const client = await connect(server);
    try {
      await client.callTool({
        name: 'hook',
        arguments: substituted('prompt', promptEvent('sess-paid', transcript)),
      });
      expect(fake.log).toEqual([
        'POST /api/x402-router/route unpaid',
        'POST /api/x402-router/route paid',
      ]);
      expect(fake.deposits).toBe(1);
      expect(fake.settledFees).toBe(1);
    } finally {
      await client.close();
      await server.close();
      await payer.close();
    }
  });

  it('reads, sends and pays nothing for a forged path, and routes a new session', async () => {
    await writeFile(join(dir, 'config.json'), JSON.stringify({ routingFee: 'approved' }));
    const { homeDir, transcript } = await home('sess-real');
    const fake = new FakeRouter();
    const wallet = privateKeyToAccount(generatePrivateKey());
    const payer = new RoutingPayer({
      dataDir: dir,
      getSigner: async () => testSigner(wallet),
      policy: async () => ({
        maxAutoSpendAtomic: 250_000n,
        sessionBudgetAtomic: 5_000_000n,
        allowlistCreators: [],
      }),
      walletBalance: async () => 10_000_000n,
      readContract: fake.readContract as never,
      fetchImpl: fake.fetch,
      pid: 1,
      isAlive: () => true,
      warn: () => undefined,
    });
    const server = buildRouterMcpServer({
      dataDir: dir,
      homeDir,
      payer,
      handlerDeps: { cwd: dir, signer: await testWalletProvider().getSigner() },
      hookDeps: { baseUrl: 'https://router.test', fetchImpl: fake.fetch, warn: () => undefined },
    });
    const client = await connect(server);
    const forged = join(dir, 'config.json');
    const text = async (session: string, path: string) =>
      (
        (
          await client.callTool({
            name: 'hook',
            arguments: substituted('prompt', promptEvent(session, path)),
          })
        ).content as { text: string }[]
      )[0]!.text;
    try {
      expect(await text('sess-real', forged)).toBe('');
      expect(fake.log).toEqual([]);
      await text('sess-real', transcript);
      expect(fake.settledFees).toBe(1);
      // After `/clear` the same process serves a new session id: it routes.
      const other = join(homeDir, '.claude', 'projects', '-repo', 'sess-other.jsonl');
      await writeFile(other, '');
      await text('sess-other', other);
      expect(fake.settledFees).toBe(2);
      // A path that is not that session's own transcript still sends nothing.
      const sent = fake.log.length;
      expect(await text('sess-other', transcript)).toBe('');
      expect(fake.log).toHaveLength(sent);
      expect(fake.settledFees).toBe(2);
    } finally {
      await client.close();
      await server.close();
      await payer.close();
    }
  });
});

describe('the base URL the MCP server routes against', () => {
  it('honours TENJIN_BASE_URL over the config file, like every other command', async () => {
    const fs = await import('node:fs/promises');
    await fs.writeFile(
      join(dir, 'config.json'),
      JSON.stringify({
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
        properties: {
          query: { description: string };
          id?: { description: string };
          input?: { type: string; description: string };
        };
        required?: string[];
      };
      // An offer is one call: the line's skeleton, filled, with `input`. The id
      // alone shows the spec. A query is for a task no line offered. The
      // handler refuses a call with neither.
      expect(schema.properties.query.description).toContain(SCOPE_RULE);
      expect(schema.properties.query.description).toContain('a task no line offered');
      expect(schema.required ?? []).toEqual([]);
      expect(schema.properties.id?.description).toContain('names the service');
      expect(schema.properties.id?.description).toContain("returns that service's spec");
      expect(request.description).toContain('fill them and call `{id, input}` once');
      expect(request.description).toContain('returns the full spec');
      expect(request.description).toContain("`{id}` alone returns the service's spec");
      // A projected result says where the rest of the response went.
      expect(request.description).toContain('`fullResultPath`');
      expect(schema.properties.input?.type).toBe('object');
      // THE ONE DISCOVERY SENTENCE IS GENERIC TOO: it names no marketplace and
      // no seller, only when to ask.
      expect(request.description).toContain(
        'Before asking the user to get an API key or account for a one-off task',
      );
      for (const name of ['Bazaar', 'Coinbase', 'BlockRun', 'ElevenLabs']) {
        expect(request.description).not.toContain(name);
        expect(schema.properties.input?.description).not.toContain(name);
      }
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
      expect(envelopeOf(called)).toMatchObject({ status: 'native' });
    } finally {
      await client.close();
      await server.close();
    }
  });
});
