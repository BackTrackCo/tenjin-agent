import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { CliError } from '../errors';
import { readPassphraseRecord } from '../passphrase-record';
import {
  dataDir,
  passphraseBlobPath,
  passphraseBlobPathFor,
  passphraseFilePathFor,
} from '../paths';
import {
  KEYCHAIN_SERVICE,
  StoreExecError,
  classifyStoreFailure,
  hiddenPrompt,
  osStoreByName,
  osStoreFor,
  storeNoun,
  type ExecFn,
  type OsStore,
  type PromptFn,
  type SecretSlot,
  type StoreCallOptions,
  type StoreProbe,
  type StoreRead,
} from '../os-store';
import {
  FILE_STORE_FAILED_FIX,
  KEYCHAIN_LOCKED_FIX,
  KEYCHAIN_WAIT_LINE,
  REPAIR_IN_TERMINAL,
  unlockDetails,
  type DurableStore,
} from '../wallet-unlock';

export type { DurableStore } from '../wallet-unlock';
export {
  StoreExecError,
  classifyStoreFailure,
  defaultExecFor,
  storeNoun,
  type ExecFn,
  type PromptFn,
  type StoreCallOptions,
  type StoreProbe,
  type StoreRead,
} from '../os-store';

/**
 * Wallet passphrase resolution. The private key lives on disk as an encrypted
 * Keystore v3 document; the passphrase that unlocks it is resolved here, in a
 * fixed order, so signing works headlessly (env), transparently through the OS
 * store (macOS keychain, Windows DPAPI, desktop-Linux keyring), or interactively
 * (TTY). Every side-effecting seam — the store CLIs and the hidden-input prompt —
 * is injectable so tests never touch a real keychain or terminal.
 *
 * The passphrase never appears in any argv (which the OS process table can show):
 * reads come back on stdout, and writes pipe the secret over the child's stdin.
 * A failed store CLI never carries its stdout anywhere (for a read, that IS the
 * secret): it rejects with a {@link StoreExecError} holding only the exit code,
 * the signal and the stderr {@link classifyStoreFailure} reads, and every detail
 * built from it names only those.
 *
 * ONE ANNOUNCED PLAINTEXT EXCEPTION: where no OS store exists at all (headless
 * Linux, WSL, a sandbox; the probe says `absent`) or the user chose
 * `--insecure-storage`, the passphrase is saved to `passphrase.<address>.plain`
 * at 0600 in the 0700 data dir, the way the GitHub CLI keeps `hosts.yml`.
 * Create and repair say so in one line. A store that exists but is LOCKED never
 * routes there: a locked keychain is unlocked, not worked around. Everywhere
 * else no plaintext is written to disk (the Windows blob is DPAPI-encrypted, not
 * the passphrase itself).
 *
 * Durable entries are PER WALLET (account = lowercase address); the legacy
 * shared slot is only ever read, for migration (#32). Where each wallet's
 * passphrase went is recorded in the sidecar (`src/lib/passphrase-record.ts`),
 * so a recorded wallet reads exactly one store.
 */

/**
 * The pre-per-wallet shared slot (service `tenjin-cli`, account `wallet`) that
 * every create used to `-U`-overwrite. Never written anymore; read only as a
 * migration fallback and removed only after a verified per-address copy exists.
 */
const LEGACY_ACCOUNT = 'wallet';

/** A lowercase 0x-prefixed 20-byte hex address — the per-wallet store account. */
const ACCOUNT_ADDRESS_RE = /^0x[0-9a-f]{40}$/;

/**
 * The OS-store account for a wallet address: lowercased (checksum-insensitive)
 * and validated as plain hex before it can reach the piped `security -i` line.
 */
export function walletStoreAccount(address: string): string {
  const account = address.toLowerCase();
  if (!ACCOUNT_ADDRESS_RE.test(account)) {
    throw new CliError('INTERNAL', `Not a valid wallet address for passphrase storage: ${address}`);
  }
  return account;
}

