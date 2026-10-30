import { describe, expect, it } from 'vitest';
import { BatchSettlementEvmScheme } from '@x402/evm/batch-settlement/server';
import { KEYCHAIN_LOCKED_FIX, REPAIR_CLAUSE } from '../lib/wallet-unlock';
import {
  CHANNEL_DEPOSIT_ATOMIC,
  depositSentence,
  MAX_CHANNEL_DEPOSIT_ATOMIC,
  routingDepositAtomic,
  unpaid,
  unpaidSentence,
} from './fee';
import { FakeRouter } from './fee-test-utils';
import { ASK_FOR_REPAIR, WALLET_REASONS } from './wallet-reasons';

/** Every key the routing payer can skip with, and a call with no payer's. */
const ALL_KEYS = [
  ...Object.keys(WALLET_REASONS),
  'wallet_low',
  'limit_below_deposit',
  'budget_reached',
  'not_allowlisted',
  'payment_failed',
  'no_payer',
  'fee_above_ceiling',
];

describe('routingDepositAtomic', () => {
  /** The deposit: the smallest of the hint, the wallet and the per-call
   *  limit, never below ten quoted fees, never above the SDK's ceiling. */
  const size = (o: {
    hint?: bigint;
    quote?: bigint;
    wallet?: bigint | null;
    perCall?: bigint;
    needed?: bigint;
  }) =>
    routingDepositAtomic({
      hintAtomic: o.hint ?? CHANNEL_DEPOSIT_ATOMIC,
      quoteAtomic: o.quote ?? 3_000n,
      walletAtomic: o.wallet === undefined ? 10_000_000n : o.wallet,
      perCallAtomic: o.perCall ?? 250_000n,
      maxAtomic: MAX_CHANNEL_DEPOSIT_ATOMIC,
      ...(o.needed !== undefined ? { neededAtomic: o.needed } : {}),
    });

  it.each<[string, Parameters<typeof size>[0], bigint]>([
    ['the hint, from a big wallet', {}, CHANNEL_DEPOSIT_ATOMIC],
    ['the hint, with the balance unread', { wallet: null }, CHANNEL_DEPOSIT_ATOMIC],
    ['a wallet below the hint, all of it', { quote: 1_000n, wallet: 20_000n }, 20_000n],
    ['a per-call limit below the hint', { quote: 1_000n, perCall: 15_000n }, 15_000n],
    ['ten quoted fees, over a smaller wallet', { quote: 1_000n, wallet: 4_000n }, 10_000n],
    ['ten quoted fees, over a smaller limit', { perCall: 2_000n }, 30_000n],
    ['what the next voucher needs, over the floor', { needed: 60_000n }, 60_000n],
    [
      'a bigger hint, up to the ceiling',
      { hint: 1_000_000n, perCall: 1_000_000n },
      MAX_CHANNEL_DEPOSIT_ATOMIC,
    ],
  ])('signs %s', (_label, o, signed) => {
    expect(size(o)).toBe(signed);
  });
});

describe('UNPAID wallet entries', () => {
  it("pins the constant to the router's announced $0.05 hint (extra.minDeposit 50000)", async () => {
    const scheme = new BatchSettlementEvmScheme('0x0000000000000000000000000000000000000001');
    const requirement = { ...new FakeRouter().requirement, extra: { minDeposit: '50000' } };
    expect(CHANNEL_DEPOSIT_ATOMIC).toBe(BigInt(await scheme.resolveMinDepositHint(requirement)));
  });

  it('is {reason, fix} from WALLET_REASONS, the PERSON fix, for every wallet key', () => {
    for (const [key, entry] of Object.entries(WALLET_REASONS)) {
      expect(unpaid(key), key).toEqual({ reason: entry.reason, fix: entry.fix });
    }
  });

  it('never carries agentFix where the person and model fixes differ', () => {
    for (const [key, entry] of Object.entries(WALLET_REASONS)) {
      if (entry.agentFix === entry.fix) continue;
      expect(unpaid(key)!.fix, key).not.toBe(entry.agentFix);
    }
    expect(unpaid('passphrase_missing')!.fix).not.toBe(ASK_FOR_REPAIR);
  });

  it('keeps a passphrase off the command line and never steers a locked keychain to plaintext (B1, S3)', () => {
    for (const key of ALL_KEYS) {
      const u = unpaid(key)!;
      expect(u.fix, key).not.toContain('TENJIN_WALLET_PASSPHRASE=');
      expect(u.fix, key).not.toContain('--insecure-storage');
      expect(u.fix.startsWith('Ask the person'), key).toBe(false);
      if (u.fix.includes('tenjin wallet repair')) expect(u.fix, key).toContain(REPAIR_CLAUSE);
    }
    expect(unpaid('keychain_locked')!.fix).toBe(KEYCHAIN_LOCKED_FIX);
  });

  it('says nothing for an unlock that ran out of time', () => {
    expect(unpaid('unlock_timeout')).toBeNull();
    expect(unpaidSentence('unlock_timeout')).toBeNull();
  });
});

