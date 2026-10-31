import { describe, expect, it } from 'vitest';
import type { PolicyReason } from '../lib/policy';
import { DEFINITE_UNLOCK, ENV_PASSPHRASE_WRONG, type UnlockReason } from '../lib/wallet-unlock';
import {
  canPayProvider,
  canPayRouting,
  canSign,
  isDefiniteBlock,
  signFromVerification,
  type ProviderFacts,
  type RoutingFacts,
  type SignFacts,
  type SignVerdict,
} from './eligibility';
import {
  CHANNEL_DEPOSIT_ATOMIC,
  DEPOSIT_FLOOR_FEES,
  ROUTING_FEE_CEILING_ATOMIC,
  unpaid,
} from './fee';
import { UNKNOWN_DETAIL, WALLET_REASONS } from './wallet-reasons';

const READY: SignVerdict = { status: 'ready', source: 'keychain' };
const UNKNOWN: SignVerdict = {
  status: 'unknown',
  reason: 'keychain_locked',
  detail: UNKNOWN_DETAIL['keychain_locked']!,
};
const BLOCKED: SignVerdict = {
  status: 'blocked',
  reason: 'passphrase_wrong',
  detail: WALLET_REASONS.passphrase_wrong.reason,
  fix: WALLET_REASONS.passphrase_wrong.fix,
};

function blockedFor(reason: Exclude<UnlockReason, 'keychain_locked' | 'unlock_timeout'>) {
  return {
    status: 'blocked',
    reason,
    detail: WALLET_REASONS[reason].reason,
    fix: WALLET_REASONS[reason].fix,
  };
}

const PRESENT: SignFacts = { envKey: 'absent', walletFile: 'present' };

describe('canSign (section 2.4)', () => {
  it.each<[string, SignFacts, unknown]>([
    [
      '1. a valid env key is ready',
      { envKey: 'valid', walletFile: 'unparsable' },
      { status: 'ready', source: 'key-env' },
    ],
    [
      '2. a malformed env key is blocked',
      { envKey: 'malformed', walletFile: 'present' },
      blockedFor('env_key_invalid'),
    ],
    [
      '3. no wallet file is blocked',
      { envKey: 'absent', walletFile: 'absent' },
      blockedFor('no_wallet'),
    ],
    [
      '4. an unparsable wallet is blocked',
      { envKey: 'absent', walletFile: 'unparsable' },
      blockedFor('wallet_corrupt'),
    ],
    [
      '5. an unlock that worked is ready',
      { ...PRESENT, unlock: { ok: true, source: 'file', warning: ENV_PASSPHRASE_WRONG } },
      { status: 'ready', source: 'file', warning: ENV_PASSPHRASE_WRONG },
    ],
    [
      '6. passphrase_missing with the variable set is unknown (S13)',
      { ...PRESENT, envPassphraseSet: true, unlock: { ok: false, reason: 'passphrase_missing' } },
      { status: 'unknown', reason: 'not_checked', detail: UNKNOWN_DETAIL['not_checked'] },
    ],
    [
      '6. a definite unlock failure is blocked',
      { ...PRESENT, unlock: { ok: false, reason: 'passphrase_wrong' } },
      blockedFor('passphrase_wrong'),
    ],
    [
      '6. a definite unlock failure keeps a given fix',
      { ...PRESENT, unlock: { ok: false, reason: 'env_passphrase_wrong', fix: 'custom' } },
      { ...blockedFor('env_passphrase_wrong'), fix: 'custom' },
    ],
    [
      '6. a locked keychain is unknown',
      { ...PRESENT, unlock: { ok: false, reason: 'keychain_locked' } },
      { status: 'unknown', reason: 'keychain_locked', detail: UNKNOWN_DETAIL['keychain_locked'] },
    ],
    [
      '6. a timeout is unknown',
      { ...PRESENT, unlock: { ok: false, reason: 'unlock_timeout' } },
      { status: 'unknown', reason: 'unlock_timeout', detail: UNKNOWN_DETAIL['unlock_timeout'] },
    ],
    [
      '6. the unclassified fallback is unknown',
      { ...PRESENT, unlock: { ok: false, reason: 'wallet_locked', detail: 'x' } },
      { status: 'unknown', reason: 'wallet_locked', detail: UNKNOWN_DETAIL['wallet_locked'] },
    ],
    [
      '7. a missing passphrase file without the variable is blocked',
      { ...PRESENT, passphraseFileMissing: true },
      blockedFor('passphrase_missing'),
    ],
    [
      '7/8. a missing passphrase file WITH the variable is unknown (S13)',
      { ...PRESENT, passphraseFileMissing: true, envPassphraseSet: true },
      { status: 'unknown', reason: 'not_checked', detail: UNKNOWN_DETAIL['not_checked'] },
    ],
    [
      '8. nothing tried yet is unknown',
      PRESENT,
      { status: 'unknown', reason: 'not_checked', detail: UNKNOWN_DETAIL['not_checked'] },
    ],
  ])('%s', (_label, facts, expected) => {
    expect(canSign(facts)).toEqual(expected);
  });

  it('S13: the variable set with a verified unlock is ready', () => {
    expect(
      canSign({
        ...PRESENT,
        envPassphraseSet: true,
        unlock: { ok: true, source: 'passphrase-env' },
      }),
    ).toEqual({ status: 'ready', source: 'passphrase-env' });
  });
});