export type PassphraseSource = 'env' | DurableStore | 'prompt';

export interface ResolvedPassphrase {
  passphrase: string;
  source: PassphraseSource;
  /**
   * Present ONLY when the passphrase came from the legacy shared slot. Call it
   * strictly AFTER proving the passphrase decrypts this wallet's keystore; it
   * re-keys the slot per migrateLegacyEntry's contract. On a decrypt failure
   * do NOT call it — surface the ambiguity and leave the legacy entry alone.
   */
  migrateLegacy?: () => Promise<boolean>;
  /** true when the sidecar named the store that served it. */
  recorded?: boolean;
}

/**
 * Store-operation deadlines (decision 7). Reads are NOT here: the router never
 * kills a store read; only verify (doctor, install) bounds one, at
 * `verifyReadMs`. Writes are bounded as a whole: pre-read, write and read-back
 * share one deadline, 10 s headless or 60 s at a terminal, where the person may
 * be answering an OS unlock prompt (`waitLineAfterMs` in, they are told so).
 */
export const STORE_TIMEOUTS = {
  verifyReadMs: 5000,
  writeMs: 10000,
  interactiveWriteMs: 60000,
  probeMs: 3000,
  waitLineAfterMs: 1000,
} as const;

/** {@link STORE_TIMEOUTS}' shape, as plain numbers a test may override. */
export type StoreTimeouts = Record<keyof typeof STORE_TIMEOUTS, number>;

export interface PassphraseDeps {
  env: NodeJS.ProcessEnv;
  /** Data dir that holds the sidecar, the DPAPI blob and the passphrase file; defaults to the resolved data dir. */
  dir?: string;
  /** Defaults to `process.platform`; selects the OS store (or none). */
  platform?: NodeJS.Platform;
  /** Whether an interactive prompt is possible; defaults to `process.stdin.isTTY`. */
  isTTY?: boolean;
  /** The store-CLI exec seam; defaults to a real execFile with stdin support. */
  exec?: ExecFn;
  /** The hidden-input prompt seam; defaults to a raw-mode TTY reader. */
  prompt?: PromptFn;
  /** Test override for {@link STORE_TIMEOUTS}. */
  timeouts?: Partial<StoreTimeouts>;
  /**
   * Read deadline for verify only (doctor and install pass
   * `STORE_TIMEOUTS.verifyReadMs`). Absent means reads are never killed, which
   * is what every signing caller must stay (B3).
   */
  readDeadlineMs?: number;
  /**
   * Create and repair at a TTY: called once with KEYCHAIN_WAIT_LINE when
   * storeDurablyDetailed has not settled after `waitLineAfterMs`. Commands wire it to
   * stderr.
   */
  onWait?: (line: string) => void;
}

/**
 * 'kept-existing': the pre-read found a different value and replaceIf said keep it (nothing written).
 * 'conflict': a different value with no replaceIf, or a read-back that differs after the write (S1).
 */
export type DurableWrite =
  | 'stored'
  | 'already-stored'
  | 'kept-existing'
  | 'conflict'
  | 'uncertain'
  | 'store-failed'
  | 'rejected-characters';

/** A --replace archive write's outcome ({@link toStoreOutcome}); `no-store`: nowhere to write. */
export type StorePassphraseOutcome =
  'stored' | 'no-store' | 'rejected-characters' | 'store-failed' | 'uncertain';

/** The effective deadlines: STORE_TIMEOUTS with any test override applied. */
function timeoutsOf(deps: PassphraseDeps): StoreTimeouts {
  return { ...STORE_TIMEOUTS, ...deps.timeouts };
}

/**
 * WHERE A WALLET'S PASSPHRASE LIVES in each OS store: per-wallet accounts are
 * the lowercase address (the keychain writer takes nothing else), the DPAPI
 * blob and plain file are named for it, and the legacy shared slot's blob is
 * the one pre-per-wallet file.
 */
