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
 * The encryption passphrase for a create: a fixed string, or a resolver invoked
 * with the freshly derived ADDRESS — so passphrase storage can be keyed to the
 * wallet's own per-address OS-store entry before the key is ever encrypted.
 */
export type CreatePassphrase = string | ((address: Address) => Promise<string>);

/**
 * Generate a fresh key, resolve the passphrase FOR THAT ADDRESS (the resolver
 * runs after key generation so per-wallet passphrase entries are keyed by the
 * new address, and before encryption so a stored passphrase always exists by the
 * time an encrypted wallet does), encrypt the key into a Keystore v3 document,
 * and persist the record NO-CLOBBER. The raw key exists only in memory here and
 * is never written to disk in cleartext. The write, not a caller's pre-check, is
 * the authority: a lost create race throws WALLET_EXISTS rather than overwriting
 * a funded key.
 */
export async function createLocalWallet(
  dir: string,
  passphrase: CreatePassphrase,
): Promise<LocalWalletInfo> {
  const key = generatePrivateKey();
  const address = privateKeyToAccount(key).address;
  const resolved = typeof passphrase === 'string' ? passphrase : await passphrase(address);
  const keystore = await encryptToKeystore(key, resolved);
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
 * credential resolves the passphrase FOR ITS ADDRESS (its own per-address OS
 * store entry, with the legacy shared slot as a migration fallback), decrypts
 * the keystore, then verifies the recovered key derives the stored cleartext
 * address (a tamper signal) before trusting it. A legacy-served passphrase is
 * re-keyed under the wallet's own address only AFTER that proof — a decrypt
 * failure means the legacy slot belongs to some other wallet, so it is left
 * untouched and the ambiguity is surfaced instead of guessed away. A wrong
 * passphrase or corrupt keystore surfaces as WALLET_INVALID_KEY that names where
 * the passphrase comes from.
 */
async function accountForSigning(
  cred: Credential,
  deps: LocalProviderDeps,
): Promise<PrivateKeyAccount> {
  if (cred.source === 'env') return accountFromKey(cred.key, 'env');

  const cached = signerCache.get(cred.keystore.id);
  if (cached !== undefined) return cached;

  const resolved = await resolvePassphrase(
    {
      env: deps.env,
      dir: deps.dir,
      ...deps.passphrase,
    },
    cred.address,
  );
  let key: Hex;
  try {
    const derived = await Keystore.toKeyAsync(cred.keystore, { password: resolved.passphrase });
    key = Keystore.decrypt(cred.keystore, derived);
  } catch (err) {
    if (resolved.migrateLegacy !== undefined) {
      // The only durable passphrase came from the legacy shared slot and it does
      // NOT decrypt this wallet: it almost certainly belongs to whichever wallet
      // was created last before per-wallet entries existed. Do not migrate, do
      // not delete — surface the ambiguity and leave the entry for its owner.
      throw new CliError(
        'WALLET_INVALID_KEY',
        'The legacy shared passphrase entry (service tenjin-cli, account "wallet") does not decrypt this wallet.',
        {
          fix: "That entry likely belongs to a different wallet created later and was left untouched. If you know this wallet's passphrase, set TENJIN_WALLET_PASSPHRASE or enter it at the prompt in a terminal.",
          cause: err,
        },
      );
    }
    throw new CliError('WALLET_INVALID_KEY', 'Could not decrypt the wallet keystore.', {
      fix: `Check the passphrase: TENJIN_WALLET_PASSPHRASE, the OS credential store (service tenjin-cli, account ${cred.address.toLowerCase()}), or the one you enter when prompted.`,
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
  // Decrypt + address check passed: this wallet provably owns the legacy
  // passphrase, so re-key it under the wallet's own address (copy, verify, then
  // remove the legacy slot). Best-effort: on failure the legacy entry remains
  // the durable copy and the next signing retries the migration.
  if (resolved.migrateLegacy !== undefined) await resolved.migrateLegacy();
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
