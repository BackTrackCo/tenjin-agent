import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CommandContext } from '../context';
import { testCtx } from '../context-test-utils';
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
  return testCtx(dir, { json: false });
}

const status = (atomic: bigint | null) =>
  runRouterStatus(ctx(), {
    routingCredit: async () => 0n,
    wallet: async () => ({ address: ADDRESS, atomic }),
  });

describe('status, the wallet line', () => {
  it('keeps usable routing funds visible without asking to fund an empty wallet', async () => {
    const result = await runRouterStatus(ctx(), {
      routingCredit: async () => 18_000n,
      wallet: async () => ({ address: ADDRESS, atomic: 0n }),
    });
    expect(result.humanLines).toContain(
      'set aside for routing: approximately 0.018 USD (local estimate)',
    );
    expect(result.humanLines).not.toContain(FUND_COMMAND_LINE);
    expect(result.humanLines?.join('\n')).not.toMatch(/prepaid|routing credit/i);
    expect(result.data).toMatchObject({ routingCredit: { remaining: { atomic: '18000' } } });
  });

  // Offers show no routing fee: the routing total, beside the set-aside line, is where it shows.
  it('shows what routing has cost beside what is set aside, and no line before it cost anything', async () => {
    const spent = await runRouterStatus(ctx(), {
      routingCredit: async () => 18_000n,
      routingSpent: async () => 62_000n,
      wallet: async () => ({ address: ADDRESS, atomic: 1_000_000n }),
    });
    const lines = spent.humanLines ?? [];
    const aside = lines.indexOf('set aside for routing: approximately 0.018 USD (local estimate)');
    expect(aside).toBeGreaterThan(-1);
    expect(lines[aside + 1]).toBe(
      'spent on routing: approximately 0.062 USD (deposits sent less what is set aside; local estimate)',
    );
    expect(spent.data).toMatchObject({ routingCredit: { spent: { atomic: '62000' } } });
    const none = await runRouterStatus(ctx(), {
      routingCredit: async () => 0n,
      routingSpent: async () => 0n,
      wallet: async () => ({ address: ADDRESS, atomic: 1_000_000n }),
    });
    expect(none.humanLines?.join('\n')).not.toContain('spent on routing');
  });

  it('says how to fund a wallet at exactly $0', async () => {
    const result = await status(0n);
    expect(result.humanLines?.slice(0, 3)).toEqual([
      'wallet 0 USD',
      FUND_COMMAND_LINE,
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
      'wallet balance unknown: the RPC did not answer; `tenjin balance` retries',
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
