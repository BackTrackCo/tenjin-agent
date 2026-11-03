import { spawn } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import pkg from '../../package.json';
import { proxyNodeStep, proxySkipped } from '../lib/env-proxy';
import { CliError } from '../lib/errors';
import { MANAGERS, classifyManager, refuse, resolveManagerScript } from '../lib/install-location';
import type { Delegable } from '../lib/install-location';
import { emitWriteNotice, sanitizeForTerminal } from '../lib/output';
import {
  NUDGE_OPT_OUT,
  channelTag,
  fetchDistTags,
  fetchPublishTime,
  isNewer,
  resolveTarget,
} from '../lib/update-check';
import { loadRawConfig } from '../lib/config';
import { defaultDataDir, runtimeDir } from '../lib/paths';
import type { ensureNode, placeVersion, stageTarball } from '../lib/runtime';
import type { CommandContext, CommandResult } from '../context';
import { persistRouterProject } from './config';
import { projectInstallAt } from '../router/install';
import { readMcpServers, type InstalledAt, type ListMcpProcesses } from '../router/mcp-processes';
import { RUNTIME_MISSING_FIX } from '../router/plugin-files';

/**
 * `tenjin update`: move this machine to the newest version npm's `latest` tag
 * names. Which way depends on whether Tenjin's runtime (`~/.tenjin/runtime`,
 * the default data dir only) is here.
 *
 * THE RUNTIME BRANCH needs no npm. This OLD build downloads the release (the
 * registry tarball, once npm's provenance shows Tenjin's release workflow built
 * it, checked against its sha512; or a copy of itself when it IS that
 * release), ensures the Node the release pins, and places it beside the
 * current version. The NEW build, spawned on that Node as `install --refresh`,
 * checks itself (`verifyBuild`), and only then switches the runtime to itself
 * and registers it. The parent reads the switch back from `state.json`: a
 * release that did not switch leaves the previous version current, and the
 * update fails saying so. The parent holds no runtime lock while a child runs.
 *
 * THE NPM BRANCH is kept for an install with no runtime. It spawns the package
 * manager that OWNS the install rather than reimplementing one:
 *
 * - The argv pins the EXACT version the registry just named, never the tag, so
 *   the check and the install cannot disagree about what ships, and the version
 *   string is certified parseable by the same `isNewer` gate the nudge trusts
 *   before it goes anywhere near an argv.
 * - That version passes the runtime branch's provenance check (lib/runtime's
 *   `checkReleaseProvenance`) before the manager is spawned: what npm installs
 *   here can become the first runtime on its refresh.
 * - The owner performs the install. npm, pnpm and bun are each driven with their
 *   own global-add command, because the PATH race that makes a second install
 *   dangerous comes from CROSS-manager writes, not from asking the owner to do
 *   what it already owns. What cannot be driven is refused instead of guessed
 *   at: a source checkout updates by git, an npx run has nothing installed to
 *   replace, a project-local copy updates where it is declared, and yarn's
 *   global install exists only in yarn 1. See lib/install-location.
 * - The manager's chatter goes to stderr (live, human mode only, sanitized) and
 *   its failure into the error envelope; stdout stays the one envelope every
 *   command emits.
 *
 * On both, every child is a binary or `node <script>`, never a shell. That is
 * what makes a pinned argv worth pinning, and it is the only form that works on
 * win32, where the runtime's child is its absolute `node.exe`.
 */

/** How long the npm child gets before it is killed. npm's own retry budget runs
 *  into minutes, and an agent's turn should not hang on a wedged registry. */
const INSTALL_TIMEOUT_MS = 300_000;

/** How long the release's tarball, and the Node it pins, may take to download. */
const STAGE_TIMEOUT_MS = 120_000;
const NODE_TIMEOUT_MS = 300_000;

/**
 * HOW OLD A RELEASE MUST BE BEFORE THE BACKGROUND RUN TAKES IT: a day since
 * the registry published it. The window lets maintainers move `latest` back
 * (`npm dist-tag add tenjin-cli@<good> latest`) before any auto-updater runs
 * a bad or malicious release, which the provenance check (lib/runtime's
 * `RELEASE_WORKFLOW`) cannot catch when the release workflow itself was
 * compromised. Publish times are set by the registry and cannot be backdated.
 * A manual `tenjin update` is the person choosing the release now, and does
 * not wait.
 */
export const BACKGROUND_COOLDOWN_MS = 24 * 60 * 60_000;

