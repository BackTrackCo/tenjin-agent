import { link, readdir, stat, unlink } from 'node:fs/promises';
import { fsyncDir } from '../atomic-json';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import type { PrivateKeyAccount } from 'viem/accounts';
import type { Address, Hex } from 'viem';
import * as Keystore from 'ox/Keystore';
import { CliError } from '../errors';
import { deriveKeystoreKey, type KeystoreDerivationOptions } from './keystore-kdf';
import { hasCode } from '../errno';
import { archivedWalletPath, passphraseFilePathFor, walletPath } from '../paths';
import { readPassphraseRecord, writePassphraseRecord } from '../passphrase-record';
import {
  ENV_PASSPHRASE_WRONG,
  FILE_STORE_FAILED_FIX,
  KEYCHAIN_LOCKED_FIX,
  REPAIR_CLAUSE,
  REPAIR_IN_TERMINAL,
  unlockDetails,
  unlockReasonOf,
  type DurableStore,
  type SigningSource,
} from '../wallet-unlock';
import {
  PRIVATE_KEY_RE,
  WALLET_SCHEMA_VERSION,
  readWalletRecord,
  walletFileMode,
  writeWalletRecord,
  type WalletRecord,
} from './store';
import {
  STORE_TIMEOUTS,
  describeStoreLocation,
  probeDurableStore,
  readStoredPassphrase,
  resolvePassphrase,
  storeDurablyDetailed,
  storeNoun,
  toStoreOutcome,
  unstorableWhy,
  walletStoreAccount,
  type PassphraseDeps,
  type PassphraseSource,
  type ResolvedPassphrase,
  type StorePassphraseOutcome,
} from './passphrase';
import type {
  TenjinSigner,
  WalletDescription,
  WalletDiagnostics,
  WalletProvider,
  WalletVerification,
} from './provider';

/** Passphrase seams the local provider forwards to the resolver (env comes from `deps.env`). */
export type PassphraseOverrides = Omit<PassphraseDeps, 'env'>;

/**
 * Said once per provider instance per keystore: TENJIN_WALLET_PASSPHRASE does
 * not open the wallet, a saved passphrase did, and signing went ahead with it.
 */
export interface WalletWarning {
  code: 'env_passphrase_wrong';
  message: typeof ENV_PASSPHRASE_WRONG;
}

export interface LocalProviderDeps {
  dir: string;
  env: NodeJS.ProcessEnv;
  /** Test seam for keychain exec / TTY prompt / platform during decryption. */
  passphrase?: PassphraseOverrides;
  /** Bounds only pure KDF work; credential-store migration remains unchanged. */
  derivation?: KeystoreDerivationOptions;
  /** Fired at most once per provider instance per keystore id, including on a cache hit. */
  onWarning?: (w: WalletWarning) => void;
}

const isWindows = process.platform === 'win32';
const KEY_STORAGE = 'encrypted (keystore v3, scrypt)';

/**
 * A one-shot decrypt cache. The CLI is a single invocation, so a signer derived
 * once (scrypt is deliberately slow) is reused for the rest of the process.
 * Keyed by the keystore's unique id, so distinct wallets never collide.
 * `envShadowed` remembers that a wrong TENJIN_WALLET_PASSPHRASE was passed over
 * to get there, so a provider that hits the cache still says so once.
 */
const signerCache = new Map<string, { account: PrivateKeyAccount; envShadowed: boolean }>();

/**
 * The only real B1 provider: a local viem account whose key comes from the env
 * override or the encrypted wallet file. `describe()` returns just the address
 * and posture WITHOUT a passphrase (the address is stored cleartext on purpose);
 * `getSigner()` is the single door to key material a caller can SIGN with.
 * `verify()` also decrypts, but returns a verdict rather than the key.
 *
 * Each instance warns once per keystore that a wrong TENJIN_WALLET_PASSPHRASE
 * was passed over, even when another instance decrypted first and this one
 * only hit the cache: the routing payer's provider must still hear it when the
 * request tool's provider unlocked the wallet.
 */
export function createLocalProvider(deps: LocalProviderDeps): WalletProvider {
  const warned = new Set<string>();
  const warnOnce = (keystoreId: string): void => {
    if (warned.has(keystoreId)) return;
    warned.add(keystoreId);
    deps.onWarning?.({ code: 'env_passphrase_wrong', message: ENV_PASSPHRASE_WRONG });
  };
  return {
    id: 'local',
    async describe(): Promise<WalletDescription> {
      const cred = await credentialOrThrow(deps);
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
      const cred = await credentialOrThrow(deps);
      const account = await accountForSigning(cred, deps, warnOnce);
      return {
        address: account.address,
        signMessage: (args) => account.signMessage({ message: args.message }),
        signTypedData: (args) => account.signTypedData(args),
        signTransaction: (tx) => account.signTransaction(tx),
      };
    },
    diagnostics(): Promise<WalletDiagnostics> {
      return localWalletDiagnostics(deps);
    },
    verify(): Promise<WalletVerification> {
      return verifyLocalWallet(deps);
    },
  };
}

/** What decrypting a keystore with one passphrase proved. */
type Opened =
  | { kind: 'ok'; account: PrivateKeyAccount }
  | { kind: 'wrong'; cause: unknown }
  /** Decrypts, but to a key that is not this wallet's: a tampered file. `derived` is null for a key off the curve. */
  | { kind: 'mismatch'; derived: Address | null; cause?: unknown };

/**
 * THE decrypt-and-compare, shared by signing, verify, `--replace` and repair:
 * derive (scrypt), decrypt (MAC-checked), then require the key to derive the
 * stored address. A cancelled or timed-out derivation is rethrown, never read
 * as a wrong passphrase: it says nothing about the passphrase, and must never
 * trigger a migration or a "wrong" verdict.
 */
