import { mkdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { CliError } from '../lib/errors';
import { emitNotice } from '../lib/output';
import { walletPath } from '../lib/paths';
import { withFileLock, LockTimeoutError } from '../lib/lock';
import { loadRawConfig, resolveSettings } from '../lib/config';
import { toMoney } from '../lib/money';
import { getUsdcBalance } from '../lib/usdc';
import { addressQrLines } from '../lib/qr';
import { writePassphraseRecord } from '../lib/passphrase-record';
import { NO_KEYRING_LINE, REPAIR_CLAUSE, REPAIR_IN_TERMINAL } from '../lib/wallet-unlock';
import { channelCredit } from '../router/channel-credit';
import { FUND_COMMAND_LINE, FUNDING_LINE, ROUTING_FEE_ATOMIC } from '../router/fee';
import { markUnlockPending } from '../router/router-observation';
import {
  commitLocalWallet,
  createLocalWallet,
  describeWallet,
  openKeystore,
  parkOutgoingWallet,
  prepareLocalWallet,
  repairLocalWalletPassphrase,
  resolveWalletProvider,
  restoreParkedWallet,
  verifyAndPreserveOutgoingWallet,
  type ArchivedWalletInfo,
  type ResolveWalletProviderOptions,
} from '../lib/wallet';
import {
  readWalletRecord,
  walletExistsError,
  walletFileExists,
  type WalletRecord,
} from '../lib/wallet/store';
import {
  describeStoreLocation,
  promptPassphrase,
  resolvePassphrase,
  resolvePassphraseForCreate,
  STORE_TIMEOUTS,
  storeNoun,
  unstorableWhy,
  type CreatePassphraseResult,
  type DurableStore,
} from '../lib/wallet/passphrase';
import type { PassphraseOverrides } from '../lib/wallet/local';
import type { CommandContext, CommandResult } from '../context';

const KEY_STORAGE = 'encrypted (keystore v3, scrypt)';
const isWindows = process.platform === 'win32';

/** The last line `tenjin wallet repair` prints: the save is proven, the unlock is not yet. */
export const REPAIR_DONE_LINE = 'Passphrase saved; start a new Claude Code session to verify.';

export interface WalletCreateOptions {
  /**
   * Explicitly replace the existing active wallet (mirrors the `--yes`-style
   * explicit-flag precedent): the outgoing wallet is ARCHIVED — passphrase
   * verified against its keystore and preserved under its own address, keystore
   * parked beside the new one — never destroyed. Without it, create refuses
   * when a wallet exists. There is always exactly ONE active wallet.
   */
  replace?: boolean;
  /** Test seam for passphrase resolution (keychain exec, TTY prompt, platform). */
  passphrase?: PassphraseOverrides;
  /**
   * The environment TENJIN_WALLET_PASSPHRASE is read from; defaults to
   * process.env. A seam rather than a global read so a caller (and above all a
   * test) can settle the passphrase source WITHOUT mutating the real process
   * environment, which under a parallel runner leaks across whole test files.
   */
  env?: NodeJS.ProcessEnv;
  /**
   * `--insecure-storage`: save the passphrase to the 0600 file even where an OS
   * keychain exists. For a person who chose it; never suggested by an error.
   */
  insecureStorage?: boolean;
}

export async function runWalletCreate(
  ctx: CommandContext,
  opts: WalletCreateOptions = {},
): Promise<CommandResult> {
  const { address, walletPath: path, passphrase, replaced } = await createWalletLocked(ctx, opts);

  const note = passphraseNote(passphrase, address, ctx.dataDir);
  const warnings = custodyWarnings();
  return {
    data: {
      address,
      walletPath: path,
      provider: 'local',
      policyEnforcement: 'client-only',
      keyStorage: KEY_STORAGE,
      passphraseSource: passphrase.source,
      passphraseLocation: passphrase.location,
      passphraseOrigin: passphrase.origin,
      passphraseDurable: passphrase.durable,
      passphraseNote: note,
      ...(replaced !== undefined
        ? {
            replaced: {
              address: replaced.address,
              archivedWalletPath: replaced.archivedPath,
              passphrasePreserved: replaced.passphraseLocation,
              ...(replaced.unarchivedReason !== undefined
                ? { unarchivedReason: replaced.unarchivedReason }
                : {}),
            },
          }
        : {}),
      warnings,
    },
    humanLines: [
      `Wallet created: ${address}`,
      `Key stored ${KEY_STORAGE}.`,
      note,
      ...(replaced !== undefined ? replacedNote(replaced, path) : []),
      FUNDING_LINE,
      ...warnings,
    ],
  };
}

/** Where the outgoing wallet's funds live, why they remain reachable, and how to restore it. */
function replacedNote(replaced: ArchivedWalletInfo, activeWalletPath: string): string[] {
  const passphraseLine =
    replaced.passphraseLocation === 'store'
      ? `its passphrase is preserved in ${replaced.location ?? `the OS credential store (service tenjin-cli, account ${replaced.account})`}.`
      : replaced.passphraseLocation === 'env'
        ? 'its passphrase is TENJIN_WALLET_PASSPHRASE — keep that value.'
        : replaced.unarchivedReason === 'rejected-characters'
          ? 'its passphrase was NOT archived: the macOS keychain writer only stores printable ASCII passphrases, and this typed one contains other characters. Keep it yourself, or set TENJIN_WALLET_PASSPHRASE to it.'
          : 'its passphrase was NOT archived: this platform has no OS credential store. It exists only where you keep it.';
  return [
    `Previous wallet archived: ${replaced.address} still holds any funds sent to it.`,
    `Its keystore was moved to ${replaced.archivedPath}; ${passphraseLine}`,
    `To make it the active wallet again later: move the current ${activeWalletPath} aside first, then \`mv ${replaced.archivedPath} ${activeWalletPath}\`.`,
  ];
}

/**
 * Run `fn` under the cross-process wallet lock (`<dir>/wallet.create.lock`):
 * create, `--replace` and repair all change where a wallet's passphrase lives,
 * and the sidecar's read-modify-write assumes one writer at a time.
 *
 * A lock timeout is not the user's error; it surfaces as INTERNAL with the one
 * manual step (there is no auto-steal), keeping the JSON error contract. Every
 * other error — notably a create loser's WALLET_EXISTS — propagates unchanged.
 */
export async function withWalletLock<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  // Ensure the data dir exists so the lock's own mkdir has a parent on a fresh
  // install; the exclusive wallet write re-ensures it at 0700 regardless.
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const lockPath = join(dir, 'wallet.create.lock');
  try {
    return await withFileLock(lockPath, fn);
  } catch (err) {
    if (err instanceof LockTimeoutError) {
      throw new CliError('INTERNAL', err.message, {
        fix: `If no other tenjin process is running, remove ${lockPath} and retry.`,
        cause: err,
      });
    }
    throw err;
  }
}