/** The smallest deposit the payer signs with no quote to go on: ten fees at the ceiling. */
const FLOOR = DEPOSIT_FLOOR_FEES * ROUTING_FEE_CEILING_ATOMIC;

const ROUTING: RoutingFacts = {
  feeRefusal: null,
  sign: READY,
  creditAtomic: null,
  depositRefusal: null,
  balanceAtomic: CHANNEL_DEPOSIT_ATOMIC,
};

function money(reason: string) {
  const u = unpaid(reason)!;
  return { status: 'blocked', reason, detail: u.reason, fix: u.fix };
}

describe('canPayRouting (section 2.4)', () => {
  it.each<[string, Partial<RoutingFacts>, unknown]>([
    ['1. a fee refusal is blocked', { feeRefusal: 'not_allowlisted' }, money('not_allowlisted')],
    [
      '1. a fee refusal comes before a sign block',
      { feeRefusal: 'limit_below_deposit', sign: BLOCKED },
      money('limit_below_deposit'),
    ],
    ['2. a sign block is that block', { sign: BLOCKED }, BLOCKED],
    [
      '3. credit with sign ready is ready',
      { creditAtomic: ROUTING_FEE_CEILING_ATOMIC, balanceAtomic: 0n },
      READY,
    ],
    [
      '3. credit with sign unknown is unknown',
      { creditAtomic: ROUTING_FEE_CEILING_ATOMIC, sign: UNKNOWN, balanceAtomic: 0n },
      UNKNOWN,
    ],
    [
      '3. credit skips a deposit refusal',
      { creditAtomic: ROUTING_FEE_CEILING_ATOMIC, depositRefusal: 'budget_reached' },
      READY,
    ],
    [
      '4. a deposit refusal is blocked',
      { depositRefusal: 'budget_reached' },
      money('budget_reached'),
    ],
    [
      '5. a balance below the deposit floor is wallet_low',
      { balanceAtomic: FLOOR - 1n },
      money('wallet_low'),
    ],
    // The payer deposits all of a wallet between the floor and the hint.
    ['5. a balance at the floor is ready', { balanceAtomic: FLOOR }, READY],
    ['5. a balance under the hint is ready', { balanceAtomic: CHANNEL_DEPOSIT_ATOMIC - 1n }, READY],
    ['6. sign unknown is unknown', { sign: UNKNOWN }, UNKNOWN],
    [
      '7. an unreadable balance is unknown',
      { balanceAtomic: null },
      {
        status: 'unknown',
        reason: 'balance_unreadable',
        detail: UNKNOWN_DETAIL['balance_unreadable'],
      },
    ],
    ['8. otherwise ready', {}, READY],
  ])('%s', (_label, over, expected) => {
    expect(canPayRouting({ ...ROUTING, ...over })).toEqual(expected);
  });

  it('credit covering the fee at a $0 balance with sign ready is ready (checklist item 8)', () => {
    expect(
      canPayRouting({
        ...ROUTING,
        creditAtomic: ROUTING_FEE_CEILING_ATOMIC * 10n,
        balanceAtomic: 0n,
      }),
    ).toMatchObject({ status: 'ready' });
  });

  it('sign unknown, balance below the deposit and no credit is blocked wallet_low', () => {
    expect(
      canPayRouting({ ...ROUTING, sign: UNKNOWN, creditAtomic: null, balanceAtomic: 1n }),
    ).toEqual(money('wallet_low'));
  });

  it("wallet_low and fee refusals carry unpaid()'s text byte for byte (S5)", () => {
    for (const reason of [
      'wallet_low',
      'limit_below_deposit',
      'budget_reached',
      'not_allowlisted',
    ]) {
      const v = canPayRouting({ ...ROUTING, feeRefusal: reason });
      expect(v.status).toBe('blocked');
      if (v.status !== 'blocked') continue;
      expect({ reason: v.detail, fix: v.fix }).toEqual(unpaid(reason));
    }
  });
});