async function openKeystoreAccount(
  keystore: Keystore.Keystore,
  address: string,
  passphrase: string,
  derivation?: KeystoreDerivationOptions,
): Promise<Opened> {
  let key: Hex;
  try {
    const derived = await deriveKeystoreKey(keystore, passphrase, derivation);
    key = Keystore.decrypt(keystore, derived);
  } catch (err) {
    if (isCancellation(err)) throw err;
    return { kind: 'wrong', cause: err };
  }
  let account: PrivateKeyAccount;
  try {
    account = privateKeyToAccount(key);
  } catch (err) {
    return { kind: 'mismatch', derived: null, cause: err };
  }
  if (account.address.toLowerCase() !== address.toLowerCase()) {
    return { kind: 'mismatch', derived: account.address };
  }
  return { kind: 'ok', account };
}

/**
 * Does `passphrase` open this keystore? `ok`, `wrong` (it does not decrypt), or
 * `mismatch` (it decrypts to a key that is not this wallet's: tampered).
 * Rethrows AbortError / TimeoutError from the derivation.
 */
export async function openKeystore(
  keystore: Keystore.Keystore,
  address: string,
  passphrase: string,
  derivation?: KeystoreDerivationOptions,
): Promise<'ok' | 'wrong' | 'mismatch'> {
  return (await openKeystoreAccount(keystore, address, passphrase, derivation)).kind;
}

function isCancellation(err: unknown): boolean {
  return err instanceof Error && ['AbortError', 'TimeoutError'].includes(err.name);
}

/** The person's fix when TENJIN_WALLET_PASSPHRASE opens nothing and no saved passphrase does either (B1). */
const ENV_WRONG_FIX = `TENJIN_WALLET_PASSPHRASE is set but does not open this wallet. Remove it from the environment, then: ${REPAIR_IN_TERMINAL}`;

/** The person's fix when a STORED passphrase does not decrypt the wallet (the line-568 shape). */
function storedWrongFix(source: PassphraseSource, account: string, dir: string): string {
  return `${storedEntryText(source, account, dir)} does not decrypt it. ${REPAIR_IN_TERMINAL}`;
}

/** "The OS credential store entry (…)" for keychain/keyring, the file or blob otherwise. */
function storedEntryText(source: PassphraseSource, account: string, dir: string): string {
  if (source === 'keychain' || source === 'secret-service') {
    return `The OS credential store entry (service tenjin-cli, account ${account})`;
  }
  if (source === 'dpapi' || source === 'file') {
    return `The passphrase in ${describeStoreLocation(source, account, dir)}`;
  }
  return `The passphrase from ${passphraseOrigin(source, account, dir)}`;
}

/** The legacy-slot fix: the entry is someone else's; repair is for a person who knows this one's. */
function legacyWrongFix(source: PassphraseSource, account: string, dir: string): string {
  return `That passphrase likely belongs to a wallet created later, and the entry was left untouched. If you know this wallet's passphrase: ${REPAIR_IN_TERMINAL} Otherwise restore ${passphraseOrigin(source, account, dir)} from a backup.`;
}

/**
 * Can this wallet actually sign, without asking anyone? An env key is proven by
 * deriving it; a file wallet needs its passphrase from the env or a saved
 * store, and the keystore decrypted and checked against the stored address.
 *
 * Nothing here prompts (`isTTY: false` is forced last, so no test seam can turn
 * it back on) and nothing here writes: a legacy-slot hit is used to decrypt but
 * its `migrateLegacy` handle is deliberately never invoked, and the signer cache
 * is left alone so the migration still happens on the first real signing. Both
 * would be side effects of a read-only diagnostic.
 *
 * A wrong TENJIN_WALLET_PASSPHRASE falls through to the saved passphrase, the
 * same way signing does: verified with `warning: ENV_PASSPHRASE_WRONG` when that
 * opens it, broken `env_passphrase_wrong` when nothing does.
 *
 * The one read path with a deadline (B3): `doctor` and `install` run unattended
 * and a locked keychain would otherwise hang them, so every store read here,
 * fallback included, gets `STORE_TIMEOUTS.verifyReadMs`. A killed read is
 * `keychain_locked`, which is unknown, never a block. Signing passes none.
 */
