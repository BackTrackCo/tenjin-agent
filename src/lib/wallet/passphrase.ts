import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { CliError } from '../errors';
import { writeFileAtomic } from '../atomic-json';
import { passphraseBlobPath } from '../paths';

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
 */

const KEYCHAIN_SERVICE = 'tenjin-cli';
const KEYCHAIN_ACCOUNT = 'wallet';

/** base64url alphabet — exactly what `randomBytes(32).toString('base64url')` yields. */
const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;

export type PassphraseSource = 'env' | 'keychain' | 'dpapi' | 'secret-service' | 'prompt';

export interface ResolvedPassphrase {
  passphrase: string;
  source: PassphraseSource;
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
 * A per-platform durable passphrase store. `read` returns the stored passphrase or
 * null (miss / unavailable); `store` persists one and reports whether it stuck.
 * Neither throws: a store that cannot serve degrades to null/false so resolution
 * falls through to the next source.
 */
interface PassphraseStore {
  /** The source label reported when this store serves the passphrase. */
  source: Exclude<PassphraseSource, 'env' | 'prompt'>;
  read(): Promise<string | null>;
  store(passphrase: string): Promise<boolean>;
}

const defaultExec: ExecFn = (file, args, stdin) =>
  new Promise((resolve, reject) => {
    const child = execFile(file, args, { encoding: 'utf8' }, (err, stdout, stderr) => {
      if (err) reject(err);
      else resolve({ stdout, stderr });
    });
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
 * Resolve the passphrase to DECRYPT an existing wallet: env, then the platform's
 * OS store, then an interactive prompt. When none is available the caller cannot
 * sign, so this fails USAGE rather than guessing.
 */
export async function resolvePassphrase(deps: PassphraseDeps): Promise<ResolvedPassphrase> {
  const fromEnv = envPassphrase(deps.env);
  if (fromEnv !== null) return { passphrase: fromEnv, source: 'env' };

  const store = storeFor(deps);
  if (store !== null) {
    const fromStore = await store.read();
    if (fromStore !== null) return { passphrase: fromStore, source: store.source };
  }

  if (canPrompt(deps)) {
    const entered = await promptOf(deps)('Wallet passphrase: ');
    if (entered.length === 0) throw noPassphraseError();
    return { passphrase: entered, source: 'prompt' };
  }

  throw noPassphraseError();
}

/**
 * Resolve the passphrase to ENCRYPT a new wallet: env if set; else a strong random
 * passphrase auto-stored in the platform's OS store (so signing later is
 * transparent); else an interactive prompt asked twice; else USAGE. The store
 * write happens BEFORE the caller encrypts, so a fresh random passphrase can never
 * be lost between generating it and persisting the encrypted key.
 */
export async function resolvePassphraseForCreate(
  deps: PassphraseDeps,
): Promise<ResolvedPassphrase> {
  const fromEnv = envPassphrase(deps.env);
  if (fromEnv !== null) return { passphrase: fromEnv, source: 'env' };

  const store = storeFor(deps);
  if (store !== null) {
    const generated = randomBytes(32).toString('base64url');
    if (await store.store(generated)) {
      return { passphrase: generated, source: store.source };
    }
    // Store unavailable (locked, not installed, no access): fall to prompt / USAGE.
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
    async read() {
      try {
        const { stdout } = await exec('security', [
          'find-generic-password',
          '-s',
          KEYCHAIN_SERVICE,
          '-a',
          KEYCHAIN_ACCOUNT,
          '-w',
        ]);
        return trimmedNonEmpty(stdout);
      } catch {
        // Not found, locked, or `security` unavailable: treat as "no entry".
        return null;
      }
    },
    async store(passphrase) {
      // We only ever store our own base64url passphrases, so single-quoting them
      // in the piped command line is safe (no quote or backslash to escape). Refuse
      // anything else as a store-failure rather than attempting general escaping.
      if (!BASE64URL_RE.test(passphrase)) return false;
      try {
        const command = `add-generic-password -U -s ${KEYCHAIN_SERVICE} -a ${KEYCHAIN_ACCOUNT} -w '${passphrase}'\n`;
        await exec('security', ['-i'], command);
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
 * Windows DPAPI-protected file, via preinstalled PowerShell 5.1 (zero dependency).
 * store(): protect the passphrase through DPAPI (CurrentUser) and write the base64
 * blob to `<dataDir>/passphrase.dpapi` (clobber allowed — this file, unlike the
 * wallet, is safely regenerable). read(): a missing file is a miss; otherwise the
 * blob is unprotected back to the passphrase. Any PowerShell failure degrades.
 */
function dpapiStore(deps: PassphraseDeps): PassphraseStore {
  const exec = deps.exec ?? defaultExec;
  const blobPath = passphraseBlobPath(deps.dir);
  return {
    source: 'dpapi',
    async read() {
      let blob: string;
      try {
        blob = await readFile(blobPath, 'utf8');
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
    async store(passphrase) {
      try {
        const { stdout } = await exec(
          'powershell.exe',
          powershellArgs(DPAPI_PROTECT_SCRIPT),
          passphrase,
        );
        const blob = stdout.replace(/\r?\n$/, '').trim();
        if (blob.length === 0) return false;
        await writeFileAtomic(blobPath, blob, { mode: 0o600 });
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
    async read() {
      try {
        const { stdout } = await exec('secret-tool', [
          'lookup',
          'service',
          KEYCHAIN_SERVICE,
          'account',
          KEYCHAIN_ACCOUNT,
        ]);
        return trimmedNonEmpty(stdout);
      } catch {
        return null;
      }
    },
    async store(passphrase) {
      try {
        await exec(
          'secret-tool',
          [
            'store',
            '--label=tenjin-cli-wallet',
            'service',
            KEYCHAIN_SERVICE,
            'account',
            KEYCHAIN_ACCOUNT,
          ],
          passphrase,
        );
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
