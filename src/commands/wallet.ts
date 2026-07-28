import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { CliError } from '../lib/errors';
import { walletPath } from '../lib/paths';
import { withFileLock, LockTimeoutError } from '../lib/lock';
import { loadRawConfig, resolveSettings } from '../lib/config';
import { toMoney } from '../lib/money';
import { getUsdcBalance } from '../lib/usdc';
import {
  archiveLocalWallet,
  createLocalWallet,
  describeWallet,
  resolveWalletProvider,
  type ArchivedWalletInfo,
  type ResolveWalletProviderOptions,
} from '../lib/wallet';
import { walletFileExists } from '../lib/wallet/store';
import { resolvePassphraseForCreate, type PassphraseSource } from '../lib/wallet/passphrase';
import type { PassphraseOverrides } from '../lib/wallet/local';
import type { CommandContext, CommandResult } from '../context';

const FUNDING_LINE = 'Send USDC on Base. $5 covers ~50 typical resources.';
const KEY_STORAGE = 'encrypted (keystore v3, scrypt)';
const isWindows = process.platform === 'win32';

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
}

export async function runWalletCreate(
  ctx: CommandContext,
  opts: WalletCreateOptions = {},
): Promise<CommandResult> {
  const {
    address,
    walletPath: path,
    source,
    replaced,
  } = await createWalletLocked(ctx.dataDir, opts);

  const warnings = custodyWarnings();
  return {
    data: {
      address,
      walletPath: path,
      provider: 'local',
      policyEnforcement: 'client-only',
      keyStorage: KEY_STORAGE,
      passphraseSource: source,
      ...(replaced !== undefined
        ? {
            replaced: {
              address: replaced.address,
              archivedWalletPath: replaced.archivedPath,
              passphrasePreserved: replaced.passphraseLocation,
            },
          }
        : {}),
      warnings,
    },
    humanLines: [
      `Wallet created: ${address}`,
      `Key stored ${KEY_STORAGE}.`,
      passphraseNote(source, address),
      ...(replaced !== undefined ? replacedNote(replaced) : []),
      FUNDING_LINE,
      ...warnings,
    ],
  };
}

/** Where the outgoing wallet's funds live and why they remain reachable. */
function replacedNote(replaced: ArchivedWalletInfo): string[] {
  const account = replaced.address.toLowerCase();
  const passphraseLine =
    replaced.passphraseLocation === 'store'
      ? `its passphrase is preserved in the OS credential store (service tenjin-cli, account ${account}).`
      : replaced.passphraseLocation === 'env'
        ? 'its passphrase is TENJIN_WALLET_PASSPHRASE — keep that value.'
        : 'its passphrase could NOT be archived to an OS store; it exists only where you keep it.';
  return [
    `Previous wallet archived: ${replaced.address} still holds any funds sent to it.`,
    `Its keystore was moved to ${replaced.archivedPath}; ${passphraseLine}`,
  ];
}

/**
 * Run the whole create critical section under a cross-process file lock: the
 * existence pre-check, the passphrase generate-and-store, and the no-clobber
 * write. Without the lock these interleave across two concurrent creates — each
 * generates a distinct passphrase and persists it to the OS store BEFORE the
 * exclusive file write, so a different process could win the file while this
 * one's per-address entry names a wallet that never landed. Serializing means
 * the loser blocks until the winner commits, then trips refuseIfWalletExists and
 * exits WALLET_EXISTS having never generated or stored a passphrase. The
 * store-before-write ordering stays (it still guards the single-process crash
 * window), and the exclusive write stays the final authority.
 *
 * The passphrase is resolved INSIDE createLocalWallet's address callback so the
 * OS-store entry is keyed to the new wallet's own address — a create can only
 * ever write its own entry and can never overwrite (or delete) the entry of any
 * existing wallet (issue #32).
 */
