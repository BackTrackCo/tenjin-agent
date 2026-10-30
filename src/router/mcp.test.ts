import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** When armed, every provider `tenjin mcp` resolves has its `getSigner` counted,
 *  so a test can prove the request tool's provider is not unlocked separately. */
const providerSpy = vi.hoisted(() => ({ armed: false, getSigner: 0 }));
vi.mock('../lib/wallet', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/wallet')>();
  return {
    ...actual,
    resolveWalletProvider: (...args: Parameters<typeof actual.resolveWalletProvider>) => {
      const provider = actual.resolveWalletProvider(...args);
      if (!providerSpy.armed) return provider;
      return {
        ...provider,
        getSigner: (...a: Parameters<typeof provider.getSigner>) => {
          providerSpy.getSigner += 1;
          return provider.getSigner(...a);
        },
      };
    },
  };
});
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildPaymentRequired, testWalletProvider } from '../lib/read-test-utils';
import type { SpendAuthorization, SpendAuthorizer } from '../lib/wallet';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { FakeRouter, payerDeps } from './fee-test-utils';
import { runAliveHook, sessionServedByPlugin } from './alive';
import { runHookCommand, STALE_HOOK_LINE } from './hook-command';
import { hookToolInput } from './hook-tool';
import type { OfferSpec } from './decision';
import {
  buildRouterMcpServer,
  createRouterMcpServer,
  MAX_RESULT_SIZE_CHARS,
  ALWAYS_LOAD_KEY,
  MAX_RESULT_SIZE_KEY,
  pollProgress,
  promptsBeforeApprove,
  REQUIRES_USER_INTERACTION_KEY,
  waitsForJobs,
} from './mcp';
import { RoutingPayer } from './routing-payer';
import { storeSpecs } from './specs';
import { CliError } from '../lib/errors';
import { unlockDetails } from '../lib/wallet-unlock';
import { readObservations } from './router-observation';
import { createRouterObserver, type RouterObserver } from './router-observer';

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

