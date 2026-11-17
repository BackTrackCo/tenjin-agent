import { readFile } from 'node:fs/promises';
import { basename, join, resolve, sep } from 'node:path';
import { envPieces } from './worker-env-secrets';

/** Provider secrets excluded from worker commands, not unrelated MCP credentials. */
export const MODEL_WORKER_PROVIDER_CREDENTIAL_KEYS = [
  'DEEPSEEK_API_KEY',
  'DEEPSEEK_KEY',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'TYPESAFE_KEY',
  'TYPESAFE_API_KEY',
] as const;

/** Wallet secrets are excluded too: a worker must not receive a separate signer. */
export const MODEL_WORKER_CREDENTIAL_KEYS = [
  ...MODEL_WORKER_PROVIDER_CREDENTIAL_KEYS,
  'TENJIN_WALLET_KEY',
  'TENJIN_WALLET_PASSPHRASE',
] as const;

export const SECRET_HOME_PATHS = [
  '.ssh',
  '.aws',
  '.kube',
  '.gnupg',
  '.netrc',
  '.npmrc',
  '.git-credentials',
  '.claude.json',
] as const;

export function secretHomePaths(home: string): string[] {
  return [
    ...SECRET_HOME_PATHS.map((name) => join(home, name)),
    ...claudePrivatePaths(join(home, '.claude')),
  ];
}

/** In the Claude config folder: session history a native subagent reads too. */
export const CLAUDE_WORKER_READABLE = ['projects', 'history.jsonl'] as const;
/** In the Claude config folder: opened to the worker only once their env values are known. */
export const CLAUDE_WORKER_SETTINGS = ['settings.json', 'settings.local.json'] as const;

/**
 * A settings file's `env` block, read whole: null when there is no file, undefined when
 * it cannot be read or parsed, so its values are unknown.
 */
export async function settingsFileEnv(
  path: string,
): Promise<Record<string, unknown> | null | undefined> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? null : undefined;
  }
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    const env = (parsed as { env?: unknown }).env;
    if (env === undefined) return {};
    return env !== null && typeof env === 'object' && !Array.isArray(env)
      ? (env as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Claude Code hands a settings file's `env` block to the worker's commands, and the worker
 * may read the user's settings files. Each value is replaced by the variable's name, as an
 * env file value is.
 */
export class SettingsEnvValues {
  private readonly names = new Map<string, string>();
  private pieces: string[] = [];

  add(env: Record<string, unknown> | null | undefined): void {
    const before = this.names.size;
    for (const [key, raw] of Object.entries(env ?? {})) {
      const value = typeof raw === 'number' || typeof raw === 'boolean' ? String(raw) : raw;
      if (typeof value === 'string')
        for (const piece of envPieces({ key, value, written: value }))
          if (!this.names.has(piece)) this.names.set(piece, `[env:${key}]`);
    }
    // Longest first, so a value that holds another is replaced whole.
    if (this.names.size !== before)
      this.pieces = [...this.names.keys()].sort((a, b) => b.length - a.length);
  }

  /** How many distinct strings are replaced; never the strings. */
  get size(): number {
    return this.names.size;
  }

  readonly redact = (text: string): string => {
    let out = text;
    for (const piece of this.pieces)
      if (out.includes(piece)) out = out.split(piece).join(this.names.get(piece)!);
    return out;
  };
}

/** Native support files remain usable; credentials and cross-session state do not. */
export function claudePrivatePaths(configDir: string): string[] {
  return [
    '.credentials.json',
    '.claude.json',
    'settings.json',
    'settings.local.json',
    '.mcp.json',
    'mcp.json',
    'projects',
    'history.jsonl',
    'debug',
    'session-env',
    'tasks',
    'todos',
    'backups',
    'file-history',
  ].map((name) => join(configDir, name));
}

/** Instruction disclosure never admits credential files or private controller state. */
export function isSecretPath(path: string, protectedPaths: readonly string[] = []): boolean {
  const absolute = resolve(path);
  const file = basename(absolute);
  return (
    protectedPaths.some((root) => {
      const canonical = resolve(root);
      return absolute === canonical || absolute.startsWith(`${canonical}${sep}`);
    }) ||
    absolute
      .split(sep)
      .some((part) => ['.ssh', '.aws', '.kube', '.gnupg', '.tenjin'].includes(part)) ||
    file.startsWith('.env') ||
    /^(?:auth|wallet(?:\..+)?|credentials|passphrase-store)\.json$/i.test(file) ||
    /^\.credentials\.json$/i.test(file) ||
    /^(?:\.netrc|\.npmrc|\.git-credentials)$/i.test(file) ||
    /\.(?:pem|p12|key)$/i.test(file)
  );
}
