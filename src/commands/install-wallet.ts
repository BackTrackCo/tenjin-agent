import { CliError } from '../lib/errors';
import { confirmChoice } from '../lib/clack';
import { describeWallet, resolveWalletProvider } from '../lib/wallet';
import type { PassphraseOverrides } from '../lib/wallet/local';
import { walletFileExists } from '../lib/wallet/store';
import { runWalletCreate } from './wallet';
import type { CommandContext } from '../context';

/**
 * The wallet step `tenjin install` runs: keep the wallet this machine has, or
 * create one. Shared by the router install and the shelf install so the two
 * can never disagree about when a wallet is made or what a skip tells you.
 */

/** The wallet question's literal copy. */
export const WALLET_QUESTION = 'Create a wallet now?';

/** The seams the wallet step reads; every one defaults to the real thing. */
export interface WalletDeps {
  env?: NodeJS.ProcessEnv;
  /** "Create a wallet now?"; defaults to the clack confirm (default yes). */
  confirmWallet?: (label: string) => Promise<boolean>;
  /** Does a wallet already exist? Defaults to walletFileExists(dataDir). */
  walletExists?: (dataDir: string) => Promise<boolean>;
  /** An existing wallet's address. Defaults to the local provider. */
  walletAddress?: (ctx: CommandContext) => Promise<string>;
  /** Create a wallet and return its address. Defaults to runWalletCreate. */
  createWallet?: (ctx: CommandContext) => Promise<string>;
  /**
   * Passphrase-resolution seam forwarded to `wallet create`. Tests MUST set it
   * (or `createWallet`): without it a headless run creates a real wallet, and
   * on macOS that writes to the developer's own login keychain.
   */
  walletPassphrase?: PassphraseOverrides;
}

/**
 * Why no wallet was created, when none was.
 *
 * `no-passphrase-store` is the one that matters: this machine has no OS
 * credential store that would hold a generated passphrase, and no
 * `TENJIN_WALLET_PASSPHRASE`. There is no fallback here BY DESIGN. A passphrase
 * written to a plain file beside the keystore it unlocks is not a passphrase, so
 * the run creates nothing and says so loudly with both remedies.
 */
export type WalletSkipReason = 'no-passphrase-store' | 'create-failed' | 'dry-run' | 'flag';

/**
 * How the wallet step resolved, so rendering stays separate from prompting.
 *
 * `declined` (an answer) and `skipped` (no answer, with a reason) are kept apart
 * deliberately: an install that could not create a key is a different state from
 * one the operator told not to, and only the first needs a remedy.
 */
export interface WalletOutcome {
  status: 'existing' | 'created' | 'declined' | 'skipped';
  address?: string;
  /** Only ever set on `skipped`. */
  reason?: WalletSkipReason;
  /** The exact command that changes this outcome, mirroring the CliError contract. */
  fix?: string;
  /** The underlying failure, for a `create-failed` skip. */
  warning?: string;
}

/** The remedy for each skip, so no skipped state is ever a dead end. */
function walletFix(reason: WalletSkipReason): string {
  switch (reason) {
    case 'no-passphrase-store':
      return 'No OS credential store is available to hold the wallet passphrase. Set TENJIN_WALLET_PASSPHRASE and re-run `tenjin install`, or run `tenjin wallet create` in a terminal to enter one.';
    case 'create-failed':
      return 'Fix the reported problem, then run `tenjin wallet create`.';
    case 'dry-run':
    case 'flag':
      return 'Create one with `tenjin wallet create`.';
  }
}

export function walletValue(w: WalletOutcome): string {
  if (w.status === 'existing') return `${w.address} (existing)`;
  if (w.status === 'created') return `${w.address}, $0 - fund with: tenjin wallet fund`;
  if (w.status === 'skipped') return `none (${w.reason}) - ${w.fix}`;
  return 'none - create with: tenjin wallet create';
}

/**
 * The wallet decision. A wallet is now created BY DEFAULT on both paths, because
 * the loop this command exists to set up does not close without one: `buy` needs
 * a funded key and publish-on-MISS needs a key to sign the write, so a walletless
 * install is a setup that stops at the first useful thing the agent tries.
 *
 * The headless path is the change. It creates without asking, using the
 * passphrase policy `resolvePassphraseForCreate` already enforces: an explicit
 * `TENJIN_WALLET_PASSPHRASE`, else a strong generated passphrase written to the
 * platform's OS credential store and verified by reading it back. When neither is
 * available it creates NOTHING and reports `skipped: no-passphrase-store` with
 * both remedies. There is deliberately no plain-file fallback: a passphrase
 * sitting next to the keystore it unlocks protects nothing, and an install is
 * never the right place to invent one.
 *
 * A creation failure never fails the install. The skills, hooks and permissions
 * this run just wired are all useful without a wallet, so the failure is reported
 * loudly and the command still succeeds.
 */
export async function resolveWallet(
  ctx: CommandContext,
  deps: WalletDeps,
  skipReason: 'dry-run' | 'flag' | undefined,
  canPrompt: boolean,
): Promise<WalletOutcome> {
  const exists = await (deps.walletExists ?? walletFileExists)(ctx.dataDir);
  if (exists) {
    return {
      status: 'existing',
      address: await (deps.walletAddress ?? existingWalletAddress)(ctx),
    };
  }
  if (skipReason !== undefined) {
    return { status: 'skipped', reason: skipReason, fix: walletFix(skipReason) };
  }

  // Interactive keeps the question (default yes); headless has nobody to ask and
  // takes the default rather than treating silence as a no.
  if (canPrompt) {
    const confirm = deps.confirmWallet ?? defaultConfirm;
    if (!(await confirm(WALLET_QUESTION))) return { status: 'declined' };
  }

  try {
    const create =
      deps.createWallet ??
      ((c: CommandContext) => defaultCreateWallet(c, deps.walletPassphrase, deps.env));
    return { status: 'created', address: await create(ctx) };
  } catch (err) {
    // The one failure with a real remedy: no env passphrase and no OS store, so
    // resolvePassphraseForCreate refused rather than encrypt with a passphrase
    // that has no durable copy. Anything else is reported as itself.
    const reason: WalletSkipReason = isNoPassphraseError(err)
      ? 'no-passphrase-store'
      : 'create-failed';
    return {
      status: 'skipped',
      reason,
      fix: walletFix(reason),
      ...(reason === 'create-failed'
        ? { warning: `The wallet could not be created: ${errorText(err)}` }
        : {}),
    };
  }
}

/** Is this the passphrase layer refusing because no durable store could serve? */
function isNoPassphraseError(err: unknown): boolean {
  return (
    err instanceof CliError &&
    err.code === 'USAGE' &&
    err.message.includes('No wallet passphrase is available')
  );
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function existingWalletAddress(ctx: CommandContext): Promise<string> {
  return (await describeWallet(resolveWalletProvider(ctx))).address;
}

async function defaultCreateWallet(
  ctx: CommandContext,
  passphrase?: PassphraseOverrides,
  env?: NodeJS.ProcessEnv,
): Promise<string> {
  const result = await runWalletCreate(ctx, {
    ...(passphrase !== undefined ? { passphrase } : {}),
    ...(env !== undefined ? { env } : {}),
  });
  return (result.data as { address: string }).address;
}

/** The shared confirm, defaulting to YES (setup ergonomics); cancel reads as no. */
function defaultConfirm(label: string): Promise<boolean> {
  return confirmChoice(label, true);
}