/** The one decision this server asks for, from a router with the fee off:
 *  no 402, nothing signed. */
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
      // `approve` is Claude Code's alone (below): this client never sees it.
      expect(tools.tools.map((t) => t.name)).toEqual(['request', 'hook']);
      // The harness reads its inline-result threshold from the listed tool,
      // and keeps it out of tool search.
      expect(tools.tools[0]!._meta).toEqual({
        [MAX_RESULT_SIZE_KEY]: MAX_RESULT_SIZE_CHARS,
        [ALWAYS_LOAD_KEY]: true,
      });
      expect(tools.tools[1]!._meta).toBeUndefined();
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

  it('names its host on the tool body, and carries the hook tool for either host', async () => {
    const bodies: Record<string, unknown>[] = [];
    const answer = await router({
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
    })('');
    const text = await answer.text();
    const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(text, { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    for (const harness of ['codex', 'claude', undefined] as const) {
      const server = buildRouterMcpServer({
        dataDir: dir,
        ...(harness !== undefined ? { harness } : {}),
        handlerDeps: { cwd: dir, authorizer: authorizer(), fetchImpl },
      });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: 'test', version: '0.0.0' });
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
      try {
        const names = (await client.listTools()).tools.map((t) => t.name);
        expect(names).toEqual(['request', 'hook']);
        await client.callTool({ name: 'request', arguments: { query: 'weather' } });
        expect(bodies.at(-1)).toMatchObject({ harness: harness ?? 'claude' });
      } finally {
        await client.close();
        await server.close();
      }
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
/**
 * THE APPROVE TOOL IS CLAUDE CODE'S OWN PROMPT. Offered only to Claude Code
 * from 2.1.214, which puts every call of a tool marked
 * `requiresUserInteraction` to a person, so a call that arrives is the yes.
 * Any other client never sees it, and a call over the limits there pays
 * nothing and keeps nothing.
 */
describe('the approve tool', () => {
  const PAY_TO = '0xA7f3Ad0E69F61864092FAbBa6Cee00AF6e584689';
  const SPEC: OfferSpec = {
    id: '0195f3a1-6c4d-7a2b-9e10-5f6a7b8c9d51',
    capabilityId: 'aispace-hailuo-3-max',
    provider: 'AiSpace (Hailuo 3 Max)',
    output: 'media',
    description: 'Video from a prompt.',
    priceAtomic: '155000',
    priceVaries: false,
    maxAmountAtomic: '155000',
    payTo: PAY_TO,
    network: 'eip155:8453',
    asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    request: { method: 'POST', url: 'https://x402.aispace.bot/v', fields: {}, location: 'body' },
    input: { type: 'object', properties: { prompt: { type: 'string' } } },
    pinned: {},
  };

  /** The seller: a 402 at the spec's price, then the clip; every paid call kept. */
  function seller() {
    const paid: string[] = [];
    const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith('https://tenjin.sh')) return new Response(null, { status: 204 });
      if (new Headers(init?.headers ?? {}).get('payment-signature') === null) {
        const challenge = buildPaymentRequired({ amount: SPEC.priceAtomic, payTo: PAY_TO });
        return new Response('{}', {
          status: 402,
          headers: { 'content-type': 'application/json', 'PAYMENT-REQUIRED': challenge.header },
        });
      }
      paid.push(String(init?.body));
      return new Response(new Uint8Array([0, 0, 0, 24]), {
        status: 200,
        headers: { 'content-type': 'video/mp4' },
      });
    }) as typeof fetch;
    return { fetchImpl, paid };
  }

  async function connected(client: Client) {
    await storeSpecs(dir, [SPEC]);
    const { fetchImpl, paid } = seller();
    const server = buildRouterMcpServer({
      dataDir: dir,
      handlerDeps: {
        cwd: dir,
        authorizer: authorizer(),
        provider: testWalletProvider(),
        fetchImpl,
        payDeps: {
          fetchImpl,
          readBalance: async () => 100_000_000n,
          destination: { resolveHostname: async () => [{ address: '93.184.216.34', family: 4 }] },
        },
      },
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    return {
      paid,
      tools: async () => (await client.listTools()).tools,
      call: async (name: string, args: Record<string, unknown>) =>
        client.callTool({ name, arguments: args }).catch((err: unknown) => ({ thrown: err })),
      close: async () => {
        await client.close();
        await server.close();
      },
    };
  }

  it.each([
    ['claude-code', '2.1.214', true],
    ['claude-code', '2.1.301', true],
    ['claude-code', '2.1.213', false],
    ['some-host', '9.9.9', false],
  ])('lists approve to %s %s: %s', async (name, version, offered) => {
    const { tools, call, close } = await connected(new Client({ name, version }));
    try {
      const listed = (await tools()).find((tool) => tool.name === 'approve');
      if (offered) {
        // Claude Code puts every call of it to a person.
        expect(listed?._meta).toMatchObject({ [REQUIRES_USER_INTERACTION_KEY]: true });
      } else {
        expect(listed).toBeUndefined();
        const refused = (await call('approve', { quote: 'q_AAAAAAAAAAAA' })) as {
          isError?: boolean;
          thrown?: unknown;
        };
        expect(refused.isError === true || refused.thrown !== undefined).toBe(true);
      }
    } finally {
      await close();
    }
  });

  it("runs the stored plan once Claude Code's prompt said yes", async () => {
    const { call, paid, close } = await connected(
      new Client({ name: 'claude-code', version: '2.1.214' }),
    );
    try {
      const over = envelopeOf(
        await call('request', { id: SPEC.id, input: { prompt: 'a plane' } }),
      ) as { status: string; nextStep: string; quote: { id: string; total: string; what: string } };
      expect(over.status).toBe('needs_approval');
      expect(over.nextStep).toContain(`approve({quote: "${over.quote.id}"`);
      expect(paid).toEqual([]);
      const ran = envelopeOf(
        await call('approve', {
          quote: over.quote.id,
          total: over.quote.total,
          what: over.quote.what,
        }),
      );
      expect(ran).toMatchObject({ status: 'fulfilled', cost: ['provider price 0.155 USD'] });
      expect(paid).toEqual([JSON.stringify({ prompt: 'a plane' })]);
    } finally {
      await close();
    }
  });

  it('refuses a call over the limits with no approve route on any other client', async () => {
    const { call, paid, close } = await connected(new Client({ name: 'some-host', version: '1' }));
    try {
      const over = envelopeOf(await call('request', { id: SPEC.id, input: { prompt: 'a plane' } }));
      expect(over).toMatchObject({
        status: 'needs_approval',
        nextStep: 'Tell the user what it would cost; nothing was paid.',
      });
      expect(over).not.toHaveProperty('quote');
      expect(JSON.stringify(over)).not.toMatch(/approve/);
      expect(paid).toEqual([]);
    } finally {
      await close();
    }
  });

  it('trusts the prompt only from a Claude Code that shows it on every call', () => {
    for (const version of ['2.1.214', '2.1.301', '2.2.0', '3.0.0']) {
      expect(promptsBeforeApprove({ name: 'claude-code', version })).toBe(true);
    }
    for (const version of ['2.1.213', '2.0.999', '1.9.0', 'beta']) {
      expect(promptsBeforeApprove({ name: 'claude-code', version })).toBe(false);
    }
    expect(promptsBeforeApprove({ name: 'other-host', version: '9.9.9' })).toBe(false);
    expect(promptsBeforeApprove(undefined)).toBe(false);
  });
});

/** A LONG JOB IN ONE CALL: Claude Code from 2.1.212 backgrounds a call past
 *  two minutes, and each poll is a progress notification on the call's own
 *  token, which resets its idle timeout. */
describe('a call that waits on a job', () => {
  it('waits out the job only for a Claude Code that backgrounds long calls', () => {
    expect(waitsForJobs({ name: 'claude-code', version: '2.1.212' })).toBe(true);
    expect(waitsForJobs({ name: 'claude-code', version: '2.1.211' })).toBe(false);
    expect(waitsForJobs({ name: 'other-host', version: '9.0.0' })).toBe(false);
  });

  it("sends each poll as progress on the call's token, and nothing without one", async () => {
    const sent: unknown[] = [];
    const sendNotification = async (notification: unknown) => {
      sent.push(notification);
    };
    const { onPoll } = pollProgress({ _meta: { progressToken: 7 }, sendNotification });
    await onPoll!();
    await onPoll!();
    expect(sent).toEqual([
      expect.objectContaining({
        method: 'notifications/progress',
        params: expect.objectContaining({ progressToken: 7, progress: 1 }) as unknown,
      }),
      expect.objectContaining({
        params: expect.objectContaining({ progressToken: 7, progress: 2 }) as unknown,
      }),
    ]);
    expect(pollProgress({ sendNotification })).toEqual({});
  });
});

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
    const { homeDir, transcript } = await home('sess-hook');
    const log: string[] = [];
    const offer = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      log.push(`POST ${new URL(new Request(input, init).url).pathname}`);
      return Response.json({
        schemaVersion: 1,
        routerVersion: 'test',
        decision: {
          action: 'execute',
          id: 'k3f9-abcd',
          capabilityId: 'cmc-quote',
          category: 'live price',
          provider: 'CoinMarketCap',
          capabilityDescription: 'live crypto quotes',
          endpoint: 'https://example.test/quote',
          providerPriceAtomic: '10000',
          usage: 'the coin and currency',
          hint: 'CoinMarketCap fits this: live crypto quotes. Call request({query: "ETH in USD", id: "k3f9-abcd"}) alone and wait for its result.',
        },
      });
    }) as typeof fetch;
    const server = buildRouterMcpServer({
      dataDir: dir,
      homeDir,
      handlerDeps: { cwd: dir, signer: await testWalletProvider().getSigner() },
      hookDeps: {
        baseUrl: 'https://router.test',
        fetchImpl: offer,
        warn: () => undefined,
        // A wallet the hooks' file facts call ready, so the offer is shown.
        env: { TENJIN_WALLET_KEY: generatePrivateKey() },
      },
    });
    const client = await connect(server);
    try {
      const called = await client.callTool({
        name: 'hook',
        arguments: substituted('prompt', promptEvent('sess-hook', transcript)),
      });
      const text = (called.content as { text: string }[])[0]!.text;
      // No payer in this server: the paid route, unpaid, which a router
      // charging nothing answers.
      expect(log).toEqual(['POST /api/x402-router/route']);
      expect(JSON.parse(text)).toMatchObject({
        hookSpecificOutput: {
          hookEventName: 'UserPromptSubmit',
          additionalContext: expect.stringContaining('CoinMarketCap fits this'),
        },
      });
    } finally {
      await client.close();
      await server.close();
    }
  });

  /**
   * A MACHINE CARRYING THE PLUGIN AND A SETTINGS INSTALL runs both servers in
   * a session. The plugin's `alive` leg marks the session first; the settings
   * install's server, which the plugin did not launch, then says nothing there.
   * SHIM: goes with the settings install's migration.
   */
  it('stays silent in a session the plugin serves, when a settings install started it', async () => {
    const { homeDir, transcript } = await home('sess-both');
    await runAliveHook({ session_id: 'sess-both' }, { dataDir: dir, version: 'test' });
    const fetchImpl = vi.fn(async () => Response.json({}, { status: 400 }));
    const server = buildRouterMcpServer({
      dataDir: dir,
      homeDir,
      env: {},
      handlerDeps: { cwd: dir, signer: await testWalletProvider().getSigner() },
      hookDeps: {
        baseUrl: 'https://router.test',
        fetchImpl: fetchImpl as unknown as typeof fetch,
        warn: () => undefined,
      },
    });
    const client = await connect(server);
    try {
      const called = await client.callTool({
        name: 'hook',
        arguments: substituted('prompt', promptEvent('sess-both', transcript)),
      });
      expect((called.content as { text: string }[])[0]!.text).toBe('');
      expect(fetchImpl).not.toHaveBeenCalled();
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('marks its own session when the plugin started it, and still routes there', async () => {
    const { homeDir, transcript } = await home('sess-plugin');
    const fetchImpl = vi.fn(async () => Response.json({}, { status: 400 }));
    const server = buildRouterMcpServer({
      dataDir: dir,
      homeDir,
      env: { CLAUDE_PLUGIN_ROOT: '/plugin' },
      handlerDeps: { cwd: dir, signer: await testWalletProvider().getSigner() },
      hookDeps: {
        baseUrl: 'https://router.test',
        fetchImpl: fetchImpl as unknown as typeof fetch,
        warn: () => undefined,
      },
    });
    const client = await connect(server);
    try {
      await client.callTool({
        name: 'hook',
        arguments: substituted('prompt', promptEvent('sess-plugin', transcript)),
      });
      expect(fetchImpl).toHaveBeenCalled();
      expect(await sessionServedByPlugin(dir, { session_id: 'sess-plugin' })).toBe(true);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('the command form of a settings install stays silent there too', async () => {
    await runAliveHook({ session_id: 'sess-cmd' }, { dataDir: dir, version: 'test' });
    const written: string[] = [];
    const io = {
      stdout: { write: (s: string) => written.push(s) },
      stderr: { write: () => true },
      isTTY: false,
    } as unknown as Parameters<typeof runHookCommand>[0];
    const run = (session: string) =>
      runHookCommand(io, {
        dataDir: dir,
        env: {},
        readEvent: async () =>
          JSON.stringify({
            hook_event_name: 'UserPromptSubmit',
            session_id: session,
            cwd: dir,
            prompt: 'what is the current price of ETH in USD',
          }),
      });
    await run('sess-cmd');
    expect(written).toEqual([]);
    // A session the plugin does not serve hears, once, to set the hooks up again.
    await run('sess-other');
    expect(written.map((line) => JSON.parse(line) as unknown)).toEqual([
      { systemMessage: STALE_HOOK_LINE },
    ]);
  });

  it("tells the user once, in the hook's systemMessage, when the fee cannot be paid", async () => {
    const { homeDir, transcript } = await home('sess-told');
    // The paid route asks for the fee, and this server has no payer.
    const feeRequired = (async () => Response.json({}, { status: 402 })) as typeof fetch;
    const server = buildRouterMcpServer({
      dataDir: dir,
      homeDir,
      handlerDeps: { cwd: dir, signer: await testWalletProvider().getSigner() },
      hookDeps: { baseUrl: 'https://router.test', fetchImpl: feeRequired, warn: () => undefined },
    });
    const client = await connect(server);
    const call = async () =>
      (
        (
          await client.callTool({
            name: 'hook',
            arguments: substituted('prompt', promptEvent('sess-told', transcript)),
          })
        ).content as { text: string }[]
      )[0]!.text;
    try {
      expect(JSON.parse(await call())).toEqual({
        systemMessage: expect.stringContaining('`tenjin doctor`'),
      });
      expect(await call()).toBe('');
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("pays the routing fee through this process's payer", async () => {
    const { homeDir, transcript } = await home('sess-paid');
    const fake = new FakeRouter();
    const wallet = privateKeyToAccount(generatePrivateKey());
    const payer = new RoutingPayer(payerDeps(fake, dir, wallet));
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
      // The leg's 402, the background top-up it waited for, then its voucher.
      expect(fake.log).toEqual([
        'POST /api/x402-router/route unpaid',
        'POST /api/x402-router/route warm unpaid',
        'POST /api/x402-router/route warm paid',
        'POST /api/x402-router/route unpaid',
        'POST /api/x402-router/route paid',
      ]);
      expect(fake.depositedOn).toEqual(['warm']);
      expect(fake.settledFees).toBe(1);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("routes and pays a session's first prompt, before Claude Code writes its transcript", async () => {
    const { homeDir, transcript } = await home('sess-first');
    await rm(transcript);
    const fake = new FakeRouter();
    const payer = new RoutingPayer(payerDeps(fake, dir, privateKeyToAccount(generatePrivateKey())));
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
        arguments: substituted('prompt', promptEvent('sess-first', transcript)),
      });
      expect(fake.settledFees).toBe(1);
      // The same missing name outside the projects directory sends nothing.
      const sent = fake.log.length;
      await client.callTool({
        name: 'hook',
        arguments: substituted('prompt', promptEvent('sess-first', join(dir, 'sess-first.jsonl'))),
      });
      expect(fake.log).toHaveLength(sent);
      expect(fake.settledFees).toBe(1);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('reads, sends and pays nothing for a forged path, and routes a new session', async () => {
    const { homeDir, transcript } = await home('sess-real');
    const fake = new FakeRouter();
    const wallet = privateKeyToAccount(generatePrivateKey());
    const payer = new RoutingPayer(payerDeps(fake, dir, wallet));
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
    }
  });
});

/**
 * `tenjin mcp` WIRING: the payer's verdict gates the hook legs, the observer's
 * news rides on them, and the prewarm is the payer's alone. A server that only
 * answers `tools/list` (a `claude mcp get` health check) never serves a session.
 */
describe('the payer verdict and the wallet news', () => {
  const OFFER = {
    schemaVersion: 1,
    routerVersion: 'v',
    decision: {
      action: 'execute',
      id: 'k3f9-abcd',
      capabilityId: 'cmc-quote',
      category: 'live price',
      provider: 'CoinMarketCap',
      capabilityDescription: 'live crypto quotes',
      endpoint: 'https://example.test/quote',
      providerPriceAtomic: '10000',
      usage: 'the coin and currency',
      hint: 'CoinMarketCap fits this: live crypto quotes. Call request({query: "ETH in USD", id: "k3f9-abcd"}) alone and wait for its result.',
    },
  };
  let observers: RouterObserver[];
  beforeEach(() => {
    observers = [];
    providerSpy.armed = true;
    providerSpy.getSigner = 0;
  });
  afterEach(() => {
    providerSpy.armed = false;
    for (const o of observers) o.dispose();
  });

  function observer(): RouterObserver {
    const o = createRouterObserver({
      dataDir: dir,
      pid: process.pid,
      startedAt: Date.now(),
      cliVersion: 'test',
      harness: 'claude',
      launchedByPlugin: true,
      cwd: dir,
      env: {},
    });
    observers.push(o);
    return o;
  }

  async function connect(server: ReturnType<typeof buildRouterMcpServer>) {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '0.0.0' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    return client;
  }

  /** The observation once the observer's queued writes have landed. */
  async function settledObservation() {
    await new Promise((resolve) => setTimeout(resolve, 30));
    return (await readObservations(dir)).find((o) => o.pid === process.pid);
  }

  /**
   * One prompt leg through `tenjin mcp`'s hook tool, with `payer` and the
   * hook env `env`. Returns the answer and how many times the hook legs asked
   * the payer for its verdict (this test's own calls left out).
   */
  async function promptLeg(
    payer: RoutingPayer,
    env: NodeJS.ProcessEnv,
    obs = observer(),
    router = new FakeRouter(),
  ) {
    const homeDir = join(dir, 'home');
    const project = join(homeDir, '.claude', 'projects', '-repo');
    await mkdir(project, { recursive: true });
    const transcript = join(project, 'sess-wired.jsonl');
    await writeFile(transcript, '');
    const fake = router;
    fake.body = OFFER;
    const server = buildRouterMcpServer({
      dataDir: dir,
      homeDir: await realpath(homeDir),
      payer,
      observer: obs,
      hookDeps: {
        baseUrl: 'https://router.test',
        fetchImpl: fake.fetch,
        warn: () => undefined,
        env,
      },
    });
    const event: Record<string, string> = {
      hook_event_name: 'UserPromptSubmit',
      session_id: 'sess-wired',
      transcript_path: await realpath(transcript),
      cwd: dir,
      prompt: 'what is the current price of ETH in USD',
    };
    const client = await connect(server);
    try {
      const signVerdict = vi.spyOn(payer, 'signVerdict');
      const called = await client.callTool({
        name: 'hook',
        arguments: Object.fromEntries(
          Object.entries(hookToolInput('prompt')).map(([key, value]) => {
            const field = /^\$\{(.+)\}$/.exec(value)?.[1];
            return [key, field === undefined ? value : (event[field] ?? '')];
          }),
        ),
      });
      const asked = signVerdict.mock.calls.length;
      signVerdict.mockRestore();
      const text = (called.content as { text: string }[])[0]!.text;
      const answer = JSON.parse(text) as {
        systemMessage?: string;
        hookSpecificOutput?: { additionalContext?: string };
      };
      return { answer, asked, served: (await settledObservation())?.servedSession };
    } finally {
      await client.close();
      await server.close();
    }
  }

  it("withholds on the payer's blocked verdict though the files alone would offer, carries the news, and prewarms only through the payer", async () => {
    const payer = new RoutingPayer(
      payerDeps(new FakeRouter(), dir, privateKeyToAccount(generatePrivateKey()), {
        getSigner: async () => {
          throw new CliError('PROVIDER_ERROR', 'no passphrase', {
            details: unlockDetails('passphrase_missing'),
          });
        },
      }),
    );
    const prewarm = vi.spyOn(payer, 'prewarm');
    const obs = observer();
    obs.queueNews('A one-time wallet line.');
    // Prewarmed by building the server; wait for its verdict before the leg.
    const built = buildRouterMcpServer({ dataDir: dir, payer, observer: observer() });
    await built.close();
    expect(prewarm).toHaveBeenCalledTimes(1);
    // The request tool's provider is not unlocked beside the payer's prewarm.
    expect(providerSpy.getSigner).toBe(0);
    await vi.waitFor(() => expect(payer.signVerdict().status).toBe('blocked'));
    // A valid key in the hook env: the files alone would say ready and offer.
    // The router charges no fee here, so the offer comes back and only the
    // verdict withholds it.
    const { answer, asked, served } = await promptLeg(
      payer,
      { TENJIN_WALLET_KEY: generatePrivateKey() },
      obs,
      new FakeRouter({ paid: false }),
    );
    expect(asked).toBeGreaterThan(0);
    expect(answer.hookSpecificOutput?.additionalContext ?? '').not.toContain(
      'CoinMarketCap fits this',
    );
    // The observer's news rides in systemMessage, and the router is now serving a session.
    expect(answer.systemMessage).toContain('A one-time wallet line.');
    expect(served).toBe(true);
  });

  it("offers on the payer's ready verdict though the files alone would withhold", async () => {
    const fake = new FakeRouter();
    const payer = new RoutingPayer(payerDeps(fake, dir, privateKeyToAccount(generatePrivateKey())));
    await payer.prewarm();
    expect(payer.signVerdict().status).toBe('ready');
    // No wallet.json and no key in the hook env: the files alone say no_wallet.
    const { answer, asked } = await promptLeg(payer, {}, observer(), fake);
    expect(asked).toBeGreaterThan(0);
    expect(answer.hookSpecificOutput?.additionalContext ?? '').toContain('CoinMarketCap fits this');
  });

  it('a server that answers only tools/list leaves servedSession false', async () => {
    const fake = new FakeRouter();
    const payer = new RoutingPayer(payerDeps(fake, dir, privateKeyToAccount(generatePrivateKey())));
    const obs = observer();
    const server = buildRouterMcpServer({
      dataDir: dir,
      payer,
      observer: obs,
      handlerDeps: { cwd: dir, signer: await testWalletProvider().getSigner() },
    });
    const client = await connect(server);
    try {
      const tools = await client.listTools();
      expect(tools.tools.map((t) => t.name)).toContain('hook');
      const observation = await settledObservation();
      expect(observation?.servedSession).toBe(false);
    } finally {
      await client.close();
      await server.close();
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
    expect(seen[0]).toBe('https://env.example.test/api/x402-router/route');
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
      // WHAT THE AGENT DOES, and no catalog or list of kinds here: the client is
      // not a second source of what services exist, a list reads as all there
      // is, and the hook line names the one that fits the turn.
      expect(
        request.description?.startsWith(
          "When a hook line names a service from Tenjin's router, call it as the line says.",
        ),
      ).toBe(true);
      expect(request.description).not.toContain('Paid lookups');
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
      // Several takes of a media call, and a job resumed by its id.
      const extra = request.inputSchema.properties as Record<
        string,
        { type?: string; minimum?: number; maximum?: number; description?: string }
      >;
      expect(extra.count).toMatchObject({ type: 'integer', minimum: 2, maximum: 5 });
      expect(extra.count?.description).toContain('its own payment');
      expect(extra.job).toMatchObject({ type: 'string' });
      expect(extra.job?.description).toContain('nothing more is paid');
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
      // The router quotes the fee; the only amount written here is this CLI's ceiling.
      expect(request.description).toContain(
        'Routing costs a fee the router quotes, never more than $0.003 a call;',
      );
    } finally {
      await client.close();
      await server.close();
    }
  });
});

/**
 * A WALLET IS THE PAYING LEG'S PROBLEM. The handler used to open the wallet
 * before the tool ran, which meant a machine with no wallet, or a locked one,
 * could not even be told that its own tools cover the task. Here the router
 * charges nothing (the fee off), so the decision reaches the tool unpaid.
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

/**
 * THE SESSION'S FIRST TOP-UP: `tenjin mcp` funds a channel that
 * cannot cover a fee once its prewarm unlock settles, so the first prompt
 * meets no deposit; where the router is off it sends nothing.
 */
describe('the top-up at the start of tenjin mcp', () => {
  const observers: RouterObserver[] = [];
  afterEach(() => {
    for (const o of observers.splice(0)) o.dispose();
  });

  async function started(config: Record<string, unknown>) {
    await writeFile(join(dir, 'config.json'), JSON.stringify(config));
    const fake = new FakeRouter();
    const payer = new RoutingPayer(payerDeps(fake, dir, privateKeyToAccount(generatePrivateKey())));
    const observer = createRouterObserver({
      dataDir: dir,
      pid: process.pid,
      startedAt: Date.now(),
      cliVersion: 'test',
      harness: 'claude',
      launchedByPlugin: true,
      cwd: dir,
      env: {},
    });
    observers.push(observer);
    const server = await createRouterMcpServer({
      dataDir: dir,
      flags: { baseUrl: 'https://router.test' },
      payer,
      observer,
      // `router.*` resolves from this test's own git root, never the suite's cwd.
      handlerDeps: { cwd: dir },
      topUpAtStart: true,
    });
    return { fake, payer, server };
  }

  it('funds a new channel in the background, with no prompt asking, where the router is on', async () => {
    const { fake, payer, server } = await started({ maxAutoSpend: '250000' });
    try {
      await vi.waitFor(() => expect(fake.depositedOn).toEqual(['warm']));
      // Its channel write and memo clear land before the folder goes.
      await payer.idle();
      expect(fake.log).toEqual([
        'POST /api/x402-router/route warm unpaid',
        'POST /api/x402-router/route warm paid',
      ]);
    } finally {
      await server.close();
    }
  });

  it('sends nothing where the router is off', async () => {
    const { fake, payer, server } = await started({ router: { enabled: false } });
    try {
      await payer.prewarm();
      await new Promise((resolve) => setTimeout(resolve, 200));
      await payer.idle();
      expect(fake.log).toEqual([]);
    } finally {
      await server.close();
    }
  });
});