export interface UpdateOptions {
  /** Report whether a newer version exists; never install. */
  check: boolean;
  /**
   * The detached run lib/auto-update starts: the runtime branch only, never
   * npm, only a release published at least a day ago
   * ({@link BACKGROUND_COOLDOWN_MS}), with how it ended recorded in
   * `<runtime>/auto-update.json`.
   */
  background?: boolean;
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
  /** Home whose manual-fix command the report names, and whose `.tenjin` is the
   *  default data dir the runtime belongs to. Defaults to os.homedir(). */
  homeDir?: string;
  /**
   * The CLI entry the npm branch's refresh child runs. Defaults to `process.argv[1]`, which
   * after the swap resolves to the NEWLY installed script — that is the whole
   * point of spawning rather than calling.
   */
  refreshCommand?: string;
  /** This user's running `tenjin mcp` processes; tests inject them. */
  listMcpProcesses?: ListMcpProcesses;
  /** When the new build was installed; tests inject it. */
  installedAt?: InstalledAt;
  /** Tenjin's runtime folder; defaults to the one under the data dir. */
  runtimeRoot?: string;
  /** The runtime branch's download, Node and placement; tests inject them. */
  stage?: typeof stageTarball;
  ensure?: typeof ensureNode;
  place?: typeof placeVersion;
  /** Test seam; production asks this Node whether it can use the shell's proxy. */
  proxySupported?: boolean;
  /** The clock the background run's cooldown reads; tests pin it. */
  now?: () => number;
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
  if (opts.background !== true) return update(opts, ctx, deps);
  // THE BACKGROUND RUN records how it ended for doctor, then answers as any
  // update does: its envelope goes to the log. Only where the runtime folder
  // already is, so a run with no runtime creates nothing.
  const root = deps.runtimeRoot ?? runtimeDir(ctx.dataDir);
  const [{ recordAutoUpdate }, { readRuntimeState }] = await Promise.all([
    import('../lib/auto-update'),
    import('../lib/runtime-layout'),
  ]);
  const from = readRuntimeState(root)?.current.cli;
  const record = (r: Parameters<typeof recordAutoUpdate>[1]): void => {
    if (!existsSync(root)) return;
    try {
      recordAutoUpdate(root, { finishedAt: new Date().toISOString(), ...r });
    } catch {
      // The update itself is the result; a record that cannot be written is not.
    }
  };
  try {
    const result = await update(opts, ctx, deps);
    const d = result.data as Partial<UpdateData> & { skipped?: string };
    record(
      d.skipped !== undefined
        ? { outcome: 'skipped', reason: d.skipped }
        : d.updated === true
          ? { outcome: 'updated', from: d.current, to: d.latest }
          : { outcome: 'current', from: d.current, to: d.current },
    );
    return result;
  } catch (err) {
    const reason = sanitizeForTerminal(err instanceof Error ? err.message : String(err)).trim();
    record({
      outcome: 'failed',
      ...(from !== undefined ? { from } : {}),
      reason: reason.slice(0, REASON_LIMIT),
    });
    throw err;
  }
}

async function update(
  opts: UpdateOptions,
  ctx: CommandContext,
  deps: UpdateDeps,
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
  // THE RUNTIME'S VERSION IS THE ONE THAT RUNS, so it is what the answer is
  // about: an npm copy older than the runtime still moves the runtime forward,
  // and "up to date" or `--check` speak of what Claude Code starts.
  const runtime = await runtimeHere(ctx, deps, moduleDir);
  // The background run never reaches npm: with no runtime it has nothing to do.
  if (opts.background === true && runtime === null) {
    return {
      data: { skipped: 'no runtime' },
      humanLines: ["Nothing to update in the background: Tenjin's runtime is not set up here."],
    };
  }
  const base = runtime?.current ?? current;
  const latest = resolveTarget(base, tags);
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

  const updateAvailable = isNewer(latest, base);
  const data = (updated: boolean): UpdateData => ({
    current: base,
    latest,
    updateAvailable,
    updated,
  });

  if (!updateAvailable) {
    return {
      data: data(false),
      humanLines: [`tenjin-cli ${base} is up to date`],
    };
  }
  if (opts.check) {
    return {
      data: data(false),
      humanLines: [
        `tenjin-cli ${latest} is available (you have ${base}).`,
        'Run tenjin update to install it.',
      ],
    };
  }

  // THE BACKGROUND RUN WAITS A DAY after a release is published (see
  // BACKGROUND_COOLDOWN_MS) and switches nothing before then; the next daily
  // run takes it. Only the background run: here it always has a runtime.
  if (opts.background === true) {
    const wait = await tooNewForBackground(latest, ctx, deps);
    if (wait !== null) {
      return {
        data: { ...data(false), skipped: wait },
        humanLines: [`${wait}; the background update takes a release a day after it is published.`],
      };
    }
  }

  // No manager below this line is asked, so none of the stage-2 refusals about
  // how npm's copy was installed apply: an npx run updates the runtime too.
  if (runtime !== null) {
    return runtimeUpdate(ctx, deps, { ...runtime, base, latest, current, moduleDir, data });
  }

  await refuseRuntimeElsewhere(ctx, moduleDir, deps.homeDir ?? homedir());

  // `latest` is argv-safe here: isNewer returned true, so it matched VERSION_RE.
  const spec = `tenjin-cli@${latest}`;

  // Second stage: the entries whose fix strings name the version just resolved.
  // Reached only on the install path, since --check has already returned.
  refuse(moduleDir, { check: false, spec });

  // THE SAME PROVENANCE GATE THE RUNTIME BRANCH'S DOWNLOAD PASSES, before any
  // manager is asked: the build installed here runs its own `install --refresh`
  // next, which on the default data dir copies it into a first runtime, wallet
  // and auto-update included. The manager then installs this exact version
  // and checks its tarball against the same `dist.integrity` the provenance
  // was matched to, which a published version can never change, so it
  // installs the attested bytes. A manager configured to fetch from another
  // registry (a mirror) gets them from there, which this check does not see.
  const { checkReleaseProvenance } = await import('../lib/runtime');
  await checkReleaseProvenance(latest, {
    timeoutMs: ctx.flags.timeout,
    fetchImpl: deps.fetchImpl,
  });

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

  const { refresh } = await refreshProfiles(ctx, deps, npmLaunch(deps));
  return updated(deps, data(true), refresh, [`Updated tenjin-cli ${current} -> ${latest}.`]);
}

