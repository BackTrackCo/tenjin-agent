import { readFile, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import pkg from '../../package.json';
import {
  persistRouterDefaults,
  persistRouterProject,
  ROUTER_DEFAULTS,
  type RouterLimits,
} from '../commands/config';
import { askText, selectOne } from '../lib/clack';
import { CliError } from '../lib/errors';
import { parseUsdToAtomic, toMoney } from '../lib/money';
import { paint } from '../lib/output';
import { resolveContextSettings } from '../lib/settings';
import type { SpendPolicy } from '../lib/policy';
import { removeRetiredSkills } from '../lib/skill-placement';
import { loadRawConfig, type PartialConfig } from '../lib/config';
import type { WalletDeps, WalletOutcome } from '../commands/install-wallet';
import type { CommandContext, CommandResult } from '../context';
import { readAliveStamp } from './alive';
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
import { PLUGIN_ID } from './names';
import { CLAUDE_CODE_FLOOR } from './claude-cli';
import {
  folderState,
  readPluginListing,
  registerPlugin,
  type PluginRegistration,
  type PluginScope,
} from './plugin-registration';
import { probeRouter, type RouterCheck } from './reachability';
import { readMcpServers, type InstalledAt, type ListMcpProcesses } from './mcp-processes';
import {
  FEE_APPROVAL,
  limitsUsd,
  OWN_LIMITS_COMMANDS,
  ROUTING_FEE_TERMS,
  shownLimits,
  spendQuestion,
} from './spend-question';

/**
 * `tenjin install` for the router product: the wallet, the spend limits, and
 * the Claude Code plugin `tenjin`, registered with no step left to the person.
 *
 * WHAT IT WRITES. The wallet and the spend defaults under the data dir, as
 * before. The plugin is registered through Claude Code's own `claude plugin`
 * commands from this package's `dist/hosts/claude` folder (see
 * `plugin-registration.ts`), or written as a folder under the config dir's
 * `skills/` where no `claude` binary can be run. The plugin carries the seven
 * routing legs, the `router` MCP server, and the hooks that allow the request
 * tool and deny the legs' own tool to the model, so this command writes
 * nothing into `settings.json` or `~/.claude.json` itself.
 *
 * NO STEP IS LEFT TO THE PERSON. An agent runs this in the person's session:
 * the spend question comes back for the agent to ask there, the `claude`
 * binary is found through `CLAUDE_CODE_EXECPATH` where PATH lacks it, a failed
 * plugin command falls back to the folder, and the one step after it is
 * typing `/reload-plugins` in the same session, or starting the next one.
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

/** What the person does after a successful install, in the session they are in. */
export const RELOAD_STEP =
  'type /reload-plugins in this Claude Code session, or start a new session, so Tenjin loads';
/**
 * The same step while a settings install is still here: only a new session.
 * `/reload-plugins` would load the plugin beside the pre-upgrade `x402` server
 * that session is still running, and every event would route twice.
 */
export const NEW_SESSION_STEP = 'start a new Claude Code session so Tenjin loads';

/** The step that loads the plugin, given whether a settings install is still here. */
export function loadStep(settingsInstallPresent: boolean): string {
  return settingsInstallPresent ? NEW_SESSION_STEP : RELOAD_STEP;
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
   * or a settings install the plugin then replaces, with no config write. A
   * refusal when nothing of ours is here. `tenjin update` spawns exactly this
   * after it swaps the binary, so the flag's name and meaning are a
   * compatibility contract.
   */
  refresh?: boolean;
  /**
   * Accept the limits the question shows instead of asking: the selector's
   * "Use these limits", for an agent running the user's yes.
   */
  yes?: boolean;
  /** Create no wallet, for CI and scripted machines. */
  noWallet?: boolean;
}

export interface RouterInstallDeps extends WalletDeps {
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
  /** Whether a person can answer the spend-limit question (a TTY on stdout and
   *  stdin, no `--json`); injected in tests. */
  isInteractive?: boolean;
  /** The spend-limit selector; defaults to the clack list. */
  promptLimits?: (message: string) => Promise<LimitsChoice | null>;
  /** One amount question; defaults to the clack text input. */
  promptAmount?: (message: string, placeholder: string) => Promise<string | null>;
  /** The router reachability probe's transport; tests inject it. */
  fetchImpl?: typeof fetch;
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
  const config = await loadRawConfig(ctx.dataDir); // Validate before any install writes; retired keys remain readable.
  const cwd = deps.cwd ?? process.cwd();
  // An explicit --project wins, including for a project rooted at home.
  const project =
    args.project ?? (args.refresh === true && (await projectInstallHere(cwd, home, env)));
  const scope: PluginScope = project ? 'local' : 'user';
  const claude = await readClaudeCode(env, cwd, deps.findClaude ?? findClaudeBinary);
  const paths = settingsInstallPaths(project, env, home, cwd);
  const legacy = await inspectLegacyInstall(paths.settingsPath, paths.mcpFile);

  if (args.refresh === true && !(await somethingToRefresh(claude, scope, legacy, env, home, cwd))) {
    throw new CliError(
      'REFUSED',
      `Nothing to refresh: neither the ${PLUGIN_ID} plugin nor a settings install of Tenjin is registered here.`,
      { fix: 'Run `tenjin install` to set this machine up.' },
    );
  }
  // The shelf install's gate: a refresh, `--json`, or a run with no terminal on
  // either side asks nothing. An agent's install is that run: its shell has no
  // terminal. Install then writes no spend limit at all, the same state a
  // person cancelling at the selector leaves, and its output hands the question
  // to whoever ran it (see {@link spendApproval}). Until someone answers, the
  // bare CLI's zero holds and doctor reports the question as pending.
  const humanOutput = ctx.flags.json === true ? false : (deps.isInteractive ?? ctx.io.isTTY);
  const canPrompt = humanOutput && (deps.isInteractive ?? Boolean(process.stdin.isTTY));
  // `--yes` is the selector's "Use these limits", answered ahead: the same
  // install, run again by an agent for the user's yes.
  const limits =
    args.refresh === true
      ? undefined
      : args.yes === true
        ? shownLimits(config)
        : canPrompt
          ? await approveLimits(config, deps)
          : {};
  const spend = await persistRouterDefaults(ctx.dataDir, args.refresh === true, limits);
  const removedKeysLines =
    spend.removed.length > 0
      ? [
          `Removed retired settings: ${spend.removed.join(', ')}. Automatic router limits remain in effect; manual pay always requires consent.`,
        ]
      : [];
  const removedSkills = await removeRetiredSkills(home, project ? cwd : undefined);
  // BELOW THE FLOOR, A WORKING SETTINGS INSTALL WINS. The plugin's routing
  // legs need Claude Code 2.1.287, but its `alive` leg is a command that runs
  // on any version and would silence the settings install in every session,
  // leaving the machine unrouted. So nothing is registered until `claude
  // update`, and the settings install keeps routing.
  const plugin: PluginRegistration =
    !claude.meetsFloor && legacy.present
      ? deferredRegistration(scope, claude)
      : await registerPlugin({
          binary: claude.binary,
          scope,
          version: pkg.version,
          env,
          home,
          cwd,
          ...(deps.hostsDir !== undefined ? { hostsDir: deps.hostsDir } : {}),
        });
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
  const servers = await readMcpServers(deps, { settingsInstallPending: pending });
  const serverLines =
    servers.stale > 0
      ? [paint(ctx.io, 'yellow', `! ${servers.check.detail}. ${servers.check.fix ?? ''}`.trim())]
      : [];
  const claudeCode = claudeCodeData(claude);
  const notices = refreshNotices(plugin, claude, migration);
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
      },
      humanLines: [
        ...refreshLines(ctx, plugin, claude, migration),
        ...removedKeysLines,
        ...serverLines,
      ],
    };
  }
  // The shelf install's wallet step, unchanged except that it never asks: a
  // lookup cannot be paid without a wallet, so install makes one. A failure is
  // reported, never fatal; everything above is useful without it.
  const { resolveWallet } = await import('../commands/install-wallet');
  const wallet = await resolveWallet(ctx, deps, args.noWallet === true ? 'flag' : undefined, false);
  // Read back AFTER the write: a machine that already carried its own caps
  // keeps them, and a readout quoting the defaults would describe limits this
  // run did not set.
  const effective = await resolveContextSettings(ctx);
  const approval =
    !canPrompt && args.yes !== true && !spend.kept.includes('maxAutoSpend')
      ? spendApproval(config, args)
      : undefined;
  // A warning, never a failure: everything above is written and correct, and
  // the network this machine is on now may not be the one it uses later.
  const router = await probeRouter(effective.baseUrl, {
    timeoutMs: ctx.flags.timeout,
    env,
    ...(deps.fetchImpl !== undefined ? { fetchImpl: deps.fetchImpl } : {}),
  });

  const data = {
    plugin,
    claudeCode,
    migration,
    next: nextStep(plugin, claude, wallet, migration),
    // The check for this scope, said outright; a bare doctor in the project
    // also finds it from what the project holds.
    ...(project ? { doctor: 'tenjin doctor --project' } : {}),
    spend: {
      ...spend,
      effective: effectiveLimits(effective.policy),
      ...(approval !== undefined ? { approval } : {}),
    },
    wallet,
    router: {
      status: router.status === 'ok' ? 'ok' : 'warn',
      detail: router.detail,
      ...(router.fix !== undefined ? { fix: router.fix } : {}),
    },
    disclosure: DISCLOSURE,
    removedSkills,
    mcpServer: servers.check,
  };
  return {
    data,
    humanLines: [
      ...lines(ctx, {
        plugin,
        claude,
        migration,
        wallet,
        policy: effective.policy,
        ...(approval !== undefined ? { approval } : {}),
        router,
      }),
      ...removedKeysLines,
      ...serverLines,
    ],
  };
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

