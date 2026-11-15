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
  '.claude',
  '.netrc',
  '.npmrc',
  '.git-credentials',
  '.claude.json',
] as const;

export function secretHomePaths(home: string): string[] {
  return SECRET_HOME_PATHS.map((name) => join(home, name));
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
