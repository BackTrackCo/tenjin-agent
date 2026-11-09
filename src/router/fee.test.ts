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
import { WALLET_REASONS } from './wallet-reasons';

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
  const size = (o: {
    suggested?: bigint;
    needed?: bigint;
    balance?: bigint | null;
    perCall?: bigint;
  }) =>
    routingDepositAtomic({
      suggestedAtomic: o.suggested ?? 50_000n,
      neededAtomic: o.needed ?? 600n,
      balanceAtomic: o.balance === undefined ? 1_000_000n : o.balance,
      perCallAtomic: o.perCall ?? 250_000n,
      maxAtomic: MAX_CHANNEL_DEPOSIT_ATOMIC,
    });
  it.each<[string, Parameters<typeof size>[0], bigint]>([
    ['a funded wallet keeps the SDK buffer', {}, 50_000n],
    ['ten cents uses the normal buffer', { balance: 100_000n }, 50_000n],
    ['one unit below ten cents uses one cent', { balance: 99_999n }, 10_000n],
    [
      'six cents still uses one cent even though the normal buffer fits',
      { balance: 60_000n },
      10_000n,
    ],
    ['the exact small boundary preserves one cent', { balance: 20_000n }, 10_000n],
    ['one unit below two cents shrinks the target', { balance: 19_999n }, 9_999n],
    ['one and a half cents deposits half a cent', { balance: 15_000n }, 5_000n],
    ['the exact voucher deficit fits above the reserve', { balance: 10_600n }, 600n],
    ['one unit below the voucher deficit refuses', { balance: 10_599n }, 0n],
    ['the reserve alone leaves no deposit', { balance: 10_000n }, 0n],
    ['a wallet below one cent skips the top-up', { balance: 9_999n }, 0n],
    [
      'a larger voucher deficit still fits above the reserve',
      { needed: 30_000n, balance: 40_000n },
      30_000n,
    ],
    [
      'a smaller SDK target stays smaller',
      { suggested: 5_000n, needed: 1_000n, balance: 15_000n },
      5_000n,
    ],
    ['a per-call bound reduces the buffer', { perCall: 15_000n }, 15_000n],
    ['an oversized hint still meets the deposit ceiling', { suggested: 1_000_000n }, 250_000n],
  ])('%s', (_label, o, amount) => {
    expect(size(o)).toBe(amount);
  });
});

describe('UNPAID wallet entries', () => {
  it("pins the constant to the router's announced $0.05 hint (extra.minDeposit 50000)", async () => {
    const scheme = new BatchSettlementEvmScheme('0x0000000000000000000000000000000000000001');
    const requirement = { ...new FakeRouter().requirement, extra: { minDeposit: '50000' } };
    expect(CHANNEL_DEPOSIT_ATOMIC).toBe(BigInt(await scheme.resolveMinDepositHint(requirement)));
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
      /wallet fund|send USDC|add funds|checkout|USDC|RPC|channel|facilitator/i,
    );
    expect(unpaidSentence('wallet_low')).not.toContain('tenjin fund');
    expect(unpaid('wallet_low')?.fix).toContain('tenjin fund 5');
  });

  // A spend limit is never a funding problem: money cannot help, so neither
  // reader is pointed at checkout. The agent gets the setting to raise; the
  // person, who reads it in chat, is told to ask their agent.
  it.each(['budget_reached', 'limit_below_deposit'])(
    '%s says the balance is fine and how to raise the limit, never checkout',
    (why) => {
      for (const reader of ['person', 'agent'] as const) {
        const sentence = unpaidSentence(why, reader) ?? '';
        expect(sentence).not.toMatch(/tenjin fund|wallet fund|checkout/i);
        expect(sentence).toContain('Your balance is fine');
      }
      expect(unpaidSentence(why, 'agent')).toContain('`tenjin config set ');
      expect(unpaidSentence(why, 'person')).toMatch(/ask your agent to raise it/i);
      expect(unpaidSentence(why, 'person')).not.toContain('tenjin config');
    },
  );
  // User-visible notices name the reason and its recovery action, and no fee
  // amount: only a quote above the ceiling is named, with the price the payer read.
  const EXPECTED: Record<string, string> = {
    no_wallet:
      'Tenjin could not pay the routing fee (this machine has no wallet), so Tenjin is not routing calls until that is fixed. Run `tenjin doctor`.',
    wallet_low:
      'Tenjin could not pay the routing fee (the wallet holds less than the deposit Tenjin sets aside for routing), so Tenjin is not routing calls until that is fixed. Your usual tools still work.',
    no_payer:
      'Tenjin could not pay the routing fee (the router charges it, and this session cannot pay it), so Tenjin is not routing calls until that is fixed. Run `tenjin doctor`.',
    payment_failed:
      'Tenjin could not pay the routing fee (the routing payment failed), so Tenjin is not routing calls until that is fixed. Run `tenjin doctor`.',
    limit_below_deposit:
      'Tenjin could not pay the routing fee (the per-call spend limit cannot cover the routing fee or its deposit), so Tenjin is not routing calls until that is fixed. Your balance is fine; this is the per-call limit. Ask your agent to raise it.',
    budget_reached:
      "Tenjin could not pay the routing fee (today's spend limit is used up), so Tenjin is not routing calls until that is fixed. Your balance is fine, and adding funds would not help. The limit frees up as the 24 hours pass, or ask your agent to raise it.",
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

  it('names the ceiling in the deposit line, the bound every later call keeps', () => {
    expect(depositSentence(CHANNEL_DEPOSIT_ATOMIC)).toBe(
      'Tenjin set aside $0.05 for routing. Each routing call costs at most $0.003.',
    );
  });

  it('names a repair reason with the clause that keeps the passphrase out of chat', () => {
    expect(unpaidSentence('passphrase_missing')).toBe(
      `Tenjin could not pay the routing fee (${WALLET_REASONS.passphrase_missing.reason}), so Tenjin is not routing calls until that is fixed. ${WALLET_REASONS.passphrase_missing.fix}`,
    );
    expect(unpaidSentence('passphrase_missing')).toContain(REPAIR_CLAUSE);
  });
});
