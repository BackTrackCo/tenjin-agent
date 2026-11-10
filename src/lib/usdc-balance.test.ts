import { describe, expect, it } from 'vitest';
import { CONFIG_DEFAULTS } from './config';
import { DEFAULT_RPC_URL, FALLBACK_RPC_URLS, readUsdcBalanceWithFallback } from './usdc-balance';

const WALLET = '0x1234567890AbcdEF1234567890aBcdef12345678';
const RPC = 'https://mainnet.base.org';

/**
 * A chain behind several RPCs: each URL answers with a balance, fails the way
 * it is told to, or hangs until the read gives up on it.
 */
function rpcs(answers: Record<string, bigint | 'error' | 'rate-limit' | 'down' | 'hang'>) {
  const asked: string[] = [];
  const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = String(input);
    asked.push(url);
    const answer = answers[url] ?? 'down';
    if (answer === 'down') throw new TypeError('fetch failed');
    if (answer === 'error') return new Response('nope', { status: 500 });
    if (answer === 'rate-limit') {
      return new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          error: { code: -32016, message: 'over rate limit' },
        }),
      );
    }
    if (answer === 'hang') {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      });
    }
    const word = `0x${answer.toString(16).padStart(64, '0')}`;
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: word }));
  }) as typeof fetch;
  return { fetchImpl, asked };
}

describe('the fallback RPCs', () => {
  const [PUBLICNODE, DRPC] = FALLBACK_RPC_URLS as [string, string];

  it('are asked only when the configured RPC fails', async () => {
    const { fetchImpl, asked } = rpcs({ [RPC]: 7n, [PUBLICNODE]: 8n });
    expect(await readUsdcBalanceWithFallback(WALLET, RPC, { timeoutMs: 1_000, fetchImpl })).toBe(
      7n,
    );
    expect(asked).toEqual([RPC]);
  });

  /** mainnet.base.org answered `-32016 over rate limit`, and a paid lookup was
   *  refused with `balance_unavailable`; publicnode answered the same read. */
  it.each(['rate-limit', 'error', 'down'] as const)(
    'read the balance in order when the configured RPC is %s',
    async (failure) => {
      const { fetchImpl, asked } = rpcs({ [RPC]: failure, [PUBLICNODE]: 'down', [DRPC]: 9n });
      expect(await readUsdcBalanceWithFallback(WALLET, RPC, { timeoutMs: 1_000, fetchImpl })).toBe(
        9n,
      );
      expect(asked).toEqual([RPC, PUBLICNODE, DRPC]);
    },
  );

  /**
   * A USER'S OWN RPC IS THE ONLY ONE ASKED. Choosing one can be about privacy,
   * and the public RPCs would see the wallet's address, so a read that fails
   * there fails, even when a fallback would have answered it.
   */
  it('are never asked when the user configured an RPC of their own', async () => {
    for (const failure of ['rate-limit', 'error', 'down'] as const) {
      const mine = 'https://base.example-rpc.test/v1/key';
      const { fetchImpl, asked } = rpcs({ [mine]: failure, [PUBLICNODE]: 5n, [DRPC]: 6n });
      expect(
        await readUsdcBalanceWithFallback(WALLET, mine, { timeoutMs: 1_000, fetchImpl }),
      ).toBeNull();
      expect(asked).toEqual([mine]);
    }
    // Not even a public one: a user who picked publicnode picked publicnode.
    const { fetchImpl, asked } = rpcs({ [PUBLICNODE]: 'down', [DRPC]: 6n });
    expect(
      await readUsdcBalanceWithFallback(WALLET, PUBLICNODE, { timeoutMs: 1_000, fetchImpl }),
    ).toBeNull();
    expect(asked).toEqual([PUBLICNODE]);
  });

  it('back the default however it is spelled', async () => {
    expect(DEFAULT_RPC_URL).toBe(RPC);
    expect(CONFIG_DEFAULTS.rpcUrl).toBe(DEFAULT_RPC_URL);
    const spelled = `${RPC}/`;
    const { fetchImpl, asked } = rpcs({ [spelled]: 'rate-limit', [PUBLICNODE]: 5n });
    expect(
      await readUsdcBalanceWithFallback(WALLET, spelled, { timeoutMs: 1_000, fetchImpl }),
    ).toBe(5n);
    expect(asked).toEqual([spelled, PUBLICNODE]);
  });

  it('leave a hung RPC half the time, and stay inside the one timeout', async () => {
    const { fetchImpl, asked } = rpcs({ [RPC]: 'hang', [PUBLICNODE]: 4n });
    const started = Date.now();
    expect(await readUsdcBalanceWithFallback(WALLET, RPC, { timeoutMs: 400, fetchImpl })).toBe(4n);
    expect(asked).toEqual([RPC, PUBLICNODE]);
    expect(Date.now() - started).toBeLessThan(400);

    const dead = rpcs({ [RPC]: 'hang', [PUBLICNODE]: 'hang', [DRPC]: 'hang' });
    const begun = Date.now();
    expect(
      await readUsdcBalanceWithFallback(WALLET, RPC, { timeoutMs: 300, fetchImpl: dead.fetchImpl }),
    ).toBeNull();
    expect(dead.asked).toEqual([RPC, PUBLICNODE, DRPC]);
    expect(Date.now() - begun).toBeLessThan(600);
  });
});
