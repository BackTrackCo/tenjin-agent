import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

// The real core still runs; the wrapper only records the OPTIONS it was handed,
// which is the one place the `open: false` / `wait: false` pins are observable.
// Asserting on behaviour instead would pass with either line deleted, since the
// MCP context is never a TTY and `runFund` defaults both off there anyway.
vi.mock('../commands/fund', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../commands/fund')>();
  return { ...actual, runFund: vi.fn(actual.runFund) };
});

// No RPC from this suite. Unmocked, the baseline balance read would make the
// no-poll assertion depend on network reachability and pass offline for the
// wrong reason, which is the direction that ships the bug.
vi.mock('../lib/usdc', () => ({
  USDC_ADDRESS: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  USDC_DECIMALS: 6,
  getUsdcBalance: vi.fn(),
}));

import { buildTenjinMcpServer, type BuildMcpOptions } from './server';
import { runFund } from '../commands/fund';
import { getUsdcBalance } from '../lib/usdc';
import {
  buildPaymentRequired,
  makeReadServer,
  readBody,
  reply,
  testWalletProvider,
} from '../lib/read-test-utils';
import { loadSearches, recordSearch } from '../lib/state-store';
import type { SpendAuthorizer, SpendAuthorization } from '../lib/wallet';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tenjin-mcp-'));
  vi.mocked(runFund).mockClear();
  vi.mocked(getUsdcBalance).mockClear();
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const BASE = 'https://tenjin.blog';
const URL_ = 'https://tenjin.blog/api/read/iris/slug';
const RESERVATION = 'rsv-test';
const SEARCH_ID = '0197bbbb-cccc-7ddd-8eee-ffffffffffff';

/** Spin up the server over an in-memory transport, hand back a connected client. */
async function connect(opts: BuildMcpOptions): Promise<Client> {
  const server = buildTenjinMcpServer(opts);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

/** A spend authorizer whose decision is fixed; records authorize/commit/release. */
function fakeAuthorizer(
  decision: SpendAuthorization['decision'],
  reason = 'within_policy',
): SpendAuthorizer {
  return {
    policyEnforcement: 'client-only',
    authorize: vi.fn(async (req): Promise<SpendAuthorization> => ({
      decision,
      reason: reason as SpendAuthorization['reason'],
      message: 'test',
      amountAtomic: req.amountAtomic,
      sessionSpentAtomic: 0n,
      sessionBudgetAtomic: 0n,
      policyEnforcement: 'client-only',
      ...(decision === 'deny' ? {} : { reservationId: RESERVATION }),
    })),
    commit: vi.fn(async () => undefined),
    release: vi.fn(async () => undefined),
  };
}

type ErrorEnvelope = { ok: false; error: { code: string; message: string; details?: unknown } };
type SuccessEnvelope = { ok: true; command: string; data: Record<string, unknown> };

describe('buildTenjinMcpServer, tool surface', () => {
  it('exposes exactly the nine Tenjin tools', async () => {
    const client = await connect({ dataDir: dir });
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(
      [
        'tenjin_buy',
        'tenjin_delete',
        'tenjin_edit',
        'tenjin_fund',
        'tenjin_inspect',
        'tenjin_search',
        'tenjin_outcome',
        'tenjin_publish',
        'tenjin_wallet',
      ].sort(),
    );
  });

  // The tools that destroy. A client reads `destructiveHint` to decide how hard
  // to gate a call, and these are the ones that earn it: `delete` takes a piece
  // off the shelf, and `publish` carries `discard`, which drops a stored finding
  // permanently and no capture ask offers it again. One tool carries one
  // annotation, so the honest one is the stronger.
  it('marks the tools that destroy, and nothing else', async () => {
    const client = await connect({ dataDir: dir });
    const { tools } = await client.listTools();
    const destructive = tools
      .filter((t) => t.annotations?.destructiveHint === true)
      .map((t) => t.name)
      .sort();
    expect(destructive).toEqual(['tenjin_delete', 'tenjin_publish']);
  });

  // The hosted server at tenjin.blog/api/mcp identifies as `tenjin`; this one
  // must not, or a client connected to both cannot tell them apart (issue #103).
  it('identifies as tenjin-cli, not tenjin', async () => {
    const client = await connect({ dataDir: dir });
    expect(client.getServerVersion()?.name).toBe('tenjin-cli');
  });

  // `tenjin send` is the human-invoked funds-out escape hatch (issue #34). Doc
  // 10's narrow-toolset rule keeps it OFF the MCP surface: no send tool, and no
  // send action on tenjin_wallet. This pin fails if either ever appears.
  it('never exposes the funds-out send verb (no tool, no wallet action)', async () => {
    const client = await connect({ dataDir: dir });
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).not.toContain('tenjin_send');
    const wallet = tools.find((t) => t.name === 'tenjin_wallet');
    expect(wallet).toBeDefined();
    const schema = JSON.stringify(wallet?.inputSchema ?? {});
    expect(schema).toContain('show');
    expect(schema).not.toContain('send');
  });
});

