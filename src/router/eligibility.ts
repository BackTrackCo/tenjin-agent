import type { PolicyReason } from '../lib/policy';
import type { WalletFacts } from '../lib/wallet-facts';
import type { WalletVerification } from '../lib/wallet/provider';
import { DEFINITE_UNLOCK, type SigningSource, type UnlockReason } from '../lib/wallet-unlock';
import { CHANNEL_DEPOSIT_ATOMIC, ROUTING_FEE_CEILING_ATOMIC, unpaid } from './fee';
import { UNKNOWN_DETAIL, WALLET_REASONS } from './wallet-reasons';

/**
 * CAN THIS WALLET SIGN, PAY THE ROUTING FEE, PAY A PROVIDER: three pure answers
 * from facts someone else gathered. The payer, the hooks, doctor and install
 * all decide from these, so a wallet one of them calls blocked is blocked to
 * every other.
 *
 * Every answer is one of three, never a boolean:
 * - `ready`: it will work, as far as anything here can tell;
 * - `blocked`: it DEFINITELY will not until a person fixes something, and the
 *   verdict says what and how;
 * - `unknown`: nothing definite either way (a keychain that did not answer, a
 *   balance that could not be read, an unlock not tried yet).
 *
 * ONLY `blocked` GATES. An unknown never withholds an offer, never skips a
 * routing attempt, and never renders as ok. Two invariants follow, and the
 * property test holds them: nothing is ready while signing is not ready, and
 * nothing is blocked from an unknown input alone.
 *
 * Pure and hook-safe: types, fee.ts's constants and wording, and the reason
 * strings. The I/O that fills these facts in lives in `eligibility-check.ts`
 * (doctor) and in the payer and hooks themselves.
 */
export type Verdict<R extends string = string> =
  | { status: 'ready'; source?: SigningSource; warning?: string }
  | { status: 'blocked'; reason: R; detail: string; fix: string }
  | { status: 'unknown'; reason: string; detail: string };

export type SignVerdict = Verdict<UnlockReason>;

export type { SigningSource };

export interface SignFacts {
  envKey: WalletFacts['envKey'];
  walletFile: WalletFacts['walletFile'];
  passphraseFileMissing?: boolean;
  /** S13: with this set, canSign never returns blocked passphrase_missing. */
  envPassphraseSet?: boolean;
  unlock?:
    | { ok: true; source?: SigningSource; warning?: string }
    | { ok: false; reason: UnlockReason | 'wallet_locked'; detail?: string; fix?: string };
}

export interface RoutingFacts {
  feeRefusal: string | null;
  sign: SignVerdict;
  creditAtomic: bigint | null;
  depositRefusal: string | null;
  balanceAtomic: bigint | null;
}

export interface ProviderFacts {
  policy: { decision: 'allow' } | { decision: 'refuse'; reason: PolicyReason };
  sign: SignVerdict;
  balanceAtomic: bigint | null;
}

/** A definite unlock block, worded from WALLET_REASONS: the fragment as the
 *  detail, the PERSON fix (decision 15) unless the caller supplied its own. */
function unlockBlocked(reason: UnlockReason, fix?: string): SignVerdict {
  const r = WALLET_REASONS[reason as keyof typeof WALLET_REASONS];
  return { status: 'blocked', reason, detail: r.reason, fix: fix ?? r.fix };
}

/** An unknown, worded from UNKNOWN_DETAIL, else the caller's detail. */
function unknown(
  reason: string,
  detail?: string,
): { status: 'unknown'; reason: string; detail: string } {
  return {
    status: 'unknown',
    reason,
    detail: UNKNOWN_DETAIL[reason] ?? detail ?? UNKNOWN_DETAIL['check_failed']!,
  };
}

/** A ready verdict carrying only the fields that are set. */
function ready(
  source?: SigningSource,
  warning?: string,
): { status: 'ready'; source?: SigningSource; warning?: string } {
  return {
    status: 'ready',
    ...(source !== undefined ? { source } : {}),
    ...(warning !== undefined ? { warning } : {}),
  };
}

/**
 * A money or policy block in TODAY'S words (S5): `detail` and `fix` are fee.ts's
 * `unpaid(reason)`, byte for byte. No new fee or funding wording comes from here.
 */
function moneyBlocked(reason: string): Verdict {
  const u = unpaid(reason);
  return {
    status: 'blocked',
    reason,
    detail: u?.reason ?? reason,
    fix: u?.fix ?? 'Run `tenjin doctor`.',
  };
}

/**
 * CAN THIS WALLET SIGN, first match wins (section 2.4).
 *
 * The file facts that are definite come first (a malformed key, no wallet, a
 * wallet.json nobody can read), then what an actual unlock said, then the one
 * file fact that is definite only without the env variable: the sidecar names
 * the file store and the file is gone.
 *
 * S13: a set TENJIN_WALLET_PASSPHRASE is itself a passphrase source, so "no
 * passphrase can be reached" is never definite while it is set. Until an
 * unlock has actually tried it, the answer is unknown.
 */
