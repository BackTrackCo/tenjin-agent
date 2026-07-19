import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import type { PrivateKeyAccount } from 'viem/accounts';
import type { Address, Hex } from 'viem';
import * as Keystore from 'ox/Keystore';
import { CliError } from '../errors';
import { walletPath } from '../paths';
import {
  PRIVATE_KEY_RE,
  readWalletRecord,
  walletFileMode,
  writeWalletRecord,
  type WalletRecord,
} from './store';
import { resolvePassphrase, type PassphraseDeps } from './passphrase';
import type {
  TenjinSigner,
  WalletDescription,
  WalletDiagnostics,
  WalletProvider,
} from './provider';

/** Passphrase seams the local provider forwards to the resolver (env comes from `deps.env`). */
export type PassphraseOverrides = Omit<PassphraseDeps, 'env'>;

export interface LocalProviderDeps {
  dir: string;
  env: NodeJS.ProcessEnv;
  /** Test seam for keychain exec / TTY prompt / platform during decryption. */
  passphrase?: PassphraseOverrides;
}

const isWindows = process.platform === 'win32';
const KEY_STORAGE = 'encrypted (keystore v3, scrypt)';

/**
 * A one-shot decrypt cache. The CLI is a single invocation, so a signer derived
 * once (scrypt is deliberately slow) is reused for the rest of the process.
 * Keyed by the keystore's unique id, so distinct wallets never collide.
 */
const signerCache = new Map<string, PrivateKeyAccount>();

/**
 * The only real B1 provider: a local viem account whose key comes from the env
 * override or the encrypted wallet file. `describe()` returns just the address
 * and posture WITHOUT a passphrase (the address is stored cleartext on purpose);
 * `getSigner()` is the single door to the key material and the only path that
 * decrypts the keystore.
 */
export function createLocalProvider(deps: LocalProviderDeps): WalletProvider {
  return {
    id: 'local',
    async describe(): Promise<WalletDescription> {
      const cred = resolveCredentialOrThrow(await loadCredential(deps));
      return {
        // A file credential's address is stored cleartext and returned as-is —
        // no decryption. An env credential derives (and thereby validates) its
        // key. getSigner is where a file wallet's key/address match is checked.
        address: cred.source === 'env' ? accountFromKey(cred.key, 'env').address : cred.address,
        provider: 'local',
        credentialSource: cred.source,
        policyEnforcement: 'client-only',
      };
    },
    async getSigner(): Promise<TenjinSigner> {
      const cred = resolveCredentialOrThrow(await loadCredential(deps));
      const account = await accountForSigning(cred, deps);
      return {
        address: account.address,
        signMessage: (args) => account.signMessage({ message: args.message }),
        signTypedData: (args) => account.signTypedData(args),
      };
    },
    diagnostics(): Promise<WalletDiagnostics> {
      return localWalletDiagnostics(deps);
    },
    async authorizeSpend(req) {
      const { loadConfig } = await import('../config');
      const { evaluateSpend, spentInWindow } = await import('./policy');
      const config = await loadConfig(deps.dir);
      return evaluateSpend(config, req, await spentInWindow(deps.dir));
    },
    async recordSpend(req) {
      const { appendSpend } = await import('./policy');
      await appendSpend(deps.dir, req);
    },
  };
}

/**
 * File-custody warnings for the local provider: an env key shadowing the file,
 * non-0600 perms, and the Windows "perms not checkable" note. Keyless. Also
 * reports the at-rest key protection (`keyStorage`) and — only when it is cheap
 * and side-effect-free (the env passphrase) — the passphrase source, so `show`
 * can surface custody posture without decrypting or probing the keychain.
 */
export async function localWalletDiagnostics(deps: LocalProviderDeps): Promise<WalletDiagnostics> {
  const mode = await walletFileMode(deps.dir);
  const fileExists = mode !== null;
  const envKey = deps.env.TENJIN_WALLET_KEY;
  const envSet = envKey !== undefined && envKey.length > 0;
  const path = walletPath(deps.dir);

  const warnings: string[] = [];
  if (envSet && fileExists) {
    warnings.push('TENJIN_WALLET_KEY is set and shadows the wallet file at runtime.');
  }
  if (mode !== null) {
    if (isWindows) {
      warnings.push('File permission checks are not available on Windows.');
    } else if (mode !== 0o600) {
      warnings.push(
        `Wallet file permissions are ${mode.toString(8)}, expected 600. Run \`chmod 600 ${path}\`.`,
      );
    }
  }
  const passphraseSource =
    deps.env.TENJIN_WALLET_PASSPHRASE !== undefined && deps.env.TENJIN_WALLET_PASSPHRASE.length > 0
      ? 'TENJIN_WALLET_PASSPHRASE'
      : undefined;
  return {
    ...(fileExists ? { walletPath: path, keyStorage: KEY_STORAGE } : {}),
    ...(fileExists && passphraseSource !== undefined ? { passphraseSource } : {}),
    warnings,
  };
}

export interface LocalWalletInfo {
  address: Address;
  walletPath: string;
}

