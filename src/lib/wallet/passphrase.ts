import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFile, stat, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { CliError } from '../errors';
import { hasCode } from '../errno';
import { writeFileAtomic, writeFileAtomicExclusive } from '../atomic-json';
import { readPassphraseRecord } from '../passphrase-record';
import {
  dataDir,
  passphraseBlobPath,
  passphraseBlobPathFor,
  passphraseFilePathFor,
} from '../paths';
import {
  FILE_STORE_FAILED_FIX,
  KEYCHAIN_LOCKED_FIX,
  KEYCHAIN_WAIT_LINE,
  REPAIR_IN_TERMINAL,
  unlockDetails,
  type DurableStore,
} from '../wallet-unlock';

export type { DurableStore } from '../wallet-unlock';

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

const KEYCHAIN_SERVICE = 'tenjin-cli';
/**
 * The pre-per-wallet shared slot (service `tenjin-cli`, account `wallet`) that
 * every create used to `-U`-overwrite. Never written anymore; read only as a
 * migration fallback and removed only after a verified per-address copy exists.
 */
const LEGACY_ACCOUNT = 'wallet';

/**
 * The account the Secret Service probe looks up: the zero address, which no
 * wallet can own. A hit or a miss both prove a keyring answered.
 */
const PROBE_ACCOUNT = '0x0000000000000000000000000000000000000000';

/** A lowercase 0x-prefixed 20-byte hex address — the per-wallet store account. */
const ACCOUNT_ADDRESS_RE = /^0x[0-9a-f]{40}$/;

/**
 * base64url alphabet — what generated passphrases use. These still go to the
 * keychain as today's exact `-w '<value>'` line (no quote/backslash/space/newline
 * can appear inside the single quotes), so an existing reader of that shape sees
 * no change.
 */
const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;

/**
 * Printable ASCII: what the keychain writer stores at all. Anything outside the
 * base64url alphabet goes as `-X <utf8 hex>`, which carries only `[0-9a-f]` on
 * the piped `security -i` line, so nothing in the value can be read as syntax.
 * Non-printable bytes are refused, not encoded: `security -w` prints a value
 * with them back as hex, which would not read back byte-identical.
 */
const PRINTABLE_ASCII_RE = /^[\x20-\x7e]+$/;

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
 * Runs a command with an argv array (execFile semantics — never shell-interpolated).
 * When `stdin` is provided it is written to the child's stdin and the stream is
 * closed; this is how the passphrase reaches `security -i`, PowerShell, and
 * `secret-tool` WITHOUT ever appearing in an argv the process table can expose.
 *
 * `opts.timeoutMs` absent means the child is never killed: every signing read
 * passes none (B3), so an OS unlock dialog the person may be answering stays up.
 * Rejects only with a {@link StoreExecError} (S2).
 */
export type ExecFn = (
  file: string,
  args: string[],
  stdin?: string,
  opts?: { timeoutMs?: number },
) => Promise<{ stdout: string; stderr: string }>;

/** Reads one line of hidden input, writing `label` to stderr (never stdout). */
export type PromptFn = (label: string) => Promise<string>;

/**
 * THE ONLY REJECTION OF {@link defaultExecFor} (S2). A fresh error built from the
 * Node one, never the Node one itself: Node's message and its `stdout` field can
 * carry the child's output, and for a store read that output is the passphrase.
 * There is no `stdout` field here, ever. `stderr` is kept only so
 * {@link classifyStoreFailure} can tell "no such keychain" from "locked"; it is
 * non-enumerable so a `JSON.stringify` or a log of this error cannot carry it,
 * and nothing copies it into a message, detail, warning or file.
 */
export class StoreExecError extends Error {
  readonly code: number | string | null;
  readonly signal: string | null;
  readonly killed: boolean;
  readonly enoent: boolean;
  declare readonly stderr: string;