function walletSlot(deps: PassphraseDeps): SecretSlot {
  return {
    accountRe: ACCOUNT_ADDRESS_RE,
    label: (account) => `tenjin-cli wallet ${account}`,
    blobPath: (account) =>
      account === LEGACY_ACCOUNT
        ? passphraseBlobPath(deps.dir)
        : passphraseBlobPathFor(account, deps.dir),
    filePath: (account) => passphraseFilePathFor(account, deps.dir),
  };
}

/** The durable store for this platform, or null where no built-in one exists. */
function storeFor(deps: PassphraseDeps): OsStore | null {
  return osStoreFor(walletSlot(deps), deps);
}

/** Any store by name, the file store included: what a sidecar entry or a chosen target names. */
function storeByName(deps: PassphraseDeps, name: DurableStore): OsStore {
  return osStoreByName(walletSlot(deps), deps, name);
}

/** The 0600 passphrase file store. */
function fileStore(deps: PassphraseDeps): OsStore {
  return storeByName(deps, 'file');
}

/**
 * One classified read of `address`'s entry in a named store (repair: "does the
 * store the sidecar names already hold this passphrase?"). Never throws.
 */
export function readStoredPassphrase(
  deps: PassphraseDeps,
  store: DurableStore,
  address: string,
  o?: StoreCallOptions,
): Promise<StoreRead> {
  return storeByName(deps, store).read(walletStoreAccount(address), o);
}

/**
 * Resolve the passphrase to DECRYPT the existing wallet at `address`.
 *
 * 1. `TENJIN_WALLET_PASSPHRASE`, unless `skipEnv` (the wrong-env fallthrough).
 * 2. A sidecar entry: read ONLY that store's per-address entry. There is no
 *    other-store fallback: the sidecar is the answer to "where did it go".
 * 3. No sidecar entry (every wallet made before the sidecar existed): today's
 *    order, so alpha.30 keychain users read exactly the same entry. The OS store
 *    per-address, then the legacy slot (only when the OS store exists), then the
 *    0600 file, then the prompt.
 *
 * A store that is LOCKED stops the chain, recorded or not: falling through to
 * the legacy slot or the prompt would answer "did the keychain say no?" with a
 * guess. At a TTY the person is asked instead; elsewhere it throws
 * `keychain_locked`, whose fix is to unlock the keychain, never plaintext (S3).
 * A locked LEGACY slot still lets the file be read, but a file miss after it is
 * `keychain_locked` too, never `passphrase_missing`.
 *
 * A legacy hit carries a `migrateLegacy` handle the caller invokes only after
 * proving the passphrase decrypts this wallet (see ResolvedPassphrase). Reads
 * pass `deps.readDeadlineMs` when it is set (verify only) and no deadline
 * otherwise (B3).
 */
