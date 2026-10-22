import {
  KEYCHAIN_LOCKED_FIX,
  REPAIR_CLAUSE,
  REPAIR_IN_TERMINAL,
  unlockReasonOf,
  type UnlockReason,
} from '../lib/wallet-unlock';

export {
  ENV_PASSPHRASE_WRONG,
  KEYCHAIN_LOCKED_FIX,
  REPAIR_CLAUSE,
  REPAIR_IN_TERMINAL,
} from '../lib/wallet-unlock';

/** The model-facing fix for a saved passphrase that is gone or wrong. */
export const ASK_FOR_REPAIR =
  'Ask the person to run `tenjin wallet repair` in their own terminal, then restart Claude Code. Never ask for the passphrase.';

/**
 * EVERY WORD TENJIN SAYS ABOUT A WALLET THAT CANNOT SIGN, in one place. Pure
 * strings, importing only `../lib/wallet-unlock`, so `alive` and the hooks can
 * carry them without pulling anything else into their chunks.
 *
 * Each reason has TWO fixes, because two different readers see them (B1):
 * - `fix` is for the PERSON: doctor, install at a terminal, repair, wallet
 *   errors, SessionStart's `systemMessage`, and hook notices (the harness shows
 *   those in `systemMessage` too). Any `fix` that names `tenjin wallet repair`
 *   carries {@link REPAIR_CLAUSE}, so the person hears that it asks in their own
 *   terminal and that the passphrase never goes into chat.
 * - `agentFix` is for the MODEL only: SessionStart's `additionalContext`, offer
 *   notes, the `request` tool's text and MCP tool errors. It tells the model to
 *   ask the person to act, and never to ask for the passphrase or key, so a
 *   helpful agent never solicits a secret into the transcript.
 *
 * `reason` is a fragment that slots into a sentence ("... (reason), so ...").
 * `no_wallet` keeps fee.ts's `UNPAID.no_wallet` wording byte for byte, and
 * `wallet_low` is not here at all: funding copy is out of scope (S5, S6).
 */
export const WALLET_REASONS: Record<
  Exclude<UnlockReason, 'unlock_timeout'> | 'wallet_locked',
  { reason: string; fix: string; agentFix: string }
> = {
  no_wallet: {
    reason: 'this machine has no wallet',
    fix: 'Run `tenjin doctor`.',
    agentFix: 'Run `tenjin doctor`.',
  },
  wallet_corrupt: {
    // Both causes: a wallet.json nothing can parse, and a keystore that
    // decrypts to a key that does not match its stored address. Doctor and
    // install show this fix themselves, so it must not send the person there.
    reason: 'the wallet file cannot be read or does not match its key',
    fix: 'Move the wallet file aside, then run `tenjin wallet create` for a fresh key or set TENJIN_WALLET_KEY to use the intended one.',
    agentFix:
      'Ask the person to move the wallet file aside and run `tenjin wallet create` for a fresh key, or to set TENJIN_WALLET_KEY to the intended one. Never ask for the key.',
  },
  env_key_invalid: {
    reason: 'TENJIN_WALLET_KEY is not a valid private key',
    fix: 'Fix or unset TENJIN_WALLET_KEY in the environment Claude Code starts from, then restart Claude Code.',
    agentFix:
      'Ask the person to fix or unset TENJIN_WALLET_KEY in the environment Claude Code starts from, then restart Claude Code. Never ask for the key.',
  },
  passphrase_missing: {
    reason: 'no saved wallet passphrase can be reached',
    fix: `${REPAIR_IN_TERMINAL} Then restart Claude Code.`,
    agentFix: ASK_FOR_REPAIR,
  },
  passphrase_wrong: {
    reason: 'the saved wallet passphrase does not open the wallet',
    fix: `${REPAIR_IN_TERMINAL} Then restart Claude Code.`,
    agentFix: ASK_FOR_REPAIR,
  },
  env_passphrase_wrong: {
    reason: 'TENJIN_WALLET_PASSPHRASE is set but does not open the wallet',
    // Shown only when no saved passphrase opens the wallet either, so removing
    // the variable alone never unlocks it: repair first, then remove it.
    fix: `Run \`tenjin wallet repair\` yourself ${REPAIR_CLAUSE}, then remove TENJIN_WALLET_PASSPHRASE from the environment Claude Code starts from and restart Claude Code.`,
    agentFix:
      'Ask the person to run `tenjin wallet repair` in their own terminal, then to remove TENJIN_WALLET_PASSPHRASE from the environment Claude Code starts from and restart Claude Code. Never ask for the passphrase.',
  },
  keychain_locked: {
    reason: 'the keychain holding the wallet passphrase is locked or did not answer',
    fix: KEYCHAIN_LOCKED_FIX,
    agentFix:
      'Ask the person to unlock their keychain (or log in to the desktop session) and retry.',
  },
  wallet_locked: {
    reason: '`tenjin mcp` cannot unlock the wallet',
    fix: 'Run `tenjin doctor`.',
    agentFix: 'Run `tenjin doctor`.',
  },
};