describe('unpaidSentence', () => {
  it('explains automatic unfunded routing without reopening checkout, while doctor retains its fix', () => {
    expect(unpaidSentence('wallet_low', 'agent')).toContain('could not pay the routing fee');
    expect(unpaidSentence('wallet_low', 'agent')).not.toMatch(
      /wallet fund|send USDC|add funds|checkout/i,
    );
    expect(unpaidSentence('wallet_low')).not.toContain('tenjin wallet fund');
    expect(unpaid('wallet_low')?.fix).toContain('tenjin wallet fund 5');
  });
  // User-visible notices name the reason and its recovery action, and no fee
  // amount: only a quote above the ceiling is named, with the price the payer read.
  const EXPECTED: Record<string, string> = {
    no_wallet:
      'Tenjin could not pay the routing fee (this machine has no wallet), so Tenjin is not routing calls until that is fixed. Run `tenjin doctor`.',
    wallet_low:
      'Tenjin could not pay the routing fee (the wallet holds less than the $0.03 Tenjin needs to set aside for routing), so Tenjin is not routing calls until that is fixed. Your usual tools still work.',
    no_payer:
      'Tenjin could not pay the routing fee (the router charges it, and this session cannot pay it), so Tenjin is not routing calls until that is fixed. Run `tenjin doctor`.',
    payment_failed:
      'Tenjin could not pay the routing fee (the routing payment failed), so Tenjin is not routing calls until that is fixed. Run `tenjin doctor`.',
    limit_below_deposit:
      'Tenjin could not pay the routing fee (the per-call spend limit cannot cover the routing fee or its deposit), so Tenjin is not routing calls until that is fixed. Run `tenjin doctor`.',
    budget_reached:
      'Tenjin could not pay the routing fee (the daily budget has no room left for the routing fee or its deposit), so Tenjin is not routing calls until that is fixed. Run `tenjin doctor`.',
    not_allowlisted:
      'Tenjin could not pay the routing fee (allowlistCreators does not include the router), so Tenjin is not routing calls until that is fixed. Run `tenjin doctor`.',
    fee_above_ceiling:
      'Tenjin could not pay the routing fee (the router asks more per call than this install agreed to pay), so Tenjin is not routing calls until that is fixed. Your usual tools still work.',
  };

  it('keeps actionable reasons, with no funding imperative in automatic fallback', () => {
    for (const [why, sentence] of Object.entries(EXPECTED)) {
      expect(unpaidSentence(why), why).toBe(sentence);
    }
  });

  it('names the balance a low wallet holds and the deposit it fell short of, when read', () => {
    expect(
      unpaidSentence('wallet_low', 'person', { balanceAtomic: 0n, depositAtomic: 10_000n }),
    ).toBe(
      'Tenjin could not pay the routing fee (the wallet holds $0.00, less than the $0.01 Tenjin needs to set aside for routing), so Tenjin is not routing calls until that is fixed. Your usual tools still work.',
    );
  });

  it('says nothing for a deposit the background top-up has not made yet', () => {
    expect(unpaidSentence('topping_up')).toBeNull();
    expect(unpaidSentence('deposit_deferred')).toBeNull();
  });

  it('names the ceiling in the deposit line, the bound every later call keeps', () => {
    expect(depositSentence(CHANNEL_DEPOSIT_ATOMIC)).toBe(
      'Tenjin set aside $0.05 for routing. Each routing call costs at most $0.003. Unused funds remain yours.',
    );
  });

  it('names a repair reason with the clause that keeps the passphrase out of chat', () => {
    expect(unpaidSentence('passphrase_missing')).toBe(
      `Tenjin could not pay the routing fee (${WALLET_REASONS.passphrase_missing.reason}), so Tenjin is not routing calls until that is fixed. ${WALLET_REASONS.passphrase_missing.fix}`,
    );
    expect(unpaidSentence('passphrase_missing')).toContain(REPAIR_CLAUSE);
  });
});
