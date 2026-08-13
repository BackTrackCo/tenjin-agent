import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import pkg from '../../package.json';
import { CliError } from '../lib/errors';
import { emitWriteNotice, sanitizeForTerminal } from '../lib/output';
import { channelTag, fetchDistTags, isNewer, resolveTarget } from '../lib/update-check';
import type { CommandContext, CommandResult } from '../context';

/**
 * `tenjin update`: replace the global install with the newest version npm
 * offers this build, by spawning the package manager that owns global installs
 * rather than reimplementing one. Four invariants:
 *
 * - The npm argv pins the EXACT version the registry just named, never the tag,
 *   so the check and the install cannot disagree about what ships, and the
 *   version string is certified parseable by the same `isNewer` gate the nudge
 *   trusts before it goes anywhere near an argv.
 * - Only a global npm install is replaced. A source checkout updates by git, an
 *   npx run has nothing installed to replace, a project-local copy updates
 *   where it is declared, and a pnpm/bun/yarn global replaced via `npm i -g`
 *   would leave TWO installs racing on PATH order. Each refuses with the
 *   instruction that is correct there rather than writing a global the user
 *   never had.
 * - The child is `node npm-cli.js`, never a shell. That is what makes the pinned
 *   argv worth pinning, and it is the only form that works on win32.
 * - npm's chatter goes to stderr (live, human mode only, sanitized) and its
 *   failure into the error envelope; stdout stays the one envelope every
 *   command emits.
 */

/** How long the npm child gets before it is killed. npm's own retry budget runs
 *  into minutes, and an agent's turn should not hang on a wedged registry. */
const INSTALL_TIMEOUT_MS = 300_000;

export interface UpdateOptions {
  /** Report whether a newer version exists; never install. */
  check: boolean;
}

/**
 * How the child ended. Never rejects: all three outcomes are envelope-shaped
 * facts the caller reports, not exceptions, and each is separately testable.
 */
export type SpawnResult =
  { kind: 'exit'; code: number } | { kind: 'start-failed'; cause: unknown } | { kind: 'timeout' };

export type UpdateSpawn = (
  cmd: string,
  args: string[],
  opts: { cwd: string; timeoutMs: number },
  onOutput: (chunk: string) => void,
) => Promise<SpawnResult>;

export interface UpdateDeps {
  fetchImpl?: typeof fetch;
  spawnImpl?: UpdateSpawn;
  /** Where this build's code lives on disk; tests point it at fixture trees. */
  moduleDir?: string;
  /** The running version; defaults to this build's. Injectable for tests. */
  currentVersion?: string;
  /** npm's entry script, or null when it could not be found. Injectable so the
   *  argv shape is asserted without depending on the runner's node layout. */
  npmCli?: string | null;
}

interface UpdateData {
  current: string;
  latest: string;
  channel: 'alpha' | 'latest';
  updateAvailable: boolean;
  updated: boolean;
}

