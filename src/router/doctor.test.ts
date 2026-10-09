import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileClientChannelStorage } from '@x402/evm/batch-settlement/client/file-storage';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SpendPolicy } from '../lib/policy';
import { testWalletProvider } from '../lib/read-test-utils';
import type { WalletProvider } from '../lib/wallet';
import { doctorLines, routingFeeBlock, routingFeeRow, type RoutingFeeInput } from './doctor';
import { payerDir } from './fee';

/**
 * `tenjin doctor` names the state a session's notice names: why the next
 * routing deposit would be refused, worked out from the wallet, the limits,
 * the ledger, the channel the SDK keeps and the wallet's balance.
 */

const POLICY: SpendPolicy = {
  maxAutoSpendAtomic: 250_000n,
  sessionBudgetAtomic: 5_000_000n,
  allowlistCreators: [],
};

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'router-doctor-fee-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** An RPC that answers `balanceOf` with `atomic`. */
function rpc(atomic: bigint): typeof fetch {
  return (async () =>
    Response.json({
      jsonrpc: '2.0',
      id: 1,
      result: `0x${atomic.toString(16).padStart(64, '0')}`,
    })) as typeof fetch;
}

function verified(status: 'verified' | 'unverified'): WalletProvider {
  return { ...testWalletProvider(), verify: async () => ({ status, detail: status }) };
}

function input(over: Partial<RoutingFeeInput> = {}): RoutingFeeInput {
  return {
    dataDir: dir,
    policy: POLICY,
    rpcUrl: 'https://rpc.test',
    host: 'tenjin.sh',
    timeoutMs: 1_000,
    provider: verified('verified'),
    fetchImpl: rpc(10_000_000n),
    ...over,
  };
}

describe('routingFeeBlock', () => {
  it('finds nothing in the way of a funded, unlockable wallet inside its limits', async () => {
    expect(await routingFeeBlock(input())).toBeNull();
  });

  it.each([
    ['no wallet', { provider: null }, 'no_wallet'],
    ['a wallet tenjin mcp cannot unlock', { provider: verified('unverified') }, 'wallet_locked'],
    ['a wallet under the deposit', { fetchImpl: rpc(100_000n) }, 'wallet_low'],
    [
      'a per-call limit under ten fees',
      { policy: { ...POLICY, maxAutoSpendAtomic: 20_000n } },
      'limit_below_deposit',
    ],
    [
      'a daily limit with no room for the deposit',
      { policy: { ...POLICY, sessionBudgetAtomic: 100_000n } },
      'budget_reached',
    ],
    [
      'an allowlist without the router',
      { policy: { ...POLICY, allowlistCreators: ['someone.else'] } },
      'not_allowlisted',
    ],
  ] as const)('names %s', async (_label, over, why) => {
    expect(await routingFeeBlock(input(over as Partial<RoutingFeeInput>))).toBe(why);
  });

  it.each<[string, Partial<SpendPolicy>, string]>([
    ['a per-call limit of 0', { maxAutoSpendAtomic: 0n }, 'limit_below_deposit'],
    ['a daily limit of 0', { sessionBudgetAtomic: 0n }, 'budget_reached'],
    ['an allowlist without the router', { allowlistCreators: ['someone.else'] }, 'not_allowlisted'],
  ])('names %s even while the channel still holds a fee', async (_label, change, why) => {
    const { address } = await testWalletProvider().describe();
    await new FileClientChannelStorage({ directory: payerDir(dir, address) }).set(
      `0x${'ab'.repeat(32)}`,
      { balance: '250000', chargedCumulativeAmount: '9000' },
    );
    expect(await routingFeeBlock(input({ policy: { ...POLICY, ...change } }))).toBe(why);
  });

  it('names unanswered limits before a locked wallet, as the payer meets them', async () => {
    expect(
      await routingFeeBlock(
        input({ provider: verified('unverified'), policy: { ...POLICY, maxAutoSpendAtomic: 0n } }),
      ),
    ).toBe('limit_below_deposit');
  });

  it('needs no deposit while the channel still holds a fee, whatever the wallet holds', async () => {
    const { address } = await testWalletProvider().describe();
    await new FileClientChannelStorage({ directory: payerDir(dir, address) }).set(
      `0x${'ab'.repeat(32)}`,
      { balance: '250000', chargedCumulativeAmount: '9000' },
    );
    expect(await routingFeeBlock(input({ fetchImpl: rpc(0n) }))).toBeNull();
  });
});

describe('routingFeeRow', () => {
  it('points an unanswered limit at the spend question, with its fee terms and one-step yes', () => {
    const row = routingFeeRow('limit_below_deposit', 'tenjin.sh', {
      limits: { maxAutoSpend: '250000', sessionBudget: '5000000' },
    });
    expect(row.status).toBe('warn');
    expect(row.fix).toContain('May Tenjin pay for tool calls without asking you each time');
    expect(row.fix).toContain('Routing costs $0.003 a call');
    expect(row.fix).toContain('`tenjin install --yes`');
    expect(row.fix).not.toContain('config set maxAutoSpend 0.25');
  });

  it('keeps the raise command for a limit the user chose', () => {
    expect(routingFeeRow('limit_below_deposit', 'tenjin.sh', null).fix).toBe(
      'Raise it with `tenjin config set maxAutoSpend 0.25`.',
    );
  });
});

describe('doctorLines', () => {
  it('prints the fix under a row to look at, and none under a passing row', () => {
    expect(
      doctorLines([
        { name: 'node', status: 'ok', required: true, detail: 'v24', fix: 'unused' },
        {
          name: 'spend',
          status: 'warn',
          required: false,
          detail: 'the spend limits are not answered yet',
          fix: 'Run `tenjin install --yes`.',
        },
      ]),
    ).toEqual([
      'ok    node: v24',
      'warn  spend: the spend limits are not answered yet',
      '      fix: Run `tenjin install --yes`.',
      '2 checks, 1 to look at.',
    ]);
  });
});