/**
 * The report of an update that happened, on either branch. The refresh child's
 * output is captured, so the warning it would print about a `tenjin mcp` still
 * running the old build is checked again here, with the fix the child's
 * migration state calls for. `version` is the build the runtime now runs: a
 * router launched from the runtime is stale when it runs any other.
 */
async function updated(
  deps: UpdateDeps,
  data: UpdateData,
  refresh: RefreshOutcome,
  head: string[],
  version?: string,
): Promise<CommandResult> {
  const servers = await readMcpServers(deps, {
    settingsInstallPending: refresh.settingsInstallPending,
    ...(version !== undefined ? { version } : {}),
  });
  return {
    data: { ...data, refresh, mcpServer: servers.check },
    humanLines: [
      ...head,
      ...refreshLines(refresh),
      ...projectLines(refresh),
      ...refresh.notices,
      ...(servers.stale > 0
        ? [`! ${servers.check.detail}. ${servers.check.fix ?? ''}`.trim()]
        : []),
    ],
  };
}

/** Tenjin's runtime as this update sees it. */
interface RuntimeHere {
  root: string;
  /** Its current version, or null when only this build's own location says it is one. */
  current: string | null;
  /** This build runs from the runtime itself. */
  inRuntime: boolean;
}

/**
 * The runtime to update, or null for the npm branch: the default data dir
 * only (a QA profile keeps npm's layout), and only where a runtime state
 * exists or this build runs from one. The runtime modules are imported
 * lazily: `router/plugin-registration` imports this module, and it sits in the
 * status line's chunk, which must not load them.
 */
async function runtimeHere(
  ctx: CommandContext,
  deps: UpdateDeps,
  moduleDir: string,
): Promise<RuntimeHere | null> {
  if (resolve(ctx.dataDir) !== resolve(defaultDataDir(deps.homeDir ?? homedir()))) return null;
  const { readRuntimeState, runtimeBuild } = await import('../lib/runtime-layout');
  const root = deps.runtimeRoot ?? runtimeDir(ctx.dataDir);
  const state = readRuntimeState(root);
  const inRuntime = runtimeBuild(moduleDir) !== null;
  if (state === null && !inRuntime) return null;
  return { root, current: state?.current.cli ?? null, inRuntime };
}

/**
 * Why the background run does not take `latest` yet, or null once the registry
 * published it at least {@link BACKGROUND_COOLDOWN_MS} ago. A publish time that
 * is missing, does not parse, or lies in the future counts as too new: waiting
 * is the safe side. A registry that cannot be asked fails the run, as the
 * dist-tags read does, and the next daily run asks again.
 */
