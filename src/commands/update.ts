import { spawn } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import pkg from '../../package.json';
import { CliError } from '../lib/errors';
import { MANAGERS, classifyManager, refuse, resolveManagerScript } from '../lib/install-location';
import type { Delegable } from '../lib/install-location';
import { emitWriteNotice, sanitizeForTerminal } from '../lib/output';
import {
  NUDGE_OPT_OUT,
  channelTag,
  fetchDistTags,
  isNewer,
  resolveTarget,
} from '../lib/update-check';
import { detectHookOwners } from '../lib/harness-hooks';
import type { HookOwner } from '../lib/harness-hooks';
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
  opts: {
    cwd: string;
    timeoutMs: number;
    /** Variables layered ONTO this process's environment, for the per-profile
     *  `TENJIN_DATA_DIR` the refresh pass sets. Absent means inherit unchanged. */
    env?: Record<string, string>;
  },
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
  /** Home whose harness settings the hook-owner detector reads. Defaults to os.homedir(). */
  homeDir?: string;
  /** The hook-owner detector; injected so tests choose the profiles without a settings file. */
  detectHookOwners?: (homeDir: string) => Promise<HookOwner[]>;
  /**
   * The CLI entry the refresh child runs. Defaults to `process.argv[1]`, which
   * after the swap resolves to the NEWLY installed script — that is the whole
   * point of spawning rather than calling.
   */
  refreshCommand?: string;
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

  const refresh = await refreshProfiles(ctx, deps);
  return {
    data: { ...data(true), refresh },
    humanLines: [`Updated tenjin-cli ${current} -> ${latest}.`, refreshLine(refresh)],
  };
}

/** How long one `install --refresh` child gets. Local file writes only, no
 *  registry: a minute is already generous, and `update` must not hang a turn. */
const REFRESH_TIMEOUT_MS = 60_000;

/**
 * How many detected profiles one `update` will refresh. Each costs a spawn and
 * up to {@link REFRESH_TIMEOUT_MS}, and the list is read out of a settings file
 * anything on the machine can append to, so an uncapped loop turns N planted
 * entries into N minutes of an agent's turn. Well above any real machine: the
 * default profile plus a shelf is two.
 */
const MAX_REFRESH_PROFILES = 8;

/** What the post-swap re-materialize did, per profile. */
export interface RefreshOutcome {
  /** Data dirs a refresh was run for, whether or not it succeeded. */
  profiles: string[];
  /**
   * Profiles this update did not bring up to date, with the manual command to
   * finish them. Both halves land here: a refresh that ran and did not report
   * success, and one that was never run at all (no entry to re-exec, a data dir
   * that is not a directory, past the {@link MAX_REFRESH_PROFILES} cap).
   */
  failed: string[];
  /** Present when at least one profile failed; names `tenjin install`. */
  fix?: string;
}

/**
 * Re-materialize what the swap left stale, on the NEW binary.
 *
 * `update` replaces the package and nothing else, but `install` bakes this
 * build's identity into files: the generated hook scripts carry a version, and
 * the wired skills carry this release's instructions. Until something rewrites
 * them the highest-volume request path keeps reporting the previous version and
 * agents keep reading the previous release's guidance (tenjin-agent#171).
 *
 * SPAWNED, NOT CALLED. This process is the OLD build; it cannot render the new
 * version's copies, and re-exec is the only way to reach code that can. The
 * child is the freshly installed entry, and what it runs is
 * `install --refresh` — a mode that converges existing surfaces and creates
 * none, which is the only kind of write an unattended upgrade may make.
 *
 * ONCE PER HOOK-OWNER PROFILE. `install` bakes its data dir into the scripts it
 * generates, so a machine whose hooks were installed under `TENJIN_DATA_DIR`
 * has hooks belonging to THAT profile while a bare `tenjin update` resolves the
 * default one. Refreshing only the invoking profile there would leave the
 * registered scripts — the ones the harness actually fires — stale forever,
 * which is exactly the shelf runbook's manual re-install step. So the detector
 * reads the harness settings and each profile it names is refreshed with
 * `TENJIN_DATA_DIR` set to it. A machine with no registered hooks has no other
 * profile to find, and gets one refresh for the invoking one.
 *
 * NEVER FAILS THE UPDATE. The swap already happened and is the thing the
 * operator asked for. A refusal, a run with nothing to converge, a crash, a
 * timeout, or an older-binary "unknown option --refresh" all land here as a warn
 * naming the manual command.
 */