/** The one step after the install, for the agent to relay in the session. */
function nextStep(
  plugin: PluginRegistration,
  claude: ClaudeCodeState,
  wallet: WalletOutcome,
  migration: Migration,
): string {
  if (plugin.state === 'failed') return registrationFix(plugin);
  const steps: string[] = [];
  if (wallet.status === 'created') steps.push('fund the wallet with `tenjin wallet fund`');
  if (plugin.state === 'deferred') {
    steps.unshift('run `claude update`');
    steps.push(
      'run `tenjin install` again; until then the earlier Tenjin setup keeps routing as before',
    );
    return steps.join(', then ');
  }
  if (!claude.meetsFloor) steps.unshift('run `claude update`');
  steps.push(loadStep(settingsInstallStays(migration)));
  return steps.join(', then ');
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
  return out;
}

/** What turns automatic payment on after an install that left it at zero. */
const AUTO_SPEND_FIX = `tenjin config set maxAutoSpend ${toMoney(ROUTER_DEFAULTS.maxAutoSpend).usd}`;
const DECLINED =
  'the router then pays for nothing on its own, and the question stays open until the user answers it';

/** The spend question an install that could not ask hands to its caller. */
export interface SpendApproval {
  /** For the agent to put to the user as written: the limits and the routing fee. */
  question: string;
  /** The limits the question shows, in USD, as the selector shows them. */
  limits: { maxAutoSpend: string; sessionBudget: string };
  /** The routing fee's terms, which a yes also approves. */
  routingFee: string;
  /** What the agent does with each answer. */
  next: string;
  /** The one command for a yes: this install again with `--yes`, as the selector's "Use these limits". */
  approve: string;
  /** The commands for limits of the user's own. */
  own: string;
}

