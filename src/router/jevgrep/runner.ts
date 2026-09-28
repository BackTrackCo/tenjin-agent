import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { mkdtemp, mkdir, open, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { JEV_LIMITS, JEV_MODEL } from './protocol.js';
import { startJevgrepProxy } from './proxy.js';
import type { JevgrepEvaluate } from './proxy.js';
import { createJevgrepSnapshot, SnapshotPolicyUnavailable } from './snapshot.js';
import type { SnapshotSummary } from './snapshot.js';

/** No published release containing upstream #28 has been qualified yet. */
export const QUALIFIED_JEVGREP_RELEASES: readonly string[] = Object.freeze([]);
export type JevgrepRuntime =
  { kind: 'release'; version: string } | { kind: 'local-artifact'; path: string; sha256: string };
export type JevgrepRunResult = {
  status: 'complete' | 'partial' | 'failed' | 'cancelled' | 'unavailable';
  output: string;
  reason?: string;
  requests: number;
  snapshot?: SnapshotSummary;
};
export type BoundedCommand = {
  argv: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  input?: string;
  signal: AbortSignal;
};
export type CommandResult = {
  code: number | null;
  stdout: string;
  stderr: string;
  reason?: string;
};

export function isJevgrepRuntimeAvailable(runtime: JevgrepRuntime | undefined): boolean {
  if (!runtime || !['darwin', 'linux'].includes(process.platform)) return false;
  return runtime.kind === 'release'
    ? QUALIFIED_JEVGREP_RELEASES.includes(runtime.version)
    : isAbsolute(runtime.path) &&
        runtime.path.endsWith('.tgz') &&
        /^[a-f0-9]{64}$/.test(runtime.sha256);
}

type ProcessIdentity = { pid: number; parent: number; started: string };
function processTable(): Promise<ProcessIdentity[]> {
  return new Promise((resolve) =>
    execFile(
      '/bin/ps',
      ['-axo', 'pid=,ppid=,lstart='],
      { timeout: 1000, maxBuffer: 1024 * 1024, env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' } },
      (error, stdout) => {
        if (error) {
          resolve([]);
          return;
        }
        resolve(
          stdout.split('\n').flatMap((line) => {
            const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);
            return match
              ? [{ pid: Number(match[1]), parent: Number(match[2]), started: match[3]! }]
              : [];
          }),
        );
      },
    ),
  );
}

/** Only the fixed runtime argv calls this in production. Exported for focused lifecycle tests. */
export async function runBoundedCommand(command: BoundedCommand): Promise<CommandResult> {
  command.signal.throwIfAborted();
  const child = spawn('npx', command.argv, {
    cwd: command.cwd,
    env: command.env,
    shell: false,
    detached: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let reason: string | undefined;
  let stdout = Buffer.alloc(0);
  let stderr = Buffer.alloc(0);
  let closed = false;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  let scan: Promise<void> = Promise.resolve();
  const owned = new Map<number, ProcessIdentity>();
  const observe = async () => {
    if (!child.pid) return;
    const table = await processTable();
    const self = table.find((row) => row.pid === child.pid);
    const previous = owned.get(child.pid);
    const parents = new Set(
      table.filter((row) => owned.get(row.pid)?.started === row.started).map((row) => row.pid),
    );
    if (!closed && self && (!previous || previous.started === self.started)) {
      parents.add(self.pid);
      owned.set(self.pid, self);
    }
    let changed = true;
    while (changed) {
      changed = false;
      for (const row of table)
        if (parents.has(row.parent) && !parents.has(row.pid)) {
          parents.add(row.pid);
          owned.set(row.pid, row);
          changed = true;
        }
    }
  };
  const signalOwned = async (signal: NodeJS.Signals) => {
    await observe();
    const table = await processTable();
    for (const row of table) {
      if (owned.get(row.pid)?.started !== row.started) continue;
      try {
        process.kill(row.pid, signal);
      } catch {
        /* Already stopped. */
      }
    }
    if (!closed && child.pid) {
      try {
        process.kill(-child.pid, signal);
      } catch {
        /* No surviving process group. */
      }
    }
  };
  const stop = (why: string) => {
    reason ??= why;
    void signalOwned('SIGTERM');
    killTimer ??= setTimeout(() => {
      void signalOwned('SIGKILL');
    }, 100);
  };
  const onAbort = () => stop('cancelled');
  command.signal.addEventListener('abort', onAbort, { once: true });
  if (command.signal.aborted) onAbort();
  const poll = setInterval(() => {
    scan = scan.then(observe);
  }, 100);
  const append = (kind: 'stdout' | 'stderr', chunk: Buffer) => {
    const current = kind === 'stdout' ? stdout : stderr;
    const combined = Buffer.concat([current, chunk]);
    if (kind === 'stdout') stdout = combined.subarray(0, JEV_LIMITS.outputBytes);
    else stderr = combined.subarray(0, JEV_LIMITS.outputBytes);
    if (combined.length > JEV_LIMITS.outputBytes) stop('output-limit');
  };
  child.stdout.on('data', (chunk: Buffer) => append('stdout', chunk));
  child.stderr.on('data', (chunk: Buffer) => append('stderr', chunk));
  child.stdin.on('error', () => {
    /* Auth can reject before consuming input. */
  });
  child.stdin.end(command.input ?? '');
  const result = await new Promise<{ code: number | null }>((resolve) => {
    child.once('error', () => {
      reason ??= 'runtime-start-failed';
      resolve({ code: null });
    });
    child.once('close', (code) => {
      closed = true;
      resolve({ code });
    });
  });
  clearInterval(poll);
  clearTimeout(killTimer);
  command.signal.removeEventListener('abort', onAbort);
  await scan;
  await signalOwned('SIGKILL');
  return {
    ...result,
    stdout: stdout.toString('utf8'),
    stderr: stderr.toString('utf8'),
    ...(reason ? { reason } : {}),
  };
}

async function runtimePackage(runtime: JevgrepRuntime, directory: string, signal: AbortSignal) {
  if (runtime.kind === 'release') return `@dzhng/jevgrep@${runtime.version}`;
  signal.throwIfAborted();
  const source = await open(runtime.path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await source.stat();
    if (!stat.isFile() || stat.size > 64 * 1024 * 1024)
      throw new Error('Invalid reviewed artifact');
    const bytes = Buffer.alloc(stat.size + 1);
    let read = 0;
    while (read < bytes.length) {
      signal.throwIfAborted();
      const part = await source.read(bytes, read, bytes.length - read, read);
      if (!part.bytesRead) break;
      read += part.bytesRead;
    }
    const content = bytes.subarray(0, read);
    signal.throwIfAborted();
    if (
      content.length !== stat.size ||
      createHash('sha256').update(content).digest('hex') !== runtime.sha256
    ) {
      throw new Error('Reviewed artifact hash mismatch');
    }
    const target = join(directory, 'runtime.tgz');
    await writeFile(target, content, { mode: 0o400, flag: 'wx' });
    return target;
  } finally {
    await source.close();
  }
}

function redactedOutput(raw: string, token: string) {
  const cleaned = raw.replaceAll(token, '[redacted]');
  if (cleaned.replace(/\s/g, '').includes(token.slice(0, 12))) return '[output redacted]';
  return cleaned;
}

function boundedUtf8(value: string, bytes: number): string {
  const clipped = Buffer.from(value).subarray(0, bytes).toString('utf8');
  return Buffer.byteLength(clipped) <= bytes ? clipped : clipped.slice(0, -1);
}

export async function runJevgrep(
  options: {
    root: string;
    query: string;
    runtime?: JevgrepRuntime;
    evaluate: JevgrepEvaluate;
    signal?: AbortSignal;
  },
  dependencies: {
    runCommand?: (command: BoundedCommand) => Promise<CommandResult>;
    setupTimeoutMs?: number;
    searchTimeoutMs?: number;
  } = {},
): Promise<JevgrepRunResult> {
  if (!isJevgrepRuntimeAvailable(options.runtime)) {
    return {
      status: 'unavailable',
      output: '',
      reason: 'No qualified Jevgrep runtime configured',
      requests: 0,
    };
  }
  if (
    !isAbsolute(options.root) ||
    !options.query.trim() ||
    options.query.length > 8000 ||
    options.query.includes('\0') ||
    ['auth', 'doctor', 'skill', 'cache'].includes(options.query)
  ) {
    return { status: 'failed', output: '', reason: 'Invalid local retrieval request', requests: 0 };
  }
  const cancelled = new AbortController();
  const outerSignal = options.signal
    ? AbortSignal.any([options.signal, cancelled.signal])
    : cancelled.signal;
  const setupSignal = AbortSignal.any([
    outerSignal,
    AbortSignal.timeout(dependencies.setupTimeoutMs ?? 60_000),
  ]);
  const runCommand = dependencies.runCommand ?? runBoundedCommand;
  let directory: string | undefined;
  let proxy: Awaited<ReturnType<typeof startJevgrepProxy>> | undefined;
  let snapshot: SnapshotSummary | undefined;
  let phase: 'setup' | 'search' = 'setup';
  let phaseSignal: AbortSignal = setupSignal;
  const abortProxy = () => {
    void proxy?.close();
  };
  try {
    setupSignal.throwIfAborted();
    const root = await realpath(options.root);
    directory = await mkdtemp(join(tmpdir(), 'tenjin-jevgrep-'));
    const relation = relative(root, await realpath(directory));
    if (
      relation === '' ||
      (!relation.startsWith(`..${sep}`) && relation !== '..' && !isAbsolute(relation))
    ) {
      throw new Error('Temporary state must be outside the approved source root');
    }
    const packageSpec = await runtimePackage(options.runtime!, directory, setupSignal);
    const source = join(directory, 'source');
    snapshot = await createJevgrepSnapshot({ root, destination: source, signal: setupSignal });
    const home = join(directory, 'home');
    const config = join(directory, 'config');
    const cache = join(directory, 'cache');
    const npmCache = join(directory, 'npm-cache');
    for (const path of [home, config, cache, npmCache]) await mkdir(path, { mode: 0o700 });
    const userNpm = join(directory, 'user.npmrc');
    const globalNpm = join(directory, 'global.npmrc');
    await writeFile(userNpm, '', { mode: 0o600 });
    await writeFile(globalNpm, '', { mode: 0o600 });
    const env: NodeJS.ProcessEnv = {
      PATH: [
        dirname(process.execPath),
        '/opt/homebrew/bin',
        '/usr/local/bin',
        '/usr/bin',
        '/bin',
      ].join(':'),
      HOME: home,
      XDG_CONFIG_HOME: config,
      XDG_CACHE_HOME: cache,
      TMPDIR: directory,
      LANG: 'C.UTF-8',
      NO_COLOR: '1',
      npm_config_cache: npmCache,
      npm_config_userconfig: userNpm,
      npm_config_globalconfig: globalNpm,
      npm_config_ignore_scripts: 'true',
      npm_config_audit: 'false',
      npm_config_fund: 'false',
      npm_config_update_notifier: 'false',
      npm_config_registry: 'https://registry.npmjs.org/',
    };
    proxy = await startJevgrepProxy({ evaluate: options.evaluate, signal: outerSignal });
    phaseSignal.addEventListener('abort', abortProxy, { once: true });
    if (phaseSignal.aborted) {
      abortProxy();
      phaseSignal.throwIfAborted();
    }
    const prefix = ['--yes', '--package', packageSpec, 'jg'];
    const auth = await runCommand({
      argv: [
        ...prefix,
        'auth',
        '--provider',
        'custom',
        '--base-url',
        proxy.baseURL,
        '--model',
        JEV_MODEL,
        '--stdin',
      ],
      cwd: directory,
      env,
      input: `${proxy.token}\n`,
      signal: setupSignal,
    });
    setupSignal.throwIfAborted();
    if (auth.code !== 0 || auth.reason) {
      return {
        status: 'failed',
        output: '',
        reason: auth.reason ?? 'Custom provider setup failed',
        requests: 0,
        snapshot,
      };
    }
    phase = 'search';
    const searchSignal = AbortSignal.any([
      outerSignal,
      AbortSignal.timeout(dependencies.searchTimeoutMs ?? 60_000),
    ]);
    phaseSignal.removeEventListener('abort', abortProxy);
    phaseSignal = searchSignal;
    phaseSignal.addEventListener('abort', abortProxy, { once: true });
    if (phaseSignal.aborted) {
      abortProxy();
      phaseSignal.throwIfAborted();
    }
    const search = await runCommand({
      argv: [
        ...prefix,
        '--concurrency',
        String(JEV_LIMITS.concurrency),
        '--max-source-bytes',
        String(JEV_LIMITS.outputBytes),
        '--no-cache',
        '--',
        options.query,
        source,
      ],
      cwd: directory,
      env,
      signal: searchSignal,
    });
    const summary = proxy.summary();
    const mapped = redactedOutput(search.stdout, proxy.token).replaceAll(source, root);
    const heading = `Committed HEAD snapshot ${snapshot.commit}; uncommitted and untracked changes omitted.\n`;
    const output = mapped
      ? heading + boundedUtf8(mapped, JEV_LIMITS.outputBytes - Buffer.byteLength(heading))
      : '';
    const reason = options.signal?.aborted
      ? 'cancelled'
      : searchSignal.aborted
        ? 'search-timeout'
        : (summary.stopReason ?? search.reason);
    const status = options.signal?.aborted
      ? 'cancelled'
      : reason
        ? output
          ? 'partial'
          : 'failed'
        : search.code === 0
          ? 'complete'
          : search.code === 2
            ? 'partial'
            : search.code === 130
              ? 'cancelled'
              : 'failed';
    return {
      status,
      output,
      requests: summary.requests,
      snapshot,
      ...(reason
        ? { reason }
        : status !== 'complete'
          ? { reason: 'Jevgrep did not complete retrieval' }
          : {}),
    };
  } catch (error) {
    return {
      status: options.signal?.aborted
        ? 'cancelled'
        : error instanceof SnapshotPolicyUnavailable
          ? 'unavailable'
          : 'failed',
      output: '',
      requests: proxy?.summary().requests ?? 0,
      ...(snapshot ? { snapshot } : {}),
      reason:
        error instanceof SnapshotPolicyUnavailable
          ? 'snapshot-policy-unavailable'
          : options.signal?.aborted
            ? 'cancelled'
            : setupSignal.aborted && phase === 'setup'
              ? 'setup-timeout'
              : 'Local retrieval setup or execution failed',
    };
  } finally {
    phaseSignal.removeEventListener('abort', abortProxy);
    cancelled.abort();
    await proxy?.close();
    if (directory) await rm(directory, { recursive: true, force: true });
  }
}