/**
 * Run the whole create critical section under the wallet lock: the existence
 * pre-check, the passphrase choose-and-store, and the no-clobber write. Without
 * the lock these interleave across two concurrent creates — each generates a
 * distinct passphrase and persists it BEFORE the exclusive file write, so a
 * different process could win the file while this one's per-address entry
 * names a wallet that never landed. Serializing means the loser blocks until
 * the winner commits, then trips the exists check and exits WALLET_EXISTS
 * having never generated or stored a passphrase. The store-before-write
 * ordering stays (it still guards the single-process crash window), and the
 * exclusive write stays the final authority.
 *
 * The passphrase is resolved inside the prepare step's address callback so the
 * store entry is keyed to the new wallet's own address (issue #32), and the
 * sidecar records where it went BEFORE the key is encrypted: a sidecar that
 * cannot be written aborts the create, so no wallet exists whose passphrase
 * location nobody recorded.
 *
 * `--replace` ordering closes the no-active-wallet window: verify-and-preserve
 * the outgoing wallet (no file moves), fully PREPARE the replacement (key,
 * stored passphrase, encrypted keystore — every fallible step) while the old
 * wallet is still active, and only then park the old keystore and commit the
 * new one. A commit failure rolls the park back, so at every exit either the
 * old or the new wallet is the active one.
 */
