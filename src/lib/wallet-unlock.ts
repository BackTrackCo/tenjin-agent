import { CliError } from './errors';

/**
 * WHY A WALLET COULD NOT SIGN, AS ONE VOCABULARY. The wallet layer throws with
 * it, the routing payer skips with it, the hooks gate and word notices with it,
 * and doctor renders it, so every surface names the same cause the same way.
 *
 * HOOK-SAFE ON PURPOSE: it imports `./errors` and nothing else. `tenjin hook`,
 * `alive` and the status line read these reasons, and their chunk graph must
 * stay free of `src/lib/wallet/`, viem, ox and the x402 SDK
 * (`src/router/dist-chunks.test.ts`). That is why the reasons live here and not
 * beside the wallet code that produces them.
 *
 * Six reasons are DEFINITE (this wallet cannot sign until a person fixes
 * something) and two are not (`keychain_locked`, `unlock_timeout`: the store or
 * the clock did not answer, which says nothing about the wallet). Only a
 * definite reason may withhold an offer or skip a routing attempt.
 */
export type UnlockReason =
  | 'no_wallet'
  | 'wallet_corrupt'
  | 'env_key_invalid'
  | 'passphrase_missing'
  | 'passphrase_wrong'
  | 'env_passphrase_wrong'
  | 'keychain_locked'
  | 'unlock_timeout';

const UNLOCK_REASONS: ReadonlySet<string> = new Set<UnlockReason>([
  'no_wallet',
  'wallet_corrupt',
  'env_key_invalid',
  'passphrase_missing',
  'passphrase_wrong',
  'env_passphrase_wrong',
  'keychain_locked',
  'unlock_timeout',
]);

/** A store that keeps a wallet's passphrase across sessions: the platform's own
 *  credential store, or the 0600 file where there is none. */
export type DurableStore = 'keychain' | 'secret-service' | 'dpapi' | 'file';

/** Where a passphrase came from, for messages; 'legacy' = the pre-per-wallet shared slot. */
export type PassphraseLabel = 'env' | DurableStore | 'legacy' | 'prompt';

const PASSPHRASE_LABELS: ReadonlySet<string> = new Set<PassphraseLabel>([
  'env',
  'keychain',
  'secret-service',
  'dpapi',
  'file',
  'legacy',
  'prompt',
]);

/**
 * What actually produced a signature, as doctor, install and the router report
 * it. Defined here rather than in `src/router/eligibility.ts` (which re-exports
 * it) because `src/lib/wallet/provider.ts` needs it too, and lib must not
 * import router.
 */
export type SigningSource = 'key-env' | 'passphrase-env' | DurableStore | 'legacy';

/** The cause a wallet throw site attaches as `CliError.details.unlock`. */
export interface UnlockDetails {
  reason: UnlockReason;
  source?: PassphraseLabel;
}

/** Every reason except the two that say the store or the clock did not answer. */
export const DEFINITE_UNLOCK: ReadonlySet<UnlockReason> = new Set<UnlockReason>([
  'no_wallet',
  'wallet_corrupt',
  'env_key_invalid',
  'passphrase_missing',
  'passphrase_wrong',
  'env_passphrase_wrong',
]);

/** Said once when TENJIN_WALLET_PASSPHRASE did not open the wallet and a saved
 *  passphrase did: the wallet works, the variable is the thing to remove. */
export const ENV_PASSPHRASE_WRONG = 'TENJIN_WALLET_PASSPHRASE is set but wrong; remove it.';

/**
 * Carried by every person-facing string that names `tenjin wallet repair` (B1,
 * decision 15). A passphrase never goes on a command line or into chat: repair
 * asks for it at a hidden prompt, and this clause tells the person so before an
 * agent can suggest otherwise.
 */
export const REPAIR_CLAUSE =
  '(it asks for the passphrase in your terminal; never paste it into chat)';

/** The person's fix for a wallet whose saved passphrase is gone or wrong. */
export const REPAIR_IN_TERMINAL =
  `Run \`tenjin wallet repair\` yourself ${REPAIR_CLAUSE}.` as const;

/**
 * The only fix for a keychain that exists but did not answer (S3). It never
 * points at the plaintext file or at another passphrase: a locked keychain is
 * unlocked, not routed around.
 */
export const KEYCHAIN_LOCKED_FIX =
  'Unlock your keychain (or log in to the desktop session) and retry.';

/**
 * A failed FILE-store write at create or repair (decision 6). Never used for an
 * OS store: there is no keychain to unlock when the file could not be written.
 */