export async function resolvePassphrase(
  deps: PassphraseDeps,
  address: string,
  opts: { skipEnv?: boolean; promptLabel?: string } = {},
): Promise<ResolvedPassphrase> {
  if (opts.skipEnv !== true) {
    const fromEnv = envPassphrase(deps.env);
    if (fromEnv !== null) return { passphrase: fromEnv, source: 'env' };
  }

  const account = walletStoreAccount(address);
  const readOpts: StoreCallOptions | undefined =
    deps.readDeadlineMs !== undefined ? { timeoutMs: deps.readDeadlineMs } : undefined;
  const prompted = async (): Promise<ResolvedPassphrase> => {
    const entered = await promptOf(deps)(opts.promptLabel ?? 'Wallet passphrase: ');
    if (entered.length === 0) throw noPassphraseError();
    return { passphrase: entered, source: 'prompt' };
  };

  const entry = await readPassphraseRecord(deps.dir ?? dataDir(), account);
  if (entry !== null) {
    const got = await storeByName(deps, entry.store).read(account, readOpts);
    if (got.kind === 'hit') return { passphrase: got.value, source: entry.store, recorded: true };
    if (canPrompt(deps)) return prompted();
    if (got.kind === 'miss') {
      throw noPassphraseError(describeStoreLocation(entry.store, account, deps.dir));
    }
    throw storeLockedError(entry.store, account, got.detail, deps.dir, true);
  }

  const store = storeFor(deps);
  // A legacy slot that holds an entry but did not answer. The 0600 file is
  // still read (it may hold this wallet's passphrase, and the shared legacy
  // slot may hold another wallet's), but if it misses too the answer is
  // `keychain_locked`, never a definite `passphrase_missing` (Unknown never blocks).
  let legacyLocked: { source: DurableStore; detail: string } | null = null;
  if (store !== null) {
    const own = await store.read(account, readOpts);
    if (own.kind === 'hit') return { passphrase: own.value, source: store.source };
    if (own.kind === 'locked') {
      if (canPrompt(deps)) return prompted();
      throw storeLockedError(store.source, account, own.detail, deps.dir, false);
    }
    if (own.kind === 'miss') {
      const legacy = await store.read(LEGACY_ACCOUNT, readOpts);
      if (legacy.kind === 'hit') {
        return {
          passphrase: legacy.value,
          source: store.source,
          migrateLegacy: () => migrateLegacyEntry(legacyOps(store, deps), account, legacy.value),
        };
      }
      if (legacy.kind === 'locked') legacyLocked = { source: store.source, detail: legacy.detail };
    }
  }

  const file = await fileStore(deps).read(account);
  if (file.kind === 'hit') return { passphrase: file.value, source: 'file' };

  if (canPrompt(deps)) return prompted();
  if (legacyLocked !== null) {
    throw storeLockedError(
      legacyLocked.source,
      LEGACY_ACCOUNT,
      legacyLocked.detail,
      deps.dir,
      false,
    );
  }
  throw noPassphraseError();
}

/** The three store operations a legacy migration makes, each under the store write bound. */
interface LegacyOps {
  copy(account: string, value: string): Promise<boolean>;
  readBack(account: string): Promise<string | null>;
  removeLegacy(): Promise<boolean>;
}

/**
 * The legacy migration on the store API (S10). Each call passes the store WRITE
 * bound (`writeMs`): a migration is a write and its check, not a signing read,
 * and a killed read-back is not a hit, so the legacy slot stays. Nothing here
 * writes the sidecar: only create, repair and `--replace` do.
 */
function legacyOps(store: OsStore, deps: PassphraseDeps): LegacyOps {
  const timeoutMs = timeoutsOf(deps).writeMs;
  return {
    async copy(account, value) {
      if (store.storable !== undefined && !store.storable(value)) return false;
      try {
        await store.store(account, value, { timeoutMs });
        return true;
      } catch {
        return false;
      }
    },
    async readBack(account) {
      const got = await store.read(account, { timeoutMs });
      return got.kind === 'hit' ? got.value : null;
    },
    removeLegacy: () => store.remove(LEGACY_ACCOUNT, { timeoutMs }),
  };
}

/**
 * Re-key the legacy shared slot under the owning wallet's own account: copy
 * first, verify the copy reads back byte-identical, and only then remove the
 * legacy entry. A failed copy or verify returns false with the legacy entry
 * still in place — the invariant is that at every step at least one durable
 * copy of the passphrase exists. The removal itself is best-effort: once the
 * copy has verified, a legacy entry that refuses to delete is redundant, not
 * unsafe (per-address reads win from then on), so it never fails the migration.
 */
async function migrateLegacyEntry(
  ops: LegacyOps,
  account: string,
  passphrase: string,
): Promise<boolean> {
  if (!(await ops.copy(account, passphrase))) return false;
  if ((await ops.readBack(account)) !== passphrase) return false;
  await ops.removeLegacy();
  return true;
}