  constructor(
    file: string,
    fields: {
      code?: number | string | null;
      signal?: string | null;
      killed?: boolean;
      enoent?: boolean;
      stderr?: string;
    } = {},
  ) {
    const code = fields.code ?? null;
    const signal = fields.signal ?? null;
    super(`${file} failed (${code ?? signal ?? 'no exit code'})`);
    this.name = 'StoreExecError';
    this.code = code;
    this.signal = signal;
    this.killed = fields.killed ?? false;
    this.enoent = fields.enoent ?? code === 'ENOENT';
    Object.defineProperty(this, 'stderr', {
      value: fields.stderr ?? '',
      enumerable: false,
      writable: false,
    });
  }
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
   * storeDurably has not settled after `waitLineAfterMs`. Commands wire it to
   * stderr.
   */
  onWait?: (line: string) => void;
}

/** One store read, classified. `detail` never carries the store's output (S2). */
export type StoreRead =
  | { kind: 'hit'; value: string }
  | { kind: 'miss' }
  | { kind: 'absent'; detail: string }
  | { kind: 'locked'; detail: string };

/** Whether the platform store can answer at all: before create or repair picks a target. */
export type StoreProbe = 'available' | 'absent' | 'uncertain';

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

/** Why `storePassphraseForWallet` could not produce a durable per-address copy. */
export type StorePassphraseOutcome =
  'stored' | 'no-store' | 'rejected-characters' | 'store-failed' | 'uncertain';

/** Per-call deadline for every store method (decision 7). Absent = never killed. The file store ignores it. */
export interface StoreCallOptions {
  timeoutMs?: number;
}

/**
 * A durable passphrase store, keyed by ACCOUNT (the wallet's lowercase address,
 * or the read-only legacy `wallet` slot). Reads never throw: they classify. A
 * write throws the StoreExecError (or the fs error, for the file store) so
 * storeDurably can tell a killed write, which may have committed, from a
 * definite failure.
 */
interface PassphraseStore {
  /** The source label reported when this store serves the passphrase. */
  source: DurableStore;
  read(account: string, o?: StoreCallOptions): Promise<StoreRead>;
  store(account: string, value: string, o?: StoreCallOptions & { update?: boolean }): Promise<void>;
  remove(account: string, o?: StoreCallOptions): Promise<boolean>;
  probe(o?: StoreCallOptions): Promise<{ probe: StoreProbe; detail?: string }>;
  /**
   * When present, a cheap pre-check for values this backend's writer refuses on
   * principle (the keychain's printable-ASCII gate), or that its read would not
   * give back byte for byte (a trailing line break the read strips) — so
   * callers can tell "this passphrase's characters" apart from "the store
   * write failed", and nothing is written that reads back as another secret.
   */
  storable?(value: string): boolean;
}

/**
 * The real executor. Each call applies its own `opts.timeoutMs` when given, and
 * kills with SIGKILL: a store CLI that ignored SIGTERM would otherwise outlive
 * the deadline it was given.
 *
 * WHY A WRITE MAY BE KILLED NOW. A killed write used to be a correctness hazard:
 * create treated "the write did not return" as "the write did not stick" and fell
 * through to a different, prompted passphrase while the committed value won
 * every later decrypt. That fall-through is gone. One secret per address is
 * chosen before any write, and every write is followed by a read-back
 * (storeDurably), so a killed write that did commit reads back as stored, and
 * one that did not reads back as missing. The worst a kill leaves is an orphan
 * keychain entry for an address whose create was then abandoned, which no
 * wallet will ever read.
 *
 * WHY READS STAY UNBOUNDED, except in verify. Killing a read closes an OS unlock
 * dialog the person may be answering. The router bounds its WAIT with the call
 * budget instead (routing-payer.ts), and the read keeps running so a later call
 * gets its answer. Only doctor's and install's verify, which run unattended and
 * must finish, pass a read deadline.
 */
export function defaultExecFor(): ExecFn {
  return (file, args, stdin, opts) =>
    new Promise((resolve, reject) => {
      const child = execFile(
        file,
        args,
        {
          encoding: 'utf8',
          killSignal: 'SIGKILL',
          // 0 would mean "no timeout" to Node; a spent deadline is still a deadline.
          ...(opts?.timeoutMs !== undefined ? { timeout: Math.max(1, opts.timeoutMs) } : {}),
        },
        (err, stdout, stderr) => {
          if (err) reject(toStoreExecError(file, err, stderr));
          else resolve({ stdout, stderr });
        },
      );
      if (stdin !== undefined) {
        // A child that exits before draining stdin closes the pipe; swallow the
        // resulting EPIPE so the exec callback surfaces the real exit error instead.
        child.stdin?.on('error', () => undefined);
        child.stdin?.end(stdin);
      }
    });
}

