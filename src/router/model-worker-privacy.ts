import { basename, join, resolve, sep } from 'node:path';

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

/**
 * The OS credential stores a working directory that covers the home folder would reach:
 * the macOS keychain files (the `security` command opens them itself, so a sandbox that
 * cannot read them finds no item) and the desktop-Linux keyring files and its D-Bus
 * sockets. Closing the folder closes the Tenjin and GitHub items with every other.
 */
export function osCredentialStorePaths(
  home: string,
  platform: NodeJS.Platform = process.platform,
  runtimeDir: string | undefined = process.env.XDG_RUNTIME_DIR,
): string[] {
  if (platform === 'darwin') return [join(home, 'Library', 'Keychains')];
  if (platform === 'linux')
    return [
      join(home, '.local', 'share', 'keyrings'),
      join(home, '.gnome2', 'keyrings'),
      ...(runtimeDir ? [join(runtimeDir, 'bus'), join(runtimeDir, 'keyring')] : []),
    ];
  return [];
}

export function secretHomePaths(home: string): string[] {
  return [
    ...SECRET_HOME_PATHS.map((name) => join(home, name)),
    ...osCredentialStorePaths(home),
    ...claudePrivatePaths(join(home, '.claude')),
  ];
}

/** In the Claude config folder: session history a native subagent reads too. */
export const CLAUDE_WORKER_READABLE = ['projects', 'history.jsonl'] as const;
/** In the Claude config folder: the user's settings files, read as a native subagent reads them. */
export const CLAUDE_WORKER_SETTINGS = ['settings.json', 'settings.local.json'] as const;

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
