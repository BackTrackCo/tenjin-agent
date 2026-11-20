import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { markJobFolder, removeJobFolder } from './job-folders';

/** Also the start of every other per-job folder name in the temp folder (`WorkerGithub.others`). */
const GITHUB_PREFIX = 'tenjin-worker-';

/**
 * Hosts a DeepSeek worker's sandboxed commands reach without asking. Anything else is
 * denied in auto and bypass mode (no one answers) and asked in default mode.
 */
export const WORKER_ALLOWED_DOMAINS: readonly string[] = [
  // git over HTTPS, gh REST and GraphQL, archives, release uploads.
  'github.com',
  'api.github.com',
  'codeload.github.com',
  'uploads.github.com',
  // GitHub-owned: raw files, release assets, the Actions log service.
  '*.githubusercontent.com',
  // Actions log and artifact storage, as GitHub lists it for its own agent's firewall.
  ...Array.from({ length: 20 }, (_, n) => `productionresultssa${n}.blob.core.windows.net`),
  // npm and pnpm packages, and corepack's package-manager downloads.
  'registry.npmjs.org',
  // node-gyp headers, for a dependency that builds a native module.
  'nodejs.org',
];

const TOKEN = /^[A-Za-z0-9_]{20,255}$/;
const IDENTITY = /^[^\n\r\0]{1,256}$/;
// git calls this with get, store or erase; only get answers, from the job's own env.
const CREDENTIAL_HELPER =
  '!f() { test "$1" = get || exit 0; echo username=x-access-token; echo "password=$GH_TOKEN"; }; f';

export type WorkerGithub = {
  /** Per-job directory; the worker's sandbox may read and write it. Removed by close. */
  directory: string;
  /**
   * Every job's folder that Tenjin makes in the temp folder (`tenjin-worker-*`), by each
   * spelling of it: this directory, which holds gh caches and run logs, and the folder of the
   * worker's settings file, which holds its bridge token and GitHub token
   * (`claude-worker-process`). The sandbox denies them all and re-allows this job's directory.
   */
  others: string[];
  env: Record<string, string>;
  /** Literal token values the bridge removes from everything it forwards. */
  secrets: string[];
  /** Whether gh and git over HTTPS hold a GitHub token for this job. */
  authenticated: boolean;
  close: () => Promise<void>;
};

type Exec = (file: string, args: string[], env: NodeJS.ProcessEnv) => Promise<string>;

const exec: Exec = (file, args, env) =>
  new Promise((resolve, reject) =>
    execFile(file, args, { env, timeout: 10_000, maxBuffer: 16_384 }, (error, stdout) =>
      error ? reject(error) : resolve(String(stdout)),
    ),
  );

/**
 * A token the person names for workers wins: TENJIN_WORKER_GITHUB_TOKEN, or a file at
 * TENJIN_WORKER_GITHUB_TOKEN_FILE. Tenjin never stores it. A named token that cannot be
 * read gives no token, never the broader gh login. Otherwise this server process asks
 * `gh auth token`; the worker itself never can.
 */
export async function workerGithubToken(
  parent: NodeJS.ProcessEnv,
  run: Exec = exec,
): Promise<string | null> {
  const named = parent.TENJIN_WORKER_GITHUB_TOKEN?.trim();
  if (named) return TOKEN.test(named) ? named : null;
  const file = parent.TENJIN_WORKER_GITHUB_TOKEN_FILE?.trim();
  if (file) {
    if (!isAbsolute(file)) return null;
    const value = (await readFile(file, 'utf8').catch(() => '')).trim();
    return TOKEN.test(value) ? value : null;
  }
  const value = await run('gh', ['auth', 'token', '--hostname', 'github.com'], {
    ...parent,
    GH_PROMPT_DISABLED: '1',
  }).catch(() => '');
  return TOKEN.test(value.trim()) ? value.trim() : null;
}

