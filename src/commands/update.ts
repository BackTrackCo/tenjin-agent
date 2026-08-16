import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import pkg from '../../package.json';
import { CliError } from '../lib/errors';
import { MANAGERS, classifyManager, refuse, resolveManagerScript } from '../lib/install-location';
import type { Delegable } from '../lib/install-location';
import { emitWriteNotice, sanitizeForTerminal } from '../lib/output';
import { channelTag, fetchDistTags, isNewer, resolveTarget } from '../lib/update-check';
import type { CommandContext, CommandResult } from '../context';

/**
 * `tenjin update`: replace this install with the newest version npm offers it,
 * by spawning the package manager that OWNS the install rather than
 * reimplementing one. Four invariants:
 *
 * - The argv pins the EXACT version the registry just named, never the tag, so
 *   the check and the install cannot disagree about what ships, and the version
 *   string is certified parseable by the same `isNewer` gate the nudge trusts
 *   before it goes anywhere near an argv.
 * - The owner performs the install. npm, pnpm and bun are each driven with their
 *   own global-add command, because the PATH race that makes a second install
 *   dangerous comes from CROSS-manager writes, not from asking the owner to do
 *   what it already owns. What cannot be driven is refused instead of guessed
 *   at: a source checkout updates by git, an npx run has nothing installed to
 *   replace, a project-local copy updates where it is declared, and yarn's
 *   global install exists only in yarn 1. See lib/install-location.
 * - The child is a binary or `node <script>`, never a shell. That is what makes
 *   the pinned argv worth pinning, and it is the only form that works on win32.
 * - The manager's chatter goes to stderr (live, human mode only, sanitized) and
 *   its failure into the error envelope; stdout stays the one envelope every
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

/** What to spawn for one manager: a command and any argv that must precede its own. */
interface ResolvedManager {
  cmd: string;
  prefix: readonly string[];
}

/**
 * Turn a manager into a spawnable command. A resolved script runs under THIS
 * node, keeping `shell` unset on every platform; otherwise the bare binary name
 * is used, which is correct for a native binary and fails closed on win32 for a
 * `.cmd` shim.
 */
function resolveManager(manager: Delegable, deps: UpdateDeps): ResolvedManager {
  const script =
    deps.managerScript !== undefined
      ? deps.managerScript
      : resolveManagerScript(manager, process.execPath);
  return script === null
    ? { cmd: MANAGERS[manager].bin, prefix: [] }
    : { cmd: process.execPath, prefix: [script] };
}

export interface UpdateDeps {
  fetchImpl?: typeof fetch;
  spawnImpl?: UpdateSpawn;
  /** Where this build's code lives on disk; tests point it at fixture trees. */
  moduleDir?: string;
  /** The running version; defaults to this build's. Injectable for tests. */
  currentVersion?: string;
  /** The owning manager's entry script, or null when it has none to find.
   *  Injectable so the argv shape is asserted without depending on the runner. */
  managerScript?: string | null;
}

interface UpdateData {
  current: string;
  latest: string;
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

  // First stage: everything whose fix string does not need a resolved version,
  // so it answers without the network. An offline contributor in a checkout is
  // told they are in a checkout, not told to go debug their registry access.
  refuse(moduleDir, { check: opts.check, spec: null });

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
  // Not a NETWORK_ERROR: nothing about the connection is wrong, and telling the
  // user to check their access sends them after a fault that is not there.
  if (latest === null) {
    const raw = tags[channel];
    throw raw === undefined
      ? new CliError('RESOURCE_NOT_FOUND', 'npm has no published tenjin-cli on the latest tag', {
          fix: 'Pick a version yourself: npm view tenjin-cli versions',
        })
      : new CliError(
          'RESOURCE_NOT_FOUND',
          // Registry-controlled: bounded here, escaped by the error emitter.
          `npm's latest tenjin-cli (${raw.slice(0, 40)}) is not a version this build can read`,
          {
            fix: 'Install it by name: npm i -g tenjin-cli@<version> (npm view tenjin-cli versions)',
          },
        );
  }

  const updateAvailable = isNewer(latest, current);
  const data = (updated: boolean): UpdateData => ({
    current,
    latest,
    updateAvailable,
    updated,
  });

  if (!updateAvailable) {
    return {
      data: data(false),
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

  // Second stage: the entries whose fix strings name the version just resolved.
  // Reached only on the install path, since --check has already returned.
  refuse(moduleDir, { check: false, spec });

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

  // Whoever owns the install performs it. The PATH-race objection that used to
  // make this a refusal only applies to CROSS-manager writes; invoking the owner
  // is exactly what the refusal used to tell the user to type by hand.
  //
  // The cast is sound only because `refuse` ran directly above and yarn is one
  // of its entries, so the one non-delegable manager has already thrown. Move
  // this line above that call and it becomes a lie.
  const manager = classifyManager(moduleDir) as Delegable;
  const plan = MANAGERS[manager];
  // --ignore-scripts where the manager has it (tenjin-cli has no runtime
  // dependencies and no registry install runs its own `prepare`), and cwd is the
  // home directory so the child never reads a project's config by accident.
  const args = plan.args(spec);
  const resolved = resolveManager(manager, deps);
  const manual = `Run it yourself: ${plan.manual(spec)}`;

  const outcome = await (deps.spawnImpl ?? spawnCapture)(
    resolved.cmd,
    [...resolved.prefix, ...args],
    { cwd: homedir(), timeoutMs: INSTALL_TIMEOUT_MS },
    onOutput,
  );
  if (outcome.kind === 'start-failed') {
    throw new CliError('UPDATE_FAILED', `Could not start ${manager}`, {
      fix: manual,
      cause: outcome.cause,
    });
  }
  if (outcome.kind === 'timeout') {
    throw new CliError(
      'UPDATE_FAILED',
      `${manager} did not finish in ${INSTALL_TIMEOUT_MS / 1000}s`,
      { fix: manual, details: { output: tail } },
    );
  }
  if (outcome.code !== 0) {
    throw new CliError('UPDATE_FAILED', `${manager} ${args.join(' ')} exited ${outcome.code}`, {
      // EACCES on a root-owned global prefix is the common cause; the operator
      // fixing that themselves beats this CLI ever escalating.
      fix: manual,
      details: { output: tail },
    });
  }

  emitWriteNotice(
    ctx.io,
    `tenjin update: replaced the global tenjin-cli with ${latest} via ${manager}`,
  );
  return {
    data: data(true),
    humanLines: [`Updated tenjin-cli ${current} -> ${latest}. New builds pick it up immediately.`],
  };
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
