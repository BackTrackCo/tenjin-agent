import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BALANCE_NOTICE_EVERY_MS, walletNotice } from './alive';

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

/** Each call a day after the last, so the once-a-day record never answers for it. */
let day = 0;
const nextDay = () => ++day * BALANCE_NOTICE_EVERY_MS;

describe('the wallet notice at session start', () => {
  it('says the balance, asks the person to ask their agent, and shows no address', async () => {
    await wallet({ maxAutoSpend: '250000' });
    const notice = await walletNotice(dir, { read: async () => 0n, now: nextDay });
    expect(notice).toBe('Tenjin balance $0.00 · low. Say "add funds" when you\'re ready.');
    // The balance, never the wallet's address.
    expect(notice).not.toMatch(/0x/i);
  });

  it('is said at most once a day', async () => {
    await wallet({ maxAutoSpend: '250000' });
    const read = async () => 0n;
    const at = nextDay();
    expect(await walletNotice(dir, { read, now: () => at })).not.toBeNull();
    expect(
      await walletNotice(dir, { read, now: () => at + BALANCE_NOTICE_EVERY_MS - 1 }),
    ).toBeNull();
    expect(
      await walletNotice(dir, { read, now: () => at + BALANCE_NOTICE_EVERY_MS }),
    ).not.toBeNull();
  });

  it('says a wallet under the per-call limit, and nothing for one at or over it', async () => {
    await wallet({ maxAutoSpend: '250000' });
    expect(await walletNotice(dir, { read: async () => 100_000n, now: nextDay })).toContain(
      'Tenjin balance $0.10 · low.',
    );
    expect(await walletNotice(dir, { read: async () => 250_000n, now: nextDay })).toBeNull();
  });

  it('uses the default per-call limit when the config sets none', async () => {
    await wallet();
    expect(await walletNotice(dir, { read: async () => 30_000n, now: nextDay })).toContain(
      'Tenjin balance $0.03 · low.',
    );
    expect(await walletNotice(dir, { read: async () => 300_000n, now: nextDay })).toBeNull();
  });

  it('reads the balance at most once a day, low or not', async () => {
    await wallet({ maxAutoSpend: '250000' });
    const read = vi.fn(async () => 5_000_000n);
    const at = nextDay();
    expect(await walletNotice(dir, { read, now: () => at })).toBeNull();
    expect(
      await walletNotice(dir, { read, now: () => at + BALANCE_NOTICE_EVERY_MS - 1 }),
    ).toBeNull();
    expect(read).toHaveBeenCalledTimes(1);
    await walletNotice(dir, { read, now: () => at + BALANCE_NOTICE_EVERY_MS });
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('says nothing with no wallet, or when the balance cannot be read', async () => {
    const read = vi.fn(async () => 0n);
    expect(await walletNotice(dir, { read })).toBeNull();
    expect(read).not.toHaveBeenCalled();
    await wallet();
    expect(await walletNotice(dir, { read: async () => null })).toBeNull();
  });

  it('says nothing, and reads nothing, when TENJIN_WALLET_KEY shadows wallet.json', async () => {
    await wallet();
    const read = vi.fn(async () => 0n);
    const env = { TENJIN_WALLET_KEY: `0x${'1'.repeat(64)}` };
    expect(await walletNotice(dir, { env, read, now: nextDay })).toBeNull();
    expect(read).not.toHaveBeenCalled();
  });

  it('says nothing, and reads nothing, while the router is off', async () => {
    await wallet({ router: { enabled: false } });
    const read = vi.fn(async () => 0n);
    expect(await walletNotice(dir, { cwd: dir, read, now: nextDay })).toBeNull();
    expect(read).not.toHaveBeenCalled();
  });

  it("asks the user's own RPC when the config names one", async () => {
    await wallet({ rpcUrl: 'https://rpc.example.test' });
    const read = vi.fn(async () => 5_000_000n);
    await walletNotice(dir, { read });
    expect(read).toHaveBeenCalledWith(ADDRESS, 'https://rpc.example.test', { timeoutMs: 2_000 });
  });
});