export async function verifyLocalWallet(deps: LocalProviderDeps): Promise<WalletVerification> {
  const cred = await loadCredential(deps);
  // Details read as a fragment: the caller prefixes them with the wallet line.
  if (cred === null) return { status: 'unverified', detail: 'there is no credential to verify' };
  if (cred.source === 'env') {
    // Deriving is the whole proof for a raw key, and it is cheap.
    accountFromKey(cred.key, 'env');
    return {
      status: 'verified',
      detail: 'TENJIN_WALLET_KEY derives a valid signing key',
      source: 'key-env',
    };
  }

  const account = walletStoreAccount(cred.address);
  const passphraseDeps: PassphraseDeps = {
    env: deps.env,
    dir: deps.dir,
    ...deps.passphrase,
    isTTY: false,
    readDeadlineMs: deps.passphrase?.timeouts?.verifyReadMs ?? STORE_TIMEOUTS.verifyReadMs,
  };
  const unreachable = (err: unknown): WalletVerification => {
    if (unlockReasonOf(err) === 'keychain_locked') {
      const store = (err as CliError).details as {
        unlock?: { source?: string };
        storeDetail?: string;
      };
      const noun = isDurableStore(store.unlock?.source)
        ? storeNoun(store.unlock.source)
        : 'keychain';
      return {
        status: 'unverified',
        reason: 'keychain_locked',
        detail: `the ${noun} did not answer (${store.storeDetail ?? 'no answer'}), so the keystore was not opened`,
      };
    }
    return {
      status: 'unverified',
      reason: 'passphrase_missing',
      detail: 'no passphrase is reachable without prompting, so the keystore was not opened',
    };
  };

  let resolved: ResolvedPassphrase;
  try {
    resolved = await resolvePassphrase(passphraseDeps, cred.address);
  } catch (err) {
    return unreachable(err);
  }

  const cancelled: WalletVerification = {
    status: 'unverified',
    reason: 'unlock_timeout',
    detail: 'keystore verification was cancelled or timed out',
  };
  let opened: Opened;
  try {
    opened = await openKeystoreAccount(
      cred.keystore,
      account,
      resolved.passphrase,
      deps.derivation,
    );
  } catch {
    return cancelled;
  }
  const origin = resolvedOrigin(resolved, account, deps.dir);
  if (opened.kind === 'ok') {
    return {
      status: 'verified',
      detail: `keystore decrypts with the passphrase from ${origin}`,
      source: signingSourceOf(resolved),
    };
  }
  if (opened.kind === 'mismatch') return tamperedVerification(cred.address, opened);

  // The #70 shape: the only durable passphrase is the pre-per-address shared
  // slot and it belongs to some later wallet, so this keystore is unopenable
  // and the address it identifies you by is unsignable. Named apart from a
  // plain wrong passphrase because the remedy is different.
  if (resolved.migrateLegacy !== undefined) {
    return {
      status: 'broken',
      reason: 'passphrase_wrong',
      detail: `the keystore cannot be decrypted: the only stored passphrase is ${legacyOrigin(resolved.source)}, which does not open it`,
      fix: legacyWrongFix(resolved.source, account, deps.dir),
    };
  }
  if (resolved.source !== 'env') {
    return {
      status: 'broken',
      reason: 'passphrase_wrong',
      detail: `the keystore cannot be decrypted with the passphrase from ${origin}`,
      fix: storedWrongFix(resolved.source, account, deps.dir),
    };
  }

  // A wrong TENJIN_WALLET_PASSPHRASE: does a SAVED passphrase open it?
  let saved: ResolvedPassphrase;
  try {
    saved = await resolvePassphrase(passphraseDeps, cred.address, { skipEnv: true });
  } catch (err) {
    if (unlockReasonOf(err) === 'keychain_locked') return unreachable(err);
    return envWrongVerification();
  }
  let fallback: Opened;
  try {
    fallback = await openKeystoreAccount(cred.keystore, account, saved.passphrase, deps.derivation);
  } catch {
    return cancelled;
  }
  if (fallback.kind === 'ok') {
    return {
      status: 'verified',
      detail: `keystore decrypts with the passphrase from ${resolvedOrigin(saved, account, deps.dir)}; TENJIN_WALLET_PASSPHRASE does not open it`,
      source: signingSourceOf(saved),
      warning: ENV_PASSPHRASE_WRONG,
    };
  }
  if (fallback.kind === 'mismatch') return tamperedVerification(cred.address, fallback);
  return envWrongVerification();
}

function envWrongVerification(): WalletVerification {
  return {
    status: 'broken',
    reason: 'env_passphrase_wrong',
    detail: 'the keystore cannot be decrypted with the passphrase from TENJIN_WALLET_PASSPHRASE',
    fix: ENV_WRONG_FIX,
  };
}

function tamperedVerification(
  address: string,
  opened: Extract<Opened, { kind: 'mismatch' }>,
): WalletVerification {
  return {
    status: 'broken',
    reason: 'wallet_corrupt',
    detail:
      opened.derived === null
        ? 'the decrypted key is not a valid secp256k1 key'
        : `the decrypted key does not derive the wallet file's stored address ${address}`,
    fix: 'The wallet file may be tampered. Move it aside, then run `tenjin wallet create` for a fresh key or set TENJIN_WALLET_KEY to use the intended one.',
  };
}

/** What produced a signature, as doctor and install report it. */
function signingSourceOf(resolved: ResolvedPassphrase): SigningSource {
  if (resolved.migrateLegacy !== undefined) return 'legacy';
  if (resolved.source === 'env') return 'passphrase-env';
  // isTTY is forced false wherever this is asked, so 'prompt' cannot happen;
  // name it the file rather than invent a source.
  return resolved.source === 'prompt' ? 'file' : resolved.source;
}

function isDurableStore(value: unknown): value is DurableStore {
  return (
    value === 'keychain' || value === 'secret-service' || value === 'dpapi' || value === 'file'
  );
}

/** Where a resolved passphrase came from, the legacy slot named as such. */
function resolvedOrigin(resolved: ResolvedPassphrase, account: string, dir: string): string {
  return resolved.migrateLegacy !== undefined
    ? legacyOrigin(resolved.source)
    : passphraseOrigin(resolved.source, account, dir);
}

/**
 * Where a resolved passphrase came from, in words an operator can act on.
 * Windows stores a per-wallet DPAPI file rather than a service/account entry, so
 * naming one model for both would send that operator looking for something that
 * does not exist on their machine.
 */
function passphraseOrigin(source: PassphraseSource, account: string, dir?: string): string {
  if (source === 'env') return 'TENJIN_WALLET_PASSPHRASE';
  if (source === 'prompt') return 'the prompt';
  if (source === 'dpapi') return `the DPAPI-protected passphrase file for ${account}`;
  if (source === 'file') return describeStoreLocation('file', account, dir);
  return `the OS credential store (service tenjin-cli, account ${account})`;
}

/** The same, for the pre-per-wallet shared slot every backend still reads once. */
function legacyOrigin(source: PassphraseSource): string {
  return source === 'dpapi'
    ? 'the legacy shared DPAPI passphrase file (passphrase.dpapi)'
    : 'the legacy shared entry (service tenjin-cli, account "wallet")';
}

