import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { mkdir, readFile, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { z } from 'zod';
import { writeFileAtomic } from '../../lib/atomic-json';
import { CliError } from '../../lib/errors';
import { hasCode } from '../../lib/errno';
import { LockTimeoutError, withFileLock } from '../../lib/lock';
import {
  osStoreByName,
  osStoreFor,
  storeNoun,
  type DurableStore,
  type ExecFn,
  type OsStore,
  type SecretSlot,
  type StoreRead,
} from '../../lib/os-store';
import { sourceKeyBlobPath, sourceKeyFilePath, sourceVaultPath, sourcesDir } from '../../lib/paths';
import { stableJson } from '../access';
import { isAccountId, STORE_ACCOUNT, storeAccountFor } from './ids';

/**
 * A CONNECTED ACCOUNT'S SIGN-IN, ON THIS MACHINE ONLY (decided37 #14). One
 * file per account, `~/.tenjin/sources/<id>.json` (0600 in a 0700 folder):
 * a plaintext header anyone with the file can read (what is connected, how,
 * since when, and which of its services the connect-time check found ready),
 * and the sign-in itself (tokens, or a pasted key) sealed with AES-256-GCM
 * under a 32-byte key, the header bound in as additional data.
 *
 * The key lives in the OS store the wallet passphrase uses, under service
 * `tenjin-cli` and account `source:<id>`: 43 base64url characters, which the
 * keychain's piped writer takes as a plain `-w` value, where a token bundle
 * as hex would run past its line. A refresh rewrites only this file; the store
 * is written once at connect and cleared at disconnect. Connect, refresh and
 * disconnect each hold the account's lock beside the vault for their whole
 * read and write ({@link withVaultLock}). Where no OS store
 * exists at all the key goes to a 0600 file beside the vault, the same
 * announced exception the wallet makes; a store that exists but is locked is
 * never worked around.
 *
 * Reading the header needs no key, so `tenjin status` and presence never
 * touch the OS store. Every store call goes through an injected exec, so tests
 * never reach a real keychain.
 */

export const VAULT_VERSION = 1;

/** How long a key write and its read-back may take: headless, at a terminal. */
const KEY_WRITE_MS = { headless: 10_000, interactive: 60_000 } as const;
/** How long the platform store's probe may take before it reads as locked. */
const PROBE_MS = 3_000;

const HeaderSchema = z.strictObject({
  version: z.literal(VAULT_VERSION),
  id: z.string().refine(isAccountId),
  kind: z.enum(['oauth', 'key']),
  /** Where the vault key is kept. */
  store: z.enum(['keychain', 'secret-service', 'dpapi', 'file']),
  mcpUrl: z.string().min(1).max(2_048),
  connectedAt: z.string().min(1).max(64),
  /** The access token's expiry; absent for a key, or a token that names none. */
  expiresAt: z.string().min(1).max(64).optional(),
  /** `expired`: a refresh was refused, so the next call asks to reconnect. */
  state: z.enum(['ok', 'expired']),
  /** The mapped services the connect-time check found this account can run,
   *  and those whose tool it lacks: left out on this machine. */
  ready: z.array(z.string().min(1).max(64)).max(64),
  missing: z.array(z.string().min(1).max(64)).max(64),
});
export type VaultHeader = z.infer<typeof HeaderSchema>;

const FileSchema = z.strictObject({
  version: z.literal(VAULT_VERSION),
  header: HeaderSchema,
  iv: z.string().min(1).max(64),
  tag: z.string().min(1).max(64),
  data: z.string().min(1).max(1_048_576),
});

/** What the vault seals. Tokens and client information are kept as the
 *  sign-in returned them, `issuer` included, so a refresh can only ever go
 *  back to the authorization server that issued them. */
const SecretSchema = z.strictObject({
  tokens: z.record(z.string(), z.unknown()).optional(),
  /** When the tokens were obtained, ms since the epoch. */
  obtainedAt: z.number().int().nonnegative().optional(),
  clientInformation: z.record(z.string(), z.unknown()).optional(),
  discoveryState: z.record(z.string(), z.unknown()).optional(),
  apiKey: z.string().min(1).max(4_096).optional(),
  keyScheme: z.enum(['Bearer', 'Key']).optional(),
});
export type VaultSecret = z.infer<typeof SecretSchema>;

export interface VaultDeps {
  dataDir: string;
  /** Defaults to `process.platform`; selects the OS store. */
  platform?: NodeJS.Platform;
  /** The store-CLI seam. Tests always pass one: no real keychain is touched. */
  exec?: ExecFn;
  /** A person may be answering an OS unlock prompt: writes wait longer. */
  interactive?: boolean;
  /** How long a writer waits for the account's lock. */
  lockTimeoutMs?: number;
}

/** How long a writer waits for another's hold on the same account: a refresh
 *  holds it across its bounded token request. */
const LOCK_TIMEOUT_MS = 15_000;

/**
 * ONE WRITER PER ACCOUNT'S SIGN-IN, ACROSS PROCESSES: connect, refresh and
 * disconnect each hold the lock beside the vault (`<id>.json.lock`, the mkdir
 * lock the config writer uses) for their whole read and write, so a refresh's
 * late answer never lands over a newer sign-in or brings back a removed one.
 * A wait past its bound throws {@link LockTimeoutError}, naming the lock.
 */
export async function withVaultLock<T>(
  id: string,
  deps: VaultDeps,
  fn: () => Promise<T>,
): Promise<T> {
  await mkdir(sourcesDir(deps.dataDir), { recursive: true, mode: 0o700 });
  return withFileLock(`${sourceVaultPath(id, deps.dataDir)}.lock`, fn, {
    timeoutMs: deps.lockTimeoutMs ?? LOCK_TIMEOUT_MS,
  });
}

/** {@link withVaultLock} for a command: a wait past its bound says what to do. */
async function lockedFor<T>(
  id: string,
  deps: VaultDeps,
  nothing: 'saved' | 'removed',
  fn: () => Promise<T>,
): Promise<T> {
  try {
    return await withVaultLock(id, deps, fn);
  } catch (err) {
    if (!(err instanceof LockTimeoutError)) throw err;
    throw new CliError(
      'REFUSED',
      `Another Tenjin process is using this sign-in right now, so nothing was ${nothing}.`,
      { fix: `Try again; if no other Tenjin process is running, remove ${err.lockPath} first.` },
    );
  }
}

/** Where an account's vault key lives in each store. */
function slotFor(dataDir: string): SecretSlot {
  const idOf = (account: string) => account.slice('source:'.length);
  return {
    accountRe: STORE_ACCOUNT,
    label: (account) => `tenjin-cli account ${idOf(account)}`,
    blobPath: (account) => sourceKeyBlobPath(idOf(account), dataDir),
    filePath: (account) => sourceKeyFilePath(idOf(account), dataDir),
  };
}

/** Keys this process has read or written, by data dir and account id. */
const keys = new Map<string, Buffer>();
const cacheKey = (dataDir: string, id: string) => `${dataDir}\0${id}`;

/** Forget every cached key (tests). */
export function clearVaultKeyCache(): void {
  keys.clear();
}

/** The vault's header, with no key and no OS store: null when there is none
 *  or it cannot be read as one. */
export async function readVaultHeader(dataDir: string, id: string): Promise<VaultHeader | null> {
  const file = await readVaultFile(dataDir, id);
  return file?.header ?? null;
}

async function readVaultFile(
  dataDir: string,
  id: string,
): Promise<z.infer<typeof FileSchema> | null> {
  if (!isAccountId(id)) return null;
  let raw: string;
  try {
    raw = await readFile(sourceVaultPath(id, dataDir), 'utf8');
  } catch (err) {
    if (hasCode(err, 'ENOENT')) return null;
    throw err;
  }
  try {
    const parsed = FileSchema.safeParse(JSON.parse(raw));
    return parsed.success && parsed.data.header.id === id ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Why a sign-in could not be read or kept, in words a person acts on. */
function storeError(
  where: { label: string; id: string; dataDir: string },
  store: DurableStore,
  read: Exclude<StoreRead, { kind: 'hit' | 'miss' }> | { kind: 'failed'; detail?: string },
  doing: 'read' | 'save',
): CliError {
  const { label, id } = where;
  const folder = tilde(sourcesDir(where.dataDir));
  const place = store === 'file' ? `the key file in ${folder}` : `your ${storeNoun(store)}`;
  return new CliError(
    'REFUSED',
    doing === 'save'
      ? `Tenjin couldn't keep the sign-in for ${label}: ${place} didn't answer. Nothing was saved.`
      : `Tenjin couldn't read the sign-in for ${label}: ${place} didn't answer.`,
    {
      fix:
        store === 'file'
          ? `Check that ${folder} is yours and writable, then run \`tenjin connect ${id}\` again.`
          : `Unlock ${place}, then run the command again.`,
      details: { store, ...(read.detail !== undefined ? { storeDetail: read.detail } : {}) },
    },
  );
}

/** `path` with the home directory shown as `~`. */
function tilde(path: string): string {
  const home = homedir();
  return home.length > 1 && path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

/**
 * THE KEY FOR AN ACCOUNT'S VAULT, kept or made. A key this account already
 * has (a reconnect, or a vault removed by hand) is reused; otherwise 32 new
 * random bytes go to the platform store and are read back before anything is
 * sealed with them. No platform store at all is the announced 0600 file; a
 * store that does not answer refuses, and nothing is written.
 */
async function keyForWrite(
  id: string,
  label: string,
  deps: VaultDeps,
  existing: DurableStore | undefined,
): Promise<{ key: Buffer; store: DurableStore; plainFile: boolean }> {
  const slot = slotFor(deps.dataDir);
  const account = storeAccountFor(id);
  const who = { label, id, dataDir: deps.dataDir };
  const end = Date.now() + (deps.interactive ? KEY_WRITE_MS.interactive : KEY_WRITE_MS.headless);
  const left = () => Math.max(1, end - Date.now());
  let store: OsStore;
  if (existing !== undefined) {
    store = osStoreByName(slot, deps, existing);
  } else {
    const platform = osStoreFor(slot, deps);
    const probed =
      platform === null
        ? ({ probe: 'absent' } as const)
        : await platform.probe({ timeoutMs: PROBE_MS });
    if (probed.probe === 'uncertain')
      throw storeError(
        who,
        platform!.source,
        { kind: 'locked', detail: probed.detail ?? '' },
        'save',
      );
    store = probed.probe === 'available' ? platform! : osStoreByName(slot, deps, 'file');
  }
  const pre = await store.read(account, { timeoutMs: left() });
  if (pre.kind === 'hit') {
    const key = decodeKey(pre.value);
    if (key !== null) return { key, store: store.source, plainFile: store.source === 'file' };
  }
  if (pre.kind === 'locked' || pre.kind === 'absent')
    throw storeError(who, store.source, pre, 'save');
  const value = randomBytes(32).toString('base64url');
  try {
    await store.store(account, value, {
      timeoutMs: left(),
      ...(pre.kind === 'hit' ? { update: true } : {}),
    });
  } catch {
    // Only the read-back says whether a write that failed or was killed stuck.
  }
  const back = await store.read(account, { timeoutMs: left() });
  if (back.kind !== 'hit' || back.value !== value) {
    throw storeError(
      who,
      store.source,
      back.kind === 'locked' || back.kind === 'absent' ? back : { kind: 'failed' },
      'save',
    );
  }
  return { key: decodeKey(value)!, store: store.source, plainFile: store.source === 'file' };
}

function decodeKey(value: string): Buffer | null {
  if (!/^[A-Za-z0-9_-]{43}$/.test(value)) return null;
  const key = Buffer.from(value, 'base64url');
  return key.length === 32 ? key : null;
}

function seal(header: VaultHeader, secret: VaultSecret, key: Buffer) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(stableJson(header), 'utf8'));
  const data = Buffer.concat([cipher.update(JSON.stringify(secret), 'utf8'), cipher.final()]);
  return {
    version: VAULT_VERSION,
    header,
    iv: iv.toString('base64url'),
    tag: cipher.getAuthTag().toString('base64url'),
    data: data.toString('base64url'),
  };
}

function open(file: z.infer<typeof FileSchema>, key: Buffer): VaultSecret | null {
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(file.iv, 'base64url'));
    decipher.setAAD(Buffer.from(stableJson(file.header), 'utf8'));
    decipher.setAuthTag(Buffer.from(file.tag, 'base64url'));
    const plain = Buffer.concat([
      decipher.update(Buffer.from(file.data, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
    const parsed = SecretSchema.safeParse(JSON.parse(plain));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** The header a write supplies; the store is the vault's to say. */
export type HeaderInput = Omit<VaultHeader, 'version' | 'id' | 'store'>;

/**
 * Seal `secret` as account `id`'s sign-in, with its key kept or made, and
 * write the vault in one atomic replace. `plainFile` says the key went to the
 * 0600 file because this machine has no OS store, which the caller announces.
 */
export async function writeVault(
  id: string,
  label: string,
  input: HeaderInput,
  secret: VaultSecret,
  deps: VaultDeps,
): Promise<{ header: VaultHeader; plainFile: boolean }> {
  return lockedFor(id, deps, 'saved', async () => {
    const existing = await readVaultFile(deps.dataDir, id).catch(() => null);
    const { key, store, plainFile } = await keyForWrite(id, label, deps, existing?.header.store);
    const header = HeaderSchema.parse({ version: VAULT_VERSION, id, store, ...input });
    const sealed = seal(header, SecretSchema.parse(secret), key);
    await writeFileAtomic(sourceVaultPath(id, deps.dataDir), `${JSON.stringify(sealed)}\n`, {
      mode: 0o600,
      dirMode: 0o700,
    });
    keys.set(cacheKey(deps.dataDir, id), key);
    return { header, plainFile };
  });
}

/** Rewrite a vault under the key it already has: a refresh, or a header
 *  change such as `expired`. Never makes a key. The caller holds the
 *  account's lock ({@link withVaultLock}). */
export async function rewriteVault(
  id: string,
  label: string,
  header: VaultHeader,
  secret: VaultSecret,
  deps: VaultDeps,
): Promise<void> {
  const key = await keyForRead(id, label, header.store, deps);
  if (key === null)
    throw storeError(
      { label, id, dataDir: deps.dataDir },
      header.store,
      { kind: 'failed' },
      'read',
    );
  const sealed = seal(HeaderSchema.parse(header), SecretSchema.parse(secret), key);
  await writeFileAtomic(sourceVaultPath(id, deps.dataDir), `${JSON.stringify(sealed)}\n`, {
    mode: 0o600,
    dirMode: 0o700,
  });
}

async function keyForRead(
  id: string,
  label: string,
  store: DurableStore,
  deps: VaultDeps,
): Promise<Buffer | null> {
  const cached = keys.get(cacheKey(deps.dataDir, id));
  if (cached !== undefined) return cached;
  const got = await osStoreByName(slotFor(deps.dataDir), deps, store).read(storeAccountFor(id));
  if (got.kind === 'locked' || got.kind === 'absent')
    throw storeError({ label, id, dataDir: deps.dataDir }, store, got, 'read');
  const key = got.kind === 'hit' ? decodeKey(got.value) : null;
  if (key !== null) keys.set(cacheKey(deps.dataDir, id), key);
  return key;
}

export type VaultRead =
  | { status: 'ok'; header: VaultHeader; secret: VaultSecret }
  /** No vault: the account is not connected here. */
  | { status: 'absent' }
  /** A vault whose key is gone or does not open it: reconnect. */
  | { status: 'unreadable'; header: VaultHeader };

/** An account's sign-in. A store that does not answer throws; one that has
 *  lost the key, or a vault the key does not open, is `unreadable`. */
export async function readVault(id: string, label: string, deps: VaultDeps): Promise<VaultRead> {
  const file = await readVaultFile(deps.dataDir, id);
  if (file === null) return { status: 'absent' };
  const key = await keyForRead(id, label, file.header.store, deps);
  const secret = key === null ? null : open(file, key);
  if (secret === null) {
    keys.delete(cacheKey(deps.dataDir, id));
    return { status: 'unreadable', header: file.header };
  }
  return { status: 'ok', header: file.header, secret };
}

/**
 * Remove an account's sign-in from this machine: the vault, and its key from
 * every store it could be in. Removing what is not there is not a failure.
 * `removed` says whether a vault was here.
 */
export async function deleteVault(id: string, deps: VaultDeps): Promise<{ removed: boolean }> {
  return lockedFor(id, deps, 'removed', async () => {
    const slot = slotFor(deps.dataDir);
    const account = storeAccountFor(id);
    const file = await readVaultFile(deps.dataDir, id).catch(() => null);
    let removed = false;
    try {
      await unlink(sourceVaultPath(id, deps.dataDir));
      removed = true;
    } catch (err) {
      if (!hasCode(err, 'ENOENT')) throw err;
    }
    keys.delete(cacheKey(deps.dataDir, id));
    const stores = new Set<DurableStore>(['file']);
    if (file !== null) stores.add(file.header.store);
    const platform = osStoreFor(slot, deps);
    if (platform !== null) stores.add(platform.source);
    for (const store of stores) {
      await osStoreByName(slot, deps, store)
        .remove(account, { timeoutMs: KEY_WRITE_MS.headless })
        .catch(() => false);
    }
    return { removed };
  });
}
