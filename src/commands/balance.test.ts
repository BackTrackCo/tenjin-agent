import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Address } from 'viem';
import { CliError } from '../lib/errors';
import type { WalletProvider } from '../lib/wallet';
import type { CommandContext } from '../context';

// The only chain touch is the balance read.
vi.mock('../lib/usdc', () => ({
  USDC_ADDRESS: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  getUsdcBalance: vi.fn(),
}));

import { getUsdcBalance } from '../lib/usdc';
import { runBalance } from './balance';
import { recallLink, rememberLink } from './fund-watch';

const mockedBalance = vi.mocked(getUsdcBalance);
const ADDRESS = '0x5c6e1111111111111111111111111111111bB7ff' as Address;

let dataDir: string;
beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'tenjin-balance-'));
  mockedBalance.mockReset();
});
afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

function ctx(): CommandContext {
  const sink = { write: () => true } as unknown as NodeJS.WritableStream;
  return {
    flags: { json: true, timeout: 10000 },
    dataDir,
    io: { stdout: sink, stderr: sink, isTTY: false },
  };
}

const provider: WalletProvider = {
  id: 'fake',
  describe: async () => ({
    address: ADDRESS,
    provider: 'fake',
    credentialSource: 'remote',
    policyEnforcement: 'provider',
  }),
  getSigner: async () => {
    throw new Error('a balance read never unlocks the key');
  },
  diagnostics: async () => ({ warnings: [] }),
};

/** A clock the injected sleep advances, so no wait is real. */
function clock(start = 1_000_000) {
  let t = start;
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
  };
}

describe('tenjin balance --wait', () => {
  it('waits for the balance to rise, then says what arrived', async () => {
    mockedBalance
      .mockResolvedValueOnce(210_000n)
      .mockResolvedValueOnce(210_000n)
      .mockResolvedValueOnce(5_210_000n);
    const res = await runBalance(ctx(), { provider, wait: true, ...clock() });
    expect(res.data).toMatchObject({
      arrived: true,
      added: { usd: '5' },
      balance: { usd: '5.21' },
      summary: '+$5.00 · balance $5.21',
    });
    expect(res.humanLines).toEqual(['+$5.00 · balance $5.21']);
  });

  it('counts money that landed after `tenjin fund` issued its link, before the wait began', async () => {
    const c = clock();
    await rememberLink(dataDir, {
      version: 1,
      address: ADDRESS.toLowerCase(),
      url: 'https://tenjin.sh/fund#a.b',
      token: 'a.b',
      issuedAt: c.now() - 60_000,
      expiresAt: c.now() + 540_000,
      startBalanceAtomic: '0',
    });
    mockedBalance.mockResolvedValue(5_000_000n);
    const res = await runBalance(ctx(), { provider, wait: true, ...c });
    expect(res.data).toMatchObject({ arrived: true, added: { usd: '5' } });
    // Said once: the next wait measures from here.
    expect(await recallLink(dataDir, ADDRESS, c.now())).toBeNull();
  });

  it('exits non-zero when nothing arrives in time, saying nothing went wrong', async () => {
    mockedBalance.mockResolvedValue(0n);
    const err = await runBalance(ctx(), {
      provider,
      wait: true,
      waitMs: 60_000,
      ...clock(),
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).exitCode).not.toBe(0);
    expect((err as CliError).message).toContain('No funds arrived in 1 minute. Nothing went wrong');
    expect((err as CliError).details).toMatchObject({ arrived: false });
  });
});
