import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Agent, EnvHttpProxyAgent } from 'undici';
import { expect, it } from 'vitest';
import { paidCallDispatcher, paidCallTimeouts } from './paid-call-dispatcher';

// Failure caught: Node's fetch cuts a request that waits more than 300 s for its headers or
// its body, below the deadline a router may offer (540 s) and below a stream's idle limit
// (300 s plus 30 s). The call was then left uncertain although its own deadline had not come.
it('waits for headers and body at least as long as the call deadline and the stream idle limit', () => {
  expect(paidCallTimeouts(540_000, 330_000)).toEqual({
    headersTimeout: 600_000,
    bodyTimeout: 600_000,
  });
  // A stream whose idle limit is longer than the deadline keeps its body wait above the idle.
  expect(paidCallTimeouts(60_000, 330_000).bodyTimeout).toBe(390_000);
  // A limit near the timer's top is clamped, never wrapped to a tiny wait.
  expect(paidCallTimeouts(2 ** 31 - 1, 1)).toEqual({
    headersTimeout: 2 ** 31 - 1,
    bodyTimeout: 2 ** 31 - 1,
  });
});

it('keeps one dispatcher for each size', () => {
  expect(paidCallDispatcher(540_000, 330_000)).toBe(paidCallDispatcher(540_000, 330_000));
  expect(paidCallDispatcher(540_000, 330_000)).not.toBe(paidCallDispatcher(60_000, 330_000));
});

// The runtime's own fetch takes this package's dispatcher and gets the answer through it.
it('is accepted by the global fetch', async () => {
  const server = createServer((_request, response) => response.end('ok'));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const { port } = server.address() as AddressInfo;
    const answer = await fetch(`http://127.0.0.1:${port}/`, {
      dispatcher: paidCallDispatcher(540_000, 330_000),
    } as unknown as RequestInit);
    expect(await answer.text()).toBe('ok');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

// Failure caught (vraspar's repro): a router stating a limit near 2^31 ms made the idle timer
// fire after 1 ms, so every streamed call was cut right after it was paid and left reserved.
it('clamps a router-stated call wait and idle limit to what a timer holds', async () => {
  const { streamIdleMs } = await import('./model-stream');
  const { paidCallTimeoutMs } = await import('./model-limits');
  for (const stated of [2 ** 31 - 10, Number.MAX_SAFE_INTEGER]) {
    expect(streamIdleMs({ callIdleLimitMs: stated })).toBe(2 ** 31 - 1);
    expect(paidCallTimeoutMs({ maxCallDurationMs: stated })).toBe(2 ** 31 - 1);
  }
  expect(streamIdleMs({ callIdleLimitMs: 300_000 })).toBe(330_000);
  expect(paidCallTimeoutMs({ maxCallDurationMs: 540_000 })).toBe(600_000);
});

// Failure caught (Greptile): a dispatcher handed to fetch replaces the global one the CLI set
// from HTTPS_PROXY, so a paid call skipped the proxy that routing and the quote went through,
// and the call, its routing fee already paid, was left uncertain. The proxy is chosen by the
// variables `useEnvProxy` reads.
it.each(['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy'])(
  'goes through the proxy the environment names (%s), as the CLI does for its other calls',
  (name) => {
    const saved = { ...process.env };
    try {
      for (const key of [
        'HTTPS_PROXY',
        'https_proxy',
        'HTTP_PROXY',
        'http_proxy',
        'NODE_USE_ENV_PROXY',
      ])
        delete process.env[key];
      expect(paidCallDispatcher(111_000, 45_000)).toBeInstanceOf(Agent);
      expect(paidCallDispatcher(111_000, 45_000)).not.toBeInstanceOf(EnvHttpProxyAgent);
      process.env[name] = 'http://127.0.0.1:9';
      expect(paidCallDispatcher(111_000, 45_000)).toBeInstanceOf(EnvHttpProxyAgent);
    } finally {
      for (const key of [
        'HTTPS_PROXY',
        'https_proxy',
        'HTTP_PROXY',
        'http_proxy',
        'NODE_USE_ENV_PROXY',
      ])
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
    }
  },
);
