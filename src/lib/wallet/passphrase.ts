import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { promisify } from 'node:util';
import { CliError } from '../errors';

/**
 * Wallet passphrase resolution. The private key lives on disk as an encrypted
 * Keystore v3 document; the passphrase that unlocks it is resolved here, in a
 * fixed order, so signing works headlessly (env), transparently on macOS
 * (keychain), or interactively (TTY). Every side-effecting seam — the `security`
 * CLI and the hidden-input prompt — is injectable so tests never touch the real
 * keychain or terminal.
 */

const KEYCHAIN_SERVICE = 'tenjin-cli';
const KEYCHAIN_ACCOUNT = 'wallet';

export type PassphraseSource = 'env' | 'keychain' | 'prompt';

export interface ResolvedPassphrase {
  passphrase: string;
  source: PassphraseSource;
}

/** Runs a command with an argv array (execFile semantics — never shell-interpolated). */
export type ExecFn = (file: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;

/** Reads one line of hidden input, writing `label` to stderr (never stdout). */
export type PromptFn = (label: string) => Promise<string>;

export interface PassphraseDeps {
  env: NodeJS.ProcessEnv;
  /** Defaults to `process.platform`; only `darwin` uses the keychain. */
  platform?: NodeJS.Platform;
  /** Whether an interactive prompt is possible; defaults to `process.stdin.isTTY`. */
  isTTY?: boolean;
  /** The `security` CLI seam; defaults to a real execFile. */
  exec?: ExecFn;
  /** The hidden-input prompt seam; defaults to a raw-mode TTY reader. */
  prompt?: PromptFn;
}

const execFileAsync = promisify(execFile);
const defaultExec: ExecFn = async (file, args) => {
  const { stdout, stderr } = await execFileAsync(file, args, { encoding: 'utf8' });
  return { stdout, stderr };
};

/**
 * Resolve the passphrase to DECRYPT an existing wallet: env, then the macOS
 * keychain, then an interactive prompt. When none is available the caller cannot
 * sign, so this fails USAGE rather than guessing.
 */
export async function resolvePassphrase(deps: PassphraseDeps): Promise<ResolvedPassphrase> {
  const fromEnv = envPassphrase(deps.env);
  if (fromEnv !== null) return { passphrase: fromEnv, source: 'env' };

  if (isMac(deps)) {
    const fromKeychain = await keychainRead(deps);
    if (fromKeychain !== null) return { passphrase: fromKeychain, source: 'keychain' };
  }

  if (canPrompt(deps)) {
    const entered = await promptOf(deps)('Wallet passphrase: ');
    if (entered.length === 0) throw noPassphraseError();
    return { passphrase: entered, source: 'prompt' };
  }

  throw noPassphraseError();
}

/**
 * Resolve the passphrase to ENCRYPT a new wallet: env if set; else on macOS a
 * strong random passphrase auto-stored in the keychain (so signing later is
 * transparent); else an interactive prompt asked twice; else USAGE. The keychain
 * write happens BEFORE the caller encrypts, so a fresh random passphrase can
 * never be lost between generating it and persisting the encrypted key.
 */
export async function resolvePassphraseForCreate(
  deps: PassphraseDeps,
): Promise<ResolvedPassphrase> {
  const fromEnv = envPassphrase(deps.env);
  if (fromEnv !== null) return { passphrase: fromEnv, source: 'env' };

  if (isMac(deps)) {
    const generated = randomBytes(32).toString('base64url');
    if (await keychainStore(deps, generated)) {
      return { passphrase: generated, source: 'keychain' };
    }
    // Keychain unavailable (locked, no access): fall through to prompt / USAGE.
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

/** The env passphrase, non-empty and used exactly as given; null when unset/empty. */
function envPassphrase(env: NodeJS.ProcessEnv): string | null {
  const value = env.TENJIN_WALLET_PASSPHRASE;
  return value !== undefined && value.length > 0 ? value : null;
}

function isMac(deps: PassphraseDeps): boolean {
  return (deps.platform ?? process.platform) === 'darwin';
}

function canPrompt(deps: PassphraseDeps): boolean {
  return deps.isTTY ?? Boolean(process.stdin.isTTY);
}

function promptOf(deps: PassphraseDeps): PromptFn {
  return deps.prompt ?? promptHidden;
}

/** Read the passphrase from the login keychain; null on a miss or any CLI failure. */
async function keychainRead(deps: PassphraseDeps): Promise<string | null> {
  const exec = deps.exec ?? defaultExec;
  try {
    const { stdout } = await exec('security', [
      'find-generic-password',
      '-s',
      KEYCHAIN_SERVICE,
      '-a',
      KEYCHAIN_ACCOUNT,
      '-w',
    ]);
    const passphrase = stdout.replace(/\r?\n$/, '');
    return passphrase.length > 0 ? passphrase : null;
  } catch {
    // Not found, locked, or `security` unavailable: treat as "no keychain entry".
    return null;
  }
}

/** Store the passphrase in the login keychain (creating or updating); false on any failure. */
async function keychainStore(deps: PassphraseDeps, passphrase: string): Promise<boolean> {
  const exec = deps.exec ?? defaultExec;
  try {
    await exec('security', [
      'add-generic-password',
      '-s',
      KEYCHAIN_SERVICE,
      '-a',
      KEYCHAIN_ACCOUNT,
      '-w',
      passphrase,
      '-U',
    ]);
    return true;
  } catch {
    return false;
  }
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