const PROVIDER: ProviderFacts = {
  policy: { decision: 'allow' },
  sign: READY,
  balanceAtomic: 1_000n,
};

describe('canPayProvider (section 2.4)', () => {
  it.each<[string, Partial<ProviderFacts>, unknown]>([
    [
      '1. a policy refusal is needs_approval, keeping the reason',
      { policy: { decision: 'refuse', reason: 'above_auto_spend' as PolicyReason }, sign: BLOCKED },
      {
        status: 'blocked',
        reason: 'needs_approval',
        detail: '',
        fix: '',
        policyReason: 'above_auto_spend',
      },
    ],
    ['2. a sign block is that block', { sign: BLOCKED, balanceAtomic: 0n }, BLOCKED],
    [
      '3. a balance below the price is wallet_short',
      { balanceAtomic: 99n },
      { status: 'blocked', reason: 'wallet_short', detail: '', fix: '' },
    ],
    [
      '3. sign unknown with balance below the price is wallet_short',
      { sign: UNKNOWN, balanceAtomic: 99n },
      { status: 'blocked', reason: 'wallet_short', detail: '', fix: '' },
    ],
    ['4. sign unknown is unknown', { sign: UNKNOWN }, UNKNOWN],
    [
      '4. sign unknown with balance null is unknown',
      { sign: UNKNOWN, balanceAtomic: null },
      UNKNOWN,
    ],
    [
      '5. an unreadable balance is unknown',
      { balanceAtomic: null },
      {
        status: 'unknown',
        reason: 'balance_unreadable',
        detail: UNKNOWN_DETAIL['balance_unreadable'],
      },
    ],
    ['6. otherwise ready', {}, READY],
  ])('%s', (_label, over, expected) => {
    expect(canPayProvider({ ...PROVIDER, ...over }, 100n)).toEqual(expected);
  });
});

describe('signFromVerification', () => {
  it('verified with a source and warning is ready', () => {
    expect(
      signFromVerification({
        status: 'verified',
        detail: 'd',
        source: 'file',
        warning: ENV_PASSPHRASE_WRONG,
      }),
    ).toEqual({ status: 'ready', source: 'file', warning: ENV_PASSPHRASE_WRONG });
    expect(signFromVerification({ status: 'verified', detail: 'd' })).toEqual({ status: 'ready' });
  });

  it("broken is blocked with the WALLET_REASONS person fix, not the verification's own", () => {
    expect(
      signFromVerification({
        status: 'broken',
        detail: 'd',
        fix: 'Set TENJIN_WALLET_PASSPHRASE to it',
      }),
    ).toEqual(blockedFor('passphrase_wrong'));
    expect(
      signFromVerification({ status: 'broken', detail: 'd', fix: 'f', reason: 'wallet_corrupt' }),
    ).toEqual(blockedFor('wallet_corrupt'));
  });

  it('unverified with passphrase_missing is blocked, with keychain_locked unknown', () => {
    expect(
      signFromVerification({ status: 'unverified', detail: 'd', reason: 'passphrase_missing' }),
    ).toEqual(blockedFor('passphrase_missing'));
    expect(
      signFromVerification({ status: 'unverified', detail: 'd', reason: 'keychain_locked' }),
    ).toEqual(UNKNOWN);
  });

  it('unverified with no reason, null and undefined are unknown', () => {
    expect(signFromVerification({ status: 'unverified', detail: 'd' }).status).toBe('unknown');
    expect(signFromVerification(null)).toEqual({
      status: 'unknown',
      reason: 'not_checked',
      detail: UNKNOWN_DETAIL['not_checked'],
    });
    expect(signFromVerification(undefined).status).toBe('unknown');
  });

  it('isDefiniteBlock is true only for blocked', () => {
    expect(isDefiniteBlock(BLOCKED)).toBe(true);
    expect(isDefiniteBlock(UNKNOWN)).toBe(false);
    expect(isDefiniteBlock(READY)).toBe(false);
  });
});

