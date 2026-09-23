import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CommandContext } from '../context';
import { packetForText } from './context';
import { requestDecision, ROUTER_PATH } from './decision';

/**
 * THE DECISION IS FREE. No 402 on this route, no challenge to decode, no
 * signature and no ledger: a failure here costs the turn a routing answer and
 * nothing else. What is left to pin is the body that goes out, the shapes that
 * come back, and that a typed refusal arrives as its own code rather than as
 * "answered 400".
 */

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'router-decision-'));
  await writeFile(join(dir, 'config.json'), JSON.stringify({}));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const BASE = 'https://tenjin.sh';

function ctx(): CommandContext {
  const sink = () => ({ write: () => true }) as unknown as NodeJS.WritableStream;
  return {
    flags: { json: true, timeout: 5000, baseUrl: BASE },
    dataDir: dir,
    io: { stdout: sink(), stderr: sink(), isTTY: false },
  };
}

interface Call {
  url: string;
  method: string;
  body: unknown;
}

function net(body: unknown, status = 200): { fetchImpl: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    calls.push({
      url: String(input),
      method: init?.method ?? 'GET',
      body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
    });
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const NATIVE = {
  schemaVersion: 1,
  routerVersion: '2026-09-23.1',
  decision: {
    action: 'native',
    reason: 'The host assistant and its own tools are enough.',
    diagnostics: {
      reasonCode: 'native_sufficient',
      stage: 'capability',
      missing: [],
      nextAction: 'Answer with your own tools.',
    },
  },
};

const HOOK_EXECUTE = {
  schemaVersion: 1,
  routerVersion: '2026-09-23.1',
  decision: {
    action: 'execute',
    id: 'k3f9-abcd',
    capabilityId: 'cmc-quotes',
    category: 'crypto price quote',
    provider: 'CoinMarketCap',
    capabilityDescription: 'latest market quotes for one or more cryptocurrencies',
    endpoint: 'https://pro-api.example.test/quotes',
    providerPriceAtomic: '10000',
    usage: 'the coins and currency',
    hint: 'CoinMarketCap fits this. Call request({query: <the coins and currency>, id}) alone.',
  },
};

const TOOL_EXECUTE = {
  schemaVersion: 1,
  routerVersion: '2026-09-23.1',
  decision: {
    action: 'execute',
    capabilityId: 'cmc-quotes',
    category: 'crypto price quote',
    provider: 'CoinMarketCap',
    capabilityDescription: 'latest market quotes for one or more cryptocurrencies',
    endpoint: 'https://pro-api.example.test/quotes',
    description: 'crypto price quote via pro-api.example.test',
    providerPriceAtomic: '10000',
    contract: {
      method: 'GET',
      url: 'https://pro-api.example.test/quotes',
      request: { url: 'https://pro-api.example.test/quotes', method: 'GET', headers: {} },
    },
  },
};

describe('one free decision', () => {
  it('sends the query and the packet, and nothing about money', async () => {
    const { fetchImpl, calls } = net(TOOL_EXECUTE);
    const outcome = await requestDecision(
      'tool',
      { query: 'BTC and ETH price' },
      { ctx: ctx(), baseUrl: BASE, fetchImpl },
    );

    expect(outcome.status).toBe('decided');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`${BASE}${ROUTER_PATH}`);
    expect(calls[0]!.method).toBe('POST');
    const body = calls[0]!.body as Record<string, unknown>;
    expect(body).toMatchObject({ schemaVersion: 1, query: 'BTC and ETH price' });
    // One call, and no 402 probe before it: this route is free.
    expect(JSON.stringify(body)).not.toContain('billing');
  });

  it('carries the packet alone from the hook, with no query', async () => {
    const { fetchImpl, calls } = net(NATIVE);
    await requestDecision(
      'hook',
      { packet: packetForText('what is the weather') },
      { ctx: ctx(), baseUrl: BASE, fetchImpl },
    );
    // Strict on the route: exactly these two. Which hook is asking is read
    // from `packet.pendingCall`, not from a field beside it.
    expect(Object.keys(calls[0]!.body as object).sort()).toEqual(['packet', 'schemaVersion']);
  });

  it('sends the query and the turn id from the tool, with no packet of its own', async () => {
    const { fetchImpl, calls } = net(TOOL_EXECUTE);
    await requestDecision(
      'tool',
      { query: 'BTC and ETH price', id: 'k3f9-abcd' },
      { ctx: ctx(), baseUrl: BASE, fetchImpl },
    );
    // The packet lives on the backend against the id; the client keeps none.
    expect(Object.keys(calls[0]!.body as object).sort()).toEqual(['id', 'query', 'schemaVersion']);
    expect(calls[0]!.method).toBe('POST');
  });

  /**
   * ONE VARIANT PER ANSWER. Optional fields made every shape legal: an execute
   * with no contract came back to the host as a routine needs_input, and a hook
   * answer quoting a price parsed as though the hook knew the task.
   */
  it('refuses a hook answer carrying a contract it cannot have', async () => {
    // The gate names the service it chose; the CONTRACT is the tool call's,
    // because at gate time the task the host will run does not exist yet.
    const { fetchImpl } = net({
      ...HOOK_EXECUTE,
      decision: { ...HOOK_EXECUTE.decision, contract: { method: 'GET', url: 'https://x.test' } },
    });
    const outcome = await requestDecision(
      'hook',
      { packet: packetForText('q') },
      { ctx: ctx(), baseUrl: BASE, fetchImpl },
    );
    expect(outcome).toMatchObject({ status: 'failed' });
  });

  it('refuses a tool execute with no contract', async () => {
    const decision = { ...TOOL_EXECUTE.decision } as Record<string, unknown>;
    delete decision.contract;
    const { fetchImpl } = net({ ...TOOL_EXECUTE, decision });
    const outcome = await requestDecision(
      'tool',
      { query: 'q' },
      { ctx: ctx(), baseUrl: BASE, fetchImpl },
    );
    // Not a routine needs_input: a contractless execute is a protocol error.
    expect(outcome).toMatchObject({ status: 'failed' });
    expect((outcome as { reason: string }).reason).toContain('cannot read');
  });

  it('surfaces a typed refusal by its own code and message', async () => {
    const { fetchImpl } = net(
      { error: { code: 'packet_too_large', message: 'The packet exceeds the 16 KiB bound.' } },
      400,
    );
    const outcome = await requestDecision(
      'hook',
      { packet: packetForText('q') },
      { ctx: ctx(), baseUrl: BASE, fetchImpl },
    );
    expect(outcome).toMatchObject({ status: 'failed', errorCode: 'packet_too_large' });
    expect((outcome as { reason: string }).reason).toContain('16 KiB bound');
  });

  it('falls back to the status line when a refusal carries no code', async () => {
    const { fetchImpl } = net({ nope: true }, 500);
    const outcome = await requestDecision(
      'hook',
      { packet: packetForText('q') },
      { ctx: ctx(), baseUrl: BASE, fetchImpl },
    );
    expect(outcome).toMatchObject({ status: 'failed' });
    expect((outcome as { errorCode?: string }).errorCode).toBeUndefined();
    expect((outcome as { reason: string }).reason).toContain('answered 500');
  });

  /**
   * STRICT, so a field in the wrong place fails loudly rather than being
   * dropped into a shape check that then blames the whole response. Diagnostics
   * nested one level deeper than the client expected shipped three times.
   */
  it('refuses a body with a field in the wrong place', async () => {
    const { fetchImpl } = net({ ...NATIVE, action: 'native' });
    const outcome = await requestDecision(
      'hook',
      { packet: packetForText('q') },
      { ctx: ctx(), baseUrl: BASE, fetchImpl },
    );
    expect(outcome).toMatchObject({ status: 'failed' });
    expect((outcome as { reason: string }).reason).toContain('cannot read');
  });
});