/**
 * File-custody warnings for the local provider: an env key shadowing the file,
 * non-0600 perms (the wallet file, and the passphrase file when the sidecar says
 * that is where the passphrase lives), and the Windows "perms not checkable"
 * note. Keyless. Also reports the at-rest key protection (`keyStorage`), where
 * the sidecar says the passphrase was saved (`passphraseStore`, a file read, not
 * a store probe) and — only when it is cheap and side-effect-free (the env
 * passphrase) — the passphrase source, so `show` can surface custody posture
 * without decrypting or probing the keychain.
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
  const passphraseStore = fileExists ? await recordedStore(deps.dir) : null;
  if (passphraseStore?.store === 'file' && !isWindows) {
    const plain = passphraseFilePathFor(passphraseStore.account, deps.dir);
    const plainMode = await stat(plain).then(
      (s) => s.mode & 0o777,
      () => null,
    );
    if (plainMode !== null && plainMode !== 0o600) {
      warnings.push(
        `Passphrase file permissions are ${plainMode.toString(8)}, expected 600. Run \`chmod 600 ${plain}\`.`,
      );
    }
  }
  const passphraseSource =
    deps.env.TENJIN_WALLET_PASSPHRASE !== undefined && deps.env.TENJIN_WALLET_PASSPHRASE.length > 0
      ? 'TENJIN_WALLET_PASSPHRASE'
      : undefined;
  const archivedWallets = await listArchivedWallets(deps.dir);
  return {
    ...(fileExists ? { walletPath: path, keyStorage: KEY_STORAGE } : {}),
    ...(fileExists && passphraseSource !== undefined ? { passphraseSource } : {}),
    ...(passphraseStore !== null ? { passphraseStore: passphraseStore.store } : {}),
    ...(archivedWallets.length > 0 ? { archivedWallets } : {}),
    warnings,
  };
}

/** The sidecar's store for the active wallet file, or null (no record, or no readable wallet). */
async function recordedStore(
  dir: string,
): Promise<{ store: DurableStore; account: string } | null> {
  const record = await readWalletRecord(dir).catch(() => null);
  if (record === null) return null;
  const account = record.address.toLowerCase();
  const entry = await readPassphraseRecord(dir, account);
  return entry === null ? null : { store: entry.store, account };
}

/** Archive filenames written by `wallet create --replace`; group 1 is the address. */
const ARCHIVED_WALLET_RE = /^wallet\.(0x[0-9a-f]{40})\.json\.bak$/;

/**
 * Addresses of wallets parked by `wallet create --replace`, from a cheap dir
 * scan (no keychain probe, no file reads — the address is the filename). A
 * recovery hint for `show`; the single-active-wallet model reads none of these.
 */
async function listArchivedWallets(dir: string): Promise<string[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return []; // No data dir yet: nothing archived.
  }
  return names
    .map((name) => ARCHIVED_WALLET_RE.exec(name)?.[1])
    .filter((address): address is string => address !== undefined)
    .sort();
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
 * A wallet fully built in memory but not yet on disk — so `--replace` can
 * finish every fallible step BEFORE touching the active slot.
 */
export interface PreparedLocalWallet {
  address: Address;
  record: WalletRecord;
}

/**
 * Generate a fresh key, resolve the passphrase FOR THAT ADDRESS (before
 * encryption, so a stored passphrase always exists by the time an encrypted
 * wallet does), and encrypt — no disk write, no cleartext key anywhere.
 */
export async function prepareLocalWallet(
  passphrase: CreatePassphrase,
): Promise<PreparedLocalWallet> {
  const key = generatePrivateKey();
  const address = privateKeyToAccount(key).address;
  const resolved = typeof passphrase === 'string' ? passphrase : await passphrase(address);
  const keystore = await encryptToKeystore(key, resolved);
  return { address, record: walletRecord(address, keystore) };
}

/**
 * Persist a prepared wallet NO-CLOBBER. The write, not a caller's pre-check, is
 * the authority: a lost create race throws WALLET_EXISTS rather than
 * overwriting a funded key.
 */
export async function commitLocalWallet(
  dir: string,
  prepared: PreparedLocalWallet,
): Promise<LocalWalletInfo> {
  await writeWalletRecord(dir, prepared.record);
  return { address: prepared.address, walletPath: walletPath(dir) };
}

/** Prepare + commit in one step — the plain `wallet create` path. */
export async function createLocalWallet(
  dir: string,
  passphrase: CreatePassphrase,
): Promise<LocalWalletInfo> {
  return commitLocalWallet(dir, await prepareLocalWallet(passphrase));
}

/** Where the archived wallet's passphrase remains durable after a --replace. */
export type ArchivedPassphraseLocation = 'store' | 'env' | 'unarchived';
/**
 * When `unarchived`: why no durable copy could be made. Only these two park the
 * outgoing wallet without one; an `uncertain` or `store-failed` write refuses
 * the replace instead.
 */
export type UnarchivedReason = Extract<StorePassphraseOutcome, 'no-store' | 'rejected-characters'>;

export interface PreservedWalletInfo {
  address: Address;
  /** The wallet's OS-store account / archive filename key (lowercase address). */
  account: string;
  passphraseLocation: ArchivedPassphraseLocation;
  unarchivedReason?: UnarchivedReason;
  /** When `store`: where the passphrase is kept (describeStoreLocation), if known. */
  location?: string;
}

export interface ArchivedWalletInfo extends PreservedWalletInfo {
  /** Where the keystore file was parked (wallet.<address>.json.bak). */
  archivedPath: string;
}

/**
 * The verify-and-preserve half of `--replace`: prove the outgoing wallet's
 * passphrase decrypts its keystore (MAC + derived-address check), then ensure a
 * durable per-address copy exists (legacy slot re-keyed, REFUSING on failure).
 * Touches no wallet file — the park runs separately, after the replacement is
 * fully prepared, so every failure here leaves the old wallet active and
 * untouched.
 *
 * THE ONE PROMPT LEFT IN CREATE (decision 6). When no env value or saved store
 * serves the OUTGOING wallet's passphrase, a person at a terminal is asked for
 * it, by that wallet's address. The new wallet's secret is never prompted for.
 * A prompt-entered passphrase is then saved durably: to the platform store when
 * its probe answers, the 0600 file where there is none, and the replace refuses
 * when the store does not answer or does not read the passphrase back (S1):
 * parking a funded wallet with no durable copy of its passphrase is how funds
 * get stranded. Only a proven write records the sidecar (`by: 'replace'`). The
 * one exception kept from before: a typed passphrase the keychain writer cannot
 * store at all (`rejected-characters`) is parked `unarchived`, and create's
 * output says so.
 */