async function createWalletLocked(
  ctx: CommandContext,
  opts: WalletCreateOptions,
): Promise<{
  address: string;
  walletPath: string;
  passphrase: CreatePassphraseResult;
  replaced?: ArchivedWalletInfo;
}> {
  const dir = ctx.dataDir;
  return withWalletLock(dir, async () => {
    const env = opts.env ?? process.env;
    let chosen: CreatePassphraseResult | undefined;
    const passphraseFor = async (forAddress: string): Promise<string> => {
      const resolved = await resolvePassphraseForCreate(
        {
          env,
          dir,
          ...opts.passphrase,
          // Create never prompts; this only picks the 10 s or 60 s write bound.
          isTTY: opts.passphrase?.isTTY ?? ctx.io.isTTY,
          onWait: (line) => emitNotice(ctx.io, line, { json: ctx.flags.json }),
        },
        forAddress,
        { insecureStorage: opts.insecureStorage === true },
      );
      if (resolved.durable && resolved.source !== 'env') {
        await writePassphraseRecord(dir, forAddress, { store: resolved.source, by: 'create' });
      }
      chosen = resolved;
      return resolved.passphrase;
    };
    const result = (path: { address: string; walletPath: string }) => {
      if (chosen === undefined) throw new CliError('INTERNAL', 'No wallet passphrase was chosen.');
      return { ...path, passphrase: chosen };
    };

    if (!(await walletFileExists(dir))) {
      return result(await createLocalWallet(dir, passphraseFor));
    }

    if (opts.replace !== true) throw walletExistsError(dir);
    const preserved = await verifyAndPreserveOutgoingWallet({
      dir,
      env,
      ...(opts.passphrase !== undefined ? { passphrase: opts.passphrase } : {}),
    });
    const prepared = await prepareLocalWallet(passphraseFor);
    const archivedPath = await parkOutgoingWallet(dir, preserved.account);
    try {
      const committed = await commitLocalWallet(dir, prepared);
      return { ...result(committed), replaced: { ...preserved, archivedPath } };
    } catch (err) {
      try {
        await restoreParkedWallet(dir, archivedPath);
      } catch (restoreErr) {
        // The no-clobber restore also refuses when a wallet.json appeared out
        // of band (commit EEXIST) — never overwrite it; name both files.
        throw new CliError(
          'INTERNAL',
          'Creating the replacement wallet failed after the old wallet was parked, and restoring it also failed.',
          {
            fix: `Your old wallet ${preserved.address} is intact at ${archivedPath} with its passphrase preserved. If a ${walletPath(dir)} now exists, another process wrote it — move it aside first. Then restore with \`mv ${archivedPath} ${walletPath(dir)}\`.`,
            cause: restoreErr,
          },
        );
      }
      // Old wallet restored as the active one; say so rather than surfacing a
      // raw fs error (or a WALLET_EXISTS whose fix suggests re-running --replace).
      throw new CliError(
        'INTERNAL',
        'Creating the replacement wallet failed; the previous wallet was restored and is the active wallet again.',
        {
          fix: 'Nothing was lost. Fix the underlying error, then retry `tenjin wallet create --replace`.',
          cause: err,
        },
      );
    }
  });
}

/**
 * THE ONE LINE THAT SAYS WHERE THE PASSPHRASE WENT (Q2, S4). A generated secret
 * in an OS store keeps today's three notes byte for byte; an env secret saved
 * there says the variable is no longer needed; the 0600 file says why it was
 * used; and an env secret nothing durable holds says so, and how to fix it
 * once the store answers. Every line that names `tenjin wallet repair` carries
 * REPAIR_CLAUSE, and a file failure never names a keychain (decision 6).
 */
