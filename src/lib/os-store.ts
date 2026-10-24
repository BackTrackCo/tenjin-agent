import { execFile } from 'node:child_process';
import { readFile, stat, unlink } from 'node:fs/promises';
import { CliError } from './errors';
import { hasCode } from './errno';
import { writeFileAtomic, writeFileAtomicExclusive } from './atomic-json';
import type { DurableStore } from './wallet-unlock';

export type { DurableStore } from './wallet-unlock';

/**
 * THE OS CREDENTIAL STORES: the macOS keychain, Windows DPAPI, the desktop-Linux
 * Secret Service, and the announced 0600 plaintext file where none exists. Each
 * backend keeps one secret per ACCOUNT under the service `tenjin-cli`, and where
 * an account's secret lives on disk (the DPAPI blob, the plain file) and what
 * account names its writer accepts are the caller's {@link SecretSlot}: the
 * wallet passphrase is one slot, a connected account's vault key another.
 *
 * A secret never appears in any argv (which the OS process table can show):
 * reads come back on stdout, and writes pipe the secret over the child's stdin.
 * A failed store CLI never carries its stdout anywhere (for a read, that IS the
 * secret): it rejects with a {@link StoreExecError} holding only the exit code,
 * the signal and the stderr {@link classifyStoreFailure} reads, and every detail
 * built from it names only those.
 */

export const KEYCHAIN_SERVICE = 'tenjin-cli';

/**
 * base64url alphabet — what generated secrets use. These go to the keychain as
 * the exact `-w '<value>'` line (no quote/backslash/space/newline can appear
 * inside the single quotes), so an existing reader of that shape sees no change.
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
 * Runs a command with an argv array (execFile semantics — never shell-interpolated).
 * When `stdin` is provided it is written to the child's stdin and the stream is
 * closed; this is how a secret reaches `security -i`, PowerShell, and
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

/**
 * THE ONLY REJECTION OF {@link defaultExecFor} (S2). A fresh error built from the
 * Node one, never the Node one itself: Node's message and its `stdout` field can
 * carry the child's output, and for a store read that output is the secret.
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

/** One store read, classified. `detail` never carries the store's output (S2). */
export type StoreRead =
  | { kind: 'hit'; value: string }
  | { kind: 'miss' }
  | { kind: 'absent'; detail: string }
  | { kind: 'locked'; detail: string };

/** Whether the platform store can answer at all: before create or repair picks a target. */
export type StoreProbe = 'available' | 'absent' | 'uncertain';

/** Per-call deadline for every store method (decision 7). Absent = never killed. The file store ignores it. */
export interface StoreCallOptions {
  timeoutMs?: number;
}

/**
 * A durable secret store, keyed by ACCOUNT. Reads never throw: they classify. A
 * write throws the StoreExecError (or the fs error, for the file store) so a
 * caller can tell a killed write, which may have committed, from a definite
 * failure.
 */
export interface OsStore {
  /** The source label reported when this store serves the secret. */
  source: DurableStore;
  read(account: string, o?: StoreCallOptions): Promise<StoreRead>;
  store(account: string, value: string, o?: StoreCallOptions & { update?: boolean }): Promise<void>;
  remove(account: string, o?: StoreCallOptions): Promise<boolean>;
  probe(o?: StoreCallOptions): Promise<{ probe: StoreProbe; detail?: string }>;
  /**
   * When present, a cheap pre-check for values this backend's writer refuses on
   * principle (the keychain's printable-ASCII gate), or that its read would not
   * give back byte for byte (a trailing line break the read strips) — so
   * callers can tell "this secret's characters" apart from "the store write
   * failed", and nothing is written that reads back as another secret.
   */
  storable?(value: string): boolean;
}

/**
 * WHERE ONE KIND OF SECRET LIVES, beside the keychain and keyring entries every
 * slot shares the service of: the accounts the keychain writer accepts (checked
 * before an account reaches the piped `security -i` line), the Secret Service
 * item's label, and the DPAPI blob and plain file for an account.
 */
export interface SecretSlot {
  accountRe: RegExp;
  label(account: string): string;
  blobPath(account: string): string;
  filePath(account: string): string;
}

