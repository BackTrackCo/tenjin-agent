import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFile, unlink } from 'node:fs/promises';
import { CliError } from '../errors';
import { writeFileAtomic } from '../atomic-json';
import { passphraseBlobPath, passphraseBlobPathFor } from '../paths';

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
 * A store that cannot serve degrades to null/false so resolution falls through to
 * the next source rather than hard-failing, and no plaintext is ever written to
 * disk (the Windows blob is DPAPI-encrypted, not the passphrase itself).
 *
 * Durable entries are PER WALLET (account = lowercase address); the legacy
 * shared slot is only ever read, for migration (#32).
 */

const KEYCHAIN_SERVICE = 'tenjin-cli';
/**
 * The pre-per-wallet shared slot (service `tenjin-cli`, account `wallet`) that
 * every create used to `-U`-overwrite. Never written anymore; read only as a
 * migration fallback and removed only after a verified per-address copy exists.
 */
const LEGACY_ACCOUNT = 'wallet';

/** A lowercase 0x-prefixed 20-byte hex address — the per-wallet store account. */
const ACCOUNT_ADDRESS_RE = /^0x[0-9a-f]{40}$/;

/**
 * base64url alphabet — what generated passphrases use, and the injection gate
 * for the piped `security -i` command line (no quote/backslash/space/newline):
 * values outside it are refused by the keychain writer, never escaped.
 */
const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;

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

export type PassphraseSource = 'env' | 'keychain' | 'dpapi' | 'secret-service' | 'prompt';

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
}

/**
 * Runs a command with an argv array (execFile semantics — never shell-interpolated).
 * When `stdin` is provided it is written to the child's stdin and the stream is
 * closed; this is how the passphrase reaches `security -i`, PowerShell, and
 * `secret-tool` WITHOUT ever appearing in an argv the process table can expose.
 */
export type ExecFn = (
  file: string,
  args: string[],
  stdin?: string,
) => Promise<{ stdout: string; stderr: string }>;

/** Reads one line of hidden input, writing `label` to stderr (never stdout). */
export type PromptFn = (label: string) => Promise<string>;

export interface PassphraseDeps {
  env: NodeJS.ProcessEnv;
  /** Data dir that holds the Windows DPAPI blob; defaults to the resolved data dir. */
  dir?: string;
  /** Defaults to `process.platform`; selects the OS store (or none). */
  platform?: NodeJS.Platform;
  /** Whether an interactive prompt is possible; defaults to `process.stdin.isTTY`. */
  isTTY?: boolean;
  /** The store-CLI exec seam; defaults to a real execFile with stdin support. */
  exec?: ExecFn;
  /** The hidden-input prompt seam; defaults to a raw-mode TTY reader. */
  prompt?: PromptFn;
}

/**
 * A per-platform durable passphrase store, keyed by ACCOUNT (the wallet's
 * lowercase address, or the read-only legacy `wallet` slot). None of the
 * methods throws: a store that cannot serve degrades to null/false so
 * resolution falls through to the next source.
 */
interface PassphraseStore {
  /** The source label reported when this store serves the passphrase. */
  source: Exclude<PassphraseSource, 'env' | 'prompt'>;
  read(account: string): Promise<string | null>;
  store(account: string, passphrase: string): Promise<boolean>;
  remove(account: string): Promise<boolean>;
  /**
   * When present, a cheap pre-check for values this backend's writer refuses on
   * principle (the keychain's base64url injection gate) — so callers can tell
   * "this passphrase's characters" apart from "the store write failed".
   */
  storable?(passphrase: string): boolean;
}

/**
 * How long a credential-store helper gets before it is killed. These are GUI-
 * backed tools: a locked keychain or a stalled Secret Service prompt can block
 * forever, and `doctor` runs unattended. Every caller already treats a failed
 * exec as "no entry", so a timeout degrades to the passphrase being unreachable
 * and the wallet reported present but not verified.
 */
const EXEC_TIMEOUT_MS = 5_000;