/** storeDurablyDetailed's outcome with the classified reason behind it, for the message. */
export interface DurableWriteResult {
  outcome: DurableWrite;
  /** Why it was not stored, built from the classified kind only (S2). Absent on success. */
  detail?: string;
}

/**
 * Save `secret` as `address`'s passphrase in `store`, and say only what a
 * read-back proves.
 *
 * (a) Pre-read. An equal value is `already-stored`. A different value is
 *     `conflict` unless `replaceIf(existing)` says to replace it (repair, after
 *     proving the old entry does not open the wallet), or `kept-existing` when it
 *     says keep it. A locked or absent store is `uncertain` before any write.
 * (b) A value this store's writer refuses is `rejected-characters`.
 * (c) Exactly one write, of exactly this value.
 * (d) Always a read-back. Equal is `stored`; different is `conflict` (S1: some
 *     other writer holds the entry, so this is never "saved"); a miss after a
 *     killed write, or a store that does not answer the read-back, is
 *     `uncertain`; a miss after any other write is `store-failed`.
 *
 * All three steps share ONE deadline (decision 7): 10 s headless, 60 s at a
 * terminal. Each call gets the time left; a step with none left is not
 * started. At a terminal, a write still unsettled after a second prints
 * KEYCHAIN_WAIT_LINE once through `onWait`. The file store never waits.
 */