async function tooNewForBackground(
  latest: string,
  ctx: CommandContext,
  deps: UpdateDeps,
): Promise<string | null> {
  const answer = await fetchPublishTime(latest, {
    fetchImpl: deps.fetchImpl,
    timeoutMs: ctx.flags.timeout,
  });
  if (answer === null) {
    throw new CliError('NETWORK_ERROR', `Could not read when tenjin-cli ${latest} was published`, {
      fix: 'Check access to registry.npmjs.org and retry',
    });
  }
  if (answer.publishedAt === null) return `npm names no publish time for tenjin-cli ${latest}`;
  const age = (deps.now ?? Date.now)() - answer.publishedAt;
  // A time in the future gives a negative age, so it waits too.
  return age >= BACKGROUND_COOLDOWN_MS
    ? null
    : `tenjin-cli ${latest} was published under 24 hours ago`;
}

/**
 * A RUNTIME BUILD UNDER ANOTHER DATA DIR has no npm install to update: it is
 * `~/.local/bin/tenjin` run with `TENJIN_DATA_DIR` set, and the runtime belongs
 * to the default data dir alone. Said as that, before the npm branch's
 * refusals would call it a project-local dependency.
 */
async function refuseRuntimeElsewhere(
  ctx: CommandContext,
  moduleDir: string,
  home: string,
): Promise<void> {
  const { runtimeBuild } = await import('../lib/runtime-layout');
  if (runtimeBuild(moduleDir) === null) return;
  throw new CliError(
    'REFUSED',
    `This tenjin runs from Tenjin's runtime, which only the default data dir (${tilde(defaultDataDir(home), home)}) uses, and TENJIN_DATA_DIR is ${tilde(ctx.dataDir, home)}, so nothing was updated`,
    {
      fix: 'Run `tenjin update` with TENJIN_DATA_DIR unset: the runtime belongs to the default data dir. Another data dir runs on an npm copy, updated with `npm i -g tenjin-cli@latest`.',
    },
  );
}

/**
 * THE RUNTIME BRANCH (see the header). Everything up to the spawn is this OLD
 * build's: download, Node, placement, each under the runtime lock and released
 * before the child starts. The switch is the NEW build's, so the verdict is read
 * back from `state.json` rather than trusted from an exit code: a child that
 * exits 0 having kept the previous version (its own checks failed) did not
 * update anything.
 */
async function runtimeUpdate(
  ctx: CommandContext,
  deps: UpdateDeps,
  o: RuntimeHere & {
    base: string;
    latest: string;
    current: string;
    moduleDir: string;
    data: (updated: boolean) => UpdateData;
  },
): Promise<CommandResult> {
  const { root, base, latest } = o;
  const [rt, layout] = await Promise.all([
    import('../lib/runtime'),
    import('../lib/runtime-layout'),
  ]);
  const stays = `so ${base} stays`;

  // An npm copy that IS the release copies itself: the bytes are already here
  // and were installed by npm, with nothing to fetch. Anything else is fetched.
  let stage: string;
  if (latest === o.current && !o.inRuntime) {
    const packageRoot = rt.packageRootOf(o.moduleDir);
    if (packageRoot === null) {
      throw new CliError(
        'UPDATE_FAILED',
        `tenjin-cli ${latest} cannot find its own package, ${stays}`,
        {
          fix: RUNTIME_MISSING_FIX,
        },
      );
    }
    stage = await rt.stageSelf(root, packageRoot);
  } else {
    stage = await (deps.stage ?? rt.stageTarball)(root, latest, {
      timeoutMs: STAGE_TIMEOUT_MS,
      fetchImpl: deps.fetchImpl,
    }).catch((err: unknown) => {
      throw proxyNamed(err, deps);
    });
  }

  let node: string;
  try {
    // The NEW version's pin, read as data from the package just checked.
    const pin = rt.readNodePin(stage);
    if (pin === null) {
      throw new CliError('UPDATE_FAILED', `tenjin-cli ${latest} carries no Node pin, ${stays}`, {
        fix: `Nothing to do: ${base} keeps running. Run \`tenjin update\` again after the next release.`,
      });
    }
    node = await (deps.ensure ?? rt.ensureNode)(root, pin, {
      timeoutMs: NODE_TIMEOUT_MS,
      fetchImpl: deps.fetchImpl,
    });
    await (deps.place ?? rt.placeVersion)(root, stage, latest);
  } catch (err) {
    await rm(stage, { recursive: true, force: true }).catch(() => undefined);
    throw proxyNamed(err, deps);
  }
  const home = deps.homeDir ?? homedir();
  emitWriteNotice(ctx.io, `tenjin update: staged tenjin-cli ${latest} in ${tilde(root, home)}`);

  const { refresh, homeTail } = await refreshProfiles(ctx, deps, {
    node,
    entry: layout.versionEntry(root, latest),
  });
  if (layout.readRuntimeState(root)?.current.cli !== latest) {
    // `versions/<latest>` is left for the next collect(): nothing points at it.
    throw new CliError('UPDATE_FAILED', `tenjin-cli ${latest} did not pass its checks, ${stays}`, {
      fix: 'Run `tenjin update` again; if it fails again, run `tenjin doctor`',
      details: {
        reason:
          refresh.failed[0]?.reason ??
          runtimeReason(envelopeData(homeTail)) ??
          'The new version did not switch the runtime to itself.',
        output: homeTail.slice(-2000),
      },
    });
  }
  return updated(
    deps,
    o.data(true),
    refresh,
    [
      `Updated tenjin-cli ${base} -> ${latest}.`,
      `The previous version (${base}) stays as the fallback.`,
    ],
    latest,
  );
}