const defaultExec: ExecFn = (file, args, stdin) =>
  new Promise((resolve, reject) => {
    const child = execFile(
      file,
      args,
      { encoding: 'utf8', timeout: EXEC_TIMEOUT_MS },
      (err, stdout, stderr) => {
        if (err) reject(err);
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

/**
 * Resolve the passphrase to DECRYPT the existing wallet at `address`: env, then
 * the wallet's own per-address entry in the platform's OS store, then — as a
 * one-time migration fallback — the legacy shared slot, then an interactive
 * prompt. A legacy hit carries a `migrateLegacy` handle the caller invokes only
 * after proving the passphrase decrypts this wallet (see ResolvedPassphrase).
 * When no source is available the caller cannot sign, so this fails USAGE
 * rather than guessing.
 */
export async function resolvePassphrase(
  deps: PassphraseDeps,
  address: string,
): Promise<ResolvedPassphrase> {
  const fromEnv = envPassphrase(deps.env);
  if (fromEnv !== null) return { passphrase: fromEnv, source: 'env' };

  const store = storeFor(deps);
  if (store !== null) {
    const account = walletStoreAccount(address);
    const own = await store.read(account);
    if (own !== null) return { passphrase: own, source: store.source };

    const legacy = await store.read(LEGACY_ACCOUNT);
    if (legacy !== null) {
      return {
        passphrase: legacy,
        source: store.source,
        migrateLegacy: () => migrateLegacyEntry(store, account, legacy),
      };
    }
  }

  if (canPrompt(deps)) {
    const entered = await promptOf(deps)('Wallet passphrase: ');
    if (entered.length === 0) throw noPassphraseError();
    return { passphrase: entered, source: 'prompt' };
  }

  throw noPassphraseError();
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
  store: PassphraseStore,
  account: string,
  passphrase: string,
): Promise<boolean> {
  if (!(await store.store(account, passphrase))) return false;
  if ((await store.read(account)) !== passphrase) return false;
  await store.remove(LEGACY_ACCOUNT);
  return true;
}

/** Why `storePassphraseForWallet` could not produce a durable per-address copy. */
export type StorePassphraseOutcome = 'stored' | 'no-store' | 'rejected-characters' | 'store-failed';

/**
 * Ensure `passphrase` has a durable per-address copy in the platform's OS store
 * (used by `wallet create --replace` to ARCHIVE the outgoing wallet's
 * prompt-entered passphrase before the switch). `stored` only when the entry
 * verifiably reads back byte-identical (an existing identical entry counts);
 * otherwise the outcome says WHY — no store on this platform, the backend's
 * writer refusing the passphrase's characters (the keychain's base64url gate),
 * or a write/verify failure. The caller decides whether a non-`stored` outcome
 * blocks or just warns. Never touches any other entry.
 */
export async function storePassphraseForWallet(
  deps: PassphraseDeps,
  address: string,
  passphrase: string,
): Promise<StorePassphraseOutcome> {
  const store = storeFor(deps);
  if (store === null) return 'no-store';
  const account = walletStoreAccount(address);
  // Identical-entry check FIRST: a passphrase that already has a durable copy is
  // `stored` even when the backend's writer would refuse to (re)write it.
  if ((await store.read(account)) === passphrase) return 'stored';
  if (store.storable !== undefined && !store.storable(passphrase)) return 'rejected-characters';
  if (!(await store.store(account, passphrase))) return 'store-failed';
  return (await store.read(account)) === passphrase ? 'stored' : 'store-failed';
}

/**
 * Resolve the passphrase to ENCRYPT the new wallet at `address`: env if set;
 * else a strong random passphrase auto-stored in the platform's OS store under
 * the wallet's OWN per-address entry (so signing later is transparent); else an
 * interactive prompt asked twice; else USAGE. The store write happens BEFORE the
 * caller encrypts and is verified by reading it back, so a fresh random
 * passphrase can never be lost between generating it and persisting the
 * encrypted key. This path never touches the legacy shared slot or any other
 * wallet's entry — creating wallet B cannot strand wallet A.
 */
export async function resolvePassphraseForCreate(
  deps: PassphraseDeps,
  address: string,
): Promise<ResolvedPassphrase> {
  const fromEnv = envPassphrase(deps.env);
  if (fromEnv !== null) return { passphrase: fromEnv, source: 'env' };

  const store = storeFor(deps);
  if (store !== null) {
    const account = walletStoreAccount(address);
    const generated = randomBytes(32).toString('base64url');
    if ((await store.store(account, generated)) && (await store.read(account)) === generated) {
      return { passphrase: generated, source: store.source };
    }
    // Store unavailable (locked, not installed, no access) or the write did not
    // verifiably stick: fall to prompt / USAGE rather than encrypt with a
    // passphrase that has no durable copy.
  }

  if (canPrompt(deps)) {
    const prompt = promptOf(deps);
    const first = await prompt('Set a wallet passphrase: ');
    if (first.length === 0) {
      throw new CliError('USAGE', 'The wallet passphrase must not be empty.', {
        fix: 'Enter a non-empty passphrase, or set TENJIN_WALLET_PASSPHRASE.',
      });
    }
    const second = await prompt('Confirm passphrase: ');
    if (first !== second) {
      throw new CliError('USAGE', 'The passphrases did not match.', {
        fix: 'Run `tenjin wallet create` again and enter the same passphrase both times.',
      });
    }
    return { passphrase: first, source: 'prompt' };
  }

  throw noPassphraseError();
}

/**
 * macOS login keychain via the OS `security` tool — the same mechanism the GitHub
 * CLI uses. Reads use `-w`, so the secret comes back on stdout, never in argv.
 * Writes pipe an `add-generic-password` command to `security -i` over stdin so the
 * passphrase never appears in any argv either.
 */
function keychainStore(deps: PassphraseDeps): PassphraseStore {
  const exec = deps.exec ?? defaultExec;
  return {
    source: 'keychain',
    async read(account) {
      try {
        const { stdout } = await exec('security', [
          'find-generic-password',
          '-s',
          KEYCHAIN_SERVICE,
          '-a',
          account,
          '-w',
        ]);
        return trimmedNonEmpty(stdout);
      } catch {
        // Not found, locked, or `security` unavailable: treat as "no entry".
        return null;
      }
    },
    // The one backend that interpolates into a command line, so only base64url
    // values pass; escaping is NOT a safe alternative (backslash bites even
    // inside single quotes there).
    storable: (passphrase) => BASE64URL_RE.test(passphrase),
    async store(account, passphrase) {
      // Single-quoting is safe because base64url excludes quote/backslash/space;
      // anything else is refused as a store-failure rather than escaped.
      // Deliberately NO `-U`: add-generic-password fails on a duplicate instead
      // of updating in place, so an existing entry can never be overwritten.
      if (!BASE64URL_RE.test(passphrase) || !BASE64URL_RE.test(account)) return false;
      try {
        const command = `add-generic-password -s ${KEYCHAIN_SERVICE} -a ${account} -w '${passphrase}'\n`;
        await exec('security', ['-i'], command);
        return true;
      } catch {
        return false;
      }
    },
    async remove(account) {
      try {
        // No secret transits here; plain argv is fine (and visible is harmless).
        await exec('security', ['delete-generic-password', '-s', KEYCHAIN_SERVICE, '-a', account]);
        return true;
      } catch {
        return false;
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
 * the passphrase. Any PowerShell failure degrades.
 */
function dpapiStore(deps: PassphraseDeps): PassphraseStore {
  const exec = deps.exec ?? defaultExec;
  const blobPathFor = (account: string): string =>
    account === LEGACY_ACCOUNT
      ? passphraseBlobPath(deps.dir)
      : passphraseBlobPathFor(account, deps.dir);
  return {
    source: 'dpapi',
    async read(account) {
      let blob: string;
      try {
        blob = await readFile(blobPathFor(account), 'utf8');
      } catch {
        return null; // No blob yet (or unreadable): a miss, not an error.
      }
      try {
        const { stdout } = await exec(
          'powershell.exe',
          powershellArgs(DPAPI_UNPROTECT_SCRIPT),
          blob,
        );
        const passphrase = stdout.replace(/\r?\n$/, '');
        return passphrase.length > 0 ? passphrase : null;
      } catch {
        return null; // Wrong user/machine, tampered blob, or no PowerShell: degrade.
      }
    },
    async store(account, passphrase) {
      try {
        const { stdout } = await exec(
          'powershell.exe',
          powershellArgs(DPAPI_PROTECT_SCRIPT),
          passphrase,
        );
        const blob = stdout.replace(/\r?\n$/, '').trim();
        if (blob.length === 0) return false;
        // DPAPI CurrentUser encryption is the real protection here; `mode` is inert
        // on win32 (writeFileAtomic drops it there) and only bites when a POSIX host
        // exercises this store in tests. The blob is ciphertext, not the passphrase.
        await writeFileAtomic(blobPathFor(account), blob, { mode: 0o600 });
        return true;
      } catch {
        return false;
      }
    },
    async remove(account) {
      try {
        await unlink(blobPathFor(account));
        return true;
      } catch {
        return false;
      }
    },
  };
}

/**
 * Desktop-Linux Secret Service via `secret-tool` (libsecret-tools), best-effort.
 * `secret-tool` reads the secret from stdin when stdin is not a TTY, so the
 * passphrase never appears in argv. Headless Linux and CI have no built-in durable
 * store, so an absent `secret-tool` (ENOENT) or any failure degrades silently to
 * the next source (env/prompt); nothing is ever written to disk here.
 */
function secretServiceStore(deps: PassphraseDeps): PassphraseStore {
  const exec = deps.exec ?? defaultExec;
  return {
    source: 'secret-service',
    async read(account) {
      try {
        const { stdout } = await exec('secret-tool', [
          'lookup',
          'service',
          KEYCHAIN_SERVICE,
          'account',
          account,
        ]);
        return trimmedNonEmpty(stdout);
      } catch {
        return null;
      }
    },
    async store(account, passphrase) {
      try {
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
        );
        return true;
      } catch {
        return false;
      }
    },
    async remove(account) {
      try {
        await exec('secret-tool', ['clear', 'service', KEYCHAIN_SERVICE, 'account', account]);
        return true;
      } catch {
        return false;
      }
    },
  };
}

/** A store payload with exactly one optional trailing newline stripped; null when empty. */
function trimmedNonEmpty(stdout: string): string | null {
  const value = stdout.replace(/\r?\n$/, '');
  return value.length > 0 ? value : null;
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

function noPassphraseError(): CliError {
  return new CliError('USAGE', 'No wallet passphrase is available.', {
    fix: 'Set TENJIN_WALLET_PASSPHRASE (headless) or run in a terminal.',
  });
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