export function canSign(f: SignFacts): SignVerdict {
  if (f.envKey === 'valid') return ready('key-env');
  if (f.envKey === 'malformed') return unlockBlocked('env_key_invalid');
  if (f.walletFile === 'absent') return unlockBlocked('no_wallet');
  if (f.walletFile === 'unparsable') return unlockBlocked('wallet_corrupt');
  const envPassphraseSet = f.envPassphraseSet === true;
  if (f.unlock !== undefined) {
    if (f.unlock.ok) return ready(f.unlock.source, f.unlock.warning);
    const { reason } = f.unlock;
    if (reason === 'passphrase_missing' && envPassphraseSet) return unknown('not_checked');
    if (reason !== 'wallet_locked' && DEFINITE_UNLOCK.has(reason)) {
      return unlockBlocked(reason, f.unlock.fix);
    }
    return unknown(reason, f.unlock.detail);
  }
  if (f.passphraseFileMissing === true && !envPassphraseSet) {
    return unlockBlocked('passphrase_missing');
  }
  return unknown('not_checked');
}

/**
 * CAN THE NEXT ROUTING CALL PAY ITS FEE, first match wins (section 2.4).
 *
 * Definite money facts come AHEAD of an unknown signer (decision 11): a
 * command-mode hook cannot unlock, so its signer is always unknown, and a
 * balance below the deposit must still withhold there as it does today. A
 * channel that already holds the fee needs no deposit, so neither the deposit
 * policy nor the balance matters to it (checklist item 8: $0 with credit).
 */
export function canPayRouting(r: RoutingFacts): Verdict {
  if (r.feeRefusal !== null) return moneyBlocked(r.feeRefusal);
  if (r.sign.status === 'blocked') return r.sign;
  if ((r.creditAtomic ?? 0n) >= ROUTING_FEE_CEILING_ATOMIC) return r.sign;
  if (r.depositRefusal !== null) return moneyBlocked(r.depositRefusal);
  if (r.balanceAtomic !== null && r.balanceAtomic < CHANNEL_DEPOSIT_ATOMIC) {
    return moneyBlocked('wallet_low');
  }
  if (r.sign.status === 'unknown') return r.sign;
  if (r.balanceAtomic === null) return unknown('balance_unreadable');
  return r.sign;
}

/**
 * CAN THIS WALLET PAY A PROVIDER `priceAtomic`, first match wins (section 2.4).
 *
 * `needs_approval` keeps the policy's own reason, and it and `wallet_short`
 * carry empty text on purpose: the hooks render them with today's Shortfall
 * strings, and nothing here may invent new ones.
 */
export function canPayProvider(
  p: ProviderFacts,
  priceAtomic: bigint,
): Verdict<UnlockReason | 'needs_approval' | 'wallet_short'> & { policyReason?: PolicyReason } {
  if (p.policy.decision !== 'allow') {
    return {
      status: 'blocked',
      reason: 'needs_approval',
      detail: '',
      fix: '',
      policyReason: p.policy.reason,
    };
  }
  if (p.sign.status === 'blocked') return p.sign;
  if (p.balanceAtomic !== null && p.balanceAtomic < priceAtomic) {
    return { status: 'blocked', reason: 'wallet_short', detail: '', fix: '' };
  }
  if (p.sign.status === 'unknown') return p.sign;
  if (p.balanceAtomic === null) return unknown('balance_unreadable');
  return p.sign;
}

/**
 * A provider's `verify()` answer as a sign verdict.
 *
 * verified is ready (with its source and warning); broken is blocked
 * (`reason`, else `passphrase_wrong`, the one thing today's broken verdicts
 * all were before they carried one); unverified is blocked only with a
 * DEFINITE reason, and unknown otherwise; no answer at all is unknown.
 *
 * A blocked verdict is worded from WALLET_REASONS, not from the verification's
 * own `detail` and `fix`: those predate B1 and can tell a person to set
 * TENJIN_WALLET_PASSPHRASE, and doctor shows the WALLET_REASONS person fix for
 * every unlock reason (decision 15).
 */
export function signFromVerification(v: WalletVerification | null | undefined): SignVerdict {
  if (v === null || v === undefined) return unknown('not_checked');
  if (v.status === 'verified') return ready(v.source, v.warning);
  if (v.status === 'broken') return unlockBlocked(v.reason ?? 'passphrase_wrong');
  if (v.reason !== undefined && DEFINITE_UNLOCK.has(v.reason)) return unlockBlocked(v.reason);
  return unknown(v.reason ?? 'wallet_locked', v.detail);
}

/** True only for a definite block: the one status any caller may gate on. */
export function isDefiniteBlock(v: Verdict): v is Extract<Verdict, { status: 'blocked' }> {
  return v.status === 'blocked';
}