const quoted = (value: string) => `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;

/**
 * The worker's global git config: the person's identity and, with a token, a GitHub
 * credential helper. Nothing else from ~/.gitconfig, which may hold credentials, and git
 * no longer needs ~/.gitconfig to be readable inside the sandbox.
 */
function gitConfig(identity: { name?: string; email?: string }, authenticated: boolean) {
  const lines: string[] = [];
  if (identity.name || identity.email)
    lines.push(
      '[user]',
      ...(identity.name ? [`\tname = ${quoted(identity.name)}`] : []),
      ...(identity.email ? [`\temail = ${quoted(identity.email)}`] : []),
    );
  if (authenticated)
    for (const host of ['https://github.com', 'https://gist.github.com'])
      // The empty helper clears system helpers (osxkeychain) for this host first.
      lines.push(
        `[credential ${quoted(host)}]`,
        '\thelper =',
        `\thelper = ${quoted(CREDENTIAL_HELPER)}`,
      );
  return lines.length ? `${lines.join('\n')}\n` : '';
}

async function gitIdentity(parent: NodeJS.ProcessEnv, run: Exec) {
  const read = async (key: string) => {
    const value = (
      await run('git', ['config', '--global', '--get', key], parent).catch(() => '')
    ).replace(/\n$/, '');
    return IDENTITY.test(value) ? value : undefined;
  };
  const [name, email] = await Promise.all([read('user.name'), read('user.email')]);
  return { ...(name ? { name } : {}), ...(email ? { email } : {}) };
}

/** Every variable through which the session's own GitHub token would reach a worker's commands. */
const SESSION_TOKENS = [
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'GH_ENTERPRISE_TOKEN',
  'GITHUB_ENTERPRISE_TOKEN',
] as const;

/**
 * A token named for workers stands in place of the session's own, also when it cannot be
 * read or the job's GitHub setup failed: the worker inherits its parent's environment, and
 * without this the broader token would still be there under these names.
 */
export function sessionTokenClears(parent: NodeJS.ProcessEnv): Record<string, string> {
  const named = Boolean(
    parent.TENJIN_WORKER_GITHUB_TOKEN?.trim() || parent.TENJIN_WORKER_GITHUB_TOKEN_FILE?.trim(),
  );
  return named ? Object.fromEntries(SESSION_TOKENS.map((key) => [key, ''])) : {};
}

/** GitHub token values an environment hands the worker's commands, for redaction. */
export function workerTokenValues(source: Record<string, string | undefined>): string[] {
  return ['GH_TOKEN', 'GITHUB_TOKEN', 'TENJIN_WORKER_GITHUB_TOKEN']
    .map((key) => source[key]?.trim())
    .filter((value): value is string => typeof value === 'string' && value.length >= 20);
}

/** Every job's GitHub folder (and settings folder) in the system temp folder, by each spelling of it. */
export async function workerGithubPatterns(): Promise<string[]> {
  return [...new Set([tmpdir(), await realpath(tmpdir()).catch(() => tmpdir())])].map((base) =>
    join(base, `${GITHUB_PREFIX}*`),
  );
}

/** Per-job GitHub and git setup for one DeepSeek worker, made by the MCP server process. */
export async function prepareWorkerGithub(
  parent: NodeJS.ProcessEnv = process.env,
  options: { run?: Exec } = {},
): Promise<WorkerGithub> {
  const run = options.run ?? exec;
  const directory = await mkdtemp(join(tmpdir(), GITHUB_PREFIX));
  markJobFolder(directory);
  try {
    const others = await workerGithubPatterns();
    const [token, identity] = await Promise.all([
      workerGithubToken(parent, run),
      gitIdentity(parent, run),
    ]);
    const gh = join(directory, 'gh');
    const cache = join(directory, 'cache');
    const config = join(directory, 'gitconfig');
    await mkdir(gh, { mode: 0o700 });
    await mkdir(cache, { mode: 0o700 });
    await writeFile(config, gitConfig(identity, token !== null), { mode: 0o600 });
    return {
      directory,
      others,
      env: {
        GH_CONFIG_DIR: gh,
        GIT_CONFIG_GLOBAL: config,
        // gh writes run logs and API caches here; the home cache is outside the sandbox.
        XDG_CACHE_HOME: cache,
        GH_PROMPT_DISABLED: '1',
        GH_NO_UPDATE_NOTIFIER: '1',
        GIT_TERMINAL_PROMPT: '0',
        ...sessionTokenClears(parent),
        ...(token ? { GH_TOKEN: token } : {}),
      },
      secrets: [...new Set([...(token ? [token] : []), ...workerTokenValues(parent)])],
      authenticated: token !== null,
      close: async () => {
        await removeJobFolder(directory);
      },
    };
  } catch (error) {
    await removeJobFolder(directory);
    throw error;
  }
}

export const REDACTED_JOB_SECRET = '[redacted job secret]';

/** Removes each literal secret; a GitHub token never needs JSON escaping. */
export function redactWorkerSecrets(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) if (secret) out = out.split(secret).join(REDACTED_JOB_SECRET);
  return out;
}

/**
 * A literal removal over every key and string of a parsed SDK message: the job's
 * token values. It feeds the activity copy behind the viewer, the plugin's progress
 * file and a stopped worker's partial handback, where `mask()` knows only token shapes.
 */
export function redactWorkerMessage(message: unknown, redact: (text: string) => string): unknown {
  const walk = (value: unknown): unknown => {
    if (typeof value === 'string') return redact(value);
    if (Array.isArray(value)) return value.map(walk);
    if (value !== null && typeof value === 'object')
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [redact(key), walk(item)]),
      );
    return value;
  };
  return walk(message);
}