export function passphraseNote(p: CreatePassphraseResult, address: string, dir: string): string {
  const account = address.toLowerCase();
  if (!p.durable) {
    const attempted = p.attempted ?? 'keychain';
    const only = 'so Claude Code can unlock this wallet only where that variable is set.';
    switch (p.notSaved) {
      case 'rejected-characters':
        // Repair would refuse the same value: the variable is the fix.
        return `Encrypted with TENJIN_WALLET_PASSPHRASE only: ${unstorableWhy(attempted)}, ${only} Keep it set in the environment Claude Code starts from.`;
      case 'conflict':
      case 'kept-existing':
        return `Encrypted with TENJIN_WALLET_PASSPHRASE only: ${describeStoreLocation(attempted, account, dir)} already holds a different passphrase for this wallet, ${only} Run \`tenjin wallet repair\` yourself ${REPAIR_CLAUSE} to replace it.`;
      default:
        break;
    }
    if (attempted === 'file') {
      const path = describeStoreLocation('file', account, dir);
      return `Encrypted with TENJIN_WALLET_PASSPHRASE only: Tenjin could not save the passphrase to ${path}, ${only} Check that ${dirname(path)} is writable, then run \`tenjin wallet repair\` yourself ${REPAIR_CLAUSE}.`;
    }
    if (p.notSaved === 'store-failed') {
      return `Encrypted with TENJIN_WALLET_PASSPHRASE only: Tenjin could not save the passphrase to the ${storeNoun(attempted)}, ${only} Run \`tenjin wallet repair\` yourself ${REPAIR_CLAUSE}.`;
    }
    return `Encrypted with TENJIN_WALLET_PASSPHRASE only: the ${storeNoun(attempted)} did not answer, ${only} Once it answers, run \`tenjin wallet repair\` yourself ${REPAIR_CLAUSE}.`;
  }
  if (p.source === 'file' || p.source === 'env') {
    if (p.fileReason === 'insecure-storage') {
      return `Passphrase saved to ${p.location} (readable only by you). Anyone who can read that file and wallet.json can spend this wallet.`;
    }
    return NO_KEYRING_LINE(p.location);
  }
  if (p.origin === 'env') {
    return `Passphrase from TENJIN_WALLET_PASSPHRASE saved to ${p.location}; Claude Code can unlock this wallet without the variable.`;
  }
  switch (p.source) {
    case 'keychain':
      return `Passphrase saved to your macOS keychain (service tenjin-cli, account ${account}); signing will be transparent on this machine.`;
    case 'dpapi':
      return `Passphrase saved to a DPAPI-encrypted per-wallet file (passphrase.${account}.dpapi), readable only by you on this Windows machine; signing will be transparent here.`;
    case 'secret-service':
      return `Passphrase saved to your Linux keyring (Secret Service, service tenjin-cli, account ${account}); signing will be transparent on this machine.`;
  }
}

export interface WalletRepairOptions {
  /** `--insecure-storage`: save to the 0600 file even where an OS keychain exists. */
  insecureStorage?: boolean;
  /** Test seam for passphrase storage (keychain exec, TTY prompt, platform). */
  passphrase?: PassphraseOverrides;
  /** The environment TENJIN_WALLET_PASSPHRASE is read from; defaults to process.env. */
  env?: NodeJS.ProcessEnv;
  /** The home directory whose shell startup files are scanned for an export; defaults to os.homedir(). */
  home?: string;
  /** Reads one startup file, null when it cannot be read; a seam for tests. */
  readText?: (path: string) => Promise<string | null>;
}

/** What `tenjin wallet repair --json` prints. */
export interface WalletRepairData {
  address: string;
  passphraseStore: DurableStore;
  location: string;
  alreadySaved: boolean;
  replacedUnusableEntry: boolean;
  envOverride: {
    state: 'unset' | 'matches' | 'wrong';
    exports: Array<{ file: string; line: number }>;
  };
  restartRequired: true;
  next: typeof REPAIR_DONE_LINE;
}

/** The shell startup files a TENJIN_WALLET_PASSPHRASE export usually lives in, relative to home. */
const SHELL_STARTUP_FILES = [
  '.zshrc',
  '.zprofile',
  '.zshenv',
  '.bashrc',
  '.bash_profile',
  '.profile',
  '.config/fish/config.fish',
];

