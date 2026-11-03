import { CliError } from '../lib/errors';
import { confirmChoice } from '../lib/clack';
import { emitNotice } from '../lib/output';
import { describeWallet, verifyLocalWallet } from '../lib/wallet';
import { createLocalProvider, type PassphraseOverrides } from '../lib/wallet/local';
import { walletFileExists } from '../lib/wallet/store';
import {
  classifyUnlockError,
  FILE_STORE_FAILED_FIX,
  PRIVATE_KEY_RE,
  unlockReasonOf,
  type DurableStore,
} from '../lib/wallet-unlock';
import {
  canSign,
  isDefiniteBlock,
  signFromVerification,
  type SignVerdict,
} from '../router/eligibility';
import {
  readProcessSnapshot,
  type ListMcpProcesses,
  type ListProcesses,
} from '../router/mcp-processes';
import {
  liveObservations,
  readObservations,
  servedObservations,
} from '../router/router-observation';
import { UNKNOWN_DETAIL } from '../router/wallet-reasons';
import { runWalletCreate } from './wallet';
import type { CommandContext } from '../context';

/**
 * The wallet step `tenjin install` runs: keep the wallet this machine has, or
 * create one. Shared by the Claude Code and Codex installs so the two can never
 * disagree about when a wallet is made or what a skip tells you.
 */

/** The wallet question's literal copy. */
export const WALLET_QUESTION = 'Create a wallet now?';

/** Where create put the passphrase, as install reports it. */
export type WalletPassphrase = {
  store: DurableStore | 'env';
  location: string;
  /** False only for a TENJIN_WALLET_PASSPHRASE nothing durable could also hold. */
  durable: boolean;
  /** Create's one line about it (Q2, S4), printed verbatim. */
  note: string;
};

/** The seams the wallet step reads; every one defaults to the real thing. */
export interface WalletDeps {
  env?: NodeJS.ProcessEnv;
  /** "Create a wallet now?"; defaults to the clack confirm (default yes). */
  confirmWallet?: (label: string) => Promise<boolean>;
  /**
   * Does a wallet file already exist? Defaults to walletFileExists(dataDir).
   * A set TENJIN_WALLET_KEY counts as an existing wallet either way.
   */
  walletExists?: (dataDir: string) => Promise<boolean>;
  /** An existing wallet's address. Defaults to the local provider. */
  walletAddress?: (ctx: CommandContext) => Promise<string>;
  /**
   * Create a wallet. Defaults to runWalletCreate, which also says where the
   * passphrase went. A bare address (the older seam) has its signing checked
   * through `walletSigning`, as an existing wallet's is.
   */
  createWallet?: (
    ctx: CommandContext,
  ) => Promise<string | { address: string; passphrase: WalletOutcome['passphrase'] }>;
  /**
   * Passphrase-resolution seam forwarded to `wallet create` and to the signing
   * check's verify. Tests MUST set it (or `createWallet` and `walletSigning`):
   * without it a headless run creates a real wallet, and on macOS that writes
   * to the developer's own login keychain.
   */
  walletPassphrase?: PassphraseOverrides;
  /**
   * Can this wallet sign, and only through a variable in this shell? Default:
   * verify with TENJIN_WALLET_PASSPHRASE removed first (does a saved passphrase
   * open it?), then with it. See {@link defaultWalletSigning}.
   */
  walletSigning?: (
    ctx: CommandContext,
    address: string,
  ) => Promise<{ signing: SignVerdict; shellOnly?: 'key' | 'passphrase' }>;
  /**
   * Has a router that served a Claude session already signed for this
   * address? Clears `shellOnly`: that session demonstrably has the variable.
   */
  observedSigning?: (address: string) => Promise<boolean>;
  /** The process seams `observedSigning`'s default reads; tests inject them. */
  listProcesses?: ListProcesses;
  listMcpProcesses?: ListMcpProcesses;
}

/**
 * Why no wallet was created, when none was.
 *
 * The passphrase is saved durably wherever a wallet is created: the OS store,
 * or where there is none, the 0600 file the GitHub CLI falls back to as well
 * (`~/.tenjin/passphrase.<address>.plain`). So the two store skips are narrow:
 *
 * - `no-passphrase-store`: even the file write failed (create's REFUSED with
 *   `details.passphraseStore.kind === 'file-write-failed'`, decision 6). Never
 *   a keychain: headless Linux with an unwritable `~/.tenjin` has none.
 * - `passphrase-store-locked`: the OS store exists but did not answer (create
 *   refused with `details.unlock.reason === 'keychain_locked'`). Nothing was
 *   encrypted, so a retry once it answers creates the wallet.
 */