export async function verifyAndPreserveOutgoingWallet(
  deps: LocalProviderDeps,
): Promise<PreservedWalletInfo> {
  const record = await readWalletRecord(deps.dir);
  if (record === null) {
    throw new CliError('WALLET_MISSING', 'No wallet found to archive.', {
      fix: 'Run `tenjin wallet create` without --replace.',
    });
  }
  const address = record.address as Address;
  const account = walletStoreAccount(address);
  const passphraseDeps: PassphraseDeps = { env: deps.env, dir: deps.dir, ...deps.passphrase };
  const resolved = await resolvePassphrase(passphraseDeps, address, {
    promptLabel: `Passphrase for the existing wallet ${address}: `,
  });

  let opened: Opened;
  try {
    opened = await openKeystoreAccount(record.keystore, account, resolved.passphrase);
  } catch (err) {
    opened = { kind: 'wrong', cause: err };
  }
  if (opened.kind === 'wrong') {
    // Name the escape that actually applies to where the passphrase came from:
    // once a store serves a value, resolution never falls through to a prompt.
    // A person at a terminal runs --replace, so this keeps its own wording.
    const escape =
      resolved.source === 'prompt'
        ? "Retry and enter that wallet's correct passphrase at the prompt, or set TENJIN_WALLET_PASSPHRASE to it"
        : resolved.source === 'env'
          ? 'TENJIN_WALLET_PASSPHRASE is set but does not decrypt it; set it to the correct passphrase'
          : `Set TENJIN_WALLET_PASSPHRASE to its passphrase, or fix ${storedEntryText(resolved.source, account, deps.dir).replace(/^The /, 'the ')}`;
    throw new CliError(
      'REFUSED',
      `Cannot verify the passphrase of the existing wallet ${address}; --replace refused.`,
      {
        fix: `Replacing now could strand that wallet's funds. ${escape}, then retry.`,
        cause: opened.cause,
      },
    );
  }
  if (opened.kind === 'mismatch') {
    throw new CliError(
      'REFUSED',
      `The wallet file's stored address ${address} does not match its key; --replace refused.`,
      {
        fix: 'The wallet file may be tampered. Resolve that before replacing it.',
        details: unlockDetails('wallet_corrupt'),
      },
    );
  }

  // A durable per-address copy must exist BEFORE the active slot changes hands.
  if (resolved.source === 'env') {
    return { address, account, passphraseLocation: 'env' };
  }
  if (resolved.migrateLegacy !== undefined) {
    if (!(await resolved.migrateLegacy())) {
      throw new CliError(
        'REFUSED',
        `Could not archive the existing wallet's passphrase under its own address; --replace refused.`,
        {
          fix: `The passphrase currently lives only in the legacy shared slot (service tenjin-cli, account "wallet"), and copying it to account ${account} failed. Retry, or check OS credential store access.`,
        },
      );
    }
    return { address, account, passphraseLocation: 'store' };
  }
  if (resolved.source === 'prompt') {
    return archivePromptedPassphrase(
      passphraseDeps,
      deps.dir,
      address,
      account,
      resolved.passphrase,
    );
  }
  // Served from its own entry (a store, or the 0600 file): already archived.
  return {
    address,
    account,
    passphraseLocation: 'store',
    location: describeStoreLocation(resolved.source, account, deps.dir),
  };
}

/** Save a prompt-entered outgoing passphrase durably, or refuse the replace (see above). */
async function archivePromptedPassphrase(
  passphraseDeps: PassphraseDeps,
  dir: string,
  address: Address,
  account: string,
  passphrase: string,
): Promise<PreservedWalletInfo> {
  const probed = await probeDurableStore(passphraseDeps);
  if (probed.probe === 'uncertain') throw outgoingUncertainError(probed.store);
  const target: DurableStore = probed.probe === 'available' ? probed.store : 'file';
  const written = await storeDurablyDetailed(passphraseDeps, target, address, passphrase);
  // A file cannot be "locked": an fs error there is a failed write, and its
  // fix is the directory, never a keychain (decision 6).
  const outcome =
    target === 'file' && written.outcome === 'uncertain'
      ? 'store-failed'
      : toStoreOutcome(written.outcome);
  switch (outcome) {
    case 'stored':
      await writePassphraseRecord(dir, account, { store: target, by: 'replace' });
      return {
        address,
        account,
        passphraseLocation: 'store',
        location: describeStoreLocation(target, account, dir),
      };
    case 'uncertain':
      throw outgoingUncertainError(target);
    case 'store-failed': {
      const detail = written.detail ?? `the ${storeNoun(target)} write failed`;
      const message = `Could not save the existing wallet's passphrase (${detail}); --replace refused.`;
      if (target === 'file') {
        const path = describeStoreLocation('file', account, dir);
        throw new CliError('REFUSED', message, {
          fix: FILE_STORE_FAILED_FIX(path),
          details: { passphraseStore: { kind: 'file-write-failed', path } },
        });
      }
      throw new CliError('REFUSED', message, {
        fix: KEYCHAIN_LOCKED_FIX,
        details: unlockDetails('keychain_locked', target),
      });
    }
    case 'rejected-characters':
      return { address, account, passphraseLocation: 'unarchived', unarchivedReason: outcome };
  }
}

function outgoingUncertainError(store: DurableStore): CliError {
  return new CliError(
    'REFUSED',
    `Could not save the existing wallet's passphrase (the ${storeNoun(store)} did not answer); --replace refused.`,
    { fix: KEYCHAIN_LOCKED_FIX, details: unlockDetails('keychain_locked', store) },
  );
}

/**
 * The park half of `--replace`: move the outgoing keystore to
 * wallet.<address>.json.bak, NO-CLOBBER (link + unlink, so an existing archive
 * is never silently replaced — the .bak is the last copy of a funded key). Run
 * only after verify-and-preserve succeeded AND the replacement is fully
 * prepared. Returns the archive path.
 */
