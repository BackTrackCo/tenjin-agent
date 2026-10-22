import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { walletNotice } from './alive';

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
  it('says an empty wallet, with the fund command and the $5 floor', async () => {
    await wallet({ maxAutoSpend: '250000' });
    expect(await walletNotice(dir, { read: async () => 0n })).toBe(
      'Tenjin wallet 0x5c6e…B7ff holds $0.00: run `tenjin wallet fund` to add $5 or more, and lookups pay from it.',
    );
  });

  it('says a wallet under the per-call limit, and nothing for one at or over it', async () => {
    await wallet({ maxAutoSpend: '250000' });
    expect(await walletNotice(dir, { read: async () => 100_000n })).toContain('holds $0.10');
    await rm(join(dir, 'balance.json'), { force: true });
    expect(await walletNotice(dir, { read: async () => 250_000n })).toBeNull();
  });

  it('uses the default per-call limit when the config sets none', async () => {
    await wallet();
    expect(await walletNotice(dir, { read: async () => 30_000n })).toContain('holds $0.03');
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
    expect(read).toHaveBeenCalledWith(ADDRESS, 'https://rpc.example.test', { timeoutMs: 2_000 });
  });
});