/**
 * A download in the runtime branch that failed on a Node which skips the
 * shell's proxy (#470), said as that with the step that works: `tenjin update`
 * again on the same Node fails the same way.
 */
function proxyNamed(err: unknown, deps: UpdateDeps): unknown {
  if (!(err instanceof CliError) || err.code !== 'NETWORK_ERROR') return err;
  const skipped = proxySkipped(process.env, deps.proxySupported);
  if (skipped === null) return err;
  const step = proxyNodeStep('tenjin update');
  return new CliError('NETWORK_ERROR', `${err.message}: ${skipped}`, {
    fix: `${step.charAt(0).toUpperCase()}${step.slice(1)}.`,
    cause: err,
  });
}

/** Why the child kept the previous runtime, from its `data.runtime.reason`. */
function runtimeReason(data: Record<string, unknown> | null): string | undefined {
  const reason = (data?.runtime as { reason?: unknown } | undefined)?.reason;
  if (typeof reason !== 'string') return undefined;
  const text = sanitizeForTerminal(reason).trim();
  return text.length > 0 ? text.slice(0, REASON_LIMIT) : undefined;
}

/** `path` with the home folder written as `~`. */
function tilde(path: string, home: string): string {
  return path === home || path.startsWith(`${home}${sep}`) ? `~${path.slice(home.length)}` : path;
}

/** How long one `install --refresh` child gets. Local file writes only, no
 *  registry: a minute is already generous, and `update` must not hang a turn. */
const REFRESH_TIMEOUT_MS = 60_000;

/** One profile this update did not bring up to date, and why. */
export interface RefreshFailure {
  /** The profile's data dir. */
  dataDir: string;
  /**
   * Why it is not up to date, in the words of whoever decided that: the child's
   * own `error.message` when it printed a failure envelope, this pass's own
   * account when the child was never run or never got that far. Always present,
   * because a failure whose four causes render identically is the reason this
   * field exists.
   */
  reason: string;
  /** The command that converges THIS profile; see {@link manualFix}. */
  fix: string;
}