export async function parkOutgoingWallet(dir: string, account: string): Promise<string> {
  const src = walletPath(dir);
  const dst = archivedWalletPath(account, dir);
  try {
    await link(src, dst);
  } catch (err) {
    if (hasCode(err, 'EEXIST')) {
      throw new CliError('REFUSED', `An archived wallet already exists at ${dst}.`, {
        fix: `Move ${dst} aside, then retry \`tenjin wallet create --replace\`. Nothing has moved; the current wallet is still active.`,
        cause: err,
      });
    }
    throw new CliError('INTERNAL', `Could not park the outgoing keystore at ${dst}.`, {
      fix: `Nothing has moved; the current wallet is still active at ${src}. Fix the underlying filesystem error and retry.`,
      cause: err,
    });
  }
  try {
    await unlink(src);
  } catch (err) {
    // link succeeded but the active slot would not clear (e.g. EBUSY on win32
    // with the file held open): both names point at one inode and the ACTIVE
    // wallet would be listed as archived. Best-effort undo the new link so the
    // state stays exactly as before the park.
    await unlink(dst).catch(() => undefined);
    throw new CliError(
      'INTERNAL',
      `Could not clear the active wallet slot ${src} while parking the outgoing wallet.`,
      {
        fix: 'The previous wallet is still active and nothing was lost. Fix the underlying filesystem error (on Windows, close any process holding the wallet file open) and retry.',
        cause: err,
      },
    );
  }
  await syncWalletDir(dir);
  return dst;
}

/**
 * Undo a park (rollback when the replacement failed to commit), NO-CLOBBER: if
 * a wallet.json appeared out of band, `link` throws EEXIST rather than
 * overwriting it — the caller surfaces both paths instead of guessing.
 */
export async function restoreParkedWallet(dir: string, archivedPath: string): Promise<void> {
  await link(archivedPath, walletPath(dir));
  // The active wallet is restored from here on; a stale .bak link is a listing
  // blemish, not a loss, so its removal is best-effort.
  await unlink(archivedPath).catch(() => undefined);
  await syncWalletDir(dir);
}