describe('tenjin_search', () => {
  it('returns the exact success envelope as structuredContent with a non-empty text summary', async () => {
    const miss = {
      schemaVersion: 3,
      searchId: '0197aaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      calibration: 'no match',
      matched: 0,
      items: [],
    };
    const fetchImpl = (async () =>
      new Response(JSON.stringify(miss), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof fetch;
    const client = await connect({
      dataDir: dir,
      flags: { baseUrl: BASE },
      deps: { search: { fetchImpl } },
    });
    const res = await client.callTool({
      name: 'tenjin_search',
      arguments: { question: 'how do I cache in framework X' },
    });

    expect(res.isError).toBeFalsy();
    const sc = res.structuredContent as SuccessEnvelope;
    expect(sc.ok).toBe(true);
    expect(sc.command).toBe('search');
    // v3: a miss is an empty result, not a `decision` word to branch on.
    expect(sc.data.matched).toBe(0);
    expect(sc.data.items).toEqual([]);
    expect((res.content as { text: string }[])[0]?.text ?? '').not.toBe('');
  });
});

describe('tenjin_buy consent', () => {
  it('a confirm-required spend without yes surfaces the refusal envelope and never pays', async () => {
    const pr = buildPaymentRequired();
    const { fetch, calls } = makeReadServer({
      plain: () => reply.paymentRequired(pr),
      siwx: () => reply.paymentRequired(pr),
      payment: () => reply.entitled(readBody()),
    });
    const client = await connect({
      dataDir: dir,
      flags: { baseUrl: BASE },
      deps: {
        buy: {
          fetchImpl: fetch,
          provider: testWalletProvider(),
          authorizer: fakeAuthorizer('confirm', 'confirm_always'),
        },
      },
    });
    const res = await client.callTool({ name: 'tenjin_buy', arguments: { ref: URL_ } });

    expect(res.isError).toBe(true);
    const sc = res.structuredContent as ErrorEnvelope;
    // buy safe-declines a non-interactive confirm (isTTY:false) and throws POLICY_REFUSED.
    expect(sc.error.code).toBe('POLICY_REFUSED');
    expect(calls.some((c) => c.phase === 'payment')).toBe(false);
  });

  it('yes:true with a permissive policy settles and returns the body inline in data', async () => {
    const pr = buildPaymentRequired();
    const { fetch } = makeReadServer({
      plain: () => reply.paymentRequired(pr),
      siwx: () => reply.paymentRequired(pr),
      payment: () => reply.entitled(readBody()),
    });
    const client = await connect({
      dataDir: dir,
      flags: { baseUrl: BASE },
      deps: {
        buy: {
          fetchImpl: fetch,
          provider: testWalletProvider(),
          authorizer: fakeAuthorizer('allow'),
        },
      },
    });
    const res = await client.callTool({
      name: 'tenjin_buy',
      arguments: { ref: URL_, yes: true },
    });

    expect(res.isError).toBeFalsy();
    const sc = res.structuredContent as SuccessEnvelope;
    expect(sc.data.entitlement).toBe('purchased');
    // A pure MCP client cannot read the local bodyPath file, so the body is inline.
    expect(sc.data.body).toContain('full body');
  });
});

describe('tenjin_publish consent', () => {
  it('never treats the MCP stdio transport or a special file as a publish body', async () => {
    const client = await connect({
      dataDir: dir,
      flags: { baseUrl: BASE },
      deps: { publish: { cwd: dir, env: {} } },
    });
    const inputs: Array<Record<string, unknown>> = [{}, { file: '-' }];
    if (process.platform !== 'win32') inputs.push({ file: '/dev/null' });
    for (const arguments_ of inputs) {
      const res = await client.callTool({ name: 'tenjin_publish', arguments: arguments_ });
      expect(res.isError).toBe(true);
      const error = (res.structuredContent as ErrorEnvelope).error;
      expect(error.code).toBe('USAGE');
      expect(error.message).toMatch(/Nothing to publish|CLI stdin|Could not read/);
    }
  });

  it('review mode without yes returns NEEDS_CONFIRMATION carrying the confirm payload', async () => {
    const file = join(dir, 'clean.md');
    await writeFile(file, '# Caching notes\n\nSome clean public prose about caching.\n');
    const client = await connect({
      dataDir: dir,
      flags: { baseUrl: BASE },
      deps: { publish: { cwd: dir, env: {} } },
    });
    const res = await client.callTool({
      name: 'tenjin_publish',
      arguments: { file, mode: 'review' },
    });

    expect(res.isError).toBe(true);
    const sc = res.structuredContent as ErrorEnvelope;
    expect(sc.error.code).toBe('NEEDS_CONFIRMATION');
    const details = sc.error.details as {
      mode: string;
      price: unknown;
      findings: unknown;
      card: unknown;
      target: unknown;
    };
    expect(details.mode).toBe('review');
    expect(details.price).toBeDefined();
    expect(details.findings).toBeDefined();
    expect(details.card).toBeDefined();
    expect(details.target).toBeDefined();
  });

  // The two flags the tool ADVERTISES have to reach the core. The `satisfies`
  // constraint on publishInput forces the schema to list them; it cannot force the
  // handler to forward them, and both were silently dropped.
  it('forwards searchId and excerpt through to the wire', async () => {
    const file = join(dir, 'clean.md');
    await writeFile(file, '# Caching notes\n\nSome clean public prose about caching.\n');
    await recordSearch(dir, {
      searchId: SEARCH_ID,
      at: new Date().toISOString(),
      question: 'what the search asked',
      decision: 'MISS',
      candidates: [],
    });

    let body: Record<string, unknown> | undefined;
    const fetchImpl = (async (_u: string | URL, init?: RequestInit) => {
      body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
      return new Response(
        JSON.stringify({
          id: '0197aaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
          slug: 's',
          title: 'Caching notes',
          status: 'published',
          price: '100000',
          url: `${BASE}/a/iris/s`,
          tags: [],
        }),
        { status: 201, headers: { 'content-type': 'application/json' } },
      );
    }) as unknown as typeof fetch;

    const client = await connect({
      dataDir: dir,
      flags: { baseUrl: BASE },
      deps: {
        publish: {
          cwd: dir,
          env: {},
          fetchImpl,
          provider: testWalletProvider(),
          useSession: false,
        },
      },
    });
    const res = await client.callTool({
      name: 'tenjin_publish',
      arguments: {
        file,
        mode: 'auto',
        excerpt: 'a deliberate public preview',
        searchId: SEARCH_ID,
      },
    });

    expect(res.isError).toBeFalsy();
    // The excerpt reached the POST body rather than being derived from the body.
    expect(body?.excerpt).toBe('a deliberate public preview');
    // And so did the searchId. This assertion is the point of the test and was
    // missing: the name said "through to the wire" while only the receipt and the
    // local store were checked, so a searchId that never left the machine passed
    // here for as long as the flag existed (tenjin-agent #161).
    expect(body?.searchId).toBe(SEARCH_ID);
    // The local half still holds: the loop is reported closed on the receipt.
    const sc = res.structuredContent as { data: { search?: { id: string; closed: boolean } } };
    expect(sc.data.search).toMatchObject({ id: SEARCH_ID, closed: true });
    expect((await loadSearches(dir))[0]?.resolved?.by).toBe('publish');
  });

  // The tool schema accepting an array cannot force the handler to forward one,
  // so a regression that drops arrays would ship green on the scalar case alone.
  it('forwards an array of searchIds to the wire and closes each loop', async () => {
    const second = '0197bbbb-cccc-7ddd-8eee-aaaaaaaaaaaa';
    const file = join(dir, 'thread.md');
    await writeFile(file, '# Thread answer\n\nClean public prose answering a whole thread.\n');
    for (const id of [SEARCH_ID, second]) {
      await recordSearch(dir, {
        searchId: id,
        at: new Date().toISOString(),
        question: `what ${id} asked`,
        decision: 'MISS',
        candidates: [],
      });
    }

    let body: Record<string, unknown> | undefined;
    const fetchImpl = (async (_u: string | URL, init?: RequestInit) => {
      body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
      return new Response(
        JSON.stringify({
          id: '0197aaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
          slug: 's',
          title: 'Thread answer',
          status: 'published',
          price: '100000',
          url: `${BASE}/a/iris/s`,
          tags: [],
        }),
        { status: 201, headers: { 'content-type': 'application/json' } },
      );
    }) as unknown as typeof fetch;

    const client = await connect({
      dataDir: dir,
      flags: { baseUrl: BASE },
      deps: {
        publish: {
          cwd: dir,
          env: {},
          fetchImpl,
          provider: testWalletProvider(),
          useSession: false,
        },
      },
    });
    const res = await client.callTool({
      name: 'tenjin_publish',
      arguments: { file, mode: 'auto', searchId: [SEARCH_ID, second] },
    });

    expect(res.isError).toBeFalsy();
    expect(body?.searchId).toEqual([SEARCH_ID, second]);
    const sc = res.structuredContent as {
      data: { search?: unknown; searches: { id: string; closed: boolean }[] };
    };
    expect(sc.data.searches).toHaveLength(2);
    expect(sc.data.searches.every((s) => s.closed)).toBe(true);
    // No single result to repeat, so the flat key is gone: the duality an agent
    // reading only `.search` would trip over.
    expect(sc.data.search).toBeUndefined();
    const stored = await loadSearches(dir);
    for (const id of [SEARCH_ID, second]) {
      expect(stored.find((s) => s.searchId === id)?.resolved?.by, id).toBe('publish');
    }
  });

  // The same edge check the CLI applies, over MCP: an agent-supplied id is not a
  // trusted one, and it must fail before any wallet touch.
  it('refuses a malformed searchId with USAGE, like the CLI', async () => {
    const file = join(dir, 'clean.md');
    await writeFile(file, '# Caching notes\n\nSome clean public prose about caching.\n');
    const client = await connect({
      dataDir: dir,
      flags: { baseUrl: BASE },
      deps: { publish: { cwd: dir, env: {} } },
    });
    const res = await client.callTool({
      name: 'tenjin_publish',
      arguments: { file, mode: 'auto', searchId: 'not-a-uuid' },
    });
    expect(res.isError).toBe(true);
    expect((res.structuredContent as ErrorEnvelope).error.code).toBe('USAGE');
  });

  it('a block-severity scan finding needs confirmation, and clears with yes:true', async () => {
    const file = join(dir, 'leaky.md');
    // A live-shaped AWS access key is a block finding. The local scan never
    // refuses any more: it is a flag through the ordinary consent cascade, so
    // review's default NEEDS_CONFIRMATION is what fires without yes:true, and
    // yes:true clears it like it would a warn. The server's ingest gate is the
    // one place left that can still refuse a live secret.
    await writeFile(file, '# Deploy\n\nSet AKIAIOSFODNN7EXAMPLE in the environment.\n');
    const noYesClient = await connect({
      dataDir: dir,
      flags: { baseUrl: BASE },
      deps: { publish: { cwd: dir, env: {} } },
    });
    const blocked = await noYesClient.callTool({
      name: 'tenjin_publish',
      arguments: { file },
    });
    expect(blocked.isError).toBe(true);
    expect((blocked.structuredContent as ErrorEnvelope).error.code).toBe('NEEDS_CONFIRMATION');

    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({
          id: '0197aaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
          slug: 's',
          title: 'Deploy',
          status: 'published',
          price: '100000',
          url: `${BASE}/a/iris/s`,
          tags: [],
        }),
        { status: 201, headers: { 'content-type': 'application/json' } },
      )) as unknown as typeof fetch;
    const client = await connect({
      dataDir: dir,
      flags: { baseUrl: BASE },
      deps: {
        publish: { cwd: dir, env: {}, fetchImpl, provider: testWalletProvider() },
      },
    });
    const res = await client.callTool({
      name: 'tenjin_publish',
      arguments: { file, yes: true },
    });
    expect(res.isError).toBeFalsy();
  });
});

