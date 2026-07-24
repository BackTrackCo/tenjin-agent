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
  it('exposes exactly the seven Tenjin tools', async () => {
    const client = await connect({ dataDir: dir });
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(
      [
        'tenjin_buy',
        'tenjin_candidate',
        'tenjin_inspect',
        'tenjin_lookup',
        'tenjin_outcome',
        'tenjin_publish',
        'tenjin_wallet',
      ].sort(),
    );
  });
});

describe('tenjin_lookup', () => {
  it('returns the exact success envelope as structuredContent with a non-empty text summary', async () => {
    const miss = {
      schemaVersion: 1,
      lookupId: '0197aaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
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
      deps: { lookup: { fetchImpl } },
    });
    const res = await client.callTool({
      name: 'tenjin_lookup',
      arguments: { question: 'how do I cache in framework X' },
    });

    expect(res.isError).toBeFalsy();
    const sc = res.structuredContent as SuccessEnvelope;
    expect(sc.ok).toBe(true);
    expect(sc.command).toBe('lookup');
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

describe('MCP adapter never writes to real stdout', () => {
  it('read and write tool calls produce no process.stdout output (the transport owns the wire)', async () => {
    const miss = {
      schemaVersion: 1,
      lookupId: '0197aaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      decision: 'MISS',
      calibration: 'no match',
    };
    const lookupFetch = (async () =>
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
        lookup: { fetchImpl: lookupFetch },
        buy: {
          fetchImpl: buyFetch,
          provider: testWalletProvider(),
          authorizer: fakeAuthorizer('confirm', 'confirm_always'),
        },
        publish: { cwd: dir, env: {} },
      },
    });
    // Cover the free read path plus both write-path tools (buy, publish). Their
    // outcome (settle / refuse / needs_confirmation) is irrelevant here — no path
    // may write to real stdout, which the MCP transport owns.
    const spy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    try {
      await client.callTool({
        name: 'tenjin_lookup',
        arguments: { question: 'anything public' },
      });
      await client.callTool({ name: 'tenjin_buy', arguments: { ref: URL_ } });
      await client.callTool({ name: 'tenjin_publish', arguments: { file, mode: 'review' } });
    } finally {
      spy.mockRestore();
    }
    expect(spy).not.toHaveBeenCalled();
  });
});
