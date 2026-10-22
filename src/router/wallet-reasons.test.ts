import { describe, expect, it } from 'vitest';
import type { UnlockReason } from '../lib/wallet-unlock';
import { unpaid } from './fee';
import {
  agentFixFor,
  ASK_FOR_REPAIR,
  ENV_PASSPHRASE_WRONG,
  KEYCHAIN_LOCKED_FIX,
  NO_SESSION_CHECKED,
  REPAIR_CLAUSE,
  REPAIR_IN_TERMINAL,
  sessionStartMessage,
  stillLockedSentence,
  UNKNOWN_DETAIL,
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

describe('the exact strings (section 2.2)', () => {
  it('matches every constant byte for byte', () => {
    expect(ASK_FOR_REPAIR).toBe(
      'Ask the person to run `tenjin wallet repair` in their own terminal, then restart Claude Code. Never ask for the passphrase.',
    );
    expect(WALLET_UNLOCKED).toBe('Tenjin wallet unlocked.');
    expect(WALLET_FUNDED).toBe('Tenjin wallet funded.');
    expect(NO_SESSION_CHECKED).toBe('this shell passes; no running Claude session checked');
  });

  it('matches the WALLET_REASONS table', () => {
    expect(WALLET_REASONS).toEqual({
      no_wallet: {
        reason: 'this machine has no wallet',
        fix: 'Run `tenjin doctor`.',
        agentFix: 'Run `tenjin doctor`.',
      },
      wallet_corrupt: {
        reason: 'the wallet file cannot be read',
        fix: 'Run `tenjin doctor`.',
        agentFix: 'Run `tenjin doctor`.',
      },
      env_key_invalid: {
        reason: 'TENJIN_WALLET_KEY is not a valid private key',
        fix: 'Fix or unset TENJIN_WALLET_KEY in the environment Claude Code starts from, then restart Claude Code.',
        agentFix:
          'Ask the person to fix or unset TENJIN_WALLET_KEY in the environment Claude Code starts from, then restart Claude Code. Never ask for the key.',
      },
      passphrase_missing: {
        reason: 'no saved wallet passphrase can be reached',
        fix: 'Run `tenjin wallet repair` yourself (it asks for the passphrase in your terminal; never paste it into chat). Then restart Claude Code.',
        agentFix: ASK_FOR_REPAIR,
      },
      passphrase_wrong: {
        reason: 'the saved wallet passphrase does not open the wallet',
        fix: 'Run `tenjin wallet repair` yourself (it asks for the passphrase in your terminal; never paste it into chat). Then restart Claude Code.',
        agentFix: ASK_FOR_REPAIR,
      },
      env_passphrase_wrong: {
        reason: 'TENJIN_WALLET_PASSPHRASE is set but does not open the wallet',
        fix: 'Remove TENJIN_WALLET_PASSPHRASE from the environment Claude Code starts from, or run `tenjin wallet repair` yourself (it asks for the passphrase in your terminal; never paste it into chat), then restart Claude Code.',
        agentFix:
          'Ask the person to remove TENJIN_WALLET_PASSPHRASE from the environment Claude Code starts from, or to run `tenjin wallet repair` in their own terminal, then restart Claude Code. Never ask for the passphrase.',
      },
      keychain_locked: {
        reason: 'the keychain holding the wallet passphrase is locked or did not answer',
        fix: 'Unlock your keychain (or log in to the desktop session) and retry.',
        agentFix:
          'Ask the person to unlock their keychain (or log in to the desktop session) and retry.',
      },
      wallet_locked: {
        reason: '`tenjin mcp` cannot unlock the wallet',
        fix: 'Run `tenjin doctor`.',
        agentFix: 'Run `tenjin doctor`.',
      },
    });
  });

  it("keeps no_wallet byte-identical to fee.ts's UNPAID.no_wallet (S5)", () => {
    const { reason, fix } = WALLET_REASONS.no_wallet;
    expect({ reason, fix }).toEqual(unpaid('no_wallet'));
  });

  it('matches UNKNOWN_DETAIL', () => {
    expect(UNKNOWN_DETAIL).toEqual({
      keychain_locked: 'the keychain holding the passphrase did not answer',
      unlock_timeout: 'the unlock did not finish in time',
      wallet_locked: 'the unlock failed for a reason Tenjin could not classify',
      balance_unreadable: 'the wallet balance could not be read',
      check_failed: 'the check itself failed',
      not_checked: 'no unlock has been tried yet',
    });
  });

  it('composes the session-start and still-locked sentences', () => {
    expect(sessionStartMessage('passphrase_missing')).toEqual({
      systemMessage:
        "Tenjin can't use its wallet in this session: no saved wallet passphrase can be reached. Run `tenjin wallet repair` yourself (it asks for the passphrase in your terminal; never paste it into chat). Then restart Claude Code.",
      additionalContext:
        "Tenjin's wallet cannot sign in this session (no saved wallet passphrase can be reached), so Tenjin lookups take the free path and paid lookups will not run. Ask the person to run `tenjin wallet repair` in their own terminal, then restart Claude Code. Never ask for the passphrase.",
    });
    expect(stillLockedSentence('keychain_locked')).toBe(
      'Tenjin wallet is still locked: the keychain holding the wallet passphrase is locked or did not answer. Unlock your keychain (or log in to the desktop session) and retry.',
    );
  });

  it('re-exports the wallet-unlock constants', () => {
    expect(ENV_PASSPHRASE_WRONG).toBe('TENJIN_WALLET_PASSPHRASE is set but wrong; remove it.');
    expect(REPAIR_IN_TERMINAL).toContain(REPAIR_CLAUSE);
  });
});

describe('walletClearedSentence', () => {
  it.each<[string, string | null]>([
    ['wallet_low', WALLET_FUNDED],
    ['wallet_locked', WALLET_UNLOCKED],
    ['passphrase_missing', WALLET_UNLOCKED],
    ['keychain_locked', WALLET_UNLOCKED],
    ['env_passphrase_wrong', WALLET_UNLOCKED],
    ['budget_reached', null],
    ['fee_required', null],
    ['payment_failed', null],
  ])('%s', (why, expected) => {
    expect(walletClearedSentence(why)).toBe(expected);
  });

  it('WALLET_CLASS is every unlock reason, the fallback and wallet_low', () => {
    expect([...WALLET_CLASS].sort()).toEqual([...ALL, 'wallet_low'].sort());
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