/**
 * An agent runs install with `--json` or in a shell with no terminal, so the
 * CLI cannot ask. The agent can: this is what the selector would have shown
 * (the limits and the routing fee) and what to run for each answer, the same
 * shape as the `request` tool's `needs_input` step. A script or CI ignores
 * it, and the zero holds.
 */
function spendApproval(config: PartialConfig, args: RouterInstallArgs): SpendApproval {
  return spendApprovalFor(config, yesCommand(args));
}

/** The same question, for an install whose yes is `approve`. */
export function spendApprovalFor(config: PartialConfig, approve: string): SpendApproval {
  const limits = shownLimits(config);
  return {
    question: spendQuestion(limits),
    limits: limitsUsd(limits),
    routingFee: ROUTING_FEE_TERMS,
    next: `In this session, show the user these limits and ask this question before you change any limit. If they say yes, run the same install again with --yes: \`${approve}\`. If they give other amounts, run ${OWN_LIMITS_COMMANDS}. If they say no, run nothing: ${DECLINED}.`,
    approve,
    own: OWN_LIMITS_COMMANDS.replaceAll('`', ''),
  };
}

/** The install this run was, with `--yes`: what an agent runs for the user's yes. */
function yesCommand(args: RouterInstallArgs): string {
  return [
    'tenjin install',
    ...(args.project === true ? ['--project'] : []),
    ...(args.noWallet === true ? ['--no-wallet'] : []),
    '--yes',
  ].join(' ');
}

/**
 * The one question install asks, before anything is written: approve the
 * automatic spend limits or set your own. Only a key the file does not already
 * name is asked for, because the write fills absent keys and keeps the rest.
 * The question names the routing fee and its deposits too, and either answer
 * approves it. Cancelling at any step writes nothing.
 */
export async function approveLimits(
  config: PartialConfig,
  deps: Pick<RouterInstallDeps, 'promptLimits' | 'promptAmount'>,
): Promise<RouterLimits | undefined> {
  const shown = shownLimits(config);
  const askCall = config.maxAutoSpend === undefined;
  const askDay = config.sessionBudget === undefined;
  if (!askCall && !askDay) return undefined;
  const daily =
    shown.sessionBudget === 'none'
      ? 'no daily limit'
      : `$${toMoney(shown.sessionBudget).usd} a day`;
  const fee = `\n${ROUTING_FEE_TERMS}\n${FEE_APPROVAL}`;
  const choice = await (deps.promptLimits ?? promptLimits)(
    `The router pays for tool calls without asking, up to:\n  $${toMoney(shown.maxAutoSpend).usd} a call, ${daily}${fee}`,
  );
  if (choice === null) throw installCancelled();
  if (choice === 'approve') return shown;
  const ask = deps.promptAmount ?? promptAmount;
  return {
    maxAutoSpend: askCall
      ? await askLimit(ask, 'Most the router may pay for one call, in USD', '0.25', false)
      : shown.maxAutoSpend,
    sessionBudget: askDay
      ? await askLimit(ask, 'Most it may pay in a day, in USD, or none', '5', true)
      : shown.sessionBudget,
  };
}