export type WalletSkipReason =
  'no-passphrase-store' | 'passphrase-store-locked' | 'create-failed' | 'dry-run' | 'flag';

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
  /** Can this wallet sign without a prompt, as this shell checked it. */
  signing?: SignVerdict;
  /**
   * S7: set when signing works only through TENJIN_WALLET_KEY or
   * TENJIN_WALLET_PASSPHRASE in THIS shell, and no router that served a Claude
   * session confirmed it. A Claude Code started elsewhere may not have the
   * variable, so this is never rendered with a ✓.
   */
  shellOnly?: 'key' | 'passphrase';
  /** Where a created wallet's passphrase went. */
  passphrase?: WalletPassphrase;
}

/** The remedy for each skip, so no skipped state is ever a dead end. */
function walletFix(reason: WalletSkipReason, path?: string): string {
  switch (reason) {
    case 'no-passphrase-store':
      return `${FILE_STORE_FAILED_FIX(path ?? '~/.tenjin')} Then run \`tenjin install\` again.`;
    case 'passphrase-store-locked':
      // S3: never `--insecure-storage`; install output is read by agents.
      return 'The OS keychain did not answer (it may be locked), so no wallet was created. Unlock your keychain (or log in to the desktop session) and retry `tenjin install`.';
    case 'create-failed':
      return 'Fix the reported problem, then run `tenjin wallet create`.';
    case 'dry-run':
    case 'flag':
      return 'Create one with `tenjin wallet create`.';
  }
}

export function walletValue(w: WalletOutcome): string {
  const locked = w.signing?.status === 'blocked' ? ` - cannot unlock: ${w.signing.detail}` : '';
  if (w.status === 'existing') return `${w.address} (existing)${locked}`;
  if (w.status === 'created') return `${w.address}, $0 - fund with: tenjin wallet fund${locked}`;
  if (w.status === 'skipped') return `none (${w.reason}) - ${w.fix}`;
  return 'none - create with: tenjin wallet create';
}

/**
 * The wallet decision. A wallet is now created BY DEFAULT on both paths, because
 * the loop this command exists to set up does not close without one: `buy` needs
 * a funded key and publish-on-MISS needs a key to sign the write, so a walletless
 * install is a setup that stops at the first useful thing the agent tries.
 *
 * The headless path creates without asking. Create never prompts for the new
 * secret (Q1): it uses TENJIN_WALLET_PASSPHRASE when set, else a strong
 * generated passphrase, and saves it durably: the OS credential store, or
 * where there is none, the 0600 file, as the GitHub CLI does. Only a store that
 * did not answer (`passphrase-store-locked`) or a file that could not be
 * written (`no-passphrase-store`) leaves the machine without a wallet.
 *
 * A wallet that already exists, a TENJIN_WALLET_KEY included, is kept, and its
 * signing is checked the way a Claude Code started elsewhere would meet it: a
 * wallet that unlocks only through a variable in this shell is said so (S7).
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
  const env = deps.env ?? process.env;
  // A key-only machine has a wallet: create must never shadow it with a file.
  const keySet = (env.TENJIN_WALLET_KEY ?? '').trim().length > 0;
  const exists = keySet || (await (deps.walletExists ?? walletFileExists)(ctx.dataDir));
  if (exists) {
    const address = await (deps.walletAddress ?? ((c) => existingWalletAddress(c, deps)))(ctx);
    return {
      status: 'existing',
      address,
      ...(await signingFor(ctx, deps, address)),
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
    const made = await create(ctx);
    if (typeof made === 'string') {
      return { status: 'created', address: made, ...(await signingFor(ctx, deps, made)) };
    }
    return {
      status: 'created',
      address: made.address,
      ...(made.passphrase !== undefined ? { passphrase: made.passphrase } : {}),
      ...(await createdSigning(ctx, deps, made.address, made.passphrase)),
    };
  } catch (err) {
    return createSkip(err);
  }
}

/**
 * Create's refusal, classified: a FILE write that failed (decision 6: never
 * called a locked keychain), an OS store that did not answer, or anything
 * else, reported as itself.
 */
