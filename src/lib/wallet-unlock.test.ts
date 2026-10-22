import { describe, expect, it } from 'vitest';
import { CliError } from './errors';
import {
  classifyUnlockError,
  DEFINITE_UNLOCK,
  ENV_PASSPHRASE_WRONG,
  FILE_STORE_FAILED_FIX,
  KEYCHAIN_LOCKED_FIX,
  KEYCHAIN_WAIT_LINE,
  NO_KEYRING_LINE,
  PRIVATE_KEY_RE,
  REPAIR_CLAUSE,
  REPAIR_IN_TERMINAL,
  unlockDetails,
  unlockReasonOf,
  type UnlockReason,
} from './wallet-unlock';

const REASONS: UnlockReason[] = [
  'no_wallet',
  'wallet_corrupt',
  'env_key_invalid',
  'passphrase_missing',
  'passphrase_wrong',
  'env_passphrase_wrong',
  'keychain_locked',
  'unlock_timeout',
];

function named(name: string): Error {
  const err = new Error('stopped');
  err.name = name;
  return err;
}

describe('the exact strings', () => {
  it('matches section 2.2 byte for byte', () => {
    expect(ENV_PASSPHRASE_WRONG).toBe('TENJIN_WALLET_PASSPHRASE is set but wrong; remove it.');
    expect(REPAIR_CLAUSE).toBe(
      '(it asks for the passphrase in your terminal; never paste it into chat)',
    );
    expect(REPAIR_IN_TERMINAL).toBe(
      'Run `tenjin wallet repair` yourself (it asks for the passphrase in your terminal; never paste it into chat).',
    );
    expect(REPAIR_IN_TERMINAL).toContain(REPAIR_CLAUSE);
    expect(KEYCHAIN_LOCKED_FIX).toBe(
      'Unlock your keychain (or log in to the desktop session) and retry.',
    );
    expect(FILE_STORE_FAILED_FIX('/home/u/.tenjin/passphrase.0xab.plain')).toBe(
      'Tenjin could not save the passphrase to /home/u/.tenjin/passphrase.0xab.plain; check that /home/u/.tenjin is writable.',
    );
    expect(FILE_STORE_FAILED_FIX('~/.tenjin/passphrase.0xab.plain')).toContain(
      'check that ~/.tenjin is writable.',
    );
    expect(FILE_STORE_FAILED_FIX('/srv/tenjin/passphrase.0xab.plain')).toContain(
      'check that /srv/tenjin is writable.',
    );
    expect(NO_KEYRING_LINE('/p')).toBe(
      'No keyring reachable from this session; passphrase saved to /p (readable only by you).',
    );
    expect(KEYCHAIN_WAIT_LINE).toBe('Waiting for the keychain…');
  });

  it('never suggests an inline passphrase or plaintext storage (B1, S3)', () => {
    for (const s of [
      ENV_PASSPHRASE_WRONG,
      REPAIR_IN_TERMINAL,
      KEYCHAIN_LOCKED_FIX,
      FILE_STORE_FAILED_FIX('/p'),
      NO_KEYRING_LINE('/p'),
    ]) {
      expect(s).not.toContain('TENJIN_WALLET_PASSPHRASE=');
      expect(s).not.toContain('--insecure-storage');
    }
  });
});

describe('DEFINITE_UNLOCK', () => {
  it('holds every reason but the two that say nothing about the wallet', () => {
    expect([...DEFINITE_UNLOCK].sort()).toEqual(
      REASONS.filter((r) => r !== 'keychain_locked' && r !== 'unlock_timeout').sort(),
    );
  });
});

describe('PRIVATE_KEY_RE', () => {
  it("is store.ts's expression, case-insensitive (S12)", () => {
    expect(PRIVATE_KEY_RE.source).toBe('^0x[0-9a-f]{64}$');
    expect(PRIVATE_KEY_RE.flags).toBe('i');
    expect(PRIVATE_KEY_RE.test(`0x${'aB'.repeat(32)}`)).toBe(true);
    expect(PRIVATE_KEY_RE.test(`0x${'a'.repeat(63)}`)).toBe(false);
  });
});

describe('classifyUnlockError', () => {
  it.each(REASONS)('reads details.unlock %s', (reason) => {
    const err = new CliError('WALLET_INVALID_KEY', 'nope', {
      details: unlockDetails(reason, 'keychain'),
    });
    expect(classifyUnlockError(err)).toEqual({
      reason,
      definite: DEFINITE_UNLOCK.has(reason),
      source: 'keychain',
    });
  });

  it.each<[string, unknown, { reason: string; definite: boolean }]>([
    [
      'an undetailed WALLET_MISSING',
      new CliError('WALLET_MISSING', 'none'),
      { reason: 'no_wallet', definite: true },
    ],
    ['an AbortError', named('AbortError'), { reason: 'unlock_timeout', definite: false }],
    ['a TimeoutError', named('TimeoutError'), { reason: 'unlock_timeout', definite: false }],
    [
      'a DOMException timeout',
      new DOMException('t', 'TimeoutError'),
      { reason: 'unlock_timeout', definite: false },
    ],
    [
      'an undetailed WALLET_INVALID_KEY',
      new CliError('WALLET_INVALID_KEY', 'TENJIN_WALLET_PASSPHRASE is set but does not decrypt it'),
      { reason: 'wallet_locked', definite: false },
    ],
    ['a plain Error', new Error('passphrase_wrong'), { reason: 'wallet_locked', definite: false }],
    ['a non-Error', 'no_wallet', { reason: 'wallet_locked', definite: false }],
    ['null', null, { reason: 'wallet_locked', definite: false }],
    [
      'an unknown details.unlock reason',
      new CliError('INTERNAL', 'x', { details: { unlock: { reason: 'gremlins' } } }),
      { reason: 'wallet_locked', definite: false },
    ],
  ])('%s', (_label, err, expected) => {
    expect(classifyUnlockError(err)).toEqual(expected);
  });

  it('omits the source when details.unlock has none', () => {
    const err = new CliError('INTERNAL', 'x', { details: unlockDetails('passphrase_missing') });
    expect(classifyUnlockError(err)).toEqual({ reason: 'passphrase_missing', definite: true });
  });
});

describe('unlockReasonOf', () => {
  it.each(REASONS)('returns %s from a CliError carrying it', (reason) => {
    expect(unlockReasonOf(new CliError('REFUSED', 'x', { details: unlockDetails(reason) }))).toBe(
      reason,
    );
  });

  it.each<[string, unknown]>([
    ['an undetailed WALLET_MISSING', new CliError('WALLET_MISSING', 'none')],
    [
      'an undetailed REGISTRY_MISMATCH',
      new CliError('REGISTRY_MISMATCH', 'mismatch', { fix: 'own fix' }),
    ],
    [
      'an unknown details.unlock reason',
      new CliError('INTERNAL', 'x', { details: { unlock: { reason: 'gremlins' } } }),
    ],
    [
      'a details.unlock with an unknown source',
      new CliError('INTERNAL', 'x', {
        details: { unlock: { reason: 'no_wallet', source: 'cloud' } },
      }),
    ],
    ['an AbortError', named('AbortError')],
    ['a plain Error', new Error('x')],
    ['a non-Error', { details: { unlock: { reason: 'no_wallet' } } }],
  ])('is null for %s', (_label, err) => {
    expect(unlockReasonOf(err)).toBeNull();
  });
});
