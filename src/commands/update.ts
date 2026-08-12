import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import pkg from '../../package.json';
import { CliError } from '../lib/errors';
import { emitWriteNotice } from '../lib/output';
import { channelTag, fetchDistTag, isNewer } from '../lib/update-check';
import type { CommandContext, CommandResult } from '../context';

/**
 * `tenjin update`: replace the global install with the newest version on this
 * build's own channel (an alpha follows `@alpha`, a release follows `latest`),
 * by spawning the package manager that owns global installs rather than
 * reimplementing one. Three invariants:
 *
 * - The npm argv pins the EXACT version the registry just named, never the tag,
 *   so the check and the install cannot disagree about what ships, and the
 *   version string is certified parseable by the same `isNewer` gate the nudge
 *   trusts before it goes anywhere near an argv.
 * - Only an npm-shaped install is replaced. A source checkout updates by git,
 *   and a pnpm/bun/yarn global replaced via `npm i -g` would leave TWO installs
 *   racing on PATH order; both refuse with the command that is correct there.
 * - npm's chatter goes to stderr (live, human mode only) and its failure into
 *   the error envelope; stdout stays the one envelope every command emits.
 */

export interface UpdateOptions {
  /** Report whether a newer version exists; never install. */
  check: boolean;
}

/** Resolves the exit code; rejects only when the process could not start. */
export type UpdateSpawn = (
  cmd: string,
  args: string[],
  onOutput: (chunk: string) => void,
) => Promise<number>;

export interface UpdateDeps {
  fetchImpl?: typeof fetch;
  spawnImpl?: UpdateSpawn;
  /** Where this build's code lives on disk; tests point it at fixture trees. */
  moduleDir?: string;
  /** The running version; defaults to this build's. Injectable for tests. */
  currentVersion?: string;
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

  // Before the network: a checkout's answer is the same whatever npm says.
  if (isSourceCheckout(moduleDir)) {
    throw new CliError('REFUSED', 'tenjin-cli is running from a source checkout, not an install', {
      fix: 'Update the checkout instead: git pull && pnpm install',
    });
  }

  const latest = await fetchDistTag(channel, {
    fetchImpl: deps.fetchImpl,
    timeoutMs: ctx.flags.timeout,
  });
  if (latest === null) {
    throw new CliError('NETWORK_ERROR', 'Could not read tenjin-cli dist-tags from npm', {
      fix: 'Check access to registry.npmjs.org and retry',
    });
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
      humanLines: [`tenjin-cli ${current} is up to date (${channel} channel)`],
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
  const manager = classifyManager(moduleDir);
  if (manager !== 'npm') {
    throw new CliError(
      'REFUSED',
      `This tenjin-cli was installed with ${manager}; replacing it via npm would leave two installs racing on PATH`,
      { fix: `${GLOBAL_ADD[manager]} ${spec}` },
    );
  }

  // Live chatter is a human courtesy only; the tail rides in the error envelope
  // so a piped failure is still diagnosable.
  const human = ctx.io.isTTY && !ctx.flags.json;
  let tail = '';
  const onOutput = (chunk: string): void => {
    tail = (tail + chunk).slice(-2000);
    if (human) ctx.io.stderr.write(chunk);
  };

  const args = ['install', '-g', spec];
  let code: number;
  try {
    code = await (deps.spawnImpl ?? spawnCapture)('npm', args, onOutput);
  } catch (err) {
    throw new CliError('UPDATE_FAILED', 'Could not start npm', {
      fix: `Run it yourself: npm i -g ${spec}`,
      cause: err,
    });
  }
  if (code !== 0) {
    throw new CliError('UPDATE_FAILED', `npm ${args.join(' ')} exited ${code}`, {
      // EACCES on a root-owned global prefix is the common cause; the operator
      // fixing that themselves beats this CLI ever escalating.
      fix: `Run it yourself: npm i -g ${spec}`,
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

/** Default spawn: merged stdout+stderr chunks out, exit code back, no shell. */
const spawnCapture: UpdateSpawn = (cmd, args, onOutput) =>
  new Promise((res, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', (chunk: Buffer) => onOutput(chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => onOutput(chunk.toString()));
    child.on('error', reject);
    child.on('close', (code) => res(code ?? 1));
  });
