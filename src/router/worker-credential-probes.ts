/**
 * THE CREDENTIAL-PROBE PART OF A DEEPSEEK WORKER'S SECRETS BOUNDARY. A worker's
 * sandbox keeps secrets out by path, and these few shell commands reach one
 * without a path: the keychain, git's credential helpers and the GitHub token
 * `gh` prints. They are refused in every permission mode. Nothing else is
 * judged here: every other command, a push or a merge included, goes through
 * the native permission flow of the accepted mode, as a native subagent's does.
 * Returns the refusal reason, or undefined to continue.
 */
const WRAPPERS = new Set(['sudo', 'env', 'command', 'exec', 'time', 'nohup', 'xargs', 'nice']);
const GIT_OPTIONS_WITH_VALUE = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace']);

function words(segment: string): string[] {
  return segment
    .trim()
    .split(/\s+/)
    .map((word) => word.replace(/^['"]|['"]$/g, ''))
    .filter(Boolean);
}

/** Splits a shell command into simple-command segments, including substitutions. */
function segments(command: string): string[][] {
  return command
    .split(/\n|;|&&|\|\||\||&|\$\(|`|\(|\)/)
    .map(words)
    .map((argv) => {
      let start = 0;
      while (start < argv.length) {
        const word = argv[start]!;
        if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word) || WRAPPERS.has(word)) start++;
        else break;
      }
      return argv.slice(start);
    })
    .filter((argv) => argv.length > 0);
}

function base(program: string): string {
  return program.slice(program.lastIndexOf('/') + 1);
}

function gitProbe(args: string[]): string | undefined {
  let at = 0;
  while (at < args.length && args[at]!.startsWith('-')) {
    const option = args[at]!.split('=')[0]!;
    at += GIT_OPTIONS_WITH_VALUE.has(option) && !args[at]!.includes('=') ? 2 : 1;
  }
  return args[at]?.startsWith('credential')
    ? 'Git credential helpers are not available to the worker.'
    : undefined;
}

function ghProbe(args: string[]): string | undefined {
  const [group, action] = args;
  // git's own credential helper call never passes through here; only a direct one does.
  return group === 'auth' &&
    (action === 'token' ||
      action === 'git-credential' ||
      args.some((arg) => arg === '-t' || arg === '--show-token'))
    ? 'GitHub tokens are not shown to the worker.'
    : undefined;
}

export function workerCredentialProbe(tool: string, input: unknown): string | undefined {
  if (tool !== 'Bash' || !input || typeof input !== 'object') return undefined;
  const command = (input as { command?: unknown }).command;
  if (typeof command !== 'string') return undefined;
  for (const argv of segments(command)) {
    const program = base(argv[0]!);
    if (program === 'security') return 'Keychain access is not available to the worker.';
    if (program.startsWith('git-credential'))
      return 'Git credential helpers are not available to the worker.';
    const reason =
      program === 'git'
        ? gitProbe(argv.slice(1))
        : program === 'gh'
          ? ghProbe(argv.slice(1))
          : undefined;
    if (reason) return reason;
  }
  return undefined;
}
