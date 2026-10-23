import { existsSync } from 'node:fs';
import { readFile, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import pkg from '../../package.json';
import { persistRouterDefaults, persistRouterProject, type RouterLimits } from '../commands/config';
import { askText, selectOne } from '../lib/clack';
import { CliError } from '../lib/errors';
import { parseUsdToAtomic, toMoney } from '../lib/money';
import { paint } from '../lib/output';
import { defaultDataDir, runtimeDir } from '../lib/paths';
import { resolveContextSettings } from '../lib/settings';
import type { SpendPolicy } from '../lib/policy';
import type { LauncherResult, RuntimeSetup, setupRuntime } from '../lib/runtime';
import { runtimeBuild, runtimeStatePath, type RuntimePointer } from '../lib/runtime-layout';
import { removeRetiredSkills } from '../lib/skill-placement';
import {
  loadRawConfig,
  MAX_AUTO_SPEND_FLOOR_ATOMIC,
  MAX_AUTO_SPEND_FLOOR_WHY,
} from '../lib/config';
import type { WalletDeps, WalletOutcome } from '../commands/install-wallet';
import type { CommandContext, CommandResult } from '../context';
import { readAliveStamp } from './alive';
import { SUGGESTED_FUND_USD } from './fee';
import {
  findClaudeBinary,
  readClaudeCode,
  userMcpFile,
  userSettingsPath,
  type ClaudeBinary,
  type ClaudeCodeState,
} from './claude-cli';
import {
  inspectLegacyInstall,
  projectMcpFile,
  removeLegacyInstall,
  type LegacyInstall,
  type LegacyRemoval,
} from './legacy-install';
import { MCP_SERVER_NAME, PLUGIN_ID } from './names';
import { CLAUDE_CODE_FLOOR } from './claude-cli';
import { inspectPluginFolder } from './plugin-folder';
import {
  folderFor,
  folderState,
  marketplaceAdded,
  readPluginListing,
  recordedInstalls,
  registerPlugin,
  type PluginRegistration,
  type PluginScope,
} from './plugin-registration';
import { probeRouter, type RouterCheck } from './reachability';
import {
  readMcpServers,
  type InstalledAt,
  type ListMcpProcesses,
  type ListProcesses,
} from './mcp-processes';
import {
  ROUTER_DEFAULTS,
  ROUTING_FEE_TERMS,
  shownLimits,
  SPEND_QUESTION,
  spendChoiceQuestion,
  spendOptions,
  FEE_APPROVAL,
  type SpendOption,
} from './spend-question';
import { underAgentHarness } from '../lib/session';
import { agentFixFor, REPAIR_CLAUSE, WALLET_REASONS } from './wallet-reasons';

/**
 * `tenjin install` for the router product: the wallet, the spend limits, and
 * the Claude Code plugin `tenjin`, registered with no step left to the person.
 *
 * WHAT IT WRITES. The wallet and the spend defaults under the data dir, as
 * before. With the default data dir, this build is copied into Tenjin's own
 * runtime, `~/.tenjin/runtime`, with a pinned Node and a `tenjin` launcher in
 * `~/.local/bin` (see `lib/runtime.ts`), and the plugin is registered from
 * the runtime's `claude` folder, whose commands run that Node and that copy,
 * so neither a Node upgrade nor `npm rm -g tenjin-cli` stops it. A non-default
 * data dir, a source checkout, or a runtime that could not be set up keeps
 * the registration from this package's `dist/hosts/claude` folder, run by the
 * `node` on PATH. Either way the plugin goes through Claude Code's own `claude
 * plugin` commands (see `plugin-registration.ts`), or is written as a folder
 * under the config dir's `skills/` where no `claude` binary can be run. The
 * plugin carries the seven routing legs, the `router` MCP server, and the
 * hooks that allow the request tool and deny the legs' own tool to the model,
 * so this command writes nothing into `settings.json` or `~/.claude.json`
 * itself.
 *
 * NO STEP IS LEFT TO THE PERSON. An agent runs this in the person's session:
 * the spend question comes back for the agent to ask there, the funding question
 * with the install its answer picks, the `claude`
 * binary is found through `CLAUDE_CODE_EXECPATH` where PATH lacks it, a failed
 * plugin command falls back to the folder, and the one step after it is
 * starting a new Claude Code session: `/reload-plugins` does not run the
 * plugin's `SessionStart`, so only a new session loads Tenjin fully.
 *
 * THE SETTINGS INSTALL OF EARLIER RELEASES is left working until the plugin
 * has proven to load on this machine (see {@link migrateSettingsInstall}).
 */

export { AFTER_CALL_TIMEOUT_SECONDS, ROUTE_HOOK_TIMEOUT_SECONDS } from './plugin-files';

export const DISCLOSURE: readonly string[] = [
  "What leaves this machine: the bounded text of each prompt, each native search query or URL (and, when one came back short, its status, size or error), each task handed to a subagent, and each question your assistant asks you with your answers, sent to Tenjin for the free routing gate, beside this session's id. When the gate offers free library docs for a search, that search query also goes to Tenjin's docs lookup, which asks Context7.",
  'What is kept when a lookup is paid: the capability chosen, a hash of the contract, a hash of the arguments, and your wallet address. No prompt text, no arguments, no hint text.',
  'What never leaves: your private key. It is decrypted in this CLI to sign, and never sent anywhere.',
];

/**
 * What the person does after a successful install: only a new session.
 * `/reload-plugins` does not run the plugin's `SessionStart`, and while a
 * settings install is still here it would load the plugin beside the
 * pre-upgrade `x402` server that session is still running, so every event
 * would route twice.
 */
export const NEW_SESSION_STEP = 'start a new Claude Code session so Tenjin loads';
/** The same step; kept as its own export for its callers. */
export const RELOAD_STEP = NEW_SESSION_STEP;

/** The step that loads the plugin: a new session, whether or not a settings install is still here. */
export function loadStep(_settingsInstallPresent: boolean): string {
  return NEW_SESSION_STEP;
}

export interface RouterInstallArgs {
  /**
   * Register the plugin for this project only (Claude Code's `local` scope,
   * `.claude/settings.local.json`), or write its folder under the project's
   * `.claude/skills/`.
   */
  project?: boolean;
  /**
   * Bring what this machine ALREADY has up to the running build: the plugin,
   * or a settings install the plugin then replaces, with no spend-limit
   * write. A refusal when nothing of ours is here; a runtime alone (Codex
   * kept it after Claude Code's install was removed) is brought up to the
   * running build with nothing for Claude Code created. It may add Tenjin's
   * runtime and its launcher to an install that predates them (never a
   * downgrade: a newer runtime is kept), and records the project installs
   * Claude Code lists so `tenjin update` refreshes them too. `tenjin update`
   * spawns exactly this after it swaps the binary, so the flag's name and
   * meaning are a compatibility contract.
   */
  refresh?: boolean;
  /**
   * Accept the defaults instead of asking: the selector's "Use the defaults",
   * for an agent running the person's answer.
   */
  yes?: boolean;
  /** Create no wallet, for CI and scripted machines. */
  noWallet?: boolean;
  /**
   * `--session-budget` and `--max-auto-spend`: the person's own limits, in USD
   * as typed (`none` for no daily limit; the per-call limit is at least $0.25).
   * Either one answers the question; the other then takes the default. A named
   * limit replaces what the config file holds.
   */
  maxAutoSpend?: string;
  sessionBudget?: string;
}

export interface RouterInstallDeps extends WalletDeps {
  /** This user's running routers and Claude Code processes; tests inject them. */
  listProcesses?: ListProcesses;
  /** This user's running `tenjin mcp` processes; tests inject them. */
  listMcpProcesses?: ListMcpProcesses;
  /** When this build was installed; tests inject it. */
  installedAt?: InstalledAt;
  homeDir?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Finds the `claude` binary; tests inject one, production reads PATH and `CLAUDE_CODE_EXECPATH`. */
  findClaude?: (env: NodeJS.ProcessEnv) => ClaudeBinary | null;
  /** The marketplace folder; production reads this package's `dist/hosts/claude`. */
  hostsDir?: string | null;
  /** The CLI entry a plugin folder's commands run. Production reads this package's `dist/index.js`. */
  cliEntry?: string;
  /** Whether a person can answer the spend-limit question (a TTY on stdout and
   *  stdin, no `--json`); injected in tests. */
  isInteractive?: boolean;
  /** The spend-limit selector; defaults to the clack list. */
  promptLimits?: (message: string) => Promise<LimitsChoice | null>;
  /** One amount question; defaults to the clack text input. */
  promptAmount?: (message: string, placeholder: string) => Promise<string | null>;
  /** The router reachability probe's transport; tests inject it. */
  fetchImpl?: typeof fetch;
  /** The wallet's USDC balance in atomic units; production reads Base. */
  walletBalance?: (address: string, rpcUrl: string) => Promise<bigint>;
  /** Sets up Tenjin's runtime for this build; tests inject it, production runs `setupRuntime`. */
  runtime?: (o: Parameters<typeof setupRuntime>[0]) => Promise<RuntimeSetup>;
}

export type LimitsChoice = 'approve' | 'own';

/** Where a settings install of this scope kept its entries and its server. */
export interface SettingsInstallPaths {
  settingsPath: string;
  mcpFile: string;
  mcpScope: 'user' | 'project';
}

export function settingsInstallPaths(
  project: boolean,
  env: NodeJS.ProcessEnv,
  home: string,
  cwd: string,
): SettingsInstallPaths {
  return project
    ? {
        settingsPath: join(cwd, '.claude', 'settings.json'),
        mcpFile: projectMcpFile(cwd),
        mcpScope: 'project',
      }
    : {
        settingsPath: userSettingsPath(env, home),
        mcpFile: userMcpFile(env, home),
        mcpScope: 'user',
      };
}

/** The settings install's state, as install, update, doctor and uninstall report it. */
export interface Migration {
  /**
   * `none` (no settings install here), `pending` (left in place until the
   * plugin proves it loads), `done` (removed by this run), or `blocked` (the
   * settings file could not be read).
   */
  state: 'none' | 'pending' | 'done' | 'blocked';
  settingsPath: string;
  /** Why it is still pending or blocked. */
  reason?: string;
  removed?: LegacyRemoval;
}

/**
 * THE GUARDED MIGRATION. A working settings install is removed only once the
 * plugin has proven to load on this machine: Claude Code at or above the floor
 * and listing the plugin enabled (when a binary can be asked), and the
 * plugin's `alive` leg having stamped the machine from a real session. Until
 * then both stay, and the `alive` marker keeps the old legs silent in any
 * session the plugin serves. Only `install` and `update` migrate; doctor
 * reports.
 */
export async function pluginProof(
  claude: ClaudeCodeState,
  dataDir: string,
  env: NodeJS.ProcessEnv,
  cwd: string,
): Promise<{ proven: true } | { proven: false; reason: string }> {
  if (claude.binary !== null && !claude.meetsFloor) {
    return {
      proven: false,
      reason: `Claude Code ${claude.version ?? '(unknown)'} is older than the plugin needs`,
    };
  }
  if (claude.binary !== null) {
    const listing = await readPluginListing(claude.binary, env, cwd);
    if (!listing.enabled) {
      return { proven: false, reason: 'Claude Code does not list the plugin as enabled yet' };
    }
  }
  if ((await readAliveStamp(dataDir)) === null) {
    return {
      proven: false,
      reason: 'the plugin has not loaded in a Claude Code session on this machine yet',
    };
  }
  return { proven: true };
}

export async function migrateSettingsInstall(
  legacy: LegacyInstall,
  claude: ClaudeCodeState,
  opts: { dataDir: string; env: NodeJS.ProcessEnv; cwd: string; mcpScope: 'user' | 'project' },
): Promise<Migration> {
  if (!legacy.present) return { state: 'none', settingsPath: legacy.settingsPath };
  const proof = await pluginProof(claude, opts.dataDir, opts.env, opts.cwd);
  if (!proof.proven) {
    return { state: 'pending', settingsPath: legacy.settingsPath, reason: proof.reason };
  }
  const removed = await removeLegacyInstall(legacy, {
    binary: claude.binary,
    env: opts.env,
    cwd: opts.cwd,
    mcpScope: opts.mcpScope,
  });
  return { state: 'done', settingsPath: legacy.settingsPath, removed };
}

/**
 * Is there a project install here? A refresh, a bare doctor and a bare
 * uninstall are given no scope, and `tenjin update` runs its refresh from
 * home, where nothing proves one. A project install is taken when this
 * directory, not being home, holds one: the plugin enabled in its
 * `settings.local.json`, its plugin folder, or a settings install's entries.
 */
export async function projectInstallHere(
  cwd: string,
  home: string,
  env: NodeJS.ProcessEnv,
): Promise<boolean> {
  if (await isHome(cwd, home)) return false;
  return projectInstallAt(cwd, home, env);
}

/**
 * Does `dir` still hold the project install `install --project` recorded
 * there? Home included: a `--project` install at home is supported, and there
 * its plugin folder and settings file are the user install's own, so only the
 * plugin enabled in `.claude/settings.local.json` proves it.
 */
export async function projectInstallAt(
  dir: string,
  home: string,
  env: NodeJS.ProcessEnv,
): Promise<boolean> {
  const local = await readFile(join(dir, '.claude', 'settings.local.json'), 'utf8')
    .then((raw) => JSON.parse(raw) as { enabledPlugins?: Record<string, unknown> })
    .catch(() => null);
  if (local?.enabledPlugins?.[PLUGIN_ID] === true) return true;
  if (await isHome(dir, home)) return false;
  if ((await folderState('local', env, home, dir)).state === 'ours') return true;
  const paths = settingsInstallPaths(true, env, home, dir);
  return (await inspectLegacyInstall(paths.settingsPath, paths.mcpFile)).events.length > 0;
}

async function isHome(dir: string, home: string): Promise<boolean> {
  const [dirPath, homePath] = await Promise.all([
    realpath(dir).catch(() => dir),
    realpath(home).catch(() => home),
  ]);
  return dirPath === homePath;
}

/** Is any install of ours here for a refresh to bring up to date? */
async function somethingToRefresh(
  claude: ClaudeCodeState,
  scope: PluginScope,
  legacy: LegacyInstall,
  env: NodeJS.ProcessEnv,
  home: string,
  cwd: string,
): Promise<boolean> {
  if (legacy.present) return true;
  if ((await folderState(scope, env, home, cwd)).state === 'ours') return true;
  if (claude.binary !== null) {
    const listing = await readPluginListing(claude.binary, env, cwd);
    if (listing.id === PLUGIN_ID) return true;
  }
  return false;
}

export async function runRouterInstall(
  args: RouterInstallArgs,
  ctx: CommandContext,
  deps: RouterInstallDeps = {},
): Promise<CommandResult> {
  const env = deps.env ?? process.env;
  const home = deps.homeDir ?? homedir();
  if (!isAbsolute(home)) {
    throw new CliError('INTERNAL', 'The home directory is not an absolute path.', {
      fix: 'Set HOME to your home directory (`export HOME=...`), then re-run `tenjin install`.',
    });
  }
  assertPluginDataDir(ctx.dataDir, home, env);
  const config = await loadRawConfig(ctx.dataDir); // Validate before any install writes; retired keys remain readable.
  const named = namedLimits(args);
  const cwd = deps.cwd ?? process.cwd();
  // An explicit --project wins, including for a project rooted at home.
  const project =
    args.project ?? (args.refresh === true && (await projectInstallHere(cwd, home, env)));
  const scope: PluginScope = project ? 'local' : 'user';
  const claude = await readClaudeCode(env, cwd, deps.findClaude ?? findClaudeBinary);
  const paths = settingsInstallPaths(project, env, home, cwd);
  const legacy = await inspectLegacyInstall(paths.settingsPath, paths.mcpFile);

  const setUpRuntime = () =>
    (deps.runtime ?? defaultRuntime)({
      dataDir: ctx.dataDir,
      home,
      env,
      version: pkg.version,
      moduleDir: dirname(fileURLToPath(import.meta.url)),
      refresh: args.refresh === true,
    });

  if (args.refresh === true && !(await somethingToRefresh(claude, scope, legacy, env, home, cwd))) {
    // A RUNTIME WITH NO CLAUDE CODE SURFACE: `tenjin uninstall --harness
    // claude` keeps the runtime and its launcher while Codex still runs them,
    // and `tenjin update` brings that runtime up to its new build through this
    // same refresh. Only the runtime step runs; nothing for Claude Code is
    // registered, written or migrated.
    if (!project && hasRuntime(ctx.dataDir, home)) {
      const rt = await setUpRuntime();
      requireRuntime(rt);
      if (runtimeLaunch(rt) !== null) {
        await collectRuntime(rt.root, await fallbackFolders(ctx.dataDir, env, home, cwd, false));
      }
      return runtimeOnlyRefresh(ctx, rt, home);
    }
    throw new CliError(
      'REFUSED',
      `Nothing to refresh: neither the ${PLUGIN_ID} plugin nor a settings install of Tenjin is registered here.`,
      { fix: 'Run `tenjin install` to set this machine up.' },
    );
  }
  // The shelf install's gate: a refresh, `--json`, or a run with no terminal on
  // either side asks nothing. An agent's install is that run: its shell has no
  // terminal. Install then writes no spend limit, the defaults ($0.25 a call,
  // $5 a day) hold as they do for any key the file leaves out, and its output hands
  // the question to whoever ran it (see {@link spendApproval}).
  const humanOutput = ctx.flags.json === true ? false : (deps.isInteractive ?? ctx.io.isTTY);
  const canPrompt = humanOutput && (deps.isInteractive ?? Boolean(process.stdin.isTTY));
  // `--yes` is the selector's "Use the defaults", answered ahead, and the two
  // amount flags its "Set my own limits": the same install, run
  // again by an agent for the person's answer. A file that names either limit
  // has been answered before, so nothing asks again.
  const answered = args.yes === true || named.keys.length > 0;
  const unasked = config.maxAutoSpend === undefined && config.sessionBudget === undefined;
  const limits =
    args.refresh === true
      ? undefined
      : named.keys.length > 0
        ? { ...shownLimits(config), ...named.limits }
        : args.yes === true
          ? shownLimits(config)
          : canPrompt && unasked
            ? await approveLimits(deps)
            : {};
  // BELOW THE FLOOR, A WORKING SETTINGS INSTALL WINS. The plugin's routing
  // legs need Claude Code 2.1.287, but its `alive` leg is a command that runs
  // on any version and would silence the settings install in every session,
  // leaving the machine unrouted. So nothing is registered until `claude
  // update`, and the settings install keeps routing, and no runtime is set up.
  const deferred = !claude.meetsFloor && legacy.present;
  const rt = deferred ? null : await setUpRuntime();
  requireRuntime(rt);
  // CLAUDE CODE'S OWN PROJECT INSTALLS ARE RECORDED, before a refresh can
  // refuse: `tenjin update` refreshes every recorded project after its home
  // child, so a project an older release installed without recording it
  // moves to the runtime with the rest. A user-scope run only; never fatal.
  if (!project) {
    await recordClaudeProjects(ctx.dataDir, config.install?.routerProjects ?? [], env, home);
  }

  const spend = await persistRouterDefaults(ctx.dataDir, args.refresh === true, limits, named.keys);
  const removedKeysLines =
    spend.removed.length > 0
      ? [
          `Removed retired settings: ${spend.removed.join(', ')}. Automatic router limits remain in effect; manual pay always requires consent.`,
        ]
      : [];
  const removedSkills = await removeRetiredSkills(home, project ? cwd : undefined);
  const launch = runtimeLaunch(rt);
  const plugin: PluginRegistration = deferred
    ? deferredRegistration(scope, claude)
    : await registerPlugin({
        binary: claude.binary,
        scope,
        version: launch?.version ?? pkg.version,
        env,
        home,
        cwd,
        ...(launch !== null
          ? { hostsDir: launch.hostsDir, cliEntry: launch.cliEntry, node: launch.node }
          : {
              ...(deps.hostsDir !== undefined ? { hostsDir: deps.hostsDir } : {}),
              ...(deps.cliEntry !== undefined ? { cliEntry: deps.cliEntry } : {}),
            }),
      });
  // A registration that failed after this run switched the runtime puts the
  // runtime back, so Claude Code is never left on a folder it was not given.
  // UNLESS ITS `marketplace add` WENT THROUGH: Claude Code's one `tenjin` row
  // now names `runtime/claude` and reads it in place, so putting back what was
  // there (nothing at all, on a first activation) would leave it loading an
  // empty folder. The render it holds passed `verifyBuild`, so it stays.
  // Old versions are collected only once the plugin is registered.
  if (rt !== null && launch !== null) {
    if (plugin.state !== 'failed') {
      await collectRuntime(rt.root, await fallbackFolders(ctx.dataDir, env, home, cwd, project));
    } else if (!marketplaceAdded(plugin, launch.hostsDir)) {
      await rt.restore?.().catch(() => undefined);
    }
  }
  // A PROJECT INSTALL IS RECORDED, so `tenjin update`, which refreshes from
  // home where this scope is not visible, refreshes it from here too.
  if (project && plugin.state !== 'failed') {
    await persistRouterProject(ctx.dataDir, cwd).catch(() => undefined);
  }
  const migration =
    legacy.unreadable !== undefined && !legacy.present
      ? { state: 'blocked' as const, settingsPath: paths.settingsPath, reason: legacy.unreadable }
      : await migrateSettingsInstall(legacy, claude, {
          dataDir: ctx.dataDir,
          env,
          cwd,
          mcpScope: paths.mcpScope,
        });
  // A `tenjin mcp` that started before this install runs the old build until
  // its session reloads it. Named, never killed.
  const pending = settingsInstallStays(migration);
  const servers = await readMcpServers(deps, {
    settingsInstallPending: pending,
    ...(launch !== null ? { version: launch.version } : {}),
  });
  const serverLines =
    servers.stale > 0
      ? [paint(ctx.io, 'yellow', `! ${servers.check.detail}. ${servers.check.fix ?? ''}`.trim())]
      : [];
  const claudeCode = claudeCodeData(claude);
  const notices = refreshNotices(plugin, claude, migration, rt, home);
  if (args.refresh === true) {
    // A refresh that could not register the plugin is not a converged install,
    // unless the settings install it would replace still routes here.
    if (plugin.state === 'failed' && migration.state !== 'pending') {
      throw new CliError(
        'REFUSED',
        `The ${PLUGIN_ID} plugin could not be registered: ${plugin.reason ?? 'unknown reason'}.`,
        { fix: registrationFix(plugin), details: { plugin, claudeCode, migration } },
      );
    }
    return {
      data: {
        plugin,
        claudeCode,
        migration,
        notices,
        refresh: true,
        spend,
        removedSkills,
        scope,
        mcpServer: servers.check,
        runtime: runtimeData(rt),
        launcher: rt?.launcher ?? null,
      },
      humanLines: [
        ...refreshLines(ctx, plugin, claude, migration, rt, home),
        ...removedKeysLines,
        ...serverLines,
      ],
    };
  }
  // The shelf install's wallet step, unchanged except that it never asks: a
  // lookup cannot be paid without a wallet, so install makes one. A failure is
  // reported, never fatal; everything above is useful without it. It checks
  // that the wallet can SIGN (`verify`), and nothing about routing or funds:
  // install computes no routing eligibility, and its funding step below is
  // today's (S6). Loaded lazily: the status line shares this module's chunk
  // and must not load the wallet layer.
  const { resolveWallet } = await import('../commands/install-wallet');
  const wallet = await resolveWallet(ctx, deps, args.noWallet === true ? 'flag' : undefined, false);
  // Read back AFTER the write: a machine that already carried its own caps
  // keeps them, and a readout quoting the defaults would describe limits this
  // run did not set.
  const effective = await resolveContextSettings(ctx);
  const spendAsk = !canPrompt && !answered && unasked ? spendStep(args) : undefined;
  // A warning, never a failure: everything above is written and correct, and
  // the network this machine is on now may not be the one it uses later.
  const asksAgent = !canPrompt && underAgentHarness(env);
  const [router, fund] = await Promise.all([
    probeRouter(effective.baseUrl, {
      timeoutMs: ctx.flags.timeout,
      env,
      ...(deps.fetchImpl !== undefined ? { fetchImpl: deps.fetchImpl } : {}),
    }),
    // The spend question comes first, because its answer picks the install
    // command. The funding question rides on the install that follows it.
    asksAgent && spendAsk === undefined
      ? fundStep(wallet, effective.rpcUrl, deps)
      : Promise.resolve(undefined),
  ]);
  const nextSteps: QuestionStep[] = [
    ...(spendAsk !== undefined ? [spendAsk] : []),
    ...(fund !== undefined ? [fund] : []),
  ];

  const data = {
    plugin,
    claudeCode,
    migration,
    next: nextStep(
      plugin,
      claude,
      wallet,
      migration,
      asksAgent && nextSteps.length > 0,
      ctx.io.isTTY,
    ),
    nextSteps,
    // The check for this scope, said outright; a bare doctor in the project
    // also finds it from what the project holds.
    ...(project ? { doctor: 'tenjin doctor --project' } : {}),
    spend: { ...spend, effective: effectiveLimits(effective.policy) },
    wallet,
    router: {
      status: router.status === 'ok' ? 'ok' : 'warn',
      detail: router.detail,
      ...(router.fix !== undefined ? { fix: router.fix } : {}),
    },
    disclosure: DISCLOSURE,
    removedSkills,
    mcpServer: servers.check,
    runtime: runtimeData(rt),
    launcher: rt?.launcher ?? null,
  };
  return {
    data,
    humanLines: [
      ...lines(ctx, {
        plugin,
        claude,
        migration,
        wallet,
        ...(fund !== undefined ? { fund } : {}),
        asks: asksAgent && nextSteps.length > 0,
        policy: effective.policy,
        ...(spendAsk !== undefined ? { spendAsk } : {}),
        router,
        rt,
        home,
      }),
      ...removedKeysLines,
      ...serverLines,
    ],
  };
}

/** Loaded lazily: the status line shares this module's chunk and must not load the runtime. */
export async function defaultRuntime(o: Parameters<typeof setupRuntime>[0]): Promise<RuntimeSetup> {
  const { setupRuntime } = await import('../lib/runtime');
  return setupRuntime(o);
}

/** Results a later host of one install run got from the first host's setup: their lines were said there. */
const sharedResults = new WeakSet<RuntimeSetup>();

/**
 * ONE RUNTIME SETUP PER INSTALL RUN, however many hosts it installs. The first
 * host sets the runtime up; every later host gets that result rather than a
 * second setup, which would retry a failed Node download in full, and says
 * none of its lines again.
 */
export function runtimeOncePerRun(setup = defaultRuntime): typeof defaultRuntime {
  let first: Promise<RuntimeSetup> | undefined;
  return async (o) => {
    if (first === undefined) {
      first = setup(o);
      return first;
    }
    const rt = { ...(await first) };
    sharedResults.add(rt);
    return rt;
  };
}

/** Is there a runtime here? Only the default data dir has one, and only once an install set it up. */
export function hasRuntime(dataDir: string, home: string): boolean {
  return (
    resolve(dataDir) === resolve(defaultDataDir(home)) &&
    existsSync(runtimeStatePath(runtimeDir(dataDir)))
  );
}

/**
 * A refresh that brought only the runtime up to date, for a machine with no
 * Claude Code surface of Tenjin's: `plugin` is null, and the runtime's
 * sentences ride in `notices` for update's parent, as a full refresh's do.
 */
function runtimeOnlyRefresh(ctx: CommandContext, rt: RuntimeSetup, home: string): CommandResult {
  return {
    data: {
      plugin: null,
      refresh: true,
      scope: 'user',
      notices: runtimeNotices(rt, home),
      runtime: runtimeData(rt),
      launcher: rt.launcher,
    },
    humanLines: [
      `${paint(ctx.io, 'green', '✓')} Tenjin's runtime is up to date; no Claude Code plugin is registered here, so none was refreshed`,
      ...runtimeLines(ctx, rt, home),
    ],
  };
}

/**
 * GC of the runtime's unused versions: an optimisation that never holds
 * install up or fails it. The plugin folders in `folders` that are ours run a
 * runtime version and its Node by absolute path, which `state.json` does not
 * name, so those are kept.
 */
async function collectRuntime(root: string, folders: readonly string[]): Promise<void> {
  try {
    const { collect } = await import('../lib/runtime');
    await collect(root, { lockWaitMs: 5_000, keep: await folderPointers(root, folders) });
  } catch {
    // The next install collects them.
  }
}

/**
 * Every plugin folder an install wrote where it could run no `claude` binary:
 * the user's under the config dir, and each recorded project's (plus this
 * run's, for a `--project` run not recorded yet) under its `.claude/skills/`.
 */
async function fallbackFolders(
  dataDir: string,
  env: NodeJS.ProcessEnv,
  home: string,
  cwd: string,
  project: boolean,
): Promise<string[]> {
  const projects = (await loadRawConfig(dataDir).catch(() => null))?.install?.routerProjects ?? [];
  return [
    folderFor('user', env, home, cwd),
    ...[...projects, ...(project ? [cwd] : [])].map((dir) => folderFor('local', env, home, dir)),
  ];
}

/** A `node/<V>` folder name: digits and dots only, so a `..` can never pass. */
const NODE_DIR_RE = /^\d+\.\d+\.\d+$/;

/**
 * The runtime version and Node each folder that exists and is ours runs, read
 * from its `.mcp.json`: an entry under `<root>/versions/<cli>/` run by a Node
 * under `<root>/node/<V>/`. A folder run from a package, or unreadable, names
 * none.
 */
async function folderPointers(root: string, folders: readonly string[]): Promise<RuntimePointer[]> {
  const pointers: RuntimePointer[] = [];
  for (const dir of folders) {
    if ((await inspectPluginFolder(dir)) !== 'ours') continue;
    const server = await readFile(join(dir, '.mcp.json'), 'utf8')
      .then(
        (raw) =>
          (
            JSON.parse(raw) as {
              mcpServers?: Record<string, { command?: unknown; args?: unknown }>;
            }
          ).mcpServers?.[MCP_SERVER_NAME],
      )
      .catch(() => undefined);
    const entry = Array.isArray(server?.args) ? (server.args[0] as unknown) : undefined;
    const node = server?.command;
    if (typeof entry !== 'string' || typeof node !== 'string') continue;
    const build = runtimeBuild(dirname(entry));
    const nodeVersion = relative(join(root, 'node'), node).split(sep)[0] ?? '';
    if (build !== null && resolve(build.root) === resolve(root) && NODE_DIR_RE.test(nodeVersion)) {
      pointers.push({ cli: build.cli, node: nodeVersion });
    }
  }
  return pointers;
}

export function assertPluginDataDir(dataDir: string, home: string, env: NodeJS.ProcessEnv): void {
  if (env.TENJIN_DATA_DIR && resolve(dataDir) !== resolve(defaultDataDir(home))) {
    throw new CliError('REFUSED', 'Plugin installation needs the default data directory.', {
      fix: 'Run without TENJIN_DATA_DIR. Other CLI commands still support it.',
    });
  }
}

export function requireRuntime(rt: RuntimeSetup | null): void {
  if (rt === null || rt.state === 'skipped') return;
  if (
    rt.state === 'failed' ||
    (rt.state === 'kept' && rt.reason !== undefined && rt.newer !== true)
  ) {
    throw new CliError(
      'UPDATE_FAILED',
      `Tenjin could not finish installation: ${rt.reason ?? 'runtime setup failed'}. Your existing plugin registration was kept.`,
      {
        fix:
          rt.fix ??
          (rt.unpinned
            ? 'Use macOS, Windows or glibc Linux 2.28+ on x64/arm64.'
            : 'Check your connection and run tenjin install again.'),
      },
    );
  }
}

/** A verified runtime launch, or the explicit source-checkout development path. */
function runtimeLaunch(
  rt: RuntimeSetup | null,
): { version: string; hostsDir: string; cliEntry: string; node: string } | null {
  if (rt === null || (rt.state !== 'active' && rt.state !== 'current' && rt.state !== 'kept')) {
    return null;
  }
  if (
    rt.cli === undefined ||
    rt.hostsDir === undefined ||
    rt.entry === undefined ||
    rt.node === undefined
  ) {
    return null;
  }
  return { version: rt.cli, hostsDir: rt.hostsDir, cliEntry: rt.entry, node: rt.node };
}

export function runtimeData(rt: RuntimeSetup | null): Record<string, unknown> | null {
  if (rt === null) return null;
  return {
    state: rt.state,
    root: rt.root,
    ...(rt.cli !== undefined ? { cli: rt.cli } : {}),
    ...(rt.nodeVersion !== undefined ? { nodeVersion: rt.nodeVersion } : {}),
    ...(rt.reason !== undefined ? { reason: rt.reason } : {}),
    ...(rt.fix !== undefined ? { fix: rt.fix } : {}),
  };
}

/**
 * Adds to `install.routerProjects` every project install Claude Code records
 * that is still on disk and not yet there. An unreadable record adds nothing.
 */
async function recordClaudeProjects(
  dataDir: string,
  known: readonly string[],
  env: NodeJS.ProcessEnv,
  home: string,
): Promise<void> {
  const records = await recordedInstalls(env, home).catch(() => null);
  if (records === null || records.every((r) => r.projectPath === null)) return;
  const seen = new Set([
    ...known,
    ...(await Promise.all(known.map((dir) => realpath(dir).catch(() => dir)))),
  ]);
  for (const { projectPath } of records) {
    if (projectPath === null || seen.has(projectPath)) continue;
    if ((await stat(projectPath).catch(() => null))?.isDirectory() !== true) continue;
    seen.add(projectPath);
    await persistRouterProject(dataDir, projectPath).catch(() => undefined);
  }
}

/** `path` with the home folder written as `~`. */
export function tilde(path: string, home: string): string {
  return path === home || path.startsWith(`${home}${sep}`) ? `~${path.slice(home.length)}` : path;
}

/** The first activation's line, said once: where Tenjin runs from now. */
function runtimeSentence(rt: RuntimeSetup, home: string): string | null {
  if (rt.state !== 'active' || !rt.firstTime) return null;
  return `Runs from ${tilde(rt.root, home)} on its own Node ${rt.nodeVersion ?? ''}, so a Node upgrade or \`npm rm -g tenjin-cli\` no longer stops it.`;
}

/**
 * What the person needs to know about the `tenjin` launcher: only a file in
 * its place that is not Tenjin's, a write that failed, or a launcher folder
 * off PATH. npm's own link there (npm prefix `~/.local`) says nothing.
 */
function launcherSentence(launcher: LauncherResult | null, home: string): string | null {
  if (launcher === null) return null;
  if (launcher.state === 'foreign') {
    const who = launcher.reason?.replace(/ is not Tenjin's$/, '') ?? launcher.paths[0] ?? '';
    return `${who} is not Tenjin's, so it was left as it is, and \`tenjin\` there runs that file instead of Tenjin's runtime. Move it aside and run \`tenjin install\` again to put Tenjin's there.`;
  }
  if (launcher.state === 'failed') {
    const dir = launcher.paths[0] !== undefined ? tilde(dirname(launcher.paths[0]), home) : '';
    return `Tenjin's \`tenjin\` launcher could not be written to ${dir} (${launcher.reason ?? 'unknown reason'}), so a terminal finds \`tenjin\` only through npm's copy; run \`tenjin install\` again to retry.`;
  }
  if ((launcher.state === 'written' || launcher.state === 'current') && !launcher.onPath) {
    return `~/.local/bin is not on your PATH, so a terminal will not find \`tenjin\` once npm's copy is gone (inside Claude Code the plugin's own \`tenjin\` is on the Bash tool's PATH). Add it: ${launcher.pathLine ?? ''}`;
  }
  return null;
}

/** The runtime's lines under install's summary: where it runs from, or what needs the person. */
export function runtimeLines(ctx: CommandContext, rt: RuntimeSetup | null, home: string): string[] {
  if (rt === null || sharedResults.has(rt)) return [];
  const warn = (text: string) => paint(ctx.io, 'yellow', `! ${text}`);
  const runs = runtimeSentence(rt, home);
  const launcher = launcherSentence(rt.launcher, home);
  return [...(runs !== null ? [`  ${runs}`] : []), ...(launcher !== null ? [warn(launcher)] : [])];
}

function claudeCodeData(claude: ClaudeCodeState): Record<string, unknown> {
  return {
    binary: claude.binary?.path ?? null,
    source: claude.binary?.source ?? null,
    version: claude.version,
    meetsFloor: claude.meetsFloor,
    ...(claude.fix !== undefined ? { fix: claude.fix } : {}),
  };
}

/**
 * The fix for a registration that did not happen, worded as a step the agent
 * can take in the session: never a command for the person to run elsewhere.
 */
function registrationFix(plugin: PluginRegistration): string {
  // A project install is retried, and checked, as one.
  const flag = plugin.scope === 'local' ? ' --project' : '';
  if (plugin.id !== null && plugin.method === 'none') {
    return `${plugin.id} keeps serving this machine at the version Claude Code has; run \`tenjin install${flag}\` again to retry.`;
  }
  if (
    plugin.path !== undefined &&
    plugin.reason?.includes('not a folder this CLI wrote') === true
  ) {
    return `Move ${plugin.path} aside, then run \`tenjin install${flag}\` again.`;
  }
  return `Run \`tenjin doctor${flag}\` to see the cause, then run \`tenjin install${flag}\` again.`;
}

/** The unlock reasons `tenjin wallet repair` fixes: a saved passphrase that is gone or wrong. */
const REPAIRABLE: ReadonlySet<string> = new Set([
  'passphrase_missing',
  'passphrase_wrong',
  'env_passphrase_wrong',
]);

/**
 * The repair step, worded for whoever reads install's output (decision 15):
 * a person at a terminal runs it; an agent (no TTY) asks the person to, and
 * never asks for the passphrase (B1).
 */
function repairStep(tty: boolean): string {
  return tty
    ? `run \`tenjin wallet repair\` yourself ${REPAIR_CLAUSE}`
    : 'ask the person to run `tenjin wallet repair` in their own terminal (never ask for the passphrase)';
}

/**
 * The one step after the install, for the agent to relay in the session. A
 * wallet whose saved passphrase is gone or wrong is repaired first; otherwise
 * today's steps, unchanged (no new funding step for an existing wallet, S6).
 */
function nextStep(
  plugin: PluginRegistration,
  claude: ClaudeCodeState,
  wallet: WalletOutcome,
  migration: Migration,
  asksQuestion: boolean,
  tty: boolean,
): string {
  if (plugin.state === 'failed') return registrationFix(plugin);
  const steps = todaysSteps(plugin, claude, wallet, migration, asksQuestion);
  const signing = wallet.signing;
  if (signing?.status === 'blocked' && REPAIRABLE.has(signing.reason)) {
    steps.unshift(repairStep(tty));
  }
  return steps.join(', then ');
}

function todaysSteps(
  plugin: PluginRegistration,
  claude: ClaudeCodeState,
  wallet: WalletOutcome,
  migration: Migration,
  asksQuestion: boolean,
): string[] {
  const steps: string[] = [];
  if (asksQuestion) {
    steps.push('ask the person the question in nextSteps, then run what the answer names');
  } else if (wallet.status === 'created') {
    steps.push('fund the wallet with `tenjin wallet fund`');
  }
  if (plugin.state === 'deferred') {
    steps.unshift('run `claude update`');
    steps.push(
      'run `tenjin install` again; until then the earlier Tenjin setup keeps routing as before',
    );
    return steps;
  }
  if (!claude.meetsFloor) steps.unshift('run `claude update`');
  steps.push(loadStep(settingsInstallStays(migration)));
  return steps;
}

/** Is a settings install still on this machine after this run? */
function settingsInstallStays(migration: Migration): boolean {
  return migration.state === 'pending' || migration.state === 'blocked';
}

function deferredRegistration(scope: PluginScope, claude: ClaudeCodeState): PluginRegistration {
  return {
    method: 'none',
    id: null,
    scope,
    state: 'deferred',
    version: pkg.version,
    steps: [],
    reason: `Claude Code ${claude.version ?? ''} is older than ${CLAUDE_CODE_FLOOR}, which the plugin needs, so it was not registered and the earlier settings setup keeps routing`,
  };
}

/** The status line a migration took out, in words, or nothing. */
function statusLineNotice(migration: Migration): string | null {
  const status = migration.removed?.statusLine;
  if (status === 'removed') {
    return 'Removed the Tenjin status line (`tenjin status-line`) with the earlier settings setup; the plugin sets none. To keep it, set `tenjin status-line` as your Claude Code status line command.';
  }
  if (status === 'restored') {
    return 'Took the Tenjin footer out of your status line and put your own command back; the plugin sets none.';
  }
  return null;
}

/**
 * WHAT `tenjin update` PRINTS FROM THIS REFRESH. Update captures this run's
 * output and shows only its failures, so anything a person must know about a
 * refresh that succeeded rides here, as sentences the parent prints verbatim.
 */
function refreshNotices(
  plugin: PluginRegistration,
  claude: ClaudeCodeState,
  migration: Migration,
  rt: RuntimeSetup | null,
  home: string,
): string[] {
  const out: string[] = [];
  if (plugin.state === 'deferred') {
    out.push(
      `Claude Code ${claude.version ?? ''} is older than ${CLAUDE_CODE_FLOOR}, so the Tenjin plugin was not registered and the earlier settings setup keeps routing. Run \`claude update\`, then \`tenjin install\`.`,
    );
  } else if (plugin.state !== 'failed' && settingsInstallStays(migration)) {
    out.push(
      'Start a new Claude Code session so the Tenjin plugin loads; the earlier settings setup is removed by the next `tenjin update` or `tenjin install` after that.',
    );
  }
  const status = statusLineNotice(migration);
  if (status !== null) out.push(status);
  if (rt !== null) out.push(...runtimeNotices(rt, home));
  return out;
}

/** The runtime's sentences among a refresh's notices: where it runs from, and what needs the person. */
function runtimeNotices(rt: RuntimeSetup, home: string): string[] {
  const out: string[] = [];
  const runs = runtimeSentence(rt, home);
  if (runs !== null) out.push(`Tenjin ${runs.charAt(0).toLowerCase()}${runs.slice(1)}`);
  const launcher = launcherSentence(rt.launcher, home);
  if (launcher !== null) out.push(launcher);
  return out;
}

/** The one rule for every step the agent relays from install. */
export const SHOW_NOT_RUN =
  'Show the person addresses as written, and never ask them to run a command.';

/**
 * An agent runs install with `--json` or in a shell with no terminal, so the
 * CLI cannot ask. The agent can: this is what the selector would have shown
 * (the defaults, the routing fee) and what to run for each answer, the same
 * shape as the `request` tool's `needs_input` step. A script or CI ignores
 * it, and the defaults hold.
 */
function spendStep(args: RouterInstallArgs): QuestionStep {
  return spendStepFor(installCommand(args));
}

/** The same question, for an install an agent runs again as `command`. */
export function spendStepFor(command: string): QuestionStep {
  const options = spendOptions(command);
  const [byDefault, custom] = options as [SpendOption, SpendOption];
  return {
    id: 'spend',
    question: spendChoiceQuestion(),
    options,
    next: `In this session, ask the person this question with your question tool, offering these two options in order with the defaults marked recommended. The defaults are already in effect. Use the defaults: run \`${byDefault.command}\`. Set my own limits: ask for the most per day in USD (or none for no daily limit) and the most per call in USD (at least 0.25), then run \`${custom.command}\` with their amounts. Run the command alone, never joined with another command, and do not ask again a question its output repeats. ${SHOW_NOT_RUN}`,
  };
}

/** The install this run was: what an agent runs again for the person's answer. */
function installCommand(args: RouterInstallArgs): string {
  return [
    'tenjin install',
    ...(args.project === true ? ['--project'] : []),
    ...(args.noWallet === true ? ['--no-wallet'] : []),
  ].join(' ');
}

/** The limits the person named with `--max-auto-spend` and `--session-budget`, refused before any write. */
export function namedLimits(
  args: Pick<RouterInstallArgs, 'maxAutoSpend' | 'sessionBudget' | 'refresh'>,
): {
  limits: Partial<RouterLimits>;
  keys: (keyof RouterLimits)[];
} {
  const flags = [
    ['maxAutoSpend', '--max-auto-spend', args.maxAutoSpend, 'call'],
    ['sessionBudget', '--session-budget', args.sessionBudget, 'day'],
  ] as const;
  const limits: Partial<RouterLimits> = {};
  const keys: (keyof RouterLimits)[] = [];
  for (const [key, flag, raw, per] of flags) {
    if (raw === undefined) continue;
    if (args.refresh === true) {
      throw new CliError('USAGE', `${flag} sets a spend limit, and --refresh writes none.`, {
        fix: `Run \`tenjin install ${flag} ${raw}\` without --refresh.`,
      });
    }
    const parsed = parseLimit(raw, per);
    if ('refusal' in parsed) {
      throw new CliError('USAGE', `${flag} ${raw}: ${parsed.refusal}`, {
        fix:
          per === 'day'
            ? `Give a positive USD amount or none, for example \`${flag} 5\`.`
            : `Give 0.25 USD or more, for example \`${flag} 0.5\`. ${MAX_AUTO_SPEND_FLOOR_WHY}`,
      });
    }
    limits[key] = parsed.value;
    keys.push(key);
  }
  return { limits, keys };
}

/** The funding question an agent's completed install hands over: the checkout's $5 minimum. */
export const FUND_QUESTION = `Add $${SUGGESTED_FUND_USD} to Tenjin now?`;
/** Its yes: the agent runs this alone, in the turn the person answered. */
export const FUND_COMMAND = `tenjin wallet fund ${SUGGESTED_FUND_USD}`;

/** One question install hands to the agent that ran it, with what each answer runs. */
export interface QuestionStep {
  id: 'spend' | 'fund';
  /** For the agent to put to the person as written, with `options`. */
  question: string;
  options: {
    id: string;
    label: string;
    recommended: boolean;
    /** What to ask the person after they pick this option, before running `command`. */
    ask?: string[];
    /** The one command the agent runs alone for this answer, or null: run nothing. */
    command: string | null;
  }[];
  /** What the agent does with each answer. */
  next: string;
}

/** The funding question, keeping a transfer address available without making it the normal path. */
export interface FundStep extends QuestionStep {
  id: 'fund';
  address: string;
  /** What to tell the person when they choose to add funds later. */
  show: string;
}

/**
 * THE QUESTION BEFORE THE ACTION. Under an agent harness, install opens no
 * browser and pays nothing: once the spend answer has picked the install, the
 * install hands the agent the funding question, so the page opens only after
 * an answer the person gave in the session. It mints no link: a later yes
 * runs `tenjin wallet fund`. A wallet that
 * already holds USDC gets no question.
 */
async function fundStep(
  wallet: WalletOutcome,
  rpcUrl: string,
  deps: RouterInstallDeps,
): Promise<FundStep | undefined> {
  const address = wallet.address;
  if (address === undefined || (wallet.status !== 'created' && wallet.status !== 'existing')) {
    return undefined;
  }
  const funded =
    wallet.status === 'created'
      ? false
      : await (deps.walletBalance ?? defaultBalance)(address, rpcUrl).then(
          (atomic) => atomic > 0n,
          () => null,
        );
  if (funded === true) return undefined;
  const show =
    'You can ask your agent to add funds to Tenjin later. Paid tools need funds; your usual tools keep working.';
  return {
    id: 'fund',
    question: FUND_QUESTION,
    options: [
      {
        id: 'fund',
        label: `Add $${SUGGESTED_FUND_USD}`,
        recommended: false,
        command: FUND_COMMAND,
      },
      { id: 'later', label: 'Not now', recommended: false, command: null },
    ],
    next: `The install is done. Ask the person this question with your question tool. On "Add $${SUGGESTED_FUND_USD}", run \`${FUND_COMMAND}\` alone, in the same turn, then follow its nextStep. On "Not now", run nothing and show the person this for later: ${show} The address is an alternative only if they ask to transfer funds directly. Never run \`${FUND_COMMAND}\` without this yes. ${SHOW_NOT_RUN}`,
    address,
    show,
  };
}

/** Loaded lazily: the status line shares this module's chunk and must not load viem. */
async function defaultBalance(address: string, rpcUrl: string): Promise<bigint> {
  const { getUsdcBalance } = await import('../lib/usdc');
  return getUsdcBalance(address as `0x${string}`, rpcUrl);
}

/** The funding question, as the summary prints it. */
function fundLines(fund: FundStep): string[] {
  return [
    `  Ask the person: ${fund.question}`,
    `  Add $${SUGGESTED_FUND_USD}: ${FUND_COMMAND}`,
    `  Not now: run nothing, show them: ${fund.show}`,
  ];
}

/**
 * The one question install asks, before anything is written: the defaults, or
 * your own limits. It is asked only when the file names neither limit. The
 * question names the routing fee and its deposits too, and either answer
 * approves it. Cancelling at any step writes nothing.
 */
export async function approveLimits(
  deps: Pick<RouterInstallDeps, 'promptLimits' | 'promptAmount'>,
): Promise<RouterLimits> {
  const choice = await (deps.promptLimits ?? promptLimits)(
    `${SPEND_QUESTION}\n${ROUTING_FEE_TERMS}\n${FEE_APPROVAL}`,
  );
  if (choice === null) throw installCancelled();
  if (choice === 'approve') return { ...ROUTER_DEFAULTS };
  const ask = deps.promptAmount ?? promptAmount;
  const sessionBudget = await askLimit(
    ask,
    'Most it may pay in a day, in USD, or none',
    '5',
    'day',
  );
  const maxAutoSpend = await askLimit(
    ask,
    'Most it may pay for one call, in USD, at least 0.25',
    '0.25',
    'call',
  );
  return { maxAutoSpend, sessionBudget };
}

/** Asks until the answer is a positive amount (or `none` for the daily limit). */
async function askLimit(
  ask: NonNullable<RouterInstallDeps['promptAmount']>,
  question: string,
  placeholder: string,
  per: 'call' | 'day',
): Promise<string> {
  let message = question;
  for (;;) {
    const answer = await ask(message, placeholder);
    if (answer === null) throw installCancelled();
    const parsed = parseLimit(answer, per);
    if (!('refusal' in parsed)) return parsed.value;
    message = `${parsed.refusal} ${question}`;
  }
}

/** A daily limit is positive or `none`; zero is refused, because
 *  `router.enabled false` is how to turn the router off. A per-call limit is
 *  at least the $1 floor. */
function parseLimit(answer: string, per: 'call' | 'day'): { value: string } | { refusal: string } {
  const trimmed = answer.trim();
  if (per === 'day' && trimmed === 'none') return { value: 'none' };
  let atomic: string;
  try {
    atomic = parseUsdToAtomic(trimmed);
  } catch (err) {
    if (err instanceof CliError) return { refusal: `${err.message}.` };
    throw err;
  }
  if (per === 'call' && BigInt(atomic) < MAX_AUTO_SPEND_FLOOR_ATOMIC) {
    return { refusal: 'The per-call limit is at least $0.25.' };
  }
  if (atomic === '0') {
    return {
      refusal:
        'The limit must be more than zero; `tenjin config set router.enabled false` turns the router off.',
    };
  }
  return { value: atomic };
}

function installCancelled(): CliError {
  return new CliError('REFUSED', 'Install cancelled before anything was written.', {
    fix: 'Re-run `tenjin install` and choose the defaults or your own limits.',
  });
}

function promptLimits(message: string): Promise<LimitsChoice | null> {
  return selectOne<LimitsChoice>({
    message,
    choices: [
      { value: 'approve', label: 'Use the defaults' },
      { value: 'own', label: 'Set my own limits' },
    ],
    initialValue: 'approve',
  });
}

function promptAmount(message: string, placeholder: string): Promise<string | null> {
  return askText({ message, placeholder });
}

export interface EffectiveLimits {
  maxAutoSpend: string;
  sessionBudget: string;
}

export function effectiveLimits(policy: SpendPolicy): EffectiveLimits {
  return {
    maxAutoSpend: toMoney(policy.maxAutoSpendAtomic.toString()).usd,
    sessionBudget:
      policy.sessionBudgetAtomic === null
        ? 'no daily ceiling'
        : toMoney(policy.sessionBudgetAtomic.toString()).usd,
  };
}

/**
 * THE WALLET LINE, and who reads it. At a TTY a person ran install, so the
 * person's wording; without one an agent did, and relays it, so a blocked
 * wallet's fix and the S7 passphrase line take the agent's wording (B1,
 * decision 15): ask the person, never ask for the passphrase.
 *
 * A ✓ only for a wallet every Claude Code can unlock: a durable store, a
 * legacy entry, or a variable a served router has already signed with. A
 * wallet that signs only through a variable in this shell is a yellow `!`
 * (S7), as is one that cannot be unlocked, or could not be checked.
 */
function walletLines(ctx: CommandContext, ok: string, w: WalletOutcome): string[] {
  const warn = (text: string) => paint(ctx.io, 'yellow', text);
  if (w.status === 'created' || w.status === 'existing') {
    const a = w.address ?? '';
    const signing = w.signing;
    const tty = ctx.io.isTTY;
    if (signing?.status === 'blocked') {
      const wallet = Object.prototype.hasOwnProperty.call(WALLET_REASONS, signing.reason)
        ? WALLET_REASONS[signing.reason as keyof typeof WALLET_REASONS]
        : undefined;
      return [
        warn(`! Wallet ${a} cannot be unlocked by Claude Code: ${signing.detail}.`),
        `  ${tty ? (wallet?.fix ?? signing.fix) : agentFixFor(signing.reason, signing.fix)}`,
      ];
    }
    if (signing?.status === 'unknown') {
      return [
        warn(`! Wallet: ${a}; could not check that it unlocks (${signing.detail}).`),
        '  Run `tenjin doctor` to check it again.',
      ];
    }
    if (w.shellOnly === 'key') {
      return [
        warn(
          `! Wallet: ${a} signs here only through TENJIN_WALLET_KEY in this shell; Claude Code must have the same variable.`,
        ),
      ];
    }
    if (w.shellOnly === 'passphrase') {
      return [
        warn(
          tty
            ? `! Wallet: ${a} unlocks here only through TENJIN_WALLET_PASSPHRASE in this shell; Claude Code must have the same variable, or run \`tenjin wallet repair\` yourself to store the passphrase ${REPAIR_CLAUSE}.`
            : `! Wallet: ${a} unlocks here only through TENJIN_WALLET_PASSPHRASE in this shell; Claude Code must have the same variable, or ask the person to run \`tenjin wallet repair\` in their own terminal to store the passphrase. Never ask for the passphrase.`,
        ),
      ];
    }
    if (w.status === 'created') {
      return [
        `${ok} Wallet created: ${a}`,
        ...(w.passphrase !== undefined ? [`  ${w.passphrase.note}`] : []),
      ];
    }
    return [`${ok} Wallet: ${a}`];
  }
  if (w.reason === 'flag') return ['  No wallet yet. Create one with: tenjin wallet create'];
  return [
    paint(ctx.io, 'yellow', `! No wallet was created. ${w.warning ?? ''}`.trimEnd()),
    `  ${w.fix ?? 'Create one with: tenjin wallet create'}`,
  ];
}

/** The plugin line: what Claude Code will list, or why nothing is registered. */
function pluginLines(ctx: CommandContext, plugin: PluginRegistration): string[] {
  const warn = (text: string) => paint(ctx.io, 'yellow', `! ${text}`);
  if (plugin.state === 'deferred') return [warn(`${plugin.reason ?? ''}`)];
  if (plugin.state === 'failed') {
    return [warn(`The Tenjin plugin was not registered: ${plugin.reason ?? 'unknown reason'}`)];
  }
  if (plugin.method === 'skills-dir') {
    return [
      `  Plugin ${plugin.id ?? ''} written to ${plugin.path ?? ''} (${plugin.fallbackReason ?? ''})`,
    ];
  }
  return [];
}

/** The settings install's line, when there is one. */
function migrationLines(ctx: CommandContext, migration: Migration): string[] {
  const warn = (text: string) => paint(ctx.io, 'yellow', `! ${text}`);
  if (migration.state === 'pending') {
    return [
      `  The settings install in ${migration.settingsPath} stays until the plugin has loaded (${migration.reason ?? ''}); \`tenjin update\` or \`tenjin install\` removes it then.`,
    ];
  }
  if (migration.state === 'blocked') {
    return [warn(`${migration.settingsPath} could not be read: ${migration.reason ?? ''}`)];
  }
  if (migration.state === 'done') {
    const removed = migration.removed;
    const status = statusLineNotice(migration);
    return [
      `  Removed the earlier settings setup from ${migration.settingsPath}: the plugin carries its hooks, permissions and server`,
      ...(status !== null ? [`  ${status}`] : []),
      ...(removed?.warnings ?? []).map((w) => warn(w)),
    ];
  }
  return [];
}

function claudeLines(ctx: CommandContext, claude: ClaudeCodeState): string[] {
  if (claude.meetsFloor) return [];
  return [
    paint(
      ctx.io,
      'yellow',
      `! Claude Code ${claude.version ?? ''} is older than the plugin needs. ${claude.fix ?? ''}`.trim(),
    ),
  ];
}

/**
 * A few lines a first-time user can read at a glance: it worked, here is your
 * wallet, here is the one thing to do next. Paths, steps and data-handling
 * detail stay in `--json` and the docs; the terminal only grows a line when
 * something needs the user.
 */
function lines(
  ctx: CommandContext,
  s: {
    plugin: PluginRegistration;
    claude: ClaudeCodeState;
    migration: Migration;
    wallet: WalletOutcome;
    fund?: FundStep;
    asks: boolean;
    policy: SpendPolicy;
    spendAsk?: QuestionStep;
    router: RouterCheck;
    rt: RuntimeSetup | null;
    home: string;
  },
): string[] {
  const ok = paint(ctx.io, 'green', '✓');
  const warn = (text: string) => paint(ctx.io, 'yellow', `! ${text}`);
  const limits = effectiveLimits(s.policy);
  const daily =
    s.policy.sessionBudgetAtomic === null ? 'no daily limit' : `$${limits.sessionBudget} a day`;
  const spend = [
    `  Automatic router: up to $${limits.maxAutoSpend} per call; daily limit ${daily}`,
    ...(s.spendAsk !== undefined
      ? [
          `  Ask the person in this session: ${s.spendAsk.question}`,
          ...s.spendAsk.options.map(
            (o) => `  ${o.label}${o.recommended ? ' (recommended)' : ''}: ${o.command}`,
          ),
        ]
      : []),
  ];
  const router =
    s.router.status === 'ok'
      ? []
      : [
          warn(`The router did not answer: ${s.router.detail}`),
          ...(s.router.fix !== undefined ? [`  ${s.router.fix}`] : []),
        ];
  return [
    s.plugin.state === 'failed'
      ? warn('Tenjin could not finish setting up Claude Code')
      : s.plugin.state === 'deferred'
        ? warn('Tenjin keeps its earlier Claude Code setup until Claude Code is updated')
        : `${ok} Tenjin is set up for Claude Code (plugin ${s.plugin.id ?? PLUGIN_ID})`,
    ...(s.plugin.scope === 'local' && s.plugin.state !== 'failed'
      ? ['  For this project only; check it with: tenjin doctor --project']
      : []),
    ...runtimeLines(ctx, s.rt, s.home),
    ...walletLines(ctx, ok, s.wallet),
    ...spend,
    ...(s.fund !== undefined ? fundLines(s.fund) : []),
    ...pluginLines(ctx, s.plugin),
    ...claudeLines(ctx, s.claude),
    ...migrationLines(ctx, s.migration),
    ...router,
    '',
    `Next: ${nextStep(s.plugin, s.claude, s.wallet, s.migration, s.asks, ctx.io.isTTY)}`,
  ];
}

/** "Up to date" only when nothing below it needs the user. */
function refreshLines(
  ctx: CommandContext,
  plugin: PluginRegistration,
  claude: ClaudeCodeState,
  migration: Migration,
  rt: RuntimeSetup | null,
  home: string,
): string[] {
  const issues = [
    ...runtimeLines(ctx, rt, home),
    ...pluginLines(ctx, plugin),
    ...claudeLines(ctx, claude),
    ...migrationLines(ctx, migration),
  ];
  const head =
    plugin.state === 'failed'
      ? paint(ctx.io, 'yellow', '! Tenjin is updated, but its plugin was not registered')
      : plugin.state === 'deferred'
        ? paint(ctx.io, 'yellow', '! Tenjin is updated; its plugin waits for a newer Claude Code')
        : `${paint(ctx.io, 'green', '✓')} Tenjin is up to date (plugin ${plugin.id ?? PLUGIN_ID})`;
  return [head, ...issues];
}