/**
 * `tenjin wallet repair`: for a wallet Claude Code cannot unlock. A PERSON runs
 * it, in their own terminal: it asks for the passphrase at a hidden prompt (or
 * uses TENJIN_WALLET_PASSPHRASE when that opens the wallet), proves it opens
 * this wallet, saves it where Claude Code's router can read it without a
 * prompt, and marks the unlock as awaiting confirmation, which the next
 * session's router confirms ("Tenjin wallet unlocked.").
 *
 * With no terminal and a wrong variable, the saved passphrase is checked in
 * its place, so a headless run still names the variable when the saved one
 * already opens the wallet. With no terminal and nothing usable it refuses with
 * REPAIR_IN_TERMINAL and never suggests passing the passphrase inline (B1): a passphrase never
 * goes on a command line or into chat. It reports success only when the store
 * reads this passphrase back (S1). A TENJIN_WALLET_PASSPHRASE in this shell
 * that does not open the wallet is named, with the startup-file line that
 * exports it, because it shadows the saved passphrase until removed.
 */
export async function runWalletRepair(
  ctx: CommandContext,
  opts: WalletRepairOptions = {},
): Promise<CommandResult> {
  const env = opts.env ?? process.env;
  const dir = ctx.dataDir;
  const record = await readWalletRecord(dir);
  if (record === null) {
    throw new CliError('WALLET_MISSING', 'No wallet found to repair.', {
      fix: 'Run `tenjin wallet create` to create one.',
    });
  }
  const address = record.address;
  const humanPre: string[] = [];
  const envKey = env.TENJIN_WALLET_KEY;
  if (envKey !== undefined && envKey.trim().length > 0) {
    humanPre.push(
      'TENJIN_WALLET_KEY is set and shadows the wallet file; repair fixes only the file wallet.',
    );
  }

  const fromEnv = env.TENJIN_WALLET_PASSPHRASE;
  let envState: WalletRepairData['envOverride']['state'] = 'unset';
  let candidate: string | undefined;
  if (fromEnv !== undefined && fromEnv.length > 0) {
    const opened = await openKeystore(record.keystore, address, fromEnv);
    envState = opened === 'wrong' ? 'wrong' : 'matches';
    // A mismatch is a tampered file; repair refuses it below with the tamper error.
    if (opened !== 'wrong') candidate = fromEnv;
  }
  const interactive = ctx.io.isTTY && (opts.passphrase?.isTTY ?? Boolean(process.stdin.isTTY));
  if (candidate === undefined && !interactive && envState === 'wrong') {
    // Headless with a wrong variable: a SAVED passphrase that opens the wallet
    // is the candidate, so an agent's run reaches the same conflict line (unset
    // the variable) a person's prompt would, instead of a bare USAGE.
    candidate = await savedPassphraseThatOpens(dir, env, record, opts.passphrase);
  }
  if (candidate === undefined) {
    if (!interactive) {
      throw new CliError(
        'USAGE',
        envState === 'wrong'
          ? 'No passphrase to check: TENJIN_WALLET_PASSPHRASE is set but does not open this wallet, and no saved passphrase does.'
          : 'No passphrase to check.',
        { fix: REPAIR_IN_TERMINAL },
      );
    }
    const entered = await promptPassphrase(
      { env, ...opts.passphrase },
      `Passphrase for wallet ${address}: `,
    );
    if (entered.length === 0) {
      throw new CliError('USAGE', 'No passphrase entered; nothing was saved.', {
        fix: REPAIR_IN_TERMINAL,
      });
    }
    candidate = entered;
  }

  const passphrase = candidate;
  const outcome = await withWalletLock(dir, () =>
    repairLocalWalletPassphrase(
      {
        dir,
        env,
        passphrase: {
          ...opts.passphrase,
          isTTY: ctx.io.isTTY,
          onWait: (line) => emitNotice(ctx.io, line, { json: ctx.flags.json }),
        },
      },
      passphrase,
      opts.insecureStorage === true ? { insecureStorage: true } : {},
    ),
  );
  // The next session's router confirms the unlock and says so once. A failure
  // to record that only costs the confirmation line, never the saved passphrase,
  // so it does not fail a repair that is already proven.
  await markUnlockPending(dir, outcome.address).catch(() => undefined);

  const exports =
    envState === 'unset' ? [] : await scanShellExports(opts.home ?? homedir(), opts.readText);
  const savedLine = outcome.alreadySaved
    ? `Already saved in ${outcome.location}.`
    : outcome.fileReason === 'no-keyring'
      ? NO_KEYRING_LINE(outcome.location)
      : `Saved to ${outcome.location}.`;
  const envLine =
    envState === 'wrong'
      ? `! TENJIN_WALLET_PASSPHRASE is set in this shell but does not open this wallet. Tenjin now uses the saved passphrase, but remove the variable: \`unset TENJIN_WALLET_PASSPHRASE\`${
          exports.length > 0
            ? `, and delete the export at ${exports.map((e) => `${e.file}:${e.line}`).join(', ')}`
            : ''
        }.`
      : envState === 'matches'
        ? 'TENJIN_WALLET_PASSPHRASE in this shell matches; the saved copy is enough, so you can remove it.'
        : null;

  const data: WalletRepairData = {
    address: outcome.address,
    passphraseStore: outcome.store,
    location: outcome.location,
    alreadySaved: outcome.alreadySaved,
    replacedUnusableEntry: outcome.replacedUnusableEntry,
    envOverride: { state: envState, exports },
    restartRequired: true,
    next: REPAIR_DONE_LINE,
  };
  return {
    data,
    humanLines: [
      ...humanPre,
      `Wallet: ${outcome.address}`,
      'Passphrase verified: it opens this wallet.',
      savedLine,
      ...(envLine !== null ? [envLine] : []),
      REPAIR_DONE_LINE,
    ],
  };
}