export function FILE_STORE_FAILED_FIX(path: string): string {
  return `Tenjin could not save the passphrase to ${path}; check that ~/.tenjin is writable.`;
}

/** Shown once when create or repair has waited on the keychain for a second at a terminal. */
export const KEYCHAIN_WAIT_LINE = 'Waiting for the keychain…';

/** Why a passphrase went to the 0600 file: no OS store answered the probe as present (S4). */
export function NO_KEYRING_LINE(path: string): string {
  return `No keyring reachable from this session; passphrase saved to ${path} (readable only by you).`;
}

/**
 * THE one TENJIN_WALLET_KEY expression (S12): a 0x-prefixed 32-byte hex private
 * key, case-insensitive. Moved here from `src/lib/wallet/store.ts` unchanged, and
 * store.ts re-exports it, so the wallet layer's `loadCredential` and the
 * hook-safe `wallet-facts.ts` test exactly the same thing. Do not tighten it in
 * one place only: a key one accepts and the other rejects is a wallet doctor
 * calls fine and the hooks call broken.
 */
export const PRIVATE_KEY_RE = /^0x[0-9a-f]{64}$/i;

/** `{ unlock: { reason, source } }`, the value every wallet throw site passes as CliError `details`. */
export function unlockDetails(
  reason: UnlockReason,
  source?: PassphraseLabel,
): { unlock: UnlockDetails } {
  return { unlock: source === undefined ? { reason } : { reason, source } };
}

/** Whether `value` is a well-formed `details.unlock`: a known reason, and a known source if any. */
function isUnlockDetails(value: unknown): value is UnlockDetails {
  if (typeof value !== 'object' || value === null) return false;
  const { reason, source } = value as { reason?: unknown; source?: unknown };
  if (typeof reason !== 'string' || !UNLOCK_REASONS.has(reason)) return false;
  return source === undefined || (typeof source === 'string' && PASSPHRASE_LABELS.has(source));
}

/** `details.unlock` of a CliError that carries a valid one, else undefined. */
function detailsOf(err: unknown): UnlockDetails | undefined {
  if (!(err instanceof CliError)) return undefined;
  const unlock = (err.details as { unlock?: unknown } | null | undefined)?.unlock;
  return isUnlockDetails(unlock) ? unlock : undefined;
}

/**
 * WHAT AN UNLOCK FAILURE MEANS, for gating and wording. In order:
 * `details.unlock` when the thrower classified it; `WALLET_MISSING` is
 * `no_wallet`; an AbortError or TimeoutError is `unlock_timeout`. ANY other
 * error, an undetailed CliError included, is `wallet_locked`, which is never
 * definite: nobody said why, so nothing may be withheld on its account.
 *
 * It never matches on message text. A message is wording, free to change; a
 * reason that hung on it would turn a copy edit into a gating change.
 */
export function classifyUnlockError(err: unknown): {
  reason: UnlockReason | 'wallet_locked';
  definite: boolean;
  source?: PassphraseLabel;
} {
  const unlock = detailsOf(err);
  if (unlock !== undefined) {
    return {
      reason: unlock.reason,
      definite: DEFINITE_UNLOCK.has(unlock.reason),
      ...(unlock.source !== undefined ? { source: unlock.source } : {}),
    };
  }
  if (err instanceof CliError && err.code === 'WALLET_MISSING') {
    return { reason: 'no_wallet', definite: true };
  }
  const name = (err as { name?: unknown } | null | undefined)?.name;
  // By name, not class: a DOMException from AbortSignal.timeout and a
  // hand-made Error named AbortError mean the same thing here.
  if (name === 'AbortError' || name === 'TimeoutError') {
    return { reason: 'unlock_timeout', definite: false };
  }
  return { reason: 'wallet_locked', definite: false };
}

/**
 * `details.unlock.reason` when `err` is a CliError carrying a valid
 * `details.unlock`; null for anything else (an undetailed WALLET_MISSING, an
 * AbortError, any other CliError or value).
 *
 * THE ONLY GATE for swapping a fix to its model-facing `agentFix` (B1). Not
 * {@link classifyUnlockError}: its `wallet_locked` fallback covers EVERY
 * undetailed error, a `REGISTRY_MISMATCH` or an HTTP failure included, and
 * swapping on it would replace those errors' own fixes with wallet advice.
 */
export function unlockReasonOf(err: unknown): UnlockReason | null {
  return detailsOf(err)?.reason ?? null;
}