export async function runUpdate(
  opts: UpdateOptions,
  ctx: CommandContext,
  deps: UpdateDeps = {},
): Promise<CommandResult> {
  const current = deps.currentVersion ?? pkg.version;
  const channel = channelTag(current);
  const moduleDir = deps.moduleDir ?? fileURLToPath(new URL('.', import.meta.url));

  // Refused, not defaulted to a channel: a build whose version this package
  // cannot parse has no release line to compare against, and guessing one is how
  // a foreign build gets told it is up to date forever.
  if (channel === null) {
    throw new CliError('REFUSED', `tenjin-cli reports an unrecognizable version (${current})`, {
      fix: 'Reinstall a published build: npm i -g tenjin-cli',
    });
  }

  const tags = await fetchDistTags({
    fetchImpl: deps.fetchImpl,
    timeoutMs: ctx.flags.timeout,
  });
  if (tags === null) {
    throw new CliError('NETWORK_ERROR', 'Could not read tenjin-cli dist-tags from npm', {
      fix: 'Check access to registry.npmjs.org and retry',
    });
  }
  const latest = resolveTarget(current, tags);
  // The registry answered, it just has nothing on the tags this build follows.
  // Not a NETWORK_ERROR: nothing about the connection is wrong, and telling the
  // user to check their access sends them after a fault that is not there.
  if (latest === null) {
    throw new CliError(
      'RESOURCE_NOT_FOUND',
      `npm has no published tenjin-cli on the ${channel} or latest tag`,
      { fix: 'Pick a version yourself: npm view tenjin-cli versions' },
    );
  }

  const updateAvailable = isNewer(latest, current);
  const data = (updated: boolean): UpdateData => ({
    current,
    latest,
    channel,
    updateAvailable,
    updated,
  });

  if (!updateAvailable) {
    return {
      data: data(false),
      // Not "(alpha channel)": the answer is no longer bounded by one tag, and
      // naming one was how this line read as authoritative while being wrong.
      humanLines: [`tenjin-cli ${current} is up to date`],
    };
  }
  if (opts.check) {
    return {
      data: data(false),
      humanLines: [
        `tenjin-cli ${latest} is available (you have ${current}).`,
        'Run tenjin update to install it.',
      ],
    };
  }

  // `latest` is argv-safe here: isNewer returned true, so it matched VERSION_RE.
  const spec = `tenjin-cli@${latest}`;

  // Every refusal below is about WRITING, so all of them sit after the --check
  // return: reporting whether a newer version exists is a question a contributor
  // in a checkout is as entitled to ask as anyone.
  refuseUnlessGlobalNpm(moduleDir, spec);

  // Live chatter is a human courtesy only; the tail rides in the error envelope
  // so a piped failure is still diagnosable. Sanitized per line, because npm
  // relays publisher-controlled text (deprecation notices) and a line break is
  // the one control character this stream must keep.
  const human = ctx.io.isTTY && !ctx.flags.json;
  let tail = '';
  const onOutput = (chunk: string): void => {
    tail = (tail + chunk).slice(-2000);
    if (human) ctx.io.stderr.write(chunk.split('\n').map(sanitizeForTerminal).join('\n'));
  };

  // --ignore-scripts is free here (tenjin-cli has no runtime dependencies and
  // npm does not run a registry install's own `prepare`), and cwd is the home
  // directory so the child never reads a project's config by accident.
  const args = ['install', '-g', '--ignore-scripts', spec];
  const npmCli = deps.npmCli !== undefined ? deps.npmCli : resolveNpmCli(process.execPath);
  const [cmd, argv] = npmCli === null ? ['npm', args] : [process.execPath, [npmCli, ...args]];
  const manual = `Run it yourself: npm i -g ${spec}`;

  const outcome = await (deps.spawnImpl ?? spawnCapture)(
    cmd,
    argv,
    { cwd: homedir(), timeoutMs: INSTALL_TIMEOUT_MS },
    onOutput,
  );
  if (outcome.kind === 'start-failed') {
    throw new CliError('UPDATE_FAILED', 'Could not start npm', {
      fix: manual,
      cause: outcome.cause,
    });
  }
  if (outcome.kind === 'timeout') {
    throw new CliError('UPDATE_FAILED', `npm did not finish in ${INSTALL_TIMEOUT_MS / 1000}s`, {
      fix: manual,
      details: { output: tail },
    });
  }
  if (outcome.code !== 0) {
    throw new CliError('UPDATE_FAILED', `npm ${args.join(' ')} exited ${outcome.code}`, {
      // EACCES on a root-owned global prefix is the common cause; the operator
      // fixing that themselves beats this CLI ever escalating.
      fix: manual,
      details: { output: tail },
    });
  }

  emitWriteNotice(ctx.io, `tenjin update: replaced the global tenjin-cli with ${latest} via npm`);
  return {
    data: data(true),
    humanLines: [`Updated tenjin-cli ${current} -> ${latest}. New builds pick it up immediately.`],
  };
}

/**
 * Throw unless `npm install -g` would actually replace THIS build. Ordered
 * most-specific first: a checkout and an npx cache are both recognizable before
 * any question of which manager or which tree, and the manager check precedes
 * the global/local one because a pnpm or bun store has its own layout that the
 * global test is not written for.
 */
function refuseUnlessGlobalNpm(moduleDir: string, spec: string): void {
  if (isSourceCheckout(moduleDir)) {
    throw new CliError('REFUSED', 'tenjin-cli is running from a source checkout, not an install', {
      fix: 'Update the checkout instead: git pull && pnpm install',
    });
  }
  if (moduleDir.split(sep).includes('_npx')) {
    throw new CliError('REFUSED', 'tenjin-cli is running from the npx cache, not an install', {
      // Writing a global here would "succeed" and change nothing: the next
      // `npx tenjin` still resolves its own cached copy.
      fix: `npx fetches its own copy every time. To keep one: npm i -g ${spec}`,
    });
  }
  const manager = classifyManager(moduleDir);
  if (manager !== 'npm') {
    throw new CliError(
      'REFUSED',
      `This tenjin-cli was installed with ${manager}; replacing it via npm would leave two installs racing on PATH`,
      { fix: `${GLOBAL_ADD[manager]} ${spec}` },
    );
  }
  if (!isGlobalTree(moduleDir)) {
    throw new CliError(
      'REFUSED',
      'This tenjin-cli is a project-local dependency, not a global install',
      { fix: `Update it where it is declared: npm i ${spec}` },
    );
  }
}

