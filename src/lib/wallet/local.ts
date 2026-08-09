import { link, readdir, unlink } from 'node:fs/promises';
import { fsyncDir } from '../atomic-json';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import type { PrivateKeyAccount } from 'viem/accounts';
import type { Address, Hex } from 'viem';
import * as Keystore from 'ox/Keystore';
import { CliError } from '../errors';
import { hasCode } from '../errno';
import { archivedWalletPath, walletPath } from '../paths';
import {
  PRIVATE_KEY_RE,
  WALLET_SCHEMA_VERSION,
  readWalletRecord,
  walletFileMode,
  writeWalletRecord,
  type WalletRecord,
} from './store';
import {
  resolvePassphrase,
  storePassphraseForWallet,
  walletStoreAccount,
  type PassphraseDeps,
  type PassphraseSource,
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
      const account = await accountForSigning(cred, deps);
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

/**
 * Can this wallet actually sign, without asking anyone? An env key is proven by
 * deriving it; a file wallet needs its passphrase from the env or the OS store,
 * and the keystore decrypted and checked against the stored address.
 *
 * Nothing here prompts (`isTTY: false` is forced last, so no test seam can turn
 * it back on) and nothing here writes: a legacy-slot hit is used to decrypt but
 * its `migrateLegacy` handle is deliberately never invoked, and the signer cache
 * is left alone so the migration still happens on the first real signing. Both
 * would be side effects of a read-only diagnostic.
 *
 * scrypt is deliberately slow, which is why this runs only once a passphrase has
 * already been found without a prompt.
 */
export async function verifyLocalWallet(deps: LocalProviderDeps): Promise<WalletVerification> {
  const cred = await loadCredential(deps);
  // Details read as a fragment: the caller prefixes them with the wallet line.
  if (cred === null) return { status: 'unverified', detail: 'there is no credential to verify' };
  if (cred.source === 'env') {
    // Deriving is the whole proof for a raw key, and it is cheap.
    accountFromKey(cred.key, 'env');
    return { status: 'verified', detail: 'TENJIN_WALLET_KEY derives a valid signing key' };
  }

  const account = walletStoreAccount(cred.address);
  let resolved: Awaited<ReturnType<typeof resolvePassphrase>>;
  try {
    resolved = await resolvePassphrase(
      { env: deps.env, dir: deps.dir, ...deps.passphrase, isTTY: false },
      cred.address,
    );
  } catch {
    return {
      status: 'unverified',
      detail: 'no passphrase is reachable without prompting, so the keystore was not opened',
    };
  }

  let key: Hex;
  try {
    const derived = await Keystore.toKeyAsync(cred.keystore, { password: resolved.passphrase });
    key = Keystore.decrypt(cred.keystore, derived);
  } catch {
    // The #70 shape: the only durable passphrase is the pre-per-address shared
    // slot and it belongs to some later wallet, so this keystore is unopenable
    // and the address it identifies you by is unsignable. Named apart from a
    // plain wrong passphrase because the remedy is different.
    if (resolved.migrateLegacy !== undefined) {
      return {
        status: 'broken',
        detail:
          'the keystore cannot be decrypted: the only stored passphrase is the legacy shared entry (service tenjin-cli, account "wallet"), which does not open it',
        fix: `That entry likely belongs to a wallet created later. Set TENJIN_WALLET_PASSPHRASE to this wallet's own passphrase, or restore its entry under account ${account}.`,
      };
    }
    // Name the escape that applies to where the passphrase came from, the same
    // way accountForSigning does: "set TENJIN_WALLET_PASSPHRASE" is not advice
    // when TENJIN_WALLET_PASSPHRASE is the thing that just failed.
    const escape =
      resolved.source === 'env'
        ? 'TENJIN_WALLET_PASSPHRASE is set but does not open it; set it to the correct passphrase'
        : `The passphrase from ${passphraseOrigin(resolved.source, account)} does not open it; set TENJIN_WALLET_PASSPHRASE to the correct passphrase`;
    return {
      status: 'broken',
      detail: `the keystore cannot be decrypted with the passphrase from ${passphraseOrigin(resolved.source, account)}`,
      fix: `${escape}. Without it the key is unrecoverable and this address can no longer sign or publish.`,
    };
  }
  if (privateKeyToAccount(key).address.toLowerCase() !== account) {
    return {
      status: 'broken',
      detail: `the decrypted key does not derive the wallet file's stored address ${cred.address}`,
      fix: 'The wallet file may be tampered. Move it aside, then run `tenjin wallet create` for a fresh key or set TENJIN_WALLET_KEY to use the intended one.',
    };
  }
  return {
    status: 'verified',
    detail: `keystore decrypts with the passphrase from ${passphraseOrigin(resolved.source, account)}`,
  };
}

/**
 * Where a resolved passphrase came from, in words an operator can act on.
 * Windows stores a per-wallet DPAPI file rather than a service/account entry, so
 * naming one model for both would send that operator looking for something that
 * does not exist on their machine.
 */
function passphraseOrigin(source: PassphraseSource, account: string): string {
  if (source === 'env') return 'TENJIN_WALLET_PASSPHRASE';
  if (source === 'prompt') return 'the prompt';
  if (source === 'dpapi') return `the DPAPI-protected passphrase file for ${account}`;
  return `the OS credential store (service tenjin-cli, account ${account})`;
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
  const archivedWallets = await listArchivedWallets(deps.dir);
  return {
    ...(fileExists ? { walletPath: path, keyStorage: KEY_STORAGE } : {}),
    ...(fileExists && passphraseSource !== undefined ? { passphraseSource } : {}),
    ...(archivedWallets.length > 0 ? { archivedWallets } : {}),
    warnings,
  };
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
/** When `unarchived`: why no durable OS-store copy could be made. */
export type UnarchivedReason = Exclude<StorePassphraseOutcome, 'stored'>;

export interface PreservedWalletInfo {
  address: Address;
  /** The wallet's OS-store account / archive filename key (lowercase address). */
  account: string;
  passphraseLocation: ArchivedPassphraseLocation;
  unarchivedReason?: UnarchivedReason;
}

export interface ArchivedWalletInfo extends PreservedWalletInfo {
  /** Where the keystore file was parked (wallet.<address>.json.bak). */
  archivedPath: string;
}

/**
 * The verify-and-preserve half of `--replace`: prove the outgoing wallet's
 * passphrase decrypts its keystore (MAC + derived-address check), then ensure a
 * durable per-address copy exists (legacy slot re-keyed, REFUSING on failure;
 * prompt-entered archived best-effort with the reason reported). Touches NO
 * files — the park runs separately, after the replacement is fully prepared, so
 * every failure here leaves the old wallet active and untouched.
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
  const resolved = await resolvePassphrase(passphraseDeps, address);

  let key: Hex;
  try {
    const derived = await Keystore.toKeyAsync(record.keystore, { password: resolved.passphrase });
    key = Keystore.decrypt(record.keystore, derived);
  } catch (err) {
    // Name the escape that actually applies to where the passphrase came from:
    // once a store serves a value, resolution never falls through to a prompt.
    const escape =
      resolved.source === 'prompt'
        ? "Retry and enter that wallet's correct passphrase at the prompt, or set TENJIN_WALLET_PASSPHRASE to it"
        : resolved.source === 'env'
          ? 'TENJIN_WALLET_PASSPHRASE is set but does not decrypt it; set it to the correct passphrase'
          : `Set TENJIN_WALLET_PASSPHRASE to its passphrase, or fix its OS credential store entry (service tenjin-cli, account ${account})`;
    throw new CliError(
      'REFUSED',
      `Cannot verify the passphrase of the existing wallet ${address}; --replace refused.`,
      {
        fix: `Replacing now could strand that wallet's funds. ${escape}, then retry.`,
        cause: err,
      },
    );
  }
  if (privateKeyToAccount(key).address.toLowerCase() !== account) {
    throw new CliError(
      'REFUSED',
      `The wallet file's stored address ${address} does not match its key; --replace refused.`,
      { fix: 'The wallet file may be tampered. Resolve that before replacing it.' },
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
    const outcome = await storePassphraseForWallet(passphraseDeps, address, resolved.passphrase);
    return outcome === 'stored'
      ? { address, account, passphraseLocation: 'store' }
      : { address, account, passphraseLocation: 'unarchived', unarchivedReason: outcome };
  }
  // Served from its own per-address entry: already archived.
  return { address, account, passphraseLocation: 'store' };
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
          fix: "That entry likely belongs to a different wallet created later and was left untouched. If you know this wallet's passphrase, set TENJIN_WALLET_PASSPHRASE to it (a store-served passphrase is never re-asked at a prompt).",
          cause: err,
        },
      );
    }
    // Name only the escape that applies to where the passphrase came from —
    // resolution never falls through to a prompt after a store or env hit.
    const escape =
      resolved.source === 'env'
        ? 'TENJIN_WALLET_PASSPHRASE is set but does not decrypt it; set it to the correct passphrase'
        : resolved.source === 'prompt'
          ? 'Retry and enter the correct passphrase at the prompt, or set TENJIN_WALLET_PASSPHRASE to it'
          : `The OS credential store entry (service tenjin-cli, account ${cred.address.toLowerCase()}) does not decrypt it; set TENJIN_WALLET_PASSPHRASE to the correct passphrase`;
    throw new CliError('WALLET_INVALID_KEY', 'Could not decrypt the wallet keystore.', {
      fix: `${escape}.`,
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