async function refreshProfiles(ctx: CommandContext, deps: UpdateDeps): Promise<RefreshOutcome> {
  const home = deps.homeDir ?? homedir();
  const detect = deps.detectHookOwners ?? detectHookOwners;
  const owners = await detect(home).catch(() => []);
  const candidates = owners.length > 0 ? owners.map((o) => o.dataDir) : [ctx.dataDir];

  // A detected data dir is a path READ OUT of settings.json, not a directory
  // this CLI put there, and the child would create it: `install --refresh`
  // converges surfaces rather than materializing them, but the process around it
  // mkdirs the tree for the update cache on its way out. So a path that is not
  // already a directory is reported unrefreshed instead of visited. The cap is
  // the other half of the same argument (see MAX_REFRESH_PROFILES).
  const present: string[] = [];
  const unrun: string[] = [];
  for (const dataDir of candidates) {
    (isExistingDir(dataDir) ? present : unrun).push(dataDir);
  }
  const profiles = present.slice(0, MAX_REFRESH_PROFILES);
  unrun.push(...present.slice(profiles.length));

  const entry = versionFreeEntry(deps.refreshCommand ?? process.argv[1]);
  // Nothing safe to re-exec: no argv (an embedder, a stripped argv), or a path
  // that names the version being replaced (see versionFreeEntry). Report the
  // profiles as unrefreshed rather than guessing, since guessing is how a hook
  // script gets rewritten by the wrong binary — and a refresh that ran the OLD
  // build would report success while writing the bytes the update just left.
  if (entry === null) {
    return { profiles: [], failed: candidates, fix: REFRESH_MANUAL_FIX };
  }

  const failed = [...unrun];
  for (const dataDir of profiles) {
    const outcome = await (deps.spawnImpl ?? spawnCapture)(
      process.execPath,
      [entry, 'install', '--refresh'],
      {
        cwd: homedir(),
        timeoutMs: REFRESH_TIMEOUT_MS,
        // TENJIN_DATA_DIR aims the child at this profile; the nudge opt-out is
        // what keeps it from touching any other file in there (lib/update-check).
        env: { TENJIN_DATA_DIR: dataDir, [NUDGE_OPT_OUT]: '1' },
      },
      // A collecting sink, not the manager's live echo. npm's chatter is minutes
      // of progress a human wants to see; this child emits one envelope on a
      // pipe, and painting that JSON into the human's stderr is noise. Its
      // OUTCOME is the report, below.
      dropOutput,
    );
    // The child's exit code IS the verdict: `install --refresh` exits non-zero
    // when it refused or found nothing to converge, so a machine that never ran
    // `install` warns here instead of being told its hooks were refreshed.
    if (outcome.kind !== 'exit' || outcome.code !== 0) failed.push(dataDir);
  }
  return {
    profiles,
    failed,
    ...(failed.length > 0 ? { fix: REFRESH_MANUAL_FIX } : {}),
  };
}

/** Drains the refresh child's pipe without echoing it; see the call site. */
const dropOutput = (): void => {};

/** A path that already exists AND is a directory. Follows links on purpose: a
 *  data dir behind a symlink is an ordinary machine layout, an absent one is not
 *  a profile this command may create. */
function isExistingDir(path: string): boolean {
  return statSync(path, { throwIfNoEntry: false })?.isDirectory() === true;
}

const REFRESH_MANUAL_FIX =
  'Run `tenjin install` to bring the skills and hook scripts up to this version.';

/**
 * The entry to re-exec, or null when there is none this code may trust.
 *
 * `process.argv[1]` is the path Node RESOLVED, symlinks and all (see
 * `classifyManager`, which reads the manager off exactly that property). Under
 * npm and bun that path carries no version, so after the swap it is already the
 * new build. Under pnpm it points into the virtual store, whose directory names
 * PIN A VERSION: `.../node_modules/.pnpm/tenjin-cli@<version>/node_modules/tenjin-cli/dist/index.js`.
 * Re-executing that is the worst available outcome — it runs the build the
 * update just replaced and reports a successful refresh over the previous
 * version's bytes, which is the exact staleness this whole command exists to
 * end (tenjin-agent#171).
 *
 * The virtual store keeps the version-free link one level out, beside `.pnpm`,
 * and the swap repoints it, so the same path with the store segments removed is
 * the new build. It is derived rather than assumed: if the result is not on
 * disk, this returns null and the caller warns instead of running anything.
 */
export function versionFreeEntry(entry: string | undefined): string | null {
  if (entry === undefined || entry.length === 0) return null;
  const segs = entry.split(sep);
  const store = segs.indexOf('.pnpm');
  if (store === -1) return segs.join(sep);
  // `.pnpm/<name>@<version>/node_modules/<name>/...`: everything from the second
  // `node_modules` on is the package's own path within the global tree.
  const inner = segs.indexOf('node_modules', store);
  if (inner === -1) return null;
  const derived = [...segs.slice(0, store), ...segs.slice(inner + 1)].join(sep);
  return existsSync(derived) ? derived : null;
}

/**
 * One line reporting what the refresh actually did.
 *
 * It replaces "New builds pick it up immediately", which was true of the binary
 * and false of everything install had written — so it read as reassurance about
 * precisely the thing that was NOT handled (tenjin-agent#171).
 */
function refreshLine(refresh: RefreshOutcome): string {
  if (refresh.failed.length > 0) {
    return `Could not refresh the skills and hook scripts for ${refresh.failed.join(', ')}. ${REFRESH_MANUAL_FIX}`;
  }
  const count = refresh.profiles.length;
  return count > 1
    ? `Refreshed the skills and hook scripts for ${count} profiles: ${refresh.profiles.join(', ')}.`
    : `Refreshed the skills and hook scripts for ${refresh.profiles[0]}.`;
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
      child = spawn(cmd, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        cwd: opts.cwd,
        // Layered onto this process's environment rather than replacing it: the
        // child is a Node CLI that needs PATH and HOME, and only the keys named
        // here are being decided.
        ...(opts.env !== undefined ? { env: { ...process.env, ...opts.env } } : {}),
      });
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