/**
 * The published package ships `dist/`, `docs/`, and `skills/` with no `src/`
 * beside them (the `files` array), so a `src/` next to the nearest package.json
 * means a checkout, whose version number says nothing about what HEAD holds.
 * Same test skill-heal uses to keep its hands off working-tree skills.
 */
function isSourceCheckout(moduleDir: string): boolean {
  let dir = moduleDir;
  for (let i = 0; i < 8; i += 1) {
    if (existsSync(join(dir, 'package.json'))) return existsSync(join(dir, 'src'));
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return false;
}

const GLOBAL_ADD = {
  pnpm: 'pnpm add -g',
  bun: 'bun add -g',
  yarn: 'yarn global add',
} as const;

/**
 * Which package manager owns this install, read off the on-disk path. Node
 * resolved the bin symlink before loading us, so the segments name the real
 * store: pnpm's virtual store keeps a literal `.pnpm` segment (or
 * `pnpm/global` for older layouts), bun installs under `.bun`, yarn under
 * `.yarn` or `yarn/global`. Everything else is treated as npm's tree; that
 * covers nvm and volta, both of which route `npm i -g` correctly.
 */
function classifyManager(moduleDir: string): 'npm' | keyof typeof GLOBAL_ADD {
  const segs = moduleDir.split(sep);
  const pair = (a: string, b: string): boolean => segs.includes(a) && segs.includes(b);
  if (segs.includes('.pnpm') || pair('pnpm', 'global')) return 'pnpm';
  if (segs.includes('.bun')) return 'bun';
  if (segs.includes('.yarn') || pair('yarn', 'global')) return 'yarn';
  return 'npm';
}

/**
 * Is this a GLOBAL npm tree? A global install sits under a prefix directory that
 * is not itself a package (`<prefix>/lib/node_modules/tenjin-cli` on POSIX,
 * `<prefix>\node_modules\tenjin-cli` on win32), while a project-local one sits
 * under the project root, which by definition has a package.json. That parent is
 * the whole test, which is why it holds for homebrew, nvm, volta and a
 * user-set `npm config prefix` alike without this code enumerating any of them.
 */
function isGlobalTree(moduleDir: string): boolean {
  const segs = moduleDir.split(sep);
  const i = segs.lastIndexOf('node_modules');
  if (i <= 0) return false;
  return !existsSync(join(segs.slice(0, i).join(sep), 'package.json'));
}

/**
 * npm's own entry script, so the child can be `node npm-cli.js` rather than the
 * `npm` shim.
 *
 * On win32 the shim is `npm.cmd`, which Node refuses to spawn without
 * `shell: true`, and `shell: true` is exactly what this command must not do —
 * it would hand back the argv safety the pinned version buys. npm ships inside
 * the Node distribution, so its script is findable from `process.execPath`:
 * beside `node.exe` on win32, under `../lib` on POSIX. Null when neither exists,
 * and the caller falls back to the bare `npm` shim, which works everywhere but
 * win32 — where it fails closed into UPDATE_FAILED carrying the manual command.
 */
export function resolveNpmCli(execPath: string): string | null {
  const base = dirname(execPath);
  const candidates = [
    join(base, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    join(base, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ];
  return candidates.find((p) => existsSync(p)) ?? null;
}

/**
 * Default spawn: merged stdout+stderr chunks out, an outcome back, no shell.
 * Bounded by its own timer rather than Node's `timeout` option so that a kill
 * this code ordered is distinguishable from any other death by signal.
 */
export const spawnCapture: UpdateSpawn = (cmd, args, opts, onOutput) =>
  new Promise((res) => {
    let child;
    try {
      child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], cwd: opts.cwd });
    } catch (cause) {
      // An argv or option Node rejects outright throws here; ENOENT arrives on
      // the 'error' event instead. Both mean the same thing to the caller.
      res({ kind: 'start-failed', cause });
      return;
    }
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, opts.timeoutMs);
    child.stdout?.on('data', (chunk: Buffer) => onOutput(chunk.toString()));
    child.stderr?.on('data', (chunk: Buffer) => onOutput(chunk.toString()));
    child.on('error', (cause) => {
      clearTimeout(timer);
      res({ kind: 'start-failed', cause });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      res(timedOut ? { kind: 'timeout' } : { kind: 'exit', code: code ?? 1 });
    });
  });