/**
 * Generate a fresh key, encrypt it into a Keystore v3 document with `passphrase`,
 * and persist the record NO-CLOBBER. The raw key exists only in memory here and
 * is never written to disk in cleartext. The write, not a caller's pre-check, is
 * the authority: a lost create race throws WALLET_EXISTS rather than overwriting
 * a funded key.
 */
export async function createLocalWallet(dir: string, passphrase: string): Promise<LocalWalletInfo> {
  const key = generatePrivateKey();
  const address = privateKeyToAccount(key).address;
  const keystore = await encryptToKeystore(key, passphrase);
  await writeWalletRecord(dir, walletRecord(address, keystore));
  return { address, walletPath: walletPath(dir) };
}

type Credential =
  { source: 'env'; key: Hex } | { source: 'file'; keystore: Keystore.Keystore; address: Address };

/** Env override beats the wallet file (CI + ephemeral agents); null when neither exists. */
async function loadCredential(deps: LocalProviderDeps): Promise<Credential | null> {
  const envKey = deps.env.TENJIN_WALLET_KEY;
  if (envKey !== undefined && envKey.trim().length > 0) {
    const key = envKey.trim();
    if (!PRIVATE_KEY_RE.test(key)) {
      throw new CliError('WALLET_INVALID_KEY', 'TENJIN_WALLET_KEY is not a valid private key.', {
        fix: 'Set TENJIN_WALLET_KEY to a 0x-prefixed 32-byte hex key, or unset it to use the wallet file.',
      });
    }
    return { source: 'env', key: key as Hex };
  }
  const record = await readWalletRecord(deps.dir);
  if (record !== null) {
    return { source: 'file', keystore: record.keystore, address: record.address as Address };
  }
  return null;
}

/**
 * Build the viem account for SIGNING. An env credential uses its raw key; a file
 * credential decrypts the keystore with the resolved passphrase, then verifies
 * the recovered key derives the stored cleartext address (a tamper signal) before
 * trusting it. A wrong passphrase or corrupt keystore surfaces as
 * WALLET_INVALID_KEY that names where the passphrase comes from.
 */
async function accountForSigning(
  cred: Credential,
  deps: LocalProviderDeps,
): Promise<PrivateKeyAccount> {
  if (cred.source === 'env') return accountFromKey(cred.key, 'env');

  const cached = signerCache.get(cred.keystore.id);
  if (cached !== undefined) return cached;

  const { passphrase } = await resolvePassphrase({
    env: deps.env,
    dir: deps.dir,
    ...deps.passphrase,
  });
  let key: Hex;
  try {
    const derived = await Keystore.toKeyAsync(cred.keystore, { password: passphrase });
    key = Keystore.decrypt(cred.keystore, derived);
  } catch (err) {
    throw new CliError('WALLET_INVALID_KEY', 'Could not decrypt the wallet keystore.', {
      fix: 'Check the passphrase: TENJIN_WALLET_PASSPHRASE, the macOS keychain (service tenjin-cli), or the one you enter when prompted.',
      cause: err,
    });
  }
  const account = accountFromKey(key, 'file');
  if (account.address.toLowerCase() !== cred.address.toLowerCase()) {
    throw new CliError(
      'WALLET_INVALID_KEY',
      `The decrypted key derives ${account.address}, not the wallet file's stored address ${cred.address}.`,
      {
        fix: 'The wallet file may be tampered. Move it aside, then run `tenjin wallet create` for a fresh key or set TENJIN_WALLET_KEY to use the intended one.',
      },
    );
  }
  signerCache.set(cred.keystore.id, account);
  return account;
}

/** viem account from a raw key, mapping viem's throw on a bad key to WALLET_INVALID_KEY. */
function accountFromKey(key: Hex, source: 'env' | 'file'): PrivateKeyAccount {
  try {
    return privateKeyToAccount(key);
  } catch (err) {
    throw new CliError('WALLET_INVALID_KEY', 'The private key is not a valid secp256k1 key.', {
      fix:
        source === 'file'
          ? 'Move the wallet file aside, then run `tenjin wallet create` for a fresh key or set TENJIN_WALLET_KEY to use the intended one.'
          : 'Set TENJIN_WALLET_KEY to a valid 0x-prefixed 32-byte hex key.',
      cause: err,
    });
  }
}

/** Encrypt a raw key into a Keystore v3 document using ox's default scrypt parameters. */
async function encryptToKeystore(key: Hex, passphrase: string): Promise<Keystore.Keystore> {
  const [derivedKey, opts] = await Keystore.scryptAsync({ password: passphrase });
  return Keystore.encrypt(key, derivedKey, opts);
}

function resolveCredentialOrThrow(cred: Credential | null): Credential {
  if (cred === null) {
    throw new CliError('WALLET_MISSING', 'No wallet found.', {
      fix: 'Run `tenjin wallet create` to create one.',
    });
  }
  return cred;
}

function walletRecord(address: Address, keystore: Keystore.Keystore): WalletRecord {
  return {
    schemaVersion: 2,
    provider: 'local',
    address,
    keystore,
    createdAt: new Date().toISOString(),
  };
}