/** fsync the wallet dir so a park/restore survives a crash (POSIX only). */
async function syncWalletDir(dir: string): Promise<void> {
  if (isWindows) return; // a directory cannot be fsynced on win32
  await fsyncDir(dir);
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
        details: unlockDetails('env_key_invalid'),
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
 * Build the viem account for SIGNING. An env credential uses its raw key; a
 * file credential resolves the passphrase for its address, decrypts, then
 * verifies the recovered key derives the stored address (tamper signal). A
 * legacy-served passphrase migrates only AFTER that proof; a decrypt failure
 * with one surfaces the ambiguity and leaves the legacy entry untouched.
 *
 * WRONG ENV FALLS THROUGH (decision 8). A correct TENJIN_WALLET_PASSPHRASE
 * opens on the first try and no store is read. One that does not open the
 * wallet is passed over: the passphrase is resolved again without it and
 * without a prompt, and when the saved one opens the wallet, signing goes
 * ahead and `onWarning` says the variable is wrong, once per provider per
 * keystore. That fallback read passes no deadline (B3). A locked store on the
 * way is rethrown as `keychain_locked`; nothing else opening it is
 * `env_passphrase_wrong`.
 *
 * Every throw carries `details.unlock`, so the payer, the hooks and doctor can
 * act on the reason without reading the message. No fix here tells anyone to
 * set TENJIN_WALLET_PASSPHRASE to a value (B1): repair asks the person for it.
 */
async function accountForSigning(
  cred: Credential,
  deps: LocalProviderDeps,
  warnOnce: (keystoreId: string) => void,
): Promise<PrivateKeyAccount> {
  if (cred.source === 'env') return accountFromKey(cred.key, 'env');

  const id = cred.keystore.id;
  const cached = signerCache.get(id);
  if (cached !== undefined) {
    if (cached.envShadowed) warnOnce(id);
    return cached.account;
  }

  const account = walletStoreAccount(cred.address);
  const passphraseDeps: PassphraseDeps = { env: deps.env, dir: deps.dir, ...deps.passphrase };
  const resolved = await resolvePassphrase(passphraseDeps, cred.address);
  const opened = await openKeystoreAccount(
    cred.keystore,
    account,
    resolved.passphrase,
    deps.derivation,
  );
  if (opened.kind === 'ok') return unlocked(resolved, opened.account, false);
  if (opened.kind === 'mismatch') throw tamperedError(cred.address, opened);

  if (resolved.migrateLegacy !== undefined) {
    // The only durable passphrase came from the legacy shared slot and it does
    // NOT decrypt this wallet: it almost certainly belongs to whichever wallet
    // was created last before per-wallet entries existed. Do not migrate, do
    // not delete — surface the ambiguity and leave the entry for its owner.
    throw new CliError(
      'WALLET_INVALID_KEY',
      'The legacy shared passphrase entry (service tenjin-cli, account "wallet") does not decrypt this wallet.',
      {
        fix: `That entry likely belongs to a different wallet created later and was left untouched. If you know this wallet's passphrase: ${REPAIR_IN_TERMINAL}`,
        cause: opened.cause,
        details: unlockDetails('passphrase_wrong', 'legacy'),
      },
    );
  }
  if (resolved.source !== 'env') {
    // Name only the escape that applies to where the passphrase came from —
    // resolution never falls through to a prompt after a store hit.
    throw new CliError('WALLET_INVALID_KEY', 'Could not decrypt the wallet keystore.', {
      fix:
        resolved.source === 'prompt'
          ? 'Retry and enter the correct passphrase at the prompt.'
          : storedWrongFix(resolved.source, account, deps.dir),
      cause: opened.cause,
      details: unlockDetails('passphrase_wrong', resolved.source),
    });
  }

  // TENJIN_WALLET_PASSPHRASE did not open it: does a saved passphrase?
  const saved = await resolvePassphrase({ ...passphraseDeps, isTTY: false }, cred.address, {
    skipEnv: true,
  }).catch((err: unknown) => err);
  if (!(saved instanceof Error) && isResolved(saved)) {
    const fallback = await openKeystoreAccount(
      cred.keystore,
      account,
      saved.passphrase,
      deps.derivation,
    );
    if (fallback.kind === 'ok') {
      const result = await unlocked(saved, fallback.account, true);
      warnOnce(id);
      return result;
    }
    if (fallback.kind === 'mismatch') throw tamperedError(cred.address, fallback);
  } else if (unlockReasonOf(saved) === 'keychain_locked') {
    const locked = saved as CliError;
    throw new CliError(
      locked.code,
      `TENJIN_WALLET_PASSPHRASE does not open the wallet, and ${lowerFirst(locked.message)}`,
      {
        ...(locked.fix !== undefined ? { fix: locked.fix } : {}),
        details: locked.details,
      },
    );
  }
  throw new CliError('WALLET_INVALID_KEY', 'Could not decrypt the wallet keystore.', {
    fix: ENV_WRONG_FIX,
    cause: opened.cause,
    details: unlockDetails('env_passphrase_wrong', 'env'),
  });

  /** Cache the opened account, after running a proven legacy migration. */
  async function unlocked(
    from: ResolvedPassphrase,
    signer: PrivateKeyAccount,
    envShadowed: boolean,
  ): Promise<PrivateKeyAccount> {
    // Decrypt + address check passed: this wallet provably owns the legacy
    // passphrase, so re-key it under the wallet's own address (copy, verify,
    // then remove the legacy slot). Best-effort: on failure the legacy entry
    // remains the durable copy and the next signing retries the migration.
    if (from.migrateLegacy !== undefined) await from.migrateLegacy();
    signerCache.set(id, { account: signer, envShadowed });
    return signer;
  }
}

function isResolved(value: unknown): value is ResolvedPassphrase {
  return typeof value === 'object' && value !== null && 'passphrase' in value;
}

function lowerFirst(text: string): string {
  return text.length > 0 ? `${text.charAt(0).toLowerCase()}${text.slice(1)}` : text;
}

/** The tamper error: the keystore decrypts, but not to this wallet's key. */
function tamperedError(address: string, opened: Extract<Opened, { kind: 'mismatch' }>): CliError {
  if (opened.derived === null) return invalidKeyError('file', opened.cause);
  return new CliError(
    'WALLET_INVALID_KEY',
    `The decrypted key derives ${opened.derived}, not the wallet file's stored address ${address}.`,
    {
      fix: 'The wallet file may be tampered. Move it aside, then run `tenjin wallet create` for a fresh key or set TENJIN_WALLET_KEY to use the intended one.',
      details: unlockDetails('wallet_corrupt'),
    },
  );
}

/** viem account from a raw key, mapping viem's throw on a bad key to WALLET_INVALID_KEY. */
function accountFromKey(key: Hex, source: 'env' | 'file'): PrivateKeyAccount {
  try {
    return privateKeyToAccount(key);
  } catch (err) {
    throw invalidKeyError(source, err);
  }
}

/** A key off the secp256k1 curve: a corrupt file, or a bad TENJIN_WALLET_KEY. */
function invalidKeyError(source: 'env' | 'file', cause: unknown): CliError {
  return new CliError('WALLET_INVALID_KEY', 'The private key is not a valid secp256k1 key.', {
    fix:
      source === 'file'
        ? 'Move the wallet file aside, then run `tenjin wallet create` for a fresh key or set TENJIN_WALLET_KEY to use the intended one.'
        : 'Set TENJIN_WALLET_KEY to a valid 0x-prefixed 32-byte hex key.',
    cause,
    details: unlockDetails(source === 'file' ? 'wallet_corrupt' : 'env_key_invalid'),
  });
}

/** Encrypt a raw key into a Keystore v3 document using ox's default scrypt parameters. */
async function encryptToKeystore(key: Hex, passphrase: string): Promise<Keystore.Keystore> {
  const [derivedKey, opts] = await Keystore.scryptAsync({ password: passphrase });
  return Keystore.encrypt(key, derivedKey, opts);
}

async function credentialOrThrow(deps: LocalProviderDeps): Promise<Credential> {
  const cred = await loadCredential(deps);
  if (cred !== null) return cred;
  // Name any archived (replaced) wallets so a missing active wallet never hides
  // recoverable funds behind a bare "create one".
  const archived = await listArchivedWallets(deps.dir);
  const hint =
    archived.length > 0
      ? ` Archived wallets exist (${archived.join(', ')}); restore one with \`mv ${archivedWalletPath('<address>', deps.dir)} ${walletPath(deps.dir)}\`.`
      : '';
  throw new CliError('WALLET_MISSING', 'No wallet found.', {
    fix: `Run \`tenjin wallet create\` to create one.${hint}`,
  });
}

function walletRecord(address: Address, keystore: Keystore.Keystore): WalletRecord {
  return {
    schemaVersion: WALLET_SCHEMA_VERSION,
    provider: 'local',
    address,
    keystore,
    createdAt: new Date().toISOString(),
  };
}

/** What `tenjin wallet repair` did. */
export interface RepairOutcome {
  address: Address;
  account: string;
  store: DurableStore;
  location: string;
  /** The store already held this passphrase (or an entry that opens the wallet): nothing was written. */
  alreadySaved: boolean;
  /** An existing entry that did NOT open the wallet was replaced (`-U`). */
  replacedUnusableEntry: boolean;
  fileReason?: 'no-keyring' | 'insecure-storage';
}

/**
 * SAVE A PASSPHRASE THE PERSON PROVED, for a wallet Claude Code cannot unlock.
 *
 * 1. The passphrase must open THIS wallet (`openKeystore`): a wrong one saves
 *    nothing, and a tampered file refuses. The address never changes and
 *    wallet.json is never rewritten.
 * 2. The target: the store the sidecar names when it already reads this
 *    passphrase back (nothing to do); the 0600 file with `insecureStorage`;
 *    otherwise the platform store when its probe answers, the 0600 file when
 *    there is none (S4), and a refusal when it does not answer (S3: never a
 *    hint at plaintext).
 * 3. storeDurablyDetailed, allowed to replace an existing entry ONLY after proving that
 *    entry does not open the wallet. It succeeds only when the store reads this
 *    passphrase back (S1): a different value after the write is a refusal,
 *    never "saved".
 * 4. Only then the sidecar records the store (`by: 'repair'`).
 *
 * Never touches the legacy slot, another account, or wallet.json. The caller
 * holds `wallet.create.lock`.
 */
export async function repairLocalWalletPassphrase(
  deps: LocalProviderDeps,
  passphrase: string,
  opts: { insecureStorage?: boolean } = {},
): Promise<RepairOutcome> {
  const record = await readWalletRecord(deps.dir);
  if (record === null) {
    throw new CliError('WALLET_MISSING', 'No wallet found to repair.', {
      fix: 'Run `tenjin wallet create` to create one.',
    });
  }
  const address = record.address as Address;
  const account = walletStoreAccount(address);
  const opened = await openKeystoreAccount(record.keystore, account, passphrase, deps.derivation);
  if (opened.kind === 'wrong') {
    throw new CliError(
      'WALLET_INVALID_KEY',
      `That passphrase does not open wallet ${address}; nothing was saved.`,
      {
        fix: `Check the passphrase, then: ${REPAIR_IN_TERMINAL}`,
        details: unlockDetails('passphrase_wrong', 'prompt'),
      },
    );
  }
  if (opened.kind === 'mismatch') throw tamperedError(address, opened);

  const passphraseDeps: PassphraseDeps = { env: deps.env, dir: deps.dir, ...deps.passphrase };
  const location = (store: DurableStore): string => describeStoreLocation(store, account, deps.dir);
  const done = (
    store: DurableStore,
    fields: Partial<Pick<RepairOutcome, 'alreadySaved' | 'replacedUnusableEntry' | 'fileReason'>>,
  ): RepairOutcome => ({
    address,
    account,
    store,
    location: location(store),
    alreadySaved: fields.alreadySaved ?? false,
    replacedUnusableEntry: fields.replacedUnusableEntry ?? false,
    ...(fields.fileReason !== undefined ? { fileReason: fields.fileReason } : {}),
  });

  const recorded = await readPassphraseRecord(deps.dir, account);
  if (recorded !== null) {
    const timeouts = { ...STORE_TIMEOUTS, ...passphraseDeps.timeouts };
    const bound = passphraseDeps.isTTY === true ? timeouts.interactiveWriteMs : timeouts.writeMs;
    const held = await readStoredPassphrase(passphraseDeps, recorded.store, address, {
      timeoutMs: bound,
    });
    if (held.kind === 'hit' && held.value === passphrase) {
      return done(recorded.store, { alreadySaved: true });
    }
  }

  let target: DurableStore;
  let fileReason: RepairOutcome['fileReason'];
  if (opts.insecureStorage === true) {
    target = 'file';
    fileReason = 'insecure-storage';
  } else {
    const probed = await probeDurableStore(passphraseDeps);
    if (probed.probe === 'uncertain') {
      throw new CliError(
        'REFUSED',
        `The ${storeNoun(probed.store)} did not answer; nothing was saved.`,
        { fix: KEYCHAIN_LOCKED_FIX, details: unlockDetails('keychain_locked', probed.store) },
      );
    }
    if (probed.probe === 'available') {
      target = probed.store;
    } else {
      target = 'file';
      fileReason = 'no-keyring';
    }
  }

  let replaced = false;
  const written = await storeDurablyDetailed(passphraseDeps, target, address, passphrase, {
    // Replace an existing entry only once it is PROVEN not to open this wallet.
    replaceIf: async (existing) => {
      replaced = (await openKeystore(record.keystore, account, existing, deps.derivation)) !== 'ok';
      return replaced;
    },
  });
  const reason = fileReason !== undefined ? { fileReason } : {};
  // A file cannot be "locked": an fs error there is a failed write, and its
  // fix is the directory, never a keychain (decision 6).
  const outcome =
    target === 'file' && written.outcome === 'uncertain' ? 'store-failed' : written.outcome;
  switch (outcome) {
    case 'stored':
      await writePassphraseRecord(deps.dir, account, { store: target, by: 'repair' });
      return done(target, { replacedUnusableEntry: replaced, ...reason });
    case 'already-stored':
    case 'kept-existing':
      await writePassphraseRecord(deps.dir, account, { store: target, by: 'repair' });
      return done(target, { alreadySaved: true, ...reason });
    case 'uncertain':
      throw new CliError('REFUSED', `The ${storeNoun(target)} did not answer; nothing was saved.`, {
        fix: KEYCHAIN_LOCKED_FIX,
        details: unlockDetails('keychain_locked', target),
      });
    case 'conflict':
      throw new CliError(
        'REFUSED',
        `The ${storeNoun(target)} holds a different passphrase for wallet ${address} after the write; nothing was confirmed.`,
        {
          fix: `Run \`tenjin wallet repair\` again yourself ${REPAIR_CLAUSE}; if this repeats, another program is writing that entry: run \`tenjin doctor\`.`,
          details: unlockDetails('keychain_locked', target),
        },
      );
    case 'rejected-characters':
      throw new CliError(
        'REFUSED',
        `This passphrase cannot be saved: ${unstorableWhy(target)}; nothing was saved.`,
        {
          fix: 'Keep TENJIN_WALLET_PASSPHRASE set in the environment Claude Code starts from.',
        },
      );
    case 'store-failed': {
      const detail = written.detail ?? `the ${storeNoun(target)} write failed`;
      if (target === 'file') {
        const path = location('file');
        throw new CliError(
          'REFUSED',
          `Could not save the passphrase to ${path} (${detail}); nothing was saved.`,
          {
            fix: FILE_STORE_FAILED_FIX(path),
            details: { passphraseStore: { kind: 'file-write-failed', path } },
          },
        );
      }
      throw new CliError(
        'REFUSED',
        `Could not save the passphrase to ${location(target)} (${detail}); nothing was saved.`,
        { fix: KEYCHAIN_LOCKED_FIX, details: unlockDetails('keychain_locked', target) },
      );
    }
  }
}
