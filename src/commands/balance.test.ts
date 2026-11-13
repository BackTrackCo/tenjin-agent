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

// THE BALANCE IS READ THROUGH THE PUBLIC-RPC FALLBACK (`balanceReader`), which
// here asks the one per-RPC reader mocked above, so no test reads a chain.
vi.mock('../lib/usdc-balance', async (importOriginal) =>
  (await import('../lib/usdc-test-utils')).bridgedUsdcBalance(
    await importOriginal<typeof import('../lib/usdc-balance')>(),
  ),
);

import { getUsdcBalance } from '../lib/usdc';
import { readUsdcBalanceWithFallback } from '../lib/usdc-balance';
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

describe('tenjin balance, read through the public-RPC fallback', () => {
  /** An RPC answering `balanceOf`, or failing, by its URL. */
  function rpcs(answers: Record<string, bigint | null>) {
    const asked: string[] = [];
    const fetchImpl = (async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      asked.push(url);
      const atomic = answers[url];
      if (atomic === undefined || atomic === null) return new Response('{}', { status: 503 });
      const word = `0x${atomic.toString(16).padStart(64, '0')}`;
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: word }));
    }) as typeof fetch;
    return { fetchImpl, asked };
  }

  it('retries a public Base RPC when the default one fails', async () => {
    // Review round 1 (O1): status and balance read the configured RPC alone,
    // so a busy default RPC made `tenjin balance` fail where a lookup's read
    // would have answered.
    const actual =
      await vi.importActual<typeof import('../lib/usdc-balance')>('../lib/usdc-balance');
    // The real fallback, for this test's read.
    vi.mocked(readUsdcBalanceWithFallback).mockImplementationOnce(
      actual.readUsdcBalanceWithFallback,
    );
    const net = rpcs({
      [actual.DEFAULT_RPC_URL]: null,
      [actual.FALLBACK_RPC_URLS[0]!]: 5_000_000n,
    });
    const { balanceReader } = await import('./balance');
    const reader = await balanceReader(ctx(), { provider, rpcFetchImpl: net.fetchImpl });
    expect(await reader.read()).toBe(5_000_000n);
    expect(net.asked).toEqual([actual.DEFAULT_RPC_URL, actual.FALLBACK_RPC_URLS[0]]);
  });
});