export async function storeDurablyDetailed(
  deps: PassphraseDeps,
  storeName: DurableStore,
  address: string,
  secret: string,
  opts: { replaceIf?: (existing: string) => Promise<boolean> } = {},
): Promise<DurableWriteResult> {
  const store = storeByName(deps, storeName);
  const account = walletStoreAccount(address);
  const t = timeoutsOf(deps);
  const end = Date.now() + (deps.isTTY === true ? t.interactiveWriteMs : t.writeMs);
  const left = (): number => end - Date.now();
  const outOfTime: DurableWriteResult = {
    outcome: 'uncertain',
    detail: `the ${storeNoun(storeName)} did not answer in time`,
  };

  let timer: NodeJS.Timeout | undefined;
  if (deps.isTTY === true && storeName !== 'file' && deps.onWait !== undefined) {
    const onWait = deps.onWait;
    timer = setTimeout(() => onWait(KEYCHAIN_WAIT_LINE), t.waitLineAfterMs);
    timer.unref?.();
  }
  try {
    if (left() <= 0) return outOfTime;
    const pre = await store.read(account, { timeoutMs: left() });
    if (pre.kind === 'locked' || pre.kind === 'absent') {
      return { outcome: 'uncertain', detail: pre.detail };
    }
    let update = false;
    if (pre.kind === 'hit') {
      if (pre.value === secret) return { outcome: 'already-stored' };
      if (opts.replaceIf === undefined) {
        return { outcome: 'conflict', detail: 'a different passphrase is already saved there' };
      }
      if (!(await opts.replaceIf(pre.value))) return { outcome: 'kept-existing' };
      update = true;
    }

    if (store.storable !== undefined && !store.storable(secret)) {
      return { outcome: 'rejected-characters' };
    }

    if (left() <= 0) return outOfTime;
    let writeError: unknown;
    let wrote = true;
    try {
      await store.store(account, secret, {
        timeoutMs: left(),
        ...(update ? { update: true } : {}),
      });
    } catch (err) {
      wrote = false;
      writeError = err;
    }

    if (left() <= 0) return outOfTime;
    const back = await store.read(account, { timeoutMs: left() });
    if (back.kind === 'hit') {
      return back.value === secret
        ? { outcome: 'stored' }
        : { outcome: 'conflict', detail: 'a different passphrase is saved there after the write' };
    }
    if (back.kind !== 'miss') return { outcome: 'uncertain', detail: back.detail };
    if (wrote) return { outcome: 'store-failed', detail: 'the saved passphrase did not read back' };
    const failure = classifyStoreFailure(storeName, writeError);
    if (isKilled(writeError)) {
      return { outcome: 'uncertain', detail: 'detail' in failure ? failure.detail : undefined };
    }
    return {
      outcome: 'store-failed',
      detail: writeFailureDetail(storeName, writeError, failure),
    };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** A write that was killed on its deadline: it may have committed, so only a read-back can say. */
function isKilled(err: unknown): boolean {
  return err instanceof StoreExecError && (err.killed || err.signal !== null);
}

/** Why a write failed, in classified words: the read classification, or the fs errno for the file. */
function writeFailureDetail(
  store: DurableStore,
  err: unknown,
  failure: Exclude<StoreRead, { kind: 'hit' }>,
): string {
  if (store === 'file') {
    const code = (err as { code?: unknown } | null)?.code;
    return typeof code === 'string' && /^E[A-Z]+$/.test(code)
      ? `the passphrase file could not be written (${code})`
      : 'the passphrase file could not be written';
  }
  return 'detail' in failure ? failure.detail : `the ${storeNoun(store)} write failed`;
}

/**
 * S1: how the --replace archive writer (local.ts) maps storeDurablyDetailed's
 * DurableWrite. `stored` only ever means the store holds the intended value: a
 * store that holds a DIFFERENT one (`conflict`, or `kept-existing`, which that
 * writer never asks for since it passes no replaceIf) is `store-failed`.
 */
export function toStoreOutcome(w: DurableWrite): Exclude<StorePassphraseOutcome, 'no-store'> {
  switch (w) {
    case 'stored':
      return 'stored';
    case 'already-stored':
      return 'stored';
    case 'kept-existing':
      return 'store-failed';
    case 'conflict':
      return 'store-failed';
    case 'uncertain':
      return 'uncertain';
    case 'store-failed':
      return 'store-failed';
    case 'rejected-characters':
      return 'rejected-characters';
  }
}

/** What `resolvePassphraseForCreate` chose, and where the secret now lives. */
export interface CreatePassphraseResult {
  passphrase: string;
  source: DurableStore | 'env';
  origin: 'generated' | 'env';
  /** describeStoreLocation of the store, or `TENJIN_WALLET_PASSPHRASE` when nothing durable holds it. */
  location: string;
  /** false only for an env secret whose store write was uncertain or failed. */
  durable: boolean;
  /** Why the file store: the OS store probed absent (S4 line), or --insecure-storage. Absent otherwise. */
  fileReason?: 'no-keyring' | 'insecure-storage';
  /** durable:false only: the store the env secret could not be saved to (picks the passphraseNote wording). */
  attempted?: DurableStore;
  /** durable:false only: why it was not saved there (picks the passphraseNote wording). */
  notSaved?: Exclude<DurableWrite, 'stored' | 'already-stored'>;
}

/**
 * Is the platform's own store reachable, before create or repair picks a
 * target? `absent` is definite (no `secret-tool`, no D-Bus, no default
 * keychain, no PowerShell, or a platform with no OS store at all) and sends the
 * secret to the 0600 file. `uncertain` (killed at 3 s, refused, anything
 * unclear) is NOT absent: the store exists and may just be locked, so callers
 * refuse rather than fall to plaintext (S3). DPAPI has no lock, so its probe is
 * never `uncertain`: anything but a missing PowerShell is `available`.
 */
export async function probeDurableStore(
  deps: PassphraseDeps,
): Promise<{ store: DurableStore; probe: StoreProbe; detail?: string }> {
  const store = storeFor(deps);
  if (store === null) {
    return { store: 'file', probe: 'absent', detail: 'this platform has no OS credential store' };
  }
  const result = await store.probe({ timeoutMs: timeoutsOf(deps).probeMs });
  return { store: store.source, ...result };
}

/**
 * Resolve the passphrase to ENCRYPT the new wallet at `address`. It NEVER
 * prompts (Q1): the secret is `TENJIN_WALLET_PASSPHRASE` when set, else 32
 * random bytes, chosen ONCE before any write. Users who want their own
 * passphrase set the variable.
 *
 * Where it goes: the file store with `insecureStorage`; otherwise the platform
 * store when its probe says available, the 0600 file when it says absent (S4),
 * and a refusal when it says uncertain (S3: a locked keychain is never routed
 * around). An env secret is saved durably too (Q2), so a one-shot agent install
 * with the variable set does not strand the wallet once the variable is gone.
 *
 * The write happens BEFORE the caller encrypts and is proven by reading it back
 * (storeDurablyDetailed), so a generated passphrase can never be lost between
 * generating it and persisting the encrypted key: a generated secret that is
 * not proven stored refuses the create. An env secret is still the user's to
 * keep, so its create goes ahead with `durable: false`. This path never touches
 * the legacy shared slot or any other wallet's entry.
 */
export async function resolvePassphraseForCreate(
  deps: PassphraseDeps,
  address: string,
  opts: { insecureStorage?: boolean } = {},
): Promise<CreatePassphraseResult> {
  const fromEnv = envPassphrase(deps.env);
  const origin = fromEnv !== null ? 'env' : 'generated';
  const secret = fromEnv ?? randomBytes(32).toString('base64url');
  const account = walletStoreAccount(address);
  const envOnly = (
    attempted: DurableStore,
    notSaved: Exclude<DurableWrite, 'stored' | 'already-stored'>,
  ): CreatePassphraseResult => ({
    passphrase: secret,
    source: 'env',
    origin,
    location: 'TENJIN_WALLET_PASSPHRASE',
    durable: false,
    attempted,
    notSaved,
  });

  let target: DurableStore;
  let fileReason: CreatePassphraseResult['fileReason'];
  if (opts.insecureStorage === true) {
    target = 'file';
    fileReason = 'insecure-storage';
  } else {
    const probed = await probeDurableStore(deps);
    if (probed.probe === 'available') {
      target = probed.store;
    } else if (probed.probe === 'absent') {
      target = 'file';
      fileReason = 'no-keyring';
    } else {
      if (origin === 'env') return envOnly(probed.store, 'uncertain');
      throw new CliError(
        'REFUSED',
        `The ${storeNoun(probed.store)} did not answer within ${Math.round(timeoutsOf(deps).probeMs / 1000)} s; it may be locked. No wallet was created.`,
        { fix: KEYCHAIN_LOCKED_FIX, details: unlockDetails('keychain_locked') },
      );
    }
  }

  const written = await storeDurablyDetailed(deps, target, address, secret);
  if (written.outcome === 'stored' || written.outcome === 'already-stored') {
    return {
      passphrase: secret,
      source: target,
      origin,
      location: describeStoreLocation(target, account, deps.dir),
      durable: true,
      ...(fileReason !== undefined ? { fileReason } : {}),
    };
  }
  if (origin === 'env') return envOnly(target, written.outcome);
  const detail = written.detail ?? `the ${storeNoun(target)} write failed`;
  if (target === 'file') {
    // Decision 6: there is no keychain to unlock here, so neither the fix nor
    // the details may point at one.
    const path = describeStoreLocation('file', account, deps.dir);
    throw new CliError(
      'REFUSED',
      `Could not save the wallet passphrase to ${path} (${detail}); no wallet was created.`,
      {
        fix: FILE_STORE_FAILED_FIX(path),
        details: { passphraseStore: { kind: 'file-write-failed', path } },
      },
    );
  }
  throw new CliError(
    'REFUSED',
    `Could not save the wallet passphrase to ${describeStoreLocation(target, account, deps.dir)} (${detail}); no wallet was created.`,
    { fix: KEYCHAIN_LOCKED_FIX, details: unlockDetails('keychain_locked', target) },
  );
}

/**
 * Where a store keeps `account`'s passphrase, in words an operator can find it
 * by. The file path shows the home directory as `~`.
 */
export function describeStoreLocation(store: DurableStore, account: string, dir?: string): string {
  switch (store) {
    case 'keychain':
      return `your macOS keychain (service ${KEYCHAIN_SERVICE}, account ${account})`;
    case 'secret-service':
      return `your Linux keyring (Secret Service, service ${KEYCHAIN_SERVICE}, account ${account})`;
    case 'dpapi':
      return `a DPAPI-encrypted file (passphrase.${account}.dpapi)`;
    case 'file':
      return tildePath(passphraseFilePathFor(account, dir));
  }
}

/** `path` with the home directory shown as `~`, as a person would type it. */
function tildePath(path: string): string {
  const home = homedir();
  if (home.length > 1 && (path === home || path.startsWith(`${home}/`))) {
    return `~${path.slice(home.length)}`;
  }
  return path;
}

/** Ask for a passphrase at the hidden prompt (repair, and the `--replace` outgoing wallet). */
export function promptPassphrase(deps: PassphraseDeps, label: string): Promise<string> {
  return promptOf(deps)(label);
}

/**
 * Why `store`'s `storable` gate turned a value away, as a clause: the
 * keychain writer's printable-ASCII rule, or a line break at the end that the
 * other stores' reads strip, so the saved value would not read back.
 */
export function unstorableWhy(store: DurableStore): string {
  return store === 'keychain'
    ? 'the macOS keychain writer only stores printable ASCII passphrases'
    : `a passphrase that ends in a line break does not read back from the ${storeNoun(store)}`;
}

/** The env passphrase, non-empty and used exactly as given; null when unset/empty. */
function envPassphrase(env: NodeJS.ProcessEnv): string | null {
  const value = env.TENJIN_WALLET_PASSPHRASE;
  return value !== undefined && value.length > 0 ? value : null;
}

function canPrompt(deps: PassphraseDeps): boolean {
  return deps.isTTY ?? Boolean(process.stdin.isTTY);
}

function promptOf(deps: PassphraseDeps): PromptFn {
  return deps.prompt ?? promptHidden;
}

/** The hidden prompt for a passphrase, whose Ctrl-C names the passphrase. */
const promptHidden: PromptFn = hiddenPrompt(
  () =>
    new CliError('USAGE', 'Passphrase entry was cancelled.', {
      fix: 'Run the command again, or set TENJIN_WALLET_PASSPHRASE.',
    }),
);

/**
 * No source holds a passphrase (`passphrase_missing`). The message keeps its
 * prefix (install-wallet matches on it); `location` names the recorded store
 * that came back empty. The fix sends the PERSON to repair (B1): never "set
 * TENJIN_WALLET_PASSPHRASE", which invites an agent to ask for the value.
 */
function noPassphraseError(location?: string): CliError {
  return new CliError(
    'USAGE',
    location === undefined
      ? 'No wallet passphrase is available.'
      : `No wallet passphrase is available: ${location} has no entry for this wallet.`,
    { fix: REPAIR_IN_TERMINAL, details: unlockDetails('passphrase_missing') },
  );
}

/**
 * A store that exists but did not answer (`keychain_locked`): unknown, never a
 * block, and its fix is to unlock it, never plaintext or another passphrase
 * (S3). `detail` is the classified one (S2). It also rides in
 * `details.storeDetail` so verify can word its row without parsing this message.
 */
function storeLockedError(
  store: DurableStore,
  account: string,
  detail: string,
  dir: string | undefined,
  recorded: boolean,
): CliError {
  const where = describeStoreLocation(store, account, dir);
  return new CliError(
    'USAGE',
    `The passphrase store ${recorded ? 'recorded ' : ''}for this wallet, ${where}, did not answer (${detail}).`,
    {
      fix: KEYCHAIN_LOCKED_FIX,
      details: { ...unlockDetails('keychain_locked', store), storeDetail: detail },
    },
  );
}
