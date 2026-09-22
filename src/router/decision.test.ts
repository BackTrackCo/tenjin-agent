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

const EXECUTE = {
  schemaVersion: 1,
  routerVersion: '2026-09-23.1',
  decision: { action: 'execute', id: 'k3f9-abcd' },
};

describe('one free decision', () => {
  it('sends the query and the packet, and nothing about money', async () => {
    const { fetchImpl, calls } = net(EXECUTE);
    const outcome = await requestDecision(
      { query: 'BTC and ETH price', packet: packetForText('BTC and ETH price') },
      { ctx: ctx(), baseUrl: BASE, fetchImpl },
    );

    expect(outcome.status).toBe('decided');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`${BASE}${ROUTER_PATH}`);
    expect(calls[0]!.method).toBe('POST');
    const body = calls[0]!.body as Record<string, unknown>;
    expect(body).toMatchObject({ schemaVersion: 1, query: 'BTC and ETH price' });
    expect(body.packet).toBeDefined();
    // One call, and no 402 probe before it: this route is free.
    expect(JSON.stringify(body)).not.toContain('billing');
  });

  it('carries the packet alone from the hook, with no query', async () => {
    const { fetchImpl, calls } = net(NATIVE);
    await requestDecision(
      { packet: packetForText('what is the weather') },
      { ctx: ctx(), baseUrl: BASE, fetchImpl },
    );
    expect(Object.keys(calls[0]!.body as object).sort()).toEqual(['packet', 'schemaVersion']);
  });

  it('sends the query and the turn id from the tool, with no packet of its own', async () => {
    const { fetchImpl, calls } = net(EXECUTE);
    await requestDecision(
      { query: 'BTC and ETH price', id: 'k3f9-abcd' },
      { ctx: ctx(), baseUrl: BASE, fetchImpl },
    );
    // The packet lives on the backend against the id; the client keeps none.
    expect(Object.keys(calls[0]!.body as object).sort()).toEqual(['id', 'query', 'schemaVersion']);
    expect(calls[0]!.method).toBe('POST');
  });

  it('surfaces a typed refusal by its own code and message', async () => {
    const { fetchImpl } = net(
      { error: { code: 'packet_too_large', message: 'The packet exceeds the 16 KiB bound.' } },
      400,
    );
    const outcome = await requestDecision(
      { packet: packetForText('q') },
      { ctx: ctx(), baseUrl: BASE, fetchImpl },
    );
    expect(outcome).toMatchObject({ status: 'failed', errorCode: 'packet_too_large' });
    expect((outcome as { reason: string }).reason).toContain('16 KiB bound');
  });

  it('falls back to the status line when a refusal carries no code', async () => {
    const { fetchImpl } = net({ nope: true }, 500);
    const outcome = await requestDecision(
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
      { packet: packetForText('q') },
      { ctx: ctx(), baseUrl: BASE, fetchImpl },
    );
    expect(outcome).toMatchObject({ status: 'failed' });
    expect((outcome as { reason: string }).reason).toContain('cannot read');
  });
});