/** Asks until the answer is a positive amount (or `none` for the daily limit). */
async function askLimit(
  ask: NonNullable<RouterInstallDeps['promptAmount']>,
  question: string,
  placeholder: string,
  allowNone: boolean,
): Promise<string> {
  let message = question;
  for (;;) {
    const answer = await ask(message, placeholder);
    if (answer === null) throw installCancelled();
    const parsed = parseLimit(answer, allowNone);
    if (!('refusal' in parsed)) return parsed.value;
    message = `${parsed.refusal} ${question}`;
  }
}

/** Zero is refused: a zero per-call limit means the router can never pay, and
 *  `router.enabled false` is how to turn it off. */
function parseLimit(answer: string, allowNone: boolean): { value: string } | { refusal: string } {
  const trimmed = answer.trim();
  if (allowNone && trimmed === 'none') return { value: 'none' };
  let atomic: string;
  try {
    atomic = parseUsdToAtomic(trimmed);
  } catch (err) {
    if (err instanceof CliError) return { refusal: `${err.message}.` };
    throw err;
  }
  if (atomic === '0') return { refusal: 'The limit must be more than zero.' };
  return { value: atomic };
}

function installCancelled(): CliError {
  return new CliError('REFUSED', 'Install cancelled before anything was written.', {
    fix: 'Re-run `tenjin install` and choose the spend limits.',
  });
}

function promptLimits(message: string): Promise<LimitsChoice | null> {
  return selectOne<LimitsChoice>({
    message,
    choices: [
      { value: 'approve', label: 'Use these limits' },
      { value: 'own', label: 'Choose my own' },
    ],
    initialValue: 'approve',
  });
}

function promptAmount(message: string, placeholder: string): Promise<string | null> {
  return askText({ message, placeholder });
}

interface EffectiveLimits {
  maxAutoSpend: string;
  sessionBudget: string;
}

function effectiveLimits(policy: SpendPolicy): EffectiveLimits {
  return {
    maxAutoSpend: toMoney(policy.maxAutoSpendAtomic.toString()).usd,
    sessionBudget:
      policy.sessionBudgetAtomic === null
        ? 'no daily ceiling'
        : toMoney(policy.sessionBudgetAtomic.toString()).usd,
  };
}

function walletLines(ctx: CommandContext, ok: string, w: WalletOutcome): string[] {
  if (w.status === 'created') return [`${ok} Wallet created: ${w.address}`];
  if (w.status === 'existing') return [`${ok} Wallet: ${w.address}`];
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
    policy: SpendPolicy;
    approval?: SpendApproval;
    router: RouterCheck;
  },
): string[] {
  const ok = paint(ctx.io, 'green', '✓');
  const warn = (text: string) => paint(ctx.io, 'yellow', `! ${text}`);
  const limits = effectiveLimits(s.policy);
  const daily =
    s.policy.sessionBudgetAtomic === null ? 'no daily limit' : `$${limits.sessionBudget} a day`;
  const spend =
    s.approval !== undefined
      ? [
          warn('Automatic payments are off until the user approves a spend limit'),
          `  Ask the user in this session: ${s.approval.question}`,
          `  Yes: ${s.approval.approve}`,
          `  Other amounts: ${s.approval.own}`,
          `  No: run nothing, ${DECLINED.replaceAll('`', '')}`,
        ]
      : s.policy.maxAutoSpendAtomic === 0n
        ? [
            warn('Automatic payments are off: every paid lookup needs your approval'),
            `  To let the router pay without asking, run: ${AUTO_SPEND_FIX}`,
          ]
        : [`  Automatic router: up to $${limits.maxAutoSpend} per call; daily limit ${daily}`];
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
    ...walletLines(ctx, ok, s.wallet),
    ...spend,
    ...pluginLines(ctx, s.plugin),
    ...claudeLines(ctx, s.claude),
    ...migrationLines(ctx, s.migration),
    ...router,
    '',
    `Next: ${nextStep(s.plugin, s.claude, s.wallet, s.migration)}`,
  ];
}

/** "Up to date" only when nothing below it needs the user. */
function refreshLines(
  ctx: CommandContext,
  plugin: PluginRegistration,
  claude: ClaudeCodeState,
  migration: Migration,
): string[] {
  const issues = [
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