/** The scrubbed copy of a Node exec error: no message, no stdout (S2). */
function toStoreExecError(file: string, err: unknown, stderr: unknown): StoreExecError {
  const e = err as { code?: unknown; signal?: unknown; killed?: unknown };
  const code = typeof e.code === 'number' || typeof e.code === 'string' ? e.code : null;
  return new StoreExecError(file, {
    code,
    signal: typeof e.signal === 'string' ? e.signal : null,
    killed: e.killed === true,
    enoent: code === 'ENOENT',
    stderr: typeof stderr === 'string' ? stderr : '',
  });
}

/** The effective deadlines: STORE_TIMEOUTS with any test override applied. */
function timeoutsOf(deps: PassphraseDeps): StoreTimeouts {
  return { ...STORE_TIMEOUTS, ...deps.timeouts };
}

/** What a store is called in a sentence: "the <noun> did not answer". */
export function storeNoun(store: DurableStore): string {
  switch (store) {
    case 'keychain':
      return 'macOS keychain';
    case 'secret-service':
      return 'Linux keyring';
    case 'dpapi':
      return 'Windows DPAPI store';
    case 'file':
      return 'passphrase file';
  }
}

/**
 * WHY A STORE OPERATION FAILED, in a form that can gate (section 2.5). Anything
 * unclear is `locked`, which is unknown and never a block (Q5): only a store
 * that provably is not there is `absent`, and only the store's own "no such
 * entry" is a `miss`.
 *
 * `stderr` is read here to pick the kind and then dropped. Every detail is
 * built only from the kind, the exit code and the signal (S2), never from the
 * child's output or the error's message. A thrown value that is not a
 * StoreExecError (a test fake, a bug) is `locked` with a fixed detail and its
 * message is not read. The file store's fs errors are classified by errno code.
 */
export function classifyStoreFailure(
  store: DurableStore,
  err: unknown,
): Exclude<StoreRead, { kind: 'hit' }> {
  if (store === 'file') {
    if (hasCode(err, 'ENOENT')) return { kind: 'miss' };
    const code = (err as { code?: unknown } | null)?.code;
    const errno = typeof code === 'string' && /^E[A-Z]+$/.test(code) ? ` (${code})` : '';
    return { kind: 'locked', detail: `the passphrase file could not be read${errno}` };
  }
  if (!(err instanceof StoreExecError)) {
    return {
      kind: 'locked',
      detail: `the ${storeNoun(store)} failed for a reason Tenjin could not classify`,
    };
  }
  if (err.killed || err.signal !== null) {
    return {
      kind: 'locked',
      detail: `the ${storeNoun(store)} did not answer (killed by ${err.signal ?? 'SIGKILL'})`,
    };
  }
  switch (store) {
    case 'keychain':
      if (err.enoent) return { kind: 'absent', detail: 'the `security` tool is not installed' };
      if (err.code === 44) return { kind: 'miss' };
      if (/default keychain could not be found/i.test(err.stderr)) {
        return { kind: 'absent', detail: 'there is no default keychain' };
      }
      if (/User interaction is not allowed/.test(err.stderr)) {
        return { kind: 'locked', detail: 'the keychain refused (user interaction is not allowed)' };
      }
      return { kind: 'locked', detail: `security exited ${String(err.code)}` };
    case 'secret-service':
      if (err.enoent) return { kind: 'absent', detail: 'secret-tool is not installed' };
      if (
        /Cannot autolaunch D-Bus|org\.freedesktop\.secrets was not provided|Could not connect/.test(
          err.stderr,
        )
      ) {
        return { kind: 'absent', detail: 'no Secret Service is reachable from this session' };
      }
      if (err.code === 1 && err.stderr.trim() === '') return { kind: 'miss' };
      return { kind: 'locked', detail: `secret-tool exited ${String(err.code)}` };
    case 'dpapi':
      if (err.enoent) return { kind: 'absent', detail: 'powershell.exe is not available' };
      return {
        kind: 'locked',
        detail: `the DPAPI unprotect failed (powershell.exe exited ${String(err.code)})`,
      };
  }
}

