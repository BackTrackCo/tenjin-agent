/**
 * The floor under a DeepSeek worker's own classifier: shell actions the worker
 * never runs, whatever its permission mode or classifier says. Deterministic and
 * fail-closed on what it recognises; everything else is left to the native
 * permission flow. Returns the denial reason, or undefined to continue.
 */
const WRAPPERS = new Set(['sudo', 'env', 'command', 'exec', 'time', 'nohup', 'xargs', 'nice']);
const PROTECTED_BRANCHES = new Set(['main', 'master']);
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

function gitDeny(args: string[]): string | undefined {
  let at = 0;
  while (at < args.length && args[at]!.startsWith('-')) {
    const option = args[at]!.split('=')[0]!;
    at += GIT_OPTIONS_WITH_VALUE.has(option) && !args[at]!.includes('=') ? 2 : 1;
  }
  const sub = args[at];
  if (sub === undefined) return undefined;
  if (sub.startsWith('credential'))
    return 'Git credential helpers are not available to the worker.';
  if (sub !== 'push') return undefined;
  const rest = args.slice(at + 1);
  const flags = rest.filter((arg) => arg.startsWith('-'));
  if (
    flags.some((flag) =>
      /^(-f|--force|--force-with-lease.*|--force-if-includes|--mirror|--all|--delete|-d|--prune)$/.test(
        flag,
      ),
    ) ||
    flags.some((flag) => /^-[a-zA-Z]*[fd][a-zA-Z]*$/.test(flag))
  )
    return 'The worker may not force-push, delete remote branches or push every branch.';
  const positional = rest.filter((arg) => !arg.startsWith('-'));
  const refspecs = positional.slice(1);
  if (refspecs.length === 0)
    return 'Name the branch to push explicitly, for example `git push origin <branch>`.';
  for (const refspec of refspecs) {
    if (refspec.startsWith('+') || refspec.startsWith(':'))
      return 'The worker may not force-push or delete remote branches.';
    const target = (refspec.includes(':') ? refspec.slice(refspec.lastIndexOf(':') + 1) : refspec)
      .replace(/^refs\/heads\//, '')
      .trim();
    if (PROTECTED_BRANCHES.has(target) || target === 'HEAD')
      return `The worker may not push to ${target === 'HEAD' ? 'an unnamed branch' : target}.`;
  }
  return undefined;
}

function ghDeny(args: string[]): string | undefined {
  const [group, action] = args;
  // git's own credential helper call never passes through here; only a direct one does.
  if (group === 'auth' && (action === 'token' || action === 'git-credential'))
    return 'GitHub tokens are not shown to the worker.';
  if (group === 'auth' && args.some((arg) => arg === '-t' || arg === '--show-token'))
    return 'GitHub tokens are not shown to the worker.';
  if (group === 'pr' && action === 'merge') return 'The worker may not merge pull requests.';
  if (group === 'repo' && action === 'delete') return 'The worker may not delete repositories.';
  if (group === 'api') {
    const method = args.findIndex((arg) => arg === '-X' || arg === '--method');
    const verb = (
      method >= 0
        ? args[method + 1]
        : args.find((arg) => arg.startsWith('--method='))?.slice('--method='.length)
    )?.toUpperCase();
    if (verb === 'DELETE') return 'The worker may not delete GitHub resources.';
    if (args.some((arg) => /\/pulls\/\d+\/merge\b/.test(arg)))
      return 'The worker may not merge pull requests.';
  }
  return undefined;
}

export function workerHardDeny(tool: string, input: unknown): string | undefined {
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
        ? gitDeny(argv.slice(1))
        : program === 'gh'
          ? ghDeny(argv.slice(1))
          : undefined;
    if (reason) return reason;
  }
  return undefined;
}
