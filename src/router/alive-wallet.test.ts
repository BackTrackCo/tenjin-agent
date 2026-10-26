import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_RPC_URL, FALLBACK_RPC_URLS } from '../lib/usdc-balance';
import { walletNotice, WALLET_READ_MS } from './alive';

/**
 * THE WALLET NOTICE the `alive` leg shows the person at session start, as its
 * `systemMessage`: said while the wallet cannot pay, silent otherwise.
 */

const ADDRESS = '0x5c6e1111111111111111111111111111111bB7ff';
let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'router-alive-wallet-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function wallet(config: Record<string, unknown> = {}): Promise<void> {
  await writeFile(join(dir, 'wallet.json'), JSON.stringify({ address: ADDRESS }));
  await writeFile(join(dir, 'config.json'), JSON.stringify(config));
}

describe('the wallet notice at session start', () => {
  it('says the balance, asks the person to ask their agent, and shows no address', async () => {
    await wallet({ maxAutoSpend: '250000' });
    const notice = await walletNotice(dir, { read: async () => 0n });
    expect(notice).toContain('Tenjin last checked balance: $0.00.');
    expect(notice).toContain('before funding again');
    // The balance, never the wallet's address.
    expect(notice).not.toMatch(/0x/i);
  });

  it('says a wallet under the per-call limit, and nothing for one at or over it', async () => {
    await wallet({ maxAutoSpend: '250000' });
    expect(await walletNotice(dir, { read: async () => 100_000n })).toContain(
      'Tenjin last checked balance: $0.10.',
    );
    await rm(join(dir, 'balance.json'), { force: true });
    expect(await walletNotice(dir, { read: async () => 250_000n })).toBeNull();
  });

  it('uses the default per-call limit when the config sets none', async () => {
    await wallet();
    expect(await walletNotice(dir, { read: async () => 30_000n })).toContain(
      'Tenjin last checked balance: $0.03.',
    );
    await rm(join(dir, 'balance.json'), { force: true });
    expect(await walletNotice(dir, { read: async () => 300_000n })).toBeNull();
  });

  it('says nothing with no wallet, or when the balance cannot be read', async () => {
    const read = vi.fn(async () => 0n);
    expect(await walletNotice(dir, { read })).toBeNull();
    expect(read).not.toHaveBeenCalled();
    await wallet();
    expect(await walletNotice(dir, { read: async () => null })).toBeNull();
  });

  it("asks the user's own RPC when the config names one", async () => {
    await wallet({ rpcUrl: 'https://rpc.example.test' });
    const read = vi.fn(async () => 5_000_000n);
    await walletNotice(dir, { read });
    expect(read).toHaveBeenCalledWith(ADDRESS, 'https://rpc.example.test', {
      timeoutMs: WALLET_READ_MS,
      signal: expect.any(AbortSignal),
    });
  });
  it('returns by the whole-operation deadline even if a transport ignores abort', async () => {
    await wallet();
    let signal!: AbortSignal;
    const started = Date.now();
    expect(
      await walletNotice(dir, {
        timeoutMs: 30,
        read: async (_address, _url, opts) => {
          signal = opts.signal!;
          return new Promise(() => undefined);
        },
      }),
    ).toBeNull();
    expect(Date.now() - started).toBeLessThan(500);
    expect(signal.aborted).toBe(true);
  });

  it('does not report an env-key wallet using the file wallet balance', async () => {
    await wallet();
    const read = vi.fn(async () => 0n);
    expect(await walletNotice(dir, { read, env: { TENJIN_WALLET_KEY: 'override' } })).toBeNull();
    expect(read).not.toHaveBeenCalled();
  });

  it('keeps default RPC fallbacks within the startup deadline', async () => {
    await wallet();
    const fetch = vi.fn(async (_url: unknown) => new Response('down', { status: 503 }));
    vi.stubGlobal('fetch', fetch);
    try {
      expect(await walletNotice(dir)).toBeNull();
      expect(fetch.mock.calls.map(([url]) => url)).toEqual([DEFAULT_RPC_URL, ...FALLBACK_RPC_URLS]);
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it('bounds a stalled JSON body after response headers arrive', async () => {
    await wallet();
    vi.stubGlobal(
      'fetch',
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('{'));
            },
          }),
        ),
    );
    try {
      const started = Date.now();
      expect(await walletNotice(dir, { timeoutMs: 30 })).toBeNull();
      expect(Date.now() - started).toBeLessThan(500);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('uses a recent cache without another RPC', async () => {
    await wallet();
    const read = vi.fn(async () => 0n);
    await walletNotice(dir, { read });
    await walletNotice(dir, { read });
    expect(read).toHaveBeenCalledOnce();
  });
});
