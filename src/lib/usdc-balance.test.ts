import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LAST_KNOWN_BALANCE_MS, rememberingBalanceReader } from './usdc-balance';

const WALLET = '0x1234567890AbcdEF1234567890aBcdef12345678';
const OTHER = '0x0000000000000000000000000000000000000001';
const RPC = 'https://mainnet.base.org';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'usdc-balance-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** A reader over a scripted chain: each read takes the next answer. */
function reader(answers: (bigint | null)[], at: { now: number }) {
  const reads: string[] = [];
  const read = rememberingBalanceReader(dir, {
    now: () => at.now,
    read: async (address) => {
      reads.push(address);
      return answers.shift() ?? null;
    },
  });
  return { read: (address: string) => read(address, RPC, { timeoutMs: 1_000 }), reads };
}

describe('the last-known balance', () => {
  it('is returned without a read for a minute, for the same address only', async () => {
    const at = { now: 1_000_000 };
    const { read, reads } = reader([5_000_000n, null, 4_000_000n], at);
    expect(await read(WALLET)).toBe(5_000_000n);
    at.now += LAST_KNOWN_BALANCE_MS;
    expect(await read(WALLET)).toBe(5_000_000n);
    expect(reads).toHaveLength(1);
    expect(await read(OTHER)).toBeNull();
    at.now += 1;
    expect(await read(WALLET)).toBe(4_000_000n);
    expect(reads).toEqual([WALLET, OTHER, WALLET]);
  });
});
