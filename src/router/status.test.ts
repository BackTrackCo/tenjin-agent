import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CommandContext } from '../context';
import { FUND_COMMAND_LINE } from './fee';
import { runRouterStatus } from './status';

/**
 * `tenjin status` LEADS WITH THE WALLET'S BALANCE: at $0 it says how to fund
 * it, a read the RPC did not answer says so, and no wallet means no line and
 * no read. The chain is a seam here; nothing goes on the network.
 */

const ADDRESS = '0xA7f3Ad0E69F61864092FAbBa6Cee00AF6e584689';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'router-status-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function ctx(): CommandContext {
  const sink = () => ({ write: () => true }) as unknown as NodeJS.WritableStream;
  return {
    flags: { json: false, timeout: 5000 },
    dataDir: dir,
    io: { stdout: sink(), stderr: sink(), isTTY: false },
  };
}

const status = (atomic: bigint | null) =>
  runRouterStatus(ctx(), {
    routingCredit: async () => 0n,
    wallet: async () => ({ address: ADDRESS, atomic }),
  });

describe('status, the wallet line', () => {
  it('says how to fund a wallet at exactly $0', async () => {
    const result = await status(0n);
    expect(result.humanLines?.slice(0, 3)).toEqual([
      'wallet 0 USD',
      'Fund it with `tenjin wallet fund 5`.',
      'lookups 0 USD',
    ]);
    expect(result.data).toMatchObject({
      wallet: { address: ADDRESS, balance: { atomic: '0', usd: '0' } },
    });
  });

  it('shows a funded balance with no funding line', async () => {
    const result = await status(5_000_000n);
    expect(result.humanLines?.slice(0, 2)).toEqual(['wallet 5 USD', 'lookups 0 USD']);
    expect(result.humanLines).not.toContain(FUND_COMMAND_LINE);
  });

  it('says the balance is unknown when the RPC did not answer, without a funding line', async () => {
    const result = await status(null);
    expect(result.humanLines?.[0]).toBe(
      'wallet balance unknown: the RPC did not answer; `tenjin wallet balance` retries',
    );
    expect(result.humanLines).not.toContain(FUND_COMMAND_LINE);
    expect(result.data).toMatchObject({ wallet: { address: ADDRESS, balance: null } });
  });

  it('has no wallet line with no wallet', async () => {
    const result = await runRouterStatus(ctx(), {
      routingCredit: async () => 0n,
      wallet: async () => null,
    });
    expect(result.humanLines?.[0]).toBe('lookups 0 USD');
    expect(result.data).toMatchObject({ wallet: null });
  });

  it('never fails the readout on a wallet read that throws', async () => {
    const result = await runRouterStatus(ctx(), {
      routingCredit: async () => 0n,
      wallet: async () => {
        throw new Error('rpc down');
      },
    });
    expect(result.humanLines?.[0]).toBe('lookups 0 USD');
    expect(result.data).toMatchObject({ wallet: null });
  });

  it('reads nothing from the chain on this machine with no wallet', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('no network'));
    try {
      const result = await runRouterStatus(ctx(), { routingCredit: async () => 0n });
      expect(result.data).toMatchObject({ wallet: null });
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