/** What the post-swap re-materialize did, per profile. */
export interface RefreshOutcome {
  /** Data dirs a refresh was run for, whether or not it succeeded. */
  profiles: string[];
  /**
   * Profiles this update did not bring up to date, each with its reason and the
   * manual command to finish it. Both halves land here: a refresh that ran and
   * did not report success, and one that was never run at all (no entry to
   * re-exec, a data dir that is not a directory).
   */
  failed: RefreshFailure[];
  /**
   * What a refresh that succeeded said the person must know (the child's
   * `data.notices`): a plugin left for a newer Claude Code, a status line the
   * migration took out. Printed as given, one line each.
   */
  notices: string[];
  /** A refreshed profile still carries an earlier release's settings install. */
  settingsInstallPending: boolean;
  /** Project installs (`install --project`) refreshed from their own directory. */
  projects: string[];
  /** Project installs whose refresh did not succeed, each with its reason and fix. */
  projectsFailed: { project: string; reason: string; fix: string }[];
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
 * child is the freshly installed entry (`launch`: npm's, on this Node, or the
 * runtime's new version, on the Node it pins), and what it runs is
 * `install --refresh` — a mode that converges existing surfaces and creates
 * none but the runtime and its launcher, which is the only kind of write an
 * unattended upgrade may make.
 *
 * ONCE PER HOOK-OWNER PROFILE. `install` bakes its data dir into the scripts it
 * generates, so a machine whose hooks were installed under `TENJIN_DATA_DIR`
 * has hooks belonging to THAT profile while a bare `tenjin update` resolves the
 * default one. Refreshing only the invoking profile there would leave the
 * registered scripts — the ones the harness actually fires — stale forever,
 * short of a manual re-install for each profile. So the detector
 * reads the harness settings and each profile it names is refreshed with
 * `TENJIN_DATA_DIR` set to it. A machine with no registered hooks has no other
 * profile to find, and gets one refresh for the invoking one.
 *
 * NEVER FAILS THE UPDATE. The swap already happened and is the thing the
 * operator asked for. A refusal, a run with nothing to converge, a crash, a
 * timeout, or an older-binary "unknown option --refresh" all land here as a warn
 * naming the manual command.
 *
 * EACH FAILURE CARRIES ITS OWN REASON AND ITS OWN FIX. The four ways a profile
 * misses are not interchangeable — a dir that is not a directory, a settings
 * file that changed underneath, a machine that never ran `install`, and a
 * timeout each want a different next move — so the child's output is collected
 * and its `error.message` reported per profile rather than collapsed into one
 * parent line.
 */
async function refreshProfiles(
  ctx: CommandContext,
  deps: UpdateDeps,
  launch: ChildLaunch | null,
): Promise<{ refresh: RefreshOutcome; homeTail: string }> {
  const home = deps.homeDir ?? homedir();
  // THE INVOKING PROFILE, AND ONLY IT. The pre-daemon installer baked its data
  // dir into eight generated scripts, so an upgrade had to find every profile
  // registered in settings.json and refresh each one's bodies. Nothing is baked
  // any more: the two bundles are the same bytes for every profile, and a
  // profile's daemon picks up the new build the next time its own `tenjin`
  // command runs. So there is nothing left to hunt for, and a detector reading
  // paths out of somebody's settings file is not worth keeping to say so.
  const candidates = [ctx.dataDir];
  const fixFor = (dataDir: string): string => manualFix(dataDir, home, ctx.dataDir);

  // The child would CREATE a data dir that is not there: `install --refresh`
  // converges surfaces rather than materializing them, but the process around it
  // mkdirs the tree for the update cache on its way out. So a path that is not
  // already a directory is reported unrefreshed instead of visited.
  const profiles: string[] = [];
  const unrun: RefreshFailure[] = [];
  for (const dataDir of candidates) {
    if (isExistingDir(dataDir)) profiles.push(dataDir);
    else unrun.push({ dataDir, reason: 'It is not a directory.', fix: fixFor(dataDir) });
  }

  // Nothing safe to re-exec (see npmLaunch): report the profiles as
  // unrefreshed rather than guessing, since guessing is how a hook script gets
  // rewritten by the wrong binary — and a refresh that ran the OLD build would
  // report success while writing the bytes the update just left.
  if (launch === null) {
    const reason = 'This build has no entry the update could safely re-execute.';
    return {
      refresh: {
        profiles: [],
        failed: candidates.map((d) => ({ dataDir: d, reason, fix: fixFor(d) })),
        notices: [],
        settingsInstallPending: false,
        projects: [],
        projectsFailed: [],
      },
      homeTail: '',
    };
  }

  const failed = [...unrun];
  const notices: string[] = [];
  let settingsInstallPending = false;
  const heard = (reported: Record<string, unknown> | null): void => {
    for (const notice of noticesOf(reported)) if (!notices.includes(notice)) notices.push(notice);
    const migration = reported?.migration as { state?: unknown } | undefined;
    if (migration?.state === 'pending' || migration?.state === 'blocked') {
      settingsInstallPending = true;
    }
  };
  let homeTail = '';
  for (const dataDir of profiles) {
    const { outcome, tail } = await refreshChild(launch, homedir(), dataDir, deps);
    homeTail = tail;
    // The child's exit code IS the verdict: `install --refresh` exits non-zero
    // when it refused or found nothing to converge, so a machine that never ran
    // `install` warns here instead of being told its hooks were refreshed. The
    // envelope on the pipe is what turns that verdict into a reason.
    if (outcome.kind !== 'exit' || outcome.code !== 0) {
      failed.push({ dataDir, reason: refreshReason(outcome, tail), fix: fixFor(dataDir) });
      continue;
    }
    heard(envelopeData(tail));
  }

  // PROJECT INSTALLS, EACH FROM ITS OWN DIRECTORY. The child above runs from
  // home, where a `--project` install (Claude Code's local scope) is not
  // visible, so each one `install --project` recorded is refreshed where it
  // lives, as `--project`, since the child cannot tell one at home from the
  // user install. A directory that is gone, or that no longer holds one, is
  // forgotten.
  const projects: string[] = [];
  const projectsFailed: RefreshOutcome['projectsFailed'] = [];
  const recorded = profiles.includes(ctx.dataDir)
    ? ((await loadRawConfig(ctx.dataDir).catch(() => null))?.install?.routerProjects ?? [])
    : [];
  for (const project of recorded) {
    const forget = () => persistRouterProject(ctx.dataDir, project, false).catch(() => undefined);
    if (!isExistingDir(project) || !(await projectInstallAt(project, home, process.env))) {
      await forget();
      continue;
    }
    const { outcome, tail } = await refreshChild(launch, project, ctx.dataDir, deps, ['--project']);
    if (outcome.kind !== 'exit' || outcome.code !== 0) {
      projectsFailed.push({
        project,
        reason: refreshReason(outcome, tail),
        fix: `Run \`tenjin install --project\` in ${project}.`,
      });
      continue;
    }
    projects.push(project);
    heard(envelopeData(tail));
  }
  return {
    refresh: { profiles, failed, notices, settingsInstallPending, projects, projectsFailed },
    homeTail,
  };
}

/** The new build a refresh child runs: its Node and its entry script. */
interface ChildLaunch {
  node: string;
  entry: string;
}

/**
 * The npm branch's child: the version-free entry npm just replaced, on this
 * Node. Null when there is no argv to re-exec (an embedder, a stripped argv),
 * or only a path that names the version being replaced (see versionFreeEntry).
 */
function npmLaunch(deps: UpdateDeps): ChildLaunch | null {
  const entry = versionFreeEntry(deps.refreshCommand ?? process.argv[1]);
  return entry === null ? null : { node: process.execPath, entry };
}

/**
 * One `install --refresh` child of the new build, from `cwd`, for `dataDir`:
 * how it ended and the end of what it printed. Spawned as `<node> <entry>` by
 * absolute path, never through a shell or a `.cmd`.
 *
 * A BOUNDED COLLECTOR, not the manager's live echo. npm's chatter is minutes
 * of progress a human wants to see; this child emits one envelope on a pipe,
 * and painting that JSON into the human's stderr is noise. It is still kept,
 * because the envelope is where the child says WHICH refusal this was.
 */
async function refreshChild(
  launch: ChildLaunch,
  cwd: string,
  dataDir: string,
  deps: UpdateDeps,
  flags: string[] = [],
): Promise<{ outcome: SpawnResult; tail: string }> {
  let tail = '';
  const outcome = await (deps.spawnImpl ?? spawnCapture)(
    launch.node,
    [launch.entry, 'install', '--refresh', ...flags],
    {
      cwd,
      timeoutMs: REFRESH_TIMEOUT_MS,
      // TENJIN_DATA_DIR aims the child at this profile; the nudge opt-out is
      // what keeps it from touching any other file in there (lib/update-check).
      env: { TENJIN_DATA_DIR: dataDir, [NUDGE_OPT_OUT]: '1' },
    },
    (chunk) => {
      tail = (tail + chunk).slice(-REFRESH_TAIL_LIMIT);
    },
  );
  return { outcome, tail };
}

/** The `data` of the one success envelope the child printed, or null. */
function envelopeData(output: string): Record<string, unknown> | null {
  const lines = output.split('\n');
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (lines[i]?.trim() !== '{' && !lines[i]?.trim().startsWith('{"')) continue;
    try {
      const parsed = JSON.parse(lines.slice(i).join('\n')) as { ok?: unknown; data?: unknown };
      if (parsed?.ok === true && parsed.data !== null && typeof parsed.data === 'object') {
        return parsed.data as Record<string, unknown>;
      }
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * The child's notices, each bounded and sanitized: the child is the build
 * this update just installed, but its text still reaches a terminal.
 */
function noticesOf(data: Record<string, unknown> | null): string[] {
  const raw = data?.notices;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((n): n is string => typeof n === 'string')
    .map((n) => sanitizeForTerminal(n).trim().slice(0, REASON_LIMIT))
    .filter((n) => n.length > 0)
    .slice(0, 5);
}

/** How much of one refresh child's output is kept. It prints a single envelope,
 *  not a build log, so this is headroom rather than a budget. */
const REFRESH_TAIL_LIMIT = 64_000;

/** How much of a child's own message reaches the parent's report. Long enough
 *  for every message `install --refresh` can produce, short enough that a child
 *  which somehow printed prose cannot own the operator's terminal. */
const REASON_LIMIT = 300;

/**
 * Why this profile is not up to date, preferring the child's own account.
 *
 * The exit code separates success from failure and nothing else, so the four
 * refusals `install --refresh` can reach would otherwise reach the operator as
 * one line that names none of them. The envelope on the pipe carries the
 * distinction; the outcome kind covers the deaths that never printed one.
 */
function refreshReason(outcome: SpawnResult, output: string): string {
  const reported = envelopeMessage(output);
  if (reported !== undefined) return reported;
  if (outcome.kind === 'timeout') return `It did not finish in ${REFRESH_TIMEOUT_MS / 1000}s.`;
  if (outcome.kind === 'start-failed') return 'The refresh could not be started.';
  // An older binary rejecting `--refresh` is the expected shape here: commander
  // writes its own usage error and exits without an envelope of ours.
  return `The refresh exited ${outcome.code} without reporting a reason.`;
}

/**
 * The `error.message` out of the one failure envelope the child printed.
 *
 * Read from the LAST envelope because stdout carries exactly one while stderr
 * may carry notices ahead of it, and the two pipes are merged here.
 *
 * `writeJson` PRETTY-PRINTS, so the envelope spans many lines and its only line
 * starting with `{` is a bare `{` that does not parse alone. So scan backwards
 * for an opening line and parse from there to the end; a compact single line
 * still parses through the same path, which keeps an older child readable.
 *
 * Sanitized because this text is bound for a human's terminal and the child
 * relays paths and parse errors it did not author.
 */
function envelopeMessage(output: string): string | undefined {
  const lines = output.split('\n');
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i]?.trim();
    if (line === undefined || !line.startsWith('{')) continue;
    let parsed: { ok?: unknown; error?: { message?: unknown } };
    try {
      parsed = JSON.parse(lines.slice(i).join('\n')) as typeof parsed;
    } catch {
      continue;
    }
    if (parsed?.ok !== false || typeof parsed.error?.message !== 'string') continue;
    const message = sanitizeForTerminal(parsed.error.message).trim();
    if (message.length > 0) return message.slice(0, REASON_LIMIT);
  }
  return undefined;
}

/** A path that already exists AND is a directory. Follows links on purpose: a
 *  data dir behind a symlink is an ordinary machine layout, an absent one is not
 *  a profile this command may create. */
function isExistingDir(path: string): boolean {
  return statSync(path, { throwIfNoEntry: false })?.isDirectory() === true;
}

/**
 * The manual command that converges THIS profile.
 *
 * A bare `tenjin install` resolves one data dir, so handing it to an operator
 * whose failed profile is another one — the case the per-profile loop exists
 * for — is advice that cannot repair the thing it names. The bare form is emitted only
 * for a dir that is the default under this home AND the one this invocation
 * itself resolved, so it is right under either reading of "what a bare install
 * would do next"; every other profile gets the explicit env prefix, which is
 * right unconditionally.
 */
function manualFix(dataDir: string, home: string, invoking: string): string {
  const bare =
    resolve(dataDir) === resolve(defaultDataDir(home)) && resolve(dataDir) === resolve(invoking);
  const command = bare ? 'tenjin install' : `TENJIN_DATA_DIR=${dataDir} tenjin install`;
  return `Run \`${command}\` to bring the Claude Code plugin up to this version.`;
}

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
 * What the refresh actually did, as lines.
 *
 * It replaces "New builds pick it up immediately", which was true of the binary
 * and false of everything install had written — so it read as reassurance about
 * precisely the thing that was NOT handled (tenjin-agent#171).
 *
 * The successes are reported ALONGSIDE the failures rather than instead of them:
 * a machine where 8 of 12 profiles converged is not a machine where the refresh
 * did nothing, and one line per failure is what lets its own reason and its own
 * command travel with it.
 */
function refreshLines(refresh: RefreshOutcome): string[] {
  const failedDirs = new Set(refresh.failed.map((f) => f.dataDir));
  const done = refresh.profiles.filter((p) => !failedDirs.has(p));
  if (refresh.failed.length === 0) {
    return [
      done.length > 1
        ? `Refreshed the Claude Code plugin for ${done.length} profiles: ${done.join(', ')}.`
        : `Refreshed the Claude Code plugin for ${done[0]}.`,
    ];
  }
  const total = done.length + refresh.failed.length;
  const lines =
    done.length > 0
      ? [
          `Refreshed the Claude Code plugin for ${done.length} of ${total} profiles: ${done.join(', ')}.`,
        ]
      : [];
  lines.push(`Could not refresh the Claude Code plugin for ${refresh.failed.length}:`);
  lines.push(...refresh.failed.map((f) => `- ${f.dataDir}: ${f.reason} ${f.fix}`));
  return lines;
}

/** The project installs the refresh reached, and the ones it could not. */
function projectLines(refresh: RefreshOutcome): string[] {
  return [
    ...(refresh.projects.length > 0
      ? [`Refreshed the project install in ${refresh.projects.join(', ')}.`]
      : []),
    ...(refresh.projectsFailed.length > 0
      ? [
          `Could not refresh the project install in ${refresh.projectsFailed.length}:`,
          ...refresh.projectsFailed.map((p) => `- ${p.project}: ${p.reason} ${p.fix}`),
        ]
      : []),
  ];
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