/**
 * The saved passphrase (keychain, 0600 file or legacy slot; never the variable
 * and never a prompt) when it opens this wallet, else undefined. Reads are
 * bounded like doctor's verify, so a locked keychain cannot hang a headless
 * run; any failure to read reads as "none".
 */
async function savedPassphraseThatOpens(
  dir: string,
  env: NodeJS.ProcessEnv,
  record: WalletRecord,
  overrides: PassphraseOverrides | undefined,
): Promise<string | undefined> {
  try {
    const saved = await resolvePassphrase(
      {
        env,
        dir,
        ...overrides,
        isTTY: false,
        readDeadlineMs: overrides?.timeouts?.verifyReadMs ?? STORE_TIMEOUTS.verifyReadMs,
      },
      record.address,
      { skipEnv: true },
    );
    const opened = await openKeystore(record.keystore, record.address, saved.passphrase);
    return opened === 'ok' ? saved.passphrase : undefined;
  } catch {
    return undefined;
  }
}

/** Every TENJIN_WALLET_PASSPHRASE line in the usual shell startup files, as `~/<file>:<line>`. */
async function scanShellExports(
  home: string,
  readText: (path: string) => Promise<string | null> = (path) =>
    readFile(path, 'utf8').catch(() => null),
): Promise<Array<{ file: string; line: number }>> {
  const files: Array<{ path: string; text: string }> = [];
  for (const rel of SHELL_STARTUP_FILES) {
    const text = await readText(join(home, rel));
    if (text !== null) files.push({ path: `~/${rel}`, text });
  }
  return findPassphraseExports(files);
}

/**
 * The lines that set TENJIN_WALLET_PASSPHRASE (any `export`, `set -gx` or plain
 * assignment naming it), skipping `#` comments. Line numbers are 1-based, as an
 * editor shows them. Only the location is returned, never the line's text: the
 * line may hold the passphrase itself.
 */
export function findPassphraseExports(
  files: Array<{ path: string; text: string }>,
): Array<{ file: string; line: number }> {
  const found: Array<{ file: string; line: number }> = [];
  for (const { path, text } of files) {
    text.split(/\r?\n/).forEach((line, i) => {
      if (line.trimStart().startsWith('#')) return;
      if (/\bTENJIN_WALLET_PASSPHRASE\b/.test(line)) found.push({ file: path, line: i + 1 });
    });
  }
  return found;
}

export interface WalletShowOptions extends ResolveWalletProviderOptions {
  /** `--no-qr`: print the address without the QR block at a TTY. */
  qr?: boolean;
}