describe('tenjin_edit', () => {
  const POST_ID = '0197aaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const STORED = {
    id: POST_ID,
    creatorId: '0197cccc-bbbb-cccc-dddd-eeeeeeeeeeee',
    slug: 'the-answer',
    title: 'The Answer',
    status: 'published',
    price: '100000',
    url: `${BASE}/a/iris/the-answer`,
    excerpt: 'A short stored excerpt.',
    bodyMd: '# The Answer\n\nThe stored body.\n',
    tags: [],
    resource: {
      temporalMode: 'maintained',
      questionsAnswered: ['What is it?'],
      tasksSupported: [],
      scope: 'L2 fees only',
      exclusions: null,
      appliesTo: { products: ['Base'] },
      cacheEligible: false,
      cacheEligibleMissing: ['exclusions'],
      schemaVersion: 1,
    },
  };

  /** A GET/PUT stub over the owner-scoped route that records the PUT bodies. */
  function editServer(): { fetch: typeof fetch; puts: () => Record<string, unknown>[] } {
    const puts: Record<string, unknown>[] = [];
    const fetchFn = (async (_url: string | URL, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      if (method === 'PUT' && typeof init?.body === 'string') {
        puts.push(JSON.parse(init.body) as Record<string, unknown>);
      }
      return new Response(JSON.stringify(STORED), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;
    return { fetch: fetchFn, puts: () => puts };
  }

  async function editClient(fetchImpl: typeof fetch): Promise<Client> {
    return connect({
      dataDir: dir,
      flags: { baseUrl: BASE },
      deps: { edit: { fetchImpl, provider: testWalletProvider(), cwd: dir, env: {} } },
    });
  }

  it('never treats the MCP stdio transport or a special file as an edit body', async () => {
    const server = editServer();
    const client = await editClient(server.fetch);
    const bodies = ['-'];
    if (process.platform !== 'win32') bodies.push('/dev/null');
    for (const body of bodies) {
      const res = await client.callTool({
        name: 'tenjin_edit',
        arguments: { postId: POST_ID, body },
      });
      expect(res.isError).toBe(true);
      const error = (res.structuredContent as ErrorEnvelope).error;
      expect(error.code).toBe('USAGE');
      expect(error.message).toMatch(/CLI stdin|Could not read/);
    }
    expect(server.puts()).toHaveLength(0);
  });

  it('review mode without yes returns NEEDS_CONFIRMATION carrying the change summary', async () => {
    const server = editServer();
    const client = await editClient(server.fetch);
    const res = await client.callTool({
      name: 'tenjin_edit',
      arguments: { postId: POST_ID, title: 'A Better Answer', mode: 'review' },
    });

    expect(res.isError).toBe(true);
    const sc = res.structuredContent as ErrorEnvelope;
    expect(sc.error.code).toBe('NEEDS_CONFIRMATION');
    const details = sc.error.details as {
      mode: string;
      postId: string;
      title: string;
      changes: string[];
    };
    expect(details.mode).toBe('review');
    expect(details.postId).toBe(POST_ID);
    expect(details.title).toBe('The Answer');
    // The summary must reach the client through the payload: its stderr is a sink.
    expect(details.changes).toEqual(['title: "The Answer" → "A Better Answer"']);
    expect(server.puts()).toHaveLength(0);
  });

  it('re-calling with yes:true completes the loop and returns the summary in data', async () => {
    const server = editServer();
    const client = await editClient(server.fetch);
    const res = await client.callTool({
      name: 'tenjin_edit',
      arguments: { postId: POST_ID, title: 'A Better Answer', mode: 'review', yes: true },
    });

    expect(res.isError).toBeFalsy();
    const sc = res.structuredContent as SuccessEnvelope;
    expect(sc.ok).toBe(true);
    expect(sc.data.id).toBe(POST_ID);
    expect(sc.data.changes).toEqual(['title: "The Answer" → "A Better Answer"']);
    expect(server.puts()).toEqual([{ title: 'A Better Answer' }]);
  });

  // The reversible retraction over MCP (#221). It is an ordinary edit here, so it
  // takes the ordinary consent: review stops, yes:true completes.
  it('forwards status to the wire, under the same consent as any other change', async () => {
    const stopped = editServer();
    const held = await (
      await editClient(stopped.fetch)
    ).callTool({
      name: 'tenjin_edit',
      arguments: { postId: POST_ID, status: 'draft', mode: 'review' },
    });
    expect((held.structuredContent as ErrorEnvelope).error.code).toBe('NEEDS_CONFIRMATION');
    expect(stopped.puts()).toHaveLength(0);

    const server = editServer();
    const client = await editClient(server.fetch);
    const res = await client.callTool({
      name: 'tenjin_edit',
      arguments: { postId: POST_ID, status: 'draft', mode: 'review', yes: true },
    });
    expect(res.isError).toBeFalsy();
    expect(server.puts()).toEqual([{ status: 'draft' }]);
  });

  it('forwards a question to questionsAnswered, not to some neighbouring field', async () => {
    // The 19-field mapping is hand-written on both sides; a swapped pair would
    // otherwise sail through, so follow one value all the way to the wire.
    const server = editServer();
    const client = await editClient(server.fetch);
    await client.callTool({
      name: 'tenjin_edit',
      arguments: {
        postId: POST_ID,
        question: ['What does it cost?'],
        scope: 'a new scope',
        provenance: 'measured on mainnet',
        yes: true,
        mode: 'auto',
      },
    });
    expect(server.puts()).toEqual([
      {
        resource: {
          questionsAnswered: ['What does it cost?'],
          scope: 'a new scope',
          provenanceSummary: 'measured on mainnet',
        },
      },
    ]);
  });

  it('with no change flags it reads the post and writes nothing', async () => {
    const server = editServer();
    const client = await editClient(server.fetch);
    const res = await client.callTool({
      name: 'tenjin_edit',
      arguments: { postId: POST_ID },
    });
    expect(res.isError).toBeFalsy();
    expect((res.structuredContent as SuccessEnvelope).data.title).toBe('The Answer');
    expect(server.puts()).toHaveLength(0);
  });

  it('forwards mode, so a per-call full-auto loosens a gate config would have closed', async () => {
    // env/config resolve to review here, and the finding is warn-level, so this
    // proceeds ONLY if `mode` reached the core: dropping the forwarding leaves
    // review in charge and the call comes back NEEDS_CONFIRMATION instead.
    const server = editServer();
    const client = await editClient(server.fetch);
    const res = await client.callTool({
      name: 'tenjin_edit',
      arguments: {
        postId: POST_ID,
        provenance: `measured from 0x${'b'.repeat(40)}`,
        mode: 'full-auto',
      },
    });

    expect(res.isError).toBeFalsy();
    const sc = res.structuredContent as SuccessEnvelope;
    // The receipt names the mode that actually governed the run.
    expect(sc.data.mode).toBe('full-auto');
    expect(server.puts()).toHaveLength(1);
  });

  it('without the override the same call stops to confirm', async () => {
    const server = editServer();
    const client = await editClient(server.fetch);
    const res = await client.callTool({
      name: 'tenjin_edit',
      arguments: { postId: POST_ID, provenance: `measured from 0x${'b'.repeat(40)}` },
    });

    expect(res.isError).toBe(true);
    const sc = res.structuredContent as ErrorEnvelope;
    expect(sc.error.code).toBe('NEEDS_CONFIRMATION');
    expect((sc.error.details as { mode: string }).mode).toBe('review');
    expect(server.puts()).toHaveLength(0);
  });

  it('a live secret in the new content needs confirmation, and clears with yes:true', async () => {
    // The local scan never refuses any more: a block-severity finding is a flag
    // through the ordinary cascade, so without yes:true it stops the same way a
    // warn would, and yes:true clears it. The server's ingest gate is the one
    // place left that can still refuse a live secret.
    const withoutYes = editServer();
    const noYesClient = await editClient(withoutYes.fetch);
    const blocked = await noYesClient.callTool({
      name: 'tenjin_edit',
      arguments: { postId: POST_ID, provenance: 'AKIAIOSFODNN7EXAMPLE', mode: 'auto' },
    });
    expect(blocked.isError).toBe(true);
    expect((blocked.structuredContent as ErrorEnvelope).error.code).toBe('NEEDS_CONFIRMATION');
    expect(withoutYes.puts()).toHaveLength(0);

    const server = editServer();
    const client = await editClient(server.fetch);
    const res = await client.callTool({
      name: 'tenjin_edit',
      arguments: { postId: POST_ID, provenance: 'AKIAIOSFODNN7EXAMPLE', yes: true, mode: 'auto' },
    });
    expect(res.isError).toBeFalsy();
    expect(server.puts()).toHaveLength(1);
  });
});

describe('tenjin_delete', () => {
  const POST_ID = '0197aaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const STORED = {
    id: POST_ID,
    slug: 'the-answer',
    title: 'The Answer',
    status: 'published',
    price: '100000',
    url: `${BASE}/a/iris/the-answer`,
    tags: [],
  };

  function deleteServer(): { fetch: typeof fetch; methods: () => string[] } {
    const methods: string[] = [];
    const fetchFn = (async (_url: string | URL, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      methods.push(method);
      if (method === 'DELETE') return new Response(null, { status: 204 });
      return new Response(JSON.stringify(STORED), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;
    return { fetch: fetchFn, methods: () => methods };
  }

  async function deleteClient(fetchImpl: typeof fetch, mode: string): Promise<Client> {
    return connect({
      dataDir: dir,
      flags: { baseUrl: BASE },
      deps: {
        delete: {
          fetchImpl,
          provider: testWalletProvider(),
          // Deliberately the loosest mode: it must buy nothing here.
          env: { TENJIN_PUBLISH_MODE: mode },
        },
      },
    });
  }

  // The MCP surface is where #221's consent design has to hold hardest: this
  // context is non-interactive, so without the exit-3 channel there would be no
  // way to ask at all, and publish.mode would be the only gate — which is exactly
  // the conflation the design refuses.
  it.each(['review', 'auto', 'full-auto'])(
    'without yes it returns NEEDS_CONFIRMATION under publish.mode %s and deletes nothing',
    async (mode) => {
      const server = deleteServer();
      const client = await deleteClient(server.fetch, mode);
      const res = await client.callTool({ name: 'tenjin_delete', arguments: { postId: POST_ID } });

      expect(res.isError).toBe(true);
      const sc = res.structuredContent as ErrorEnvelope;
      expect(sc.error.code).toBe('NEEDS_CONFIRMATION');
      const details = sc.error.details as { title: string; confirmCommand: string };
      expect(details.title).toBe('The Answer');
      expect(details.confirmCommand).toBe(`tenjin delete ${POST_ID} --yes`);
      expect(server.methods()).toEqual(['GET']);
    },
  );

  it('re-calling with yes:true completes the removal', async () => {
    const server = deleteServer();
    const client = await deleteClient(server.fetch, 'review');
    const res = await client.callTool({
      name: 'tenjin_delete',
      arguments: { postId: POST_ID, yes: true },
    });

    expect(res.isError).toBeFalsy();
    const sc = res.structuredContent as SuccessEnvelope;
    expect(sc.command).toBe('delete');
    expect(sc.data).toMatchObject({ deleted: true, postId: POST_ID });
    expect(server.methods()).toEqual(['GET', 'DELETE']);
  });
});

describe('MCP adapter never writes to real stdout', () => {
  it('read and write tool calls produce no process.stdout output (the transport owns the wire)', async () => {
    const miss = {
      schemaVersion: 3,
      searchId: '0197aaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      calibration: 'no match',
      matched: 0,
      items: [],
    };
    const searchFetch = (async () =>
      new Response(JSON.stringify(miss), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof fetch;
    const pr = buildPaymentRequired();
    const { fetch: buyFetch } = makeReadServer({
      plain: () => reply.paymentRequired(pr),
      siwx: () => reply.paymentRequired(pr),
      payment: () => reply.entitled(readBody()),
    });
    const file = join(dir, 'clean.md');
    await writeFile(file, '# Notes\n\nSome clean public prose.\n');
    const client = await connect({
      dataDir: dir,
      flags: { baseUrl: BASE },
      deps: {
        search: { fetchImpl: searchFetch },
        buy: {
          fetchImpl: buyFetch,
          provider: testWalletProvider(),
          authorizer: fakeAuthorizer('confirm', 'confirm_always'),
        },
        publish: { cwd: dir, env: {} },
        edit: {
          fetchImpl: (async () =>
            new Response(JSON.stringify({ error: { code: 'post_not_found' } }), {
              status: 404,
              headers: { 'content-type': 'application/json' },
            })) as unknown as typeof fetch,
          provider: testWalletProvider(),
          cwd: dir,
          env: {},
        },
      },
    });
    // Cover the free read path plus both write-path tools (buy, publish). Their
    // outcome (settle / refuse / needs_confirmation) is irrelevant here — no path
    // may write to real stdout, which the MCP transport owns.
    const spy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    try {
      await client.callTool({
        name: 'tenjin_search',
        arguments: { question: 'anything public' },
      });
      await client.callTool({ name: 'tenjin_buy', arguments: { ref: URL_ } });
      await client.callTool({ name: 'tenjin_publish', arguments: { file, mode: 'review' } });
      await client.callTool({
        name: 'tenjin_edit',
        arguments: { postId: '0197aaaa-bbbb-cccc-dddd-eeeeeeeeeeee', title: 'x', mode: 'review' },
      });
    } finally {
      spy.mockRestore();
    }
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('tenjin_fund', () => {
  const CHECKOUT = 'https://pay.coinbase.com/buy?sessionToken=tok123';

  function mintServer(status = 200, json: unknown = { url: CHECKOUT }) {
    const calls: { url: string; body: unknown }[] = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({
        url: String(input),
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
      });
      return new Response(JSON.stringify(json), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
    return { fetchImpl, calls };
  }

  it('mints and returns the checkout URL for the human, without opening or waiting', async () => {
    const { fetchImpl, calls } = mintServer();
    const openUrl = vi.fn(async () => true);
    const client = await connect({
      dataDir: dir,
      flags: { baseUrl: BASE },
      deps: { fund: { provider: testWalletProvider(), fetchImpl, openUrl } },
    });
    const res = await client.callTool({
      name: 'tenjin_fund',
      arguments: { amountUsd: '5' },
    });

    expect(res.isError).toBeFalsy();
    const sc = res.structuredContent as SuccessEnvelope;
    expect(sc.data.checkoutUrl).toBe(CHECKOUT);
    expect(sc.data.opened).toBe(false);
    expect(sc.data.funded).toBe(false);
    expect(sc.data.pollStatus).toBe('skipped');
    expect(calls[0]!.body).toMatchObject({ mode: 'onramp', presetAmount: 5 });
    expect(openUrl).not.toHaveBeenCalled();
    expect(getUsdcBalance).not.toHaveBeenCalled();
  });

  it('pins open and wait off in the options it hands the core, not just in what happens', async () => {
    const { fetchImpl } = mintServer();
    const client = await connect({
      dataDir: dir,
      flags: { baseUrl: BASE },
      // Deliberately hostile deps: a caller (or a future edit) trying to turn
      // the browser open and the poll back ON for the MCP surface. The call-site
      // pins are spread LAST, so both must lose.
      deps: {
        fund: { provider: testWalletProvider(), fetchImpl, open: true, wait: true },
      },
    });
    await client.callTool({ name: 'tenjin_fund', arguments: {} });

    const passed = vi.mocked(runFund).mock.calls;
    expect(passed).toHaveLength(1);
    expect(passed[0]![1]).toMatchObject({ open: false, wait: false });
  });

  it('relays a coded refusal (region gate) as the failure envelope', async () => {
    const { fetchImpl } = mintServer(403, {
      error: { code: 'region_not_supported', message: 'no' },
    });
    const client = await connect({
      dataDir: dir,
      flags: { baseUrl: BASE },
      deps: { fund: { provider: testWalletProvider(), fetchImpl } },
    });
    const res = await client.callTool({ name: 'tenjin_fund', arguments: {} });

    expect(res.isError).toBe(true);
    const sc = res.structuredContent as ErrorEnvelope;
    expect(sc.error.code).toBe('REFUSED');
  });
});