/** The two seams every backend takes: the platform and the store-CLI exec. */
export interface OsStoreDeps {
  /** Defaults to `process.platform`; selects the OS store (or none). */
  platform?: NodeJS.Platform;
  /** The store-CLI exec seam; defaults to a real execFile with stdin support. */
  exec?: ExecFn;
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
 * (storeDurablyDetailed), so a killed write that did commit reads back as stored, and
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
export function osStoreFor(slot: SecretSlot, deps: OsStoreDeps): OsStore | null {
  switch (deps.platform ?? process.platform) {
    case 'darwin':
      return keychainStore(slot, deps);
    case 'win32':
      return dpapiStore(slot, deps);
    case 'linux':
      return secretServiceStore(slot, deps);
    default:
      return null;
  }
}

/** Any store by name, the file store included: what a record or a chosen target names. */
export function osStoreByName(slot: SecretSlot, deps: OsStoreDeps, name: DurableStore): OsStore {
  switch (name) {
    case 'keychain':
      return keychainStore(slot, deps);
    case 'secret-service':
      return secretServiceStore(slot, deps);
    case 'dpapi':
      return dpapiStore(slot, deps);
    case 'file':
      return fileStore(slot);
  }
}

/**
 * The account the Secret Service probe looks up: the zero address, which no
 * wallet can own. A hit or a miss both prove a keyring answered.
 */
const PROBE_ACCOUNT = '0x0000000000000000000000000000000000000000';

/**
 * macOS login keychain via the OS `security` tool — the same mechanism the GitHub
 * CLI uses. Reads use `-w`, so the secret comes back on stdout, never in argv.
 * Writes pipe an `add-generic-password` command to `security -i` over stdin so the
 * secret never appears in any argv either.
 */
function keychainStore(slot: SecretSlot, deps: OsStoreDeps): OsStore {
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
      if (!slot.accountRe.test(account) || !PRINTABLE_ASCII_RE.test(value)) {
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
// secret and the blob transit ONLY stdin/stdout, never argv. The stored blob
// is DPAPI-protected for the CurrentUser scope: it decrypts only as this user on
// this machine, which is the protection class we want; it is NOT the secret in
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
 * dependency), one blob per account at the slot's `blobPath`. store(): protect
 * the secret through DPAPI (CurrentUser) and write the base64 blob. read(): a
 * missing file is a miss; otherwise the blob is unprotected back to the
 * secret, and a failed unprotect is `locked` (unknown), never a miss.
 */
function dpapiStore(slot: SecretSlot, deps: OsStoreDeps): OsStore {
  const exec = deps.exec ?? defaultExecFor();
  return {
    source: 'dpapi',
    async read(account, o) {
      let blob: string;
      try {
        blob = await readFile(slot.blobPath(account), 'utf8');
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
    async store(account, secret, o) {
      const { stdout } = await exec(
        'powershell.exe',
        powershellArgs(DPAPI_PROTECT_SCRIPT),
        secret,
        callOpts(o),
      );
      const blob = stdout.replace(/\r?\n$/, '').trim();
      if (blob.length === 0) throw new StoreExecError('powershell.exe', { code: 0 });
      // DPAPI CurrentUser encryption is the real protection here; `mode` is inert
      // on win32 (writeFileAtomic drops it there) and only bites when a POSIX host
      // exercises this store in tests. The blob is ciphertext, not the secret.
      await writeFileAtomic(slot.blobPath(account), blob, { mode: 0o600 });
    },
    async remove(account) {
      try {
        await unlink(slot.blobPath(account));
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
 * reads the secret from stdin when stdin is not a TTY, so the secret never
 * appears in argv. Headless Linux, WSL and CI usually have no Secret Service at
 * all: an absent `secret-tool` (ENOENT) or no D-Bus is `absent`, which is what
 * sends create to the 0600 file. A keyring that is there but does not answer is
 * `locked`, which is not.
 */
function secretServiceStore(slot: SecretSlot, deps: OsStoreDeps): OsStore {
  const exec = deps.exec ?? defaultExecFor();
  const read: OsStore['read'] = async (account, o) => {
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
    async store(account, secret, o) {
      // secret-tool store replaces an existing item itself; `update` adds nothing here.
      await exec(
        'secret-tool',
        [
          'store',
          `--label=${slot.label(account)}`,
          'service',
          KEYCHAIN_SERVICE,
          'account',
          account,
        ],
        secret,
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
 * The plaintext FILE store: the slot's `filePath`, the secret at 0600 in a
 * 0700 dir, no trailing newline. Used only where no OS store exists or with
 * `--insecure-storage`. A first write is NO-CLOBBER, like the wallet file; only
 * repair, after proving the old value wrong, replaces one (`update`). fs calls
 * are not killed, so the per-call deadline is accepted and ignored. A read
 * strips exactly one trailing `\n` (someone may have written it with `echo`)
 * and nothing else: a secret ending in other whitespace round-trips, and one
 * ending in `\n` is refused before any write (`storable`), so a failed save
 * never leaves a file that reads back as a different secret.
 */
function fileStore(slot: SecretSlot): OsStore {
  return {
    source: 'file',
    async read(account) {
      try {
        const value = oneLfStripped(await readFile(slot.filePath(account), 'utf8'));
        return value.length > 0 ? { kind: 'hit', value } : { kind: 'miss' };
      } catch (err) {
        return classifyStoreFailure('file', err);
      }
    },
    // The read strips one trailing LF, so a value ending in one never reads back.
    storable: (value) => !value.endsWith('\n'),
    async store(account, value, o) {
      const path = slot.filePath(account);
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
        await unlink(slot.filePath(account));
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

/** A store payload with exactly one optional trailing newline (LF or CRLF) stripped. */
function oneNewlineStripped(stdout: string): string {
  return stdout.replace(/\r?\n$/, '');
}

/** File contents with exactly one trailing LF stripped. */
function oneLfStripped(text: string): string {
  return text.endsWith('\n') ? text.slice(0, -1) : text;
}

/** Reads one line of hidden input, writing `label` to stderr (never stdout). */
export type PromptFn = (label: string) => Promise<string>;

// Control bytes handled by the raw-mode reader, named to avoid literal control
// characters in the source.
const CTRL_C = 0x03;
const CTRL_D = 0x04;
const BACKSPACE = 0x7f;
const BACKSPACE_ALT = 0x08;

/**
 * A reader of one line of input that never echoes it. The prompt label goes to
 * stderr so stdout stays the single JSON envelope; typed characters are
 * consumed in raw mode and never printed. Ctrl-C rejects with `cancelled()`,
 * which names what was being entered. Only ever called on a real TTY (callers
 * gate it), so setRawMode is present; tests inject their own prompt and never
 * reach this.
 */
export function hiddenPrompt(cancelled: () => CliError): PromptFn {
  return (label) =>
    new Promise((resolve, reject) => {
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
            reject(cancelled());
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
