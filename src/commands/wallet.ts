import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { CliError } from '../lib/errors';
import { walletPath } from '../lib/paths';
import { withFileLock, LockTimeoutError } from '../lib/lock';
import { loadRawConfig, resolveSettings } from '../lib/config';
import { toMoney } from '../lib/money';
import { getUsdcBalance } from '../lib/usdc';
import {
  createLocalWallet,
  describeWallet,
  resolveWalletProvider,
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
  /** Test seam for passphrase resolution (keychain exec, TTY prompt, platform). */
  passphrase?: PassphraseOverrides;
}

export async function runWalletCreate(
  ctx: CommandContext,
  opts: WalletCreateOptions = {},
): Promise<CommandResult> {
  const { address, walletPath: path, source } = await createWalletLocked(ctx.dataDir, opts);

  const warnings = custodyWarnings();
  return {
    data: {
      address,
      walletPath: path,
      provider: 'local',
      policyEnforcement: 'client-only',
      keyStorage: KEY_STORAGE,
      passphraseSource: source,
      warnings,
    },
    humanLines: [
      `Wallet created: ${address}`,
      `Key stored ${KEY_STORAGE}.`,
      passphraseNote(source),
      FUNDING_LINE,
      ...warnings,
    ],
  };
}

/**
 * Run the whole create critical section under a cross-process file lock: the
 * existence pre-check, the passphrase generate-and-store, and the no-clobber
 * write. Without the lock these interleave across two concurrent creates — each
 * generates a distinct passphrase and persists it to the OS store (which is
 * last-writer-wins on every platform) BEFORE the exclusive file write, so a
 * different process can win the file, orphaning the winning wallet from the
 * passphrase the store now holds (which then decrypts nothing, unrecoverably).
 * Serializing means the loser blocks until the winner commits, then trips
 * refuseIfWalletExists and exits WALLET_EXISTS having never generated or stored a
 * passphrase. The store-before-write ordering stays (it still guards the
 * single-process crash window), and the exclusive write stays the final authority.
 */
async function createWalletLocked(
  dir: string,
  opts: WalletCreateOptions,
): Promise<{ address: string; walletPath: string; source: PassphraseSource }> {
  // Ensure the data dir exists so the lock's own mkdir has a parent on a fresh
  // install; the exclusive wallet write below re-ensures it at 0700 regardless.
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const lockPath = join(dir, 'wallet.create.lock');
  try {
    return await withFileLock(lockPath, async () => {
      await refuseIfWalletExists(dir);
      const { passphrase, source } = await resolvePassphraseForCreate({
        env: process.env,
        dir,
        ...opts.passphrase,
      });
      const { address, walletPath: path } = await createLocalWallet(dir, passphrase);
      return { address, walletPath: path, source };
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
function passphraseNote(source: PassphraseSource): string {
  switch (source) {
    case 'keychain':
      return 'Passphrase saved to your macOS keychain (service tenjin-cli); signing will be transparent on this machine.';
    case 'dpapi':
      return 'Passphrase saved to a DPAPI-encrypted file, readable only by you on this Windows machine; signing will be transparent here.';
    case 'secret-service':
      return 'Passphrase saved to your Linux keyring (Secret Service, service tenjin-cli); signing will be transparent on this machine.';
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
  const { walletPath: path, keyStorage, passphraseSource, warnings } = await provider.diagnostics();

  const humanLines = [`Address: ${desc.address}`, `Key source: ${desc.credentialSource}`];
  if (keyStorage !== undefined) humanLines.push(`Key storage: ${keyStorage}`);
  if (passphraseSource !== undefined) humanLines.push(`Passphrase: ${passphraseSource}`);
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

/** create refuses to overwrite: keys are non-recoverable and may hold funds. */
async function refuseIfWalletExists(dir: string): Promise<void> {
  if (!(await walletFileExists(dir))) return;
  const path = walletPath(dir);
  throw new CliError('WALLET_EXISTS', `A wallet already exists at ${path}.`, {
    fix: `Keys are non-recoverable; move it aside first (e.g. \`mv ${path} ${path}.bak\`) to create a new one.`,
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