function createSkip(err: unknown): WalletOutcome {
  const store =
    err instanceof CliError
      ? (err.details as { passphraseStore?: { kind?: unknown; path?: unknown } } | undefined)
          ?.passphraseStore
      : undefined;
  if (store?.kind === 'file-write-failed') {
    const path = typeof store.path === 'string' ? store.path : undefined;
    return {
      status: 'skipped',
      reason: 'no-passphrase-store',
      fix: walletFix('no-passphrase-store', path),
    };
  }
  if (unlockReasonOf(err) === 'keychain_locked') {
    return {
      status: 'skipped',
      reason: 'passphrase-store-locked',
      fix: walletFix('passphrase-store-locked'),
    };
  }
  return {
    status: 'skipped',
    reason: 'create-failed',
    fix: walletFix('create-failed'),
    warning: `The wallet could not be created: ${errorText(err)}`,
  };
}

/**
 * A created wallet's signing, from where create put its passphrase: a durable
 * store (generated or env-origin, Q2) is ready from that store; an env secret
 * nothing durable holds is ready only through the variable, so `shellOnly`.
 */
async function createdSigning(
  ctx: CommandContext,
  deps: WalletDeps,
  address: string,
  passphrase: WalletPassphrase | undefined,
): Promise<Pick<WalletOutcome, 'signing' | 'shellOnly'>> {
  if (passphrase === undefined) return {};
  if (passphrase.durable && passphrase.store !== 'env') {
    return { signing: { status: 'ready', source: passphrase.store } };
  }
  return confirmShellOnly(ctx, deps, address, {
    signing: { status: 'ready', source: 'passphrase-env' },
    shellOnly: 'passphrase',
  });
}

/** An existing (or seam-created) wallet's signing, with `shellOnly` checked against a served router. */
async function signingFor(
  ctx: CommandContext,
  deps: WalletDeps,
  address: string,
): Promise<Pick<WalletOutcome, 'signing' | 'shellOnly'>> {
  const checked = await (
    deps.walletSigning ?? ((c: CommandContext) => defaultWalletSigning(c, deps))
  )(ctx, address).catch(() => ({ signing: unknownSign('check_failed') }));
  return confirmShellOnly(ctx, deps, address, checked);
}

/**
 * S7: `shellOnly` is cleared only when a router that served a Claude session
 * already signs for this address: that session demonstrably has the variable.
 */
async function confirmShellOnly(
  ctx: CommandContext,
  deps: WalletDeps,
  address: string,
  checked: { signing: SignVerdict; shellOnly?: 'key' | 'passphrase' },
): Promise<Pick<WalletOutcome, 'signing' | 'shellOnly'>> {
  if (checked.shellOnly === undefined) return { signing: checked.signing };
  const observed = await (
    deps.observedSigning ?? ((a: string) => defaultObserved(ctx.dataDir, deps, a))
  )(address).catch(() => false);
  return observed
    ? { signing: checked.signing }
    : { signing: checked.signing, shellOnly: checked.shellOnly };
}

/** An unknown verdict worded from UNKNOWN_DETAIL. */
function unknownSign(reason: 'check_failed'): SignVerdict {
  return { status: 'unknown', reason, detail: UNKNOWN_DETAIL[reason]! };
}

/** `env` without TENJIN_WALLET_PASSPHRASE: what a Claude Code started without it would see. */
function withoutEnvPassphrase(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const rest = { ...env };
  delete rest.TENJIN_WALLET_PASSPHRASE;
  return rest;
}

/**
 * CAN THIS WALLET SIGN, AS A CLAUDE CODE STARTED ELSEWHERE WOULD MEET IT.
 * Every verify forces `isTTY: false` and keeps its 5 s store-read deadline
 * (B3): an unattended install must never hang on a locked keychain, and a
 * killed read is unknown, never a block. Anything that throws is unknown too.
 *
 * 1. A valid TENJIN_WALLET_KEY signs, but only in a shell that sets it:
 *    `shellOnly: 'key'`.
 * 2. With TENJIN_WALLET_PASSPHRASE set, a SAVED passphrase is asked first (an
 *    env without the variable), the same verify doctor's `verifySaved` runs.
 *    Ready means every Claude Code can sign. Otherwise the full env: ready
 *    means only this variable opens it (`shellOnly: 'passphrase'`); anything
 *    else reports the saved-store verdict, except that "no passphrase" is not
 *    definite while the variable is set (S13): it is the full env's definite
 *    block (a wrong variable, `env_passphrase_wrong`) when there is one, as
 *    doctor reports it, and unknown otherwise.
 * 3. Otherwise one verify.
 */