/** mulberry32: a small seeded PRNG, so the sweep is the same on every run. */
function rng(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('the invariants, over a seeded random sweep', () => {
  const next = rng(0x7e51);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)]!;
  const UNLOCK_REASONS = [
    'no_wallet',
    'wallet_corrupt',
    'env_key_invalid',
    'passphrase_missing',
    'passphrase_wrong',
    'env_passphrase_wrong',
    'keychain_locked',
    'unlock_timeout',
    'wallet_locked',
  ] as const;
  const amounts = [
    null,
    0n,
    1n,
    ROUTING_FEE_CEILING_ATOMIC,
    FLOOR - 1n,
    FLOOR,
    CHANNEL_DEPOSIT_ATOMIC,
    10n ** 9n,
  ];

  function randomSignFacts(): SignFacts {
    const unlockKind = pick(['none', 'ok', 'fail'] as const);
    return {
      envKey: pick(['absent', 'valid', 'malformed'] as const),
      walletFile: pick(['present', 'absent', 'unparsable'] as const),
      passphraseFileMissing: pick([undefined, true, false]),
      envPassphraseSet: pick([undefined, true, false]),
      ...(unlockKind === 'ok'
        ? { unlock: { ok: true as const, source: 'keychain' as const } }
        : {}),
      ...(unlockKind === 'fail'
        ? { unlock: { ok: false as const, reason: pick(UNLOCK_REASONS) } }
        : {}),
    };
  }

  it('holds for 5000 random inputs', () => {
    for (let i = 0; i < 5000; i++) {
      const facts = randomSignFacts();
      const sign = canSign(facts);
      if (facts.envPassphraseSet === true) {
        expect(sign.status === 'blocked' && sign.reason === 'passphrase_missing').toBe(false);
      }

      const routing = canPayRouting({
        feeRefusal: pick([null, null, null, 'not_allowlisted']),
        sign,
        creditAtomic: pick(amounts),
        depositRefusal: pick([null, null, null, 'budget_reached']),
        balanceAtomic: pick(amounts),
      });
      const provider = canPayProvider(
        { policy: { decision: 'allow' }, sign, balanceAtomic: pick(amounts) },
        pick([1n, 100n, CHANNEL_DEPOSIT_ATOMIC]),
      );
      // No ready while sign is not ready.
      if (sign.status !== 'ready') {
        expect(routing.status).not.toBe('ready');
        expect(provider.status).not.toBe('ready');
      }

      // No blocked from unknown inputs alone: an unknown signer, nothing refused,
      // no money fact known.
      const unknownSign: SignVerdict = {
        status: 'unknown',
        reason: pick(UNLOCK_REASONS),
        detail: 'd',
      };
      expect(
        canPayRouting({
          feeRefusal: null,
          sign: unknownSign,
          creditAtomic: pick([null, 0n]),
          depositRefusal: null,
          balanceAtomic: null,
        }).status,
      ).toBe('unknown');
      expect(
        canPayProvider(
          { policy: { decision: 'allow' }, sign: unknownSign, balanceAtomic: null },
          100n,
        ).status,
      ).toBe('unknown');
      // An unlock failure that is not definite never makes the signer blocked.
      const failed = facts.unlock?.ok === false ? facts.unlock.reason : null;
      if (
        failed !== null &&
        (failed === 'wallet_locked' || !DEFINITE_UNLOCK.has(failed)) &&
        facts.envKey === 'absent' &&
        facts.walletFile === 'present'
      ) {
        expect(sign.status).toBe('unknown');
      }
    }
  });
});
