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
function reader(answers: (bigint | null)[], at: { now: number }, preferRemembered = false) {
  const reads: string[] = [];
  const read = rememberingBalanceReader(dir, {
    preferRemembered,
    now: () => at.now,
    read: async (address) => {
      reads.push(address);
      return answers.shift() ?? null;
    },
  });
  return { read: (address: string) => read(address, RPC, { timeoutMs: 1_000 }), reads };
}

describe('the last-known balance', () => {
  it('stands in for a failed read for a minute, for the same address only', async () => {
    const at = { now: 1_000_000 };
    const { read } = reader([5_000_000n, null, null, null], at);
    expect(await read(WALLET)).toBe(5_000_000n);
    at.now += LAST_KNOWN_BALANCE_MS;
    expect(await read(WALLET)).toBe(5_000_000n);
    expect(await read(OTHER)).toBeNull();
    at.now += 1;
    expect(await read(WALLET)).toBeNull();
  });

  it('is returned without a read when the caller prefers it, and read live otherwise', async () => {
    const at = { now: 1_000_000 };
    const hook = reader([5_000_000n], at, true);
    expect(await hook.read(WALLET)).toBe(5_000_000n);
    expect(await hook.read(WALLET)).toBe(5_000_000n);
    expect(hook.reads).toHaveLength(1);
    const pay = reader([4_000_000n], at);
    expect(await pay.read(WALLET)).toBe(4_000_000n);
    expect(pay.reads).toHaveLength(1);
  });
});
