import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildTenjinMcpServer, type BuildMcpOptions } from './server';
import {
  buildPaymentRequired,
  makeReadServer,
  readBody,
  reply,
  testWalletProvider,
} from '../lib/read-test-utils';
import type { SpendAuthorizer, SpendAuthorization } from '../lib/wallet';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tenjin-mcp-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const BASE = 'https://tenjin.blog';
const URL_ = 'https://tenjin.blog/api/read/iris/slug';
const RESERVATION = 'rsv-test';

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
  it('exposes exactly the eight Tenjin tools', async () => {
    const client = await connect({ dataDir: dir });
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(
      [
        'tenjin_buy',
        'tenjin_candidate',
        'tenjin_edit',
        'tenjin_inspect',
        'tenjin_search',
        'tenjin_outcome',
        'tenjin_publish',
        'tenjin_wallet',
      ].sort(),
    );
  });
});

describe('tenjin_search', () => {
  it('returns the exact success envelope as structuredContent with a non-empty text summary', async () => {
    const miss = {
      schemaVersion: 1,
      searchId: '0197aaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      decision: 'MISS',
      calibration: 'no match',
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
    expect(sc.data.decision).toBe('MISS');
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

  it('a block-severity scan finding hard-blocks even with yes:true', async () => {
    const file = join(dir, 'leaky.md');
    // A live-shaped AWS access key is a block finding; block is never yes-clearable.
    await writeFile(file, '# Deploy\n\nSet AKIAIOSFODNN7EXAMPLE in the environment.\n');
    const client = await connect({
      dataDir: dir,
      flags: { baseUrl: BASE },
      deps: { publish: { cwd: dir, env: {} } },
    });
    const res = await client.callTool({
      name: 'tenjin_publish',
      arguments: { file, yes: true },
    });

    expect(res.isError).toBe(true);
    const sc = res.structuredContent as ErrorEnvelope;
    expect(sc.error.code).toBe('PUBLISH_BLOCKED');
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

  it('a live secret in the new content hard-blocks even with yes:true', async () => {
    const server = editServer();
    const client = await editClient(server.fetch);
    const res = await client.callTool({
      name: 'tenjin_edit',
      arguments: { postId: POST_ID, provenance: 'AKIAIOSFODNN7EXAMPLE', yes: true, mode: 'auto' },
    });
    expect(res.isError).toBe(true);
    expect((res.structuredContent as ErrorEnvelope).error.code).toBe('PUBLISH_BLOCKED');
    expect(server.puts()).toHaveLength(0);
  });
});

describe('MCP adapter never writes to real stdout', () => {
  it('read and write tool calls produce no process.stdout output (the transport owns the wire)', async () => {
    const miss = {
      schemaVersion: 1,
      searchId: '0197aaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      decision: 'MISS',
      calibration: 'no match',
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
