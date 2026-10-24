import { describe, expect, it } from 'vitest';
import { KEYCHAIN_LOCKED_FIX, REPAIR_CLAUSE } from '../lib/wallet-unlock';
import { unpaid, unpaidSentence } from './fee';
import { ASK_FOR_REPAIR, WALLET_REASONS } from './wallet-reasons';

/** Every key the routing payer can skip with, and the free path's own. */
const ALL_KEYS = [
  ...Object.keys(WALLET_REASONS),
  'wallet_low',
  'limit_below_deposit',
  'budget_reached',
  'not_allowlisted',
  'payment_failed',
  'fee_required',
];

describe('UNPAID wallet entries', () => {
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
  // Captured from d44fcf58, before the wallet reasons changed: these must not move (S5).
  const BEFORE: Record<string, string> = {
    no_wallet:
      'Tenjin routing could not pay its $0.003 fee (this machine has no wallet), so Tenjin is not routing calls until that is fixed. Run `tenjin doctor`.',
    wallet_low:
      'Tenjin routing could not pay its $0.003 fee (the wallet holds less than the $0.25 routing deposit), so Tenjin is not routing calls until that is fixed. Fund it with `tenjin wallet fund 5`.',
    fee_required:
      'Tenjin routing could not pay its $0.003 fee (the router now charges it, and this session cannot pay it), so Tenjin is not routing calls until that is fixed. Run `tenjin doctor`.',
    payment_failed:
      'Tenjin routing could not pay its $0.003 fee (the routing payment failed), so Tenjin is not routing calls until that is fixed. Run `tenjin doctor`.',
    limit_below_deposit:
      'Tenjin routing could not pay its $0.003 fee (the per-call spend limit is below the $0.25 routing deposit), so Tenjin is not routing calls until that is fixed. Run `tenjin doctor`.',
    budget_reached:
      'Tenjin routing could not pay its $0.003 fee (the daily spend limit has no room left for the routing fee or its deposit), so Tenjin is not routing calls until that is fixed. Run `tenjin doctor`.',
    not_allowlisted:
      'Tenjin routing could not pay its $0.003 fee (allowlistCreators does not include the router), so Tenjin is not routing calls until that is fixed. Run `tenjin doctor`.',
  };

  it('matches the pre-change strings byte for byte', () => {
    for (const [why, sentence] of Object.entries(BEFORE)) {
      expect(unpaidSentence(why), why).toBe(sentence);
    }
  });

  it('names a repair reason with the clause that keeps the passphrase out of chat', () => {
    expect(unpaidSentence('passphrase_missing')).toBe(
      `Tenjin routing could not pay its $0.003 fee (${WALLET_REASONS.passphrase_missing.reason}), so Tenjin is not routing calls until that is fixed. ${WALLET_REASONS.passphrase_missing.fix}`,
    );
    expect(unpaidSentence('passphrase_missing')).toContain(REPAIR_CLAUSE);
  });
});