export async function runWalletShow(
  ctx: CommandContext,
  opts: WalletShowOptions = {},
): Promise<CommandResult> {
  const provider = resolveWalletProvider(ctx, opts);
  const desc = await describeWallet(provider);
  // Diagnostics are the provider's own: a remote provider reports no local file
  // path or perms warning, so `show` never contaminates a remote wallet's output
  // with a stale local wallet.json's state. keyStorage/passphraseSource are the
  // custody posture reported without decrypting or requiring a passphrase.
  const {
    walletPath: path,
    keyStorage,
    passphraseSource,
    archivedWallets,
    warnings,
  } = await provider.diagnostics();

  const humanLines = [
    `Address: ${desc.address}`,
    ...(opts.qr !== false && ctx.io.isTTY && !ctx.flags.json
      ? addressQrLines(desc.address, ctx.io.stdout)
      : []),
    `Key source: ${desc.credentialSource}`,
  ];
  if (keyStorage !== undefined) humanLines.push(`Key storage: ${keyStorage}`);
  if (passphraseSource !== undefined) humanLines.push(`Passphrase: ${passphraseSource}`);
  if (archivedWallets !== undefined && archivedWallets.length > 0) {
    // A recovery hint, not a wallet switcher: exactly one wallet is ever active.
    humanLines.push(
      `Archived (replaced) wallets, funds recoverable via their preserved passphrases: ${archivedWallets.join(', ')}`,
    );
  }
  humanLines.push(...warnings);

  return {
    data: {
      address: desc.address,
      provider: desc.provider,
      credentialSource: desc.credentialSource,
      policyEnforcement: desc.policyEnforcement,
      ...(path !== undefined ? { walletPath: path } : {}),
      ...(keyStorage !== undefined ? { keyStorage } : {}),
      ...(passphraseSource !== undefined ? { passphraseSource } : {}),
      ...(archivedWallets !== undefined && archivedWallets.length > 0 ? { archivedWallets } : {}),
      warnings,
    },
    humanLines,
  };
}

export async function runWalletBalance(
  ctx: CommandContext,
  opts: ResolveWalletProviderOptions = {},
): Promise<CommandResult> {
  const provider = resolveWalletProvider(ctx, opts);
  const desc = await describeWallet(provider);

  const config = await loadRawConfig(ctx.dataDir);
  const rpcUrl = resolveSettings({
    config,
    flags: { baseUrl: ctx.flags.baseUrl },
    env: process.env,
  }).rpcUrl.value;

  let atomic: bigint;
  try {
    atomic = await getUsdcBalance(desc.address, rpcUrl);
  } catch (err) {
    throw new CliError('RPC_ERROR', `Could not read the USDC balance from ${rpcUrl}.`, {
      fix: 'Check your network, or set a working RPC with `tenjin config set rpcUrl <url>`.',
      cause: err,
    });
  }

  const balance = toMoney(atomic.toString());
  // The routing balance is a local estimate, separate from on-chain funds.
  const credit = toMoney(
    (await channelCredit(ctx.dataDir, desc.address).catch(() => 0n)).toString(),
  );
  return {
    data: { address: desc.address, balance, routingCredit: credit },
    humanLines: [
      `Balance: ${balance.usd} USDC on Base`,
      ...(credit.atomic !== '0'
        ? [`Set aside for routing: approximately $${credit.usd} (local estimate).`]
        : []),
      ...(atomic === 0n && BigInt(credit.atomic) < ROUTING_FEE_ATOMIC ? [FUND_COMMAND_LINE] : []),
    ],
  };
}

function custodyWarnings(): string[] {
  const warnings: string[] = [];
  if (hasEnvKey()) {
    warnings.push('TENJIN_WALLET_KEY is set and shadows this file at runtime.');
  }
  if (isWindows) {
    warnings.push('File permissions are not enforced on Windows; the key file is not restricted.');
  }
  return warnings;
}

function hasEnvKey(): boolean {
  const envKey = process.env.TENJIN_WALLET_KEY;
  return envKey !== undefined && envKey.length > 0;
}
