import { describe, expect, it } from 'vitest';
import { CliError } from '../lib/errors';
import { unlockDetails, type UnlockReason } from '../lib/wallet-unlock';
import {
  agentFixFor,
  agentFixOf,
  ASK_FOR_REPAIR,
  ENV_PASSPHRASE_WRONG,
  KEYCHAIN_LOCKED_FIX,
  REPAIR_CLAUSE,
  REPAIR_IN_TERMINAL,
  sessionStartMessage,
  stillLockedSentence,
  WALLET_CLASS,
  WALLET_FUNDED,
  WALLET_REASONS,
  WALLET_UNLOCKED,
  walletClearedSentence,
} from './wallet-reasons';

const ALL: Array<UnlockReason | 'wallet_locked'> = [
  'no_wallet',
  'wallet_corrupt',
  'env_key_invalid',
  'passphrase_missing',
  'passphrase_wrong',
  'env_passphrase_wrong',
  'keychain_locked',
  'unlock_timeout',
  'wallet_locked',
];

const REPAIR = '`tenjin wallet repair`';

describe('walletClearedSentence', () => {
  it.each<[string, string | null]>([
    ['wallet_low', WALLET_FUNDED],
    ['wallet_locked', WALLET_UNLOCKED],
    ['passphrase_missing', WALLET_UNLOCKED],
    ['keychain_locked', WALLET_UNLOCKED],
    ['env_passphrase_wrong', WALLET_UNLOCKED],
    ['budget_reached', null],
    ['no_payer', null],
    ['payment_failed', null],
  ])('%s', (why, expected) => {
    expect(walletClearedSentence(why)).toBe(expected);
  });

  it('WALLET_CLASS is every unlock reason, the fallback and wallet_low', () => {
    expect([...WALLET_CLASS].sort()).toEqual([...ALL, 'wallet_low'].sort());
  });
});

describe('agentFixOf', () => {
  it("swaps a wallet error's person fix for its agentFix, and keeps every other fix", () => {
    const missing = new CliError('USAGE', 'No wallet passphrase is available.', {
      fix: REPAIR_IN_TERMINAL,
      details: unlockDetails('passphrase_missing'),
    });
    expect(agentFixOf(missing)).toBe(ASK_FOR_REPAIR);
    expect(agentFixOf(missing)).not.toContain(REPAIR_CLAUSE);
    const other = new CliError('API_UNREACHABLE', 'x answered 500.', { fix: 'Nothing was paid.' });
    expect(agentFixOf(other)).toBe('Nothing was paid.');
    expect(agentFixOf(new CliError('API_UNREACHABLE', 'x'))).toBe('');
  });
});

describe('agentFixFor', () => {
  it('returns the agentFix for a wallet reason, the fallback otherwise', () => {
    expect(agentFixFor('passphrase_wrong', 'own')).toBe(ASK_FOR_REPAIR);
    expect(agentFixFor('budget_reached', 'own fix')).toBe('own fix');
    expect(agentFixFor('toString', 'own fix')).toBe('own fix');
  });
});

describe('the B1 / S3 sweep over every exported string', () => {
  const person: string[] = [REPAIR_IN_TERMINAL, KEYCHAIN_LOCKED_FIX, ENV_PASSPHRASE_WRONG];
  const agent: string[] = [ASK_FOR_REPAIR];
  for (const r of Object.values(WALLET_REASONS)) {
    person.push(r.reason, r.fix);
    agent.push(r.agentFix);
  }
  for (const reason of ALL) {
    const m = sessionStartMessage(reason);
    person.push(m.systemMessage, stillLockedSentence(reason));
    agent.push(m.additionalContext);
  }

  it('no string carries an inline passphrase or plaintext storage', () => {
    for (const s of [...person, ...agent]) {
      expect(s).not.toContain('TENJIN_WALLET_PASSPHRASE=');
      expect(s).not.toContain('--insecure-storage');
    }
  });

  it('every model-facing string that names repair asks the person and never for the passphrase', () => {
    for (const s of agent.filter((a) => a.includes(REPAIR))) {
      // A composed one has a leading sentence first: check the sentence that names repair.
      const sentence = s.slice(s.lastIndexOf('. ', s.indexOf(REPAIR)) + 2);
      expect(s.startsWith('Ask the person') || sentence.startsWith('Ask the person')).toBe(true);
      expect(s).toContain('Never ask for the passphrase');
      expect(s).not.toContain(REPAIR_CLAUSE);
    }
  });

  it('every person-facing string that names repair carries REPAIR_CLAUSE exactly', () => {
    const naming = person.filter((p) => p.includes(REPAIR));
    expect(naming.length).toBeGreaterThan(0);
    for (const s of naming) expect(s).toContain(REPAIR_CLAUSE);
  });

  it('the keychain_locked fix is KEYCHAIN_LOCKED_FIX', () => {
    expect(WALLET_REASONS.keychain_locked.fix).toBe(KEYCHAIN_LOCKED_FIX);
  });

  it.each(ALL)(
    '%s: systemMessage and still-locked use fix, additionalContext agentFix',
    (reason) => {
      const r = reason === 'unlock_timeout' ? WALLET_REASONS.wallet_locked : WALLET_REASONS[reason];
      const m = sessionStartMessage(reason);
      expect(m.systemMessage.endsWith(r.fix)).toBe(true);
      expect(m.additionalContext.endsWith(r.agentFix)).toBe(true);
      expect(stillLockedSentence(reason).endsWith(r.fix)).toBe(true);
      if (r.agentFix !== r.fix) {
        expect(m.systemMessage).not.toContain(r.agentFix);
        expect(stillLockedSentence(reason)).not.toContain(r.agentFix);
      }
    },
  );
});