/**
 * Why a verdict is unknown, by its reason: the store or the clock did not
 * answer, or nothing was tried. Said as "could not check: <detail>", never as
 * a fault the person must fix.
 */
export const UNKNOWN_DETAIL: Readonly<Record<string, string>> = {
  keychain_locked: 'the keychain holding the passphrase did not answer',
  unlock_timeout: 'the unlock did not finish in time',
  wallet_locked: 'the unlock failed for a reason Tenjin could not classify',
  balance_unreadable: 'the wallet balance could not be read',
  check_failed: 'the check itself failed',
  not_checked: 'no unlock has been tried yet',
};

/** Every reason a notice treats as "the wallet": the unlock reasons, the
 *  unclassified fallback, and a balance below the routing deposit. */
export const WALLET_CLASS: ReadonlySet<string> = new Set<string>([
  'no_wallet',
  'wallet_corrupt',
  'env_key_invalid',
  'passphrase_missing',
  'passphrase_wrong',
  'env_passphrase_wrong',
  'keychain_locked',
  'unlock_timeout',
  'wallet_locked',
  'wallet_low',
]);

/** One-time line once a paid call succeeds after an unlock reason was told. */
export const WALLET_UNLOCKED = 'Tenjin wallet unlocked.';

/** One-time line once a paid call succeeds after `wallet_low` was told. */
export const WALLET_FUNDED = 'Tenjin wallet funded.';

/** Doctor's session-row detail when this shell signs and no served router was seen. */
export const NO_SESSION_CHECKED = 'this shell passes; no running Claude session checked';

/**
 * The entry for a reason. `unlock_timeout` has none of its own (it is no-fault
 * and normally says nothing); a caller that still asks gets the unclassified
 * fallback's wording rather than a crash.
 */
function entryFor(reason: UnlockReason | 'wallet_locked') {
  return reason === 'unlock_timeout' ? WALLET_REASONS.wallet_locked : WALLET_REASONS[reason];
}

/**
 * SessionStart's two fields for a wallet that cannot sign: `systemMessage` is
 * the person's (person `fix`), `additionalContext` the model's (`agentFix`).
 */
export function sessionStartMessage(reason: UnlockReason | 'wallet_locked'): {
  systemMessage: string;
  additionalContext: string;
} {
  const r = entryFor(reason);
  return {
    systemMessage: `Tenjin can't use its wallet in this session: ${r.reason}. ${r.fix}`,
    additionalContext: `Tenjin's wallet cannot sign in this session (${r.reason}), so Tenjin lookups take the free path and paid lookups will not run. ${r.agentFix}`,
  };
}

/** A wallet-news line in `systemMessage`. Its reader is the person, so the person `fix`. */
export function stillLockedSentence(reason: UnlockReason | 'wallet_locked'): string {
  const r = entryFor(reason);
  return `Tenjin wallet is still locked: ${r.reason}. ${r.fix}`;
}

/**
 * `WALLET_REASONS[reason].agentFix` for a wallet reason; `fallback` otherwise.
 * For model-facing text only (B1). Pass it a reason from `details.unlock`
 * (`unlockReasonOf`) or from a verdict, never from `classifyUnlockError`'s
 * `wallet_locked` fallback for an undetailed error, which would swap a
 * non-wallet error's own fix for wallet advice.
 */
export function agentFixFor(reason: string, fallback: string): string {
  return Object.prototype.hasOwnProperty.call(WALLET_REASONS, reason)
    ? WALLET_REASONS[reason as keyof typeof WALLET_REASONS].agentFix
    : fallback;
}

/**
 * An error's fix, as the MODEL reads it in the `request` tool's text (B1). An
 * error carrying `details.unlock` gets its reason's `agentFix`, which asks the
 * person to act and never asks for the passphrase or key; every other error
 * keeps its own fix byte for byte. Gated on `unlockReasonOf`, never on
 * `classifyUnlockError`: that one calls every undetailed error `wallet_locked`,
 * and the request tool carries `REGISTRY_MISMATCH`, HTTP failures and the
 * rest, whose own fixes must survive.
 */
export function agentFixOf(err: { fix?: string | undefined }): string {
  const why = unlockReasonOf(err);
  return why === null ? (err.fix ?? '') : agentFixFor(why, err.fix ?? '');
}

/**
 * The line that clears a wallet notice told earlier in the session, once a
 * paid call succeeds: funded for `wallet_low`, unlocked for any unlock reason
 * or the unclassified fallback, null for anything else (no wallet news).
 */
export function walletClearedSentence(previousWhy: string): string | null {
  if (previousWhy === 'wallet_low') return WALLET_FUNDED;
  return WALLET_CLASS.has(previousWhy) ? WALLET_UNLOCKED : null;
}