export async function defaultWalletSigning(
  ctx: CommandContext,
  deps: Pick<WalletDeps, 'env' | 'walletPassphrase'> = {},
): Promise<{ signing: SignVerdict; shellOnly?: 'key' | 'passphrase' }> {
  const env = deps.env ?? process.env;
  const verify = async (e: NodeJS.ProcessEnv): Promise<SignVerdict> => {
    try {
      return signFromVerification(
        await verifyLocalWallet({
          dir: ctx.dataDir,
          env: e,
          ...(deps.walletPassphrase !== undefined ? { passphrase: deps.walletPassphrase } : {}),
        }),
      );
    } catch (err) {
      // A malformed key or an unreadable wallet.json throws a classified
      // error; anything unclassified is unknown, never a block.
      return canSign({
        envKey: 'absent',
        walletFile: 'present',
        unlock: { ok: false, reason: classifyUnlockError(err).reason },
      });
    }
  };
  try {
    if (PRIVATE_KEY_RE.test((env.TENJIN_WALLET_KEY ?? '').trim())) {
      return { signing: { status: 'ready', source: 'key-env' }, shellOnly: 'key' };
    }
    if ((env.TENJIN_WALLET_PASSPHRASE ?? '').length > 0) {
      const saved = await verify(withoutEnvPassphrase(env));
      if (saved.status === 'ready') return { signing: saved };
      const full = await verify(env);
      if (full.status === 'ready') {
        return { signing: { ...full, source: 'passphrase-env' }, shellOnly: 'passphrase' };
      }
      if (saved.status === 'blocked' && saved.reason === 'passphrase_missing') {
        // The variable was tried and definitely failed: that is the answer.
        if (isDefiniteBlock(full)) return { signing: full };
        return {
          signing: {
            status: 'unknown',
            reason: 'not_checked',
            detail: UNKNOWN_DETAIL['not_checked']!,
          },
        };
      }
      return { signing: saved };
    }
    return { signing: await verify(env) };
  } catch {
    return { signing: unknownSign('check_failed') };
  }
}

/**
 * Does a router that served a Claude session (B2) already sign for `address`?
 * A health-check router (`claude mcp get`), a Codex one or one that has served
 * no hook yet does not count: it says nothing about the session's own env.
 */
async function defaultObserved(
  dataDir: string,
  deps: WalletDeps,
  address: string,
): Promise<boolean> {
  const { snapshot } = await readProcessSnapshot({
    ...(deps.listProcesses !== undefined ? { listProcesses: deps.listProcesses } : {}),
    ...(deps.listMcpProcesses !== undefined ? { listMcpProcesses: deps.listMcpProcesses } : {}),
    installedAt: async () => null,
  });
  const live = servedObservations(
    liveObservations(await readObservations(dataDir), snapshot?.routers ?? null),
  );
  const want = address.toLowerCase();
  return live.some((o) => o.address?.toLowerCase() === want && o.sign.status === 'ready');
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The existing wallet's address, from this step's env (a TENJIN_WALLET_KEY included). */
async function existingWalletAddress(ctx: CommandContext, deps: WalletDeps): Promise<string> {
  return (
    await describeWallet(
      createLocalProvider({
        dir: ctx.dataDir,
        env: deps.env ?? process.env,
        passphrase: { ...deps.walletPassphrase, isTTY: false },
      }),
    )
  ).address;
}

async function defaultCreateWallet(
  ctx: CommandContext,
  passphrase?: PassphraseOverrides,
  env?: NodeJS.ProcessEnv,
): Promise<{ address: string; passphrase: WalletPassphrase }> {
  const result = await runWalletCreate(ctx, {
    // Create never prompts (Q1): this only picks the 10 s or 60 s store-write
    // bound, and whether the waiting line is printed (decision 18).
    passphrase: {
      ...passphrase,
      isTTY: ctx.io.isTTY,
      onWait: (line) => emitNotice(ctx.io, line, { json: ctx.flags.json }),
    },
    ...(env !== undefined ? { env } : {}),
  });
  const data = result.data as {
    address: string;
    passphraseSource: DurableStore | 'env';
    passphraseLocation: string;
    passphraseDurable: boolean;
    passphraseNote: string;
  };
  return {
    address: data.address,
    passphrase: {
      store: data.passphraseSource,
      location: data.passphraseLocation,
      durable: data.passphraseDurable,
      note: data.passphraseNote,
    },
  };
}

/** The shared confirm, defaulting to YES (setup ergonomics); cancel reads as no. */
function defaultConfirm(label: string): Promise<boolean> {
  return confirmChoice(label, true);
}