/** The durable store for this platform, or null where no built-in one exists. */
function storeFor(deps: PassphraseDeps): PassphraseStore | null {
  switch (deps.platform ?? process.platform) {
    case 'darwin':
      return keychainStore(deps);
    case 'win32':
      return dpapiStore(deps);
    case 'linux':
      return secretServiceStore(deps);
    default:
      return null;
  }
}

/** Any store by name, the file store included: what a sidecar entry or a chosen target names. */
function storeByName(deps: PassphraseDeps, name: DurableStore): PassphraseStore {
  switch (name) {
    case 'keychain':
      return keychainStore(deps);
    case 'secret-service':
      return secretServiceStore(deps);
    case 'dpapi':
      return dpapiStore(deps);
    case 'file':
      return fileStore(deps);
  }
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
function legacyOps(store: PassphraseStore, deps: PassphraseDeps): LegacyOps {
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

/** storeDurably's outcome with the classified reason behind it, for the caller's message. */
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
export async function storeDurably(
  deps: PassphraseDeps,
  store: DurableStore,
  address: string,
  secret: string,
  opts: { replaceIf?: (existing: string) => Promise<boolean> } = {},
): Promise<DurableWrite> {
  return (await storeDurablyDetailed(deps, store, address, secret, opts)).outcome;
}

/** {@link storeDurably}, also returning the classified detail behind a failure. */
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
 * S1: how storePassphraseForWallet maps storeDurably's DurableWrite. `stored`
 * only ever means the store holds the intended value: a store that holds a
 * DIFFERENT one (`conflict`, or `kept-existing`, which storePassphraseForWallet
 * never asks for since it passes no replaceIf) is `store-failed`.
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

/**
 * Ensure `passphrase` has a durable per-address copy (used by `wallet create
 * --replace` to ARCHIVE the outgoing wallet's prompt-entered passphrase before
 * the switch). `target` defaults to the platform store; with neither, the
 * outcome is `no-store`. `stored` only when the entry reads back byte-identical
 * (an existing identical entry counts); a different value already there, or
 * after the write, is `store-failed`, never `stored` (S1). Never touches any
 * other entry.
 */
export async function storePassphraseForWallet(
  deps: PassphraseDeps,
  address: string,
  passphrase: string,
  opts: { target?: DurableStore } = {},
): Promise<StorePassphraseOutcome> {
  const target = opts.target ?? storeFor(deps)?.source;
  if (target === undefined) return 'no-store';
  return toStoreOutcome(await storeDurably(deps, target, address, passphrase));
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
 * (storeDurably), so a generated passphrase can never be lost between
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
 * macOS login keychain via the OS `security` tool — the same mechanism the GitHub
 * CLI uses. Reads use `-w`, so the secret comes back on stdout, never in argv.
 * Writes pipe an `add-generic-password` command to `security -i` over stdin so the
 * passphrase never appears in any argv either.
 */
function keychainStore(deps: PassphraseDeps): PassphraseStore {
  const exec = deps.exec ?? defaultExecFor();
  return {
    source: 'keychain',
    async read(account, o) {
      try {
        const { stdout } = await exec(
          'security',
          ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', account, '-w'],
          undefined,
          callOpts(o),
        );
        const value = oneNewlineStripped(stdout);
        return value.length > 0 ? { kind: 'hit', value } : { kind: 'miss' };
      } catch (err) {
        return classifyStoreFailure('keychain', err);
      }
    },
    // The one backend that interpolates into a command line. base64url values
    // keep today's exact `-w '<value>'` line; any other printable-ASCII value is
    // sent as hex, so no character of it is ever syntax. Escaping is NOT a safe
    // alternative (backslash bites even inside single quotes there).
    storable: (value) => PRINTABLE_ASCII_RE.test(value),
    async store(account, value, o) {
      if (!ACCOUNT_ADDRESS_RE.test(account) || !PRINTABLE_ASCII_RE.test(value)) {
        throw new CliError('INTERNAL', 'Refusing to send this value to the keychain writer.');
      }
      const secret = BASE64URL_RE.test(value)
        ? `-w '${value}'`
        : `-X ${Buffer.from(value, 'utf8').toString('hex')}`;
      // No `-U` unless the caller proved the existing entry wrong (repair): a
      // plain add fails on a duplicate instead of overwriting it.
      const update = o?.update === true ? ' -U' : '';
      const command = `add-generic-password -s ${KEYCHAIN_SERVICE} -a ${account} ${secret}${update}\n`;
      await exec('security', ['-i'], command, callOpts(o));
    },
    async remove(account, o) {
      try {
        // No secret transits here; plain argv is fine (and visible is harmless).
        await exec(
          'security',
          ['delete-generic-password', '-s', KEYCHAIN_SERVICE, '-a', account],
          undefined,
          callOpts(o),
        );
        return true;
      } catch {
        return false;
      }
    },
    async probe(o) {
      try {
        await exec('security', ['default-keychain'], undefined, callOpts(o));
        return { probe: 'available' };
      } catch (err) {
        const failure = classifyStoreFailure('keychain', err);
        if (failure.kind === 'absent') return { probe: 'absent', detail: failure.detail };
        return {
          probe: 'uncertain',
          ...('detail' in failure ? { detail: failure.detail } : {}),
        };
      }
    },
  };
}

// PowerShell scripts run via built-in Windows PowerShell 5.1 (zero dependency).
// Each reads its input from stdin and writes its output to stdout, so the
// passphrase and the blob transit ONLY stdin/stdout, never argv. The stored blob
// is DPAPI-protected for the CurrentUser scope: it decrypts only as this user on
// this machine, which is the protection class we want; it is NOT the passphrase in
// plaintext.
const DPAPI_PROTECT_SCRIPT = [
  'Add-Type -AssemblyName System.Security;',
  '$in = [Console]::In.ReadToEnd();',
  '$bytes = [System.Text.Encoding]::UTF8.GetBytes($in);',
  "$prot = [System.Security.Cryptography.ProtectedData]::Protect($bytes, $null, 'CurrentUser');",
  '[Console]::Out.Write([Convert]::ToBase64String($prot));',
].join(' ');
const DPAPI_UNPROTECT_SCRIPT = [
  'Add-Type -AssemblyName System.Security;',
  '$in = [Console]::In.ReadToEnd();',
  '$blob = [Convert]::FromBase64String($in.Trim());',
  "$plain = [System.Security.Cryptography.ProtectedData]::Unprotect($blob, $null, 'CurrentUser');",
  '[Console]::Out.Write([System.Text.Encoding]::UTF8.GetString($plain));',
].join(' ');

function powershellArgs(script: string): string[] {
  return ['-NoProfile', '-NonInteractive', '-Command', script];
}

/**
 * Windows DPAPI-protected files, via preinstalled PowerShell 5.1 (zero
 * dependency), one blob per account: `passphrase.<address>.dpapi` for wallet
 * accounts, legacy `passphrase.dpapi` for the pre-per-wallet slot. store():
 * protect the passphrase through DPAPI (CurrentUser) and write the base64 blob.
 * read(): a missing file is a miss; otherwise the blob is unprotected back to
 * the passphrase, and a failed unprotect is `locked` (unknown), never a miss.
 */
function dpapiStore(deps: PassphraseDeps): PassphraseStore {
  const exec = deps.exec ?? defaultExecFor();
  const blobPathFor = (account: string): string =>
    account === LEGACY_ACCOUNT
      ? passphraseBlobPath(deps.dir)
      : passphraseBlobPathFor(account, deps.dir);
  return {
    source: 'dpapi',
    async read(account, o) {
      let blob: string;
      try {
        blob = await readFile(blobPathFor(account), 'utf8');
      } catch (err) {
        if (hasCode(err, 'ENOENT')) return { kind: 'miss' }; // No blob yet: a miss, not an error.
        return { kind: 'locked', detail: 'the DPAPI passphrase file could not be read' };
      }
      try {
        const { stdout } = await exec(
          'powershell.exe',
          powershellArgs(DPAPI_UNPROTECT_SCRIPT),
          blob,
          callOpts(o),
        );
        const value = stdout.replace(/\r?\n$/, '');
        return value.length > 0 ? { kind: 'hit', value } : { kind: 'miss' };
      } catch (err) {
        return classifyStoreFailure('dpapi', err);
      }
    },
    storable: readsBackFromStdout,
    async store(account, passphrase, o) {
      const { stdout } = await exec(
        'powershell.exe',
        powershellArgs(DPAPI_PROTECT_SCRIPT),
        passphrase,
        callOpts(o),
      );
      const blob = stdout.replace(/\r?\n$/, '').trim();
      if (blob.length === 0) throw new StoreExecError('powershell.exe', { code: 0 });
      // DPAPI CurrentUser encryption is the real protection here; `mode` is inert
      // on win32 (writeFileAtomic drops it there) and only bites when a POSIX host
      // exercises this store in tests. The blob is ciphertext, not the passphrase.
      await writeFileAtomic(blobPathFor(account), blob, { mode: 0o600 });
    },
    async remove(account) {
      try {
        await unlink(blobPathFor(account));
        return true;
      } catch {
        return false;
      }
    },
    async probe(o) {
      try {
        await exec(
          'powershell.exe',
          ['-NoProfile', '-NonInteractive', '-Command', '$null'],
          undefined,
          callOpts(o),
        );
        return { probe: 'available' };
      } catch (err) {
        // DPAPI has no lock state: the only thing a probe can learn is whether
        // powershell.exe exists. A slow cold start killed at the probe bound, or
        // any other answer, still means it does, so it is never `uncertain`
        // (which would refuse create and repair with an unlock fix that cannot
        // apply). A write that then fails is reported by the write itself.
        const failure = classifyStoreFailure('dpapi', err);
        if (failure.kind === 'absent') return { probe: 'absent', detail: failure.detail };
        return { probe: 'available' };
      }
    },
  };
}

/**
 * Desktop-Linux Secret Service via `secret-tool` (libsecret-tools). `secret-tool`
 * reads the secret from stdin when stdin is not a TTY, so the passphrase never
 * appears in argv. Headless Linux, WSL and CI usually have no Secret Service at
 * all: an absent `secret-tool` (ENOENT) or no D-Bus is `absent`, which is what
 * sends create to the 0600 file. A keyring that is there but does not answer is
 * `locked`, which is not.
 */
function secretServiceStore(deps: PassphraseDeps): PassphraseStore {
  const exec = deps.exec ?? defaultExecFor();
  const read: PassphraseStore['read'] = async (account, o) => {
    try {
      const { stdout } = await exec(
        'secret-tool',
        ['lookup', 'service', KEYCHAIN_SERVICE, 'account', account],
        undefined,
        callOpts(o),
      );
      const value = oneNewlineStripped(stdout);
      return value.length > 0 ? { kind: 'hit', value } : { kind: 'miss' };
    } catch (err) {
      return classifyStoreFailure('secret-service', err);
    }
  };
  return {
    source: 'secret-service',
    read,
    storable: readsBackFromStdout,
    async store(account, passphrase, o) {
      // secret-tool store replaces an existing item itself; `update` adds nothing here.
      await exec(
        'secret-tool',
        [
          'store',
          `--label=tenjin-cli wallet ${account}`,
          'service',
          KEYCHAIN_SERVICE,
          'account',
          account,
        ],
        passphrase,
        callOpts(o),
      );
    },
    async remove(account, o) {
      try {
        await exec(
          'secret-tool',
          ['clear', 'service', KEYCHAIN_SERVICE, 'account', account],
          undefined,
          callOpts(o),
        );
        return true;
      } catch {
        return false;
      }
    },
    async probe(o) {
      const got = await read(PROBE_ACCOUNT, o);
      if (got.kind === 'hit' || got.kind === 'miss') return { probe: 'available' };
      if (got.kind === 'absent') return { probe: 'absent', detail: got.detail };
      return { probe: 'uncertain', detail: got.detail };
    },
  };
}

/**
 * The passphrase FILE store: `<dataDir>/passphrase.<address>.plain`, the
 * plaintext passphrase at 0600 in a 0700 dir, no trailing newline. Used only
 * where no OS store exists or with `--insecure-storage` (see the file header).
 * A first write is NO-CLOBBER, like the wallet file; only repair, after proving
 * the old value wrong, replaces one (`update`). fs calls are not killed, so the
 * per-call deadline is accepted and ignored. A read strips exactly one trailing
 * `\n` (someone may have written it with `echo`) and nothing else: a secret
 * ending in other whitespace round-trips, and one ending in `\n` is refused
 * before any write (`storable`), so a failed save never leaves a file that
 * reads back as a different secret.
 */
function fileStore(deps: PassphraseDeps): PassphraseStore {
  const pathFor = (account: string): string => passphraseFilePathFor(account, deps.dir);
  return {
    source: 'file',
    async read(account) {
      try {
        const value = oneLfStripped(await readFile(pathFor(account), 'utf8'));
        return value.length > 0 ? { kind: 'hit', value } : { kind: 'miss' };
      } catch (err) {
        return classifyStoreFailure('file', err);
      }
    },
    // The read strips one trailing LF, so a value ending in one never reads back.
    storable: (value) => !value.endsWith('\n'),
    async store(account, value, o) {
      const path = pathFor(account);
      const mode = { mode: 0o600, dirMode: 0o700 };
      if (o?.update === true) return writeFileAtomic(path, value, mode);
      try {
        await writeFileAtomicExclusive(path, value, mode);
      } catch (err) {
        // AN EMPTY FILE HOLDS NO SECRET. On Windows the exclusive write opens the
        // target itself before writing, so a crash in between leaves it empty;
        // it reads as a miss, and without this every later save (repair
        // included) would hit EEXIST forever. Replacing it loses nothing.
        if (!hasCode(err, 'EEXIST') || (await stat(path).catch(() => null))?.size !== 0) throw err;
        await writeFileAtomic(path, value, mode);
      }
    },
    async remove(account) {
      try {
        await unlink(pathFor(account));
        return true;
      } catch {
        return false;
      }
    },
    probe: async () => ({ probe: 'available' }),
  };
}

/** The per-call exec options for a store call: the deadline when one was given, else none. */
function callOpts(o: StoreCallOptions | undefined): { timeoutMs?: number } | undefined {
  return o?.timeoutMs !== undefined ? { timeoutMs: o.timeoutMs } : undefined;
}

/**
 * Whether a value survives a read that strips one trailing newline (LF or
 * CRLF) from the store CLI's stdout: one that ends in CR or LF does not.
 */
function readsBackFromStdout(value: string): boolean {
  return !/[\r\n]$/.test(value);
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

/** A store payload with exactly one optional trailing newline (LF or CRLF) stripped. */
function oneNewlineStripped(stdout: string): string {
  return stdout.replace(/\r?\n$/, '');
}

/** File contents with exactly one trailing LF stripped. */
function oneLfStripped(text: string): string {
  return text.endsWith('\n') ? text.slice(0, -1) : text;
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

// Control bytes handled by the raw-mode reader, named to avoid literal control
// characters in the source.
const CTRL_C = 0x03;
const CTRL_D = 0x04;
const BACKSPACE = 0x7f;
const BACKSPACE_ALT = 0x08;

/**
 * Read one line of input without echoing it. The prompt label goes to stderr so
 * stdout stays the single JSON envelope; typed characters are consumed in raw
 * mode and never printed. Only ever called on a real TTY (canPrompt gates it),
 * so setRawMode is present; tests inject `prompt` and never reach this.
 */
function promptHidden(label: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    const stderr = process.stderr;
    const wasRaw = stdin.isRaw;
    let value = '';

    const cleanup = (): void => {
      stdin.setRawMode?.(wasRaw ?? false);
      stdin.pause();
      stdin.removeListener('data', onData);
    };
    const onData = (chunk: Buffer | string): void => {
      for (const ch of chunk.toString('utf8')) {
        const code = ch.charCodeAt(0);
        if (ch === '\n' || ch === '\r' || code === CTRL_D) {
          // Enter or Ctrl-D: submit what we have.
          cleanup();
          stderr.write('\n');
          resolve(value);
          return;
        }
        if (code === CTRL_C) {
          cleanup();
          stderr.write('\n');
          reject(
            new CliError('USAGE', 'Passphrase entry was cancelled.', {
              fix: 'Run the command again, or set TENJIN_WALLET_PASSPHRASE.',
            }),
          );
          return;
        }
        if (code === BACKSPACE || code === BACKSPACE_ALT) {
          value = value.slice(0, -1);
        } else {
          value += ch;
        }
      }
    };

    stderr.write(label);
    stdin.setRawMode?.(true);
    stdin.resume();
    stdin.on('data', onData);
  });
}