async function createWalletLocked(
  dir: string,
  opts: WalletCreateOptions,
): Promise<{
  address: string;
  walletPath: string;
  source: PassphraseSource;
  replaced?: ArchivedWalletInfo;
}> {
  // Ensure the data dir exists so the lock's own mkdir has a parent on a fresh
  // install; the exclusive wallet write below re-ensures it at 0700 regardless.
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const lockPath = join(dir, 'wallet.create.lock');
  try {
    return await withFileLock(lockPath, async () => {
      let replaced: ArchivedWalletInfo | undefined;
      if (await walletFileExists(dir)) {
        if (opts.replace !== true) throw walletExistsError(dir);
        // Explicit --replace: park the outgoing wallet FIRST (passphrase proven
        // against its keystore and preserved under its own address, keystore
        // renamed aside) so the switch can never strand its funds. Any failure
        // in there aborts before the active slot changes.
        replaced = await archiveLocalWallet({
          dir,
          env: process.env,
          ...(opts.passphrase !== undefined ? { passphrase: opts.passphrase } : {}),
        });
      }
      let source: PassphraseSource = 'env';
      const { address, walletPath: path } = await createLocalWallet(dir, async (forAddress) => {
        const resolved = await resolvePassphraseForCreate(
          {
            env: process.env,
            dir,
            ...opts.passphrase,
          },
          forAddress,
        );
        source = resolved.source;
        return resolved.passphrase;
      });
      return { address, walletPath: path, source, ...(replaced !== undefined ? { replaced } : {}) };
    });
  } catch (err) {
    // A lock timeout is not the user's error; surface it as INTERNAL with the one
    // manual step (there is no auto-steal), keeping the JSON error contract. Every
    // other error — notably the loser's WALLET_EXISTS — propagates unchanged.
    if (err instanceof LockTimeoutError) {
      throw new CliError('INTERNAL', err.message, {
        fix: `If no other tenjin process is running, remove ${lockPath} and retry.`,
        cause: err,
      });
    }
    throw err;
  }
}

/** Where the encryption passphrase lives, and what the user must remember. */
function passphraseNote(source: PassphraseSource, address: string): string {
  const account = address.toLowerCase();
  switch (source) {
    case 'keychain':
      return `Passphrase saved to your macOS keychain (service tenjin-cli, account ${account}); signing will be transparent on this machine.`;
    case 'dpapi':
      return `Passphrase saved to a DPAPI-encrypted per-wallet file (passphrase.${account}.dpapi), readable only by you on this Windows machine; signing will be transparent here.`;
    case 'secret-service':
      return `Passphrase saved to your Linux keyring (Secret Service, service tenjin-cli, account ${account}); signing will be transparent on this machine.`;
    case 'env':
      return 'Encrypted with TENJIN_WALLET_PASSPHRASE; keep that value to sign.';
    case 'prompt':
      return 'Remember your passphrase: it is required to sign and cannot be recovered.';
  }
}

export async function runWalletShow(
  ctx: CommandContext,
  opts: ResolveWalletProviderOptions = {},
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

  const humanLines = [`Address: ${desc.address}`, `Key source: ${desc.credentialSource}`];
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
  return {
    data: { address: desc.address, balance },
    humanLines: [`Balance: ${balance.usd} USDC on Base`],
  };
}

/**
 * create refuses to overwrite by default: the wallet decrypts only with the
 * PASSPHRASE stored in the OS credential store, and losing either half strands
 * any funds. The explicit escape hatch is `--replace`, which archives the
 * outgoing wallet (verified passphrase preserved under its own address) rather
 * than destroying anything.
 */
function walletExistsError(dir: string): CliError {
  const path = walletPath(dir);
  return new CliError('WALLET_EXISTS', `A wallet already exists at ${path}.`, {
    fix: `Run \`tenjin wallet create --replace\` to archive it and create a new one: its keystore is parked beside the new wallet and its passphrase stays preserved in the OS credential store (service tenjin-cli, account = its address), so its funds remain reachable. That passphrase is unrecoverable — never delete the credential-store entry, or the wallet's funds are stranded.`,
  });
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
