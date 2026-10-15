import { readFile, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import pkg from '../../package.json';
import { persistRouterDefaults, ROUTER_DEFAULTS, type RouterLimits } from '../commands/config';
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
  ROUTING_FEE_TERMS,
  shownLimits,
  spendChoiceQuestion,
  spendOptions,
  type SpendOption,
} from './spend-question';
import { underAgentHarness } from '../lib/session';
import { getUsdcBalance } from '../lib/usdc';

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
 * the spend and funding questions come back for the agent to ask there, the `claude`
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
  /**
   * `--max-auto-spend` and `--session-budget`: the person's own limits, in USD
   * as typed (`none` for no daily limit). Either one answers the question; the
   * other then takes the limit the question shows. A named limit replaces what
   * the config file holds.
   */
  maxAutoSpend?: string;
  sessionBudget?: string;
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
  /** Mints the wallet's fund link; production signs the request with the wallet key. */
  fundLink?: (ctx: CommandContext, address: string) => Promise<string>;
  /** The wallet's USDC balance in atomic units; production reads Base. */
  walletBalance?: (address: string, rpcUrl: string) => Promise<bigint>;
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
 * `tenjin update` runs the refresh from home, where nothing proves scope. A
 * project install is taken when this directory, not being home, holds one:
 * the plugin enabled in its `settings.local.json`, its plugin folder, or a
 * settings install's entries.
 */
async function inferRefreshProject(
  cwd: string,
  home: string,
  env: NodeJS.ProcessEnv,
): Promise<boolean> {
  const [cwdPath, homePath] = await Promise.all([
    realpath(cwd).catch(() => cwd),
    realpath(home).catch(() => home),
  ]);
  if (cwdPath === homePath) return false;
  const local = await readFile(join(cwd, '.claude', 'settings.local.json'), 'utf8')
    .then((raw) => JSON.parse(raw) as { enabledPlugins?: Record<string, unknown> })
    .catch(() => null);
  if (local?.enabledPlugins?.[PLUGIN_ID] === true) return true;
  if ((await folderState('local', env, home, cwd)).state === 'ours') return true;
  const paths = settingsInstallPaths(true, env, home, cwd);
  return (await inspectLegacyInstall(paths.settingsPath, paths.mcpFile)).events.length > 0;
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
  const named = namedLimits(args);
  const cwd = deps.cwd ?? process.cwd();
  // An explicit --project wins, including for a project rooted at home.
  const project =
    args.project ?? (args.refresh === true && (await inferRefreshProject(cwd, home, env)));
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
  // `--yes` is the selector's "Use these limits", answered ahead, and the two
  // amount flags its "Choose my own": the same install, run again by an agent
  // for the person's answer.
  const answered = args.yes === true || named.keys.length > 0;
  const limits =
    args.refresh === true
      ? undefined
      : named.keys.length > 0
        ? { ...shownLimits(config), ...named.limits }
        : args.yes === true
          ? shownLimits(config)
          : canPrompt
            ? await approveLimits(config, deps)
            : {};
  const spend = await persistRouterDefaults(ctx.dataDir, args.refresh === true, limits, named.keys);
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
    !canPrompt && !answered && !spend.kept.includes('maxAutoSpend')
      ? spendApproval(config, args)
      : undefined;
  // A warning, never a failure: everything above is written and correct, and
  // the network this machine is on now may not be the one it uses later.
  const [router, fund] = await Promise.all([
    probeRouter(effective.baseUrl, {
      timeoutMs: ctx.flags.timeout,
      env,
      ...(deps.fetchImpl !== undefined ? { fetchImpl: deps.fetchImpl } : {}),
    }),
    // An agent's install hands the person two questions; a person's own
    // terminal gets what it always got.
    !canPrompt && underAgentHarness(env)
      ? fundStep(ctx, wallet, effective.rpcUrl, deps)
      : Promise.resolve(undefined),
  ]);
  const nextSteps: QuestionStep[] = [
    ...(approval !== undefined ? [spendStep(approval)] : []),
    ...(fund !== undefined ? [fund] : []),
  ];

  const data = {
    plugin,
    claudeCode,
    migration,
    next: nextStep(plugin, claude, wallet, migration, fund !== undefined),
    nextSteps,
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
        ...(fund !== undefined ? { fund } : {}),
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
  if (plugin.id !== null && plugin.method === 'none') {
    return `${plugin.id} keeps serving this machine at the version Claude Code has; run \`tenjin install\` again to retry.`;
  }
  if (
    plugin.path !== undefined &&
    plugin.reason?.includes('not a folder this CLI wrote') === true
  ) {
    return `Move ${plugin.path} aside, then run \`tenjin install\` again.`;
  }
  return 'Run `tenjin doctor` to see the cause, then run `tenjin install` again.';
}

/** The one step after the install, for the agent to relay in the session. */
function nextStep(
  plugin: PluginRegistration,
  claude: ClaudeCodeState,
  wallet: WalletOutcome,
  migration: Migration,
  asksFunding: boolean,
): string {
  if (plugin.state === 'failed') return registrationFix(plugin);
  const steps: string[] = [];
  if (asksFunding) {
    steps.push(
      'ask the person the questions in nextSteps, in order, then run what each answer names',
    );
  } else if (wallet.status === 'created') {
    steps.push('fund the wallet with `tenjin wallet fund`');
  }
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
  /** For the agent to put to the person as written, with {@link options}. */
  question: string;
  /** The answers to offer, in order, each with the one command that applies it. */
  options: SpendOption[];
  /** The limits the default shows, in USD, as the selector shows them. */
  limits: { maxAutoSpend: string; sessionBudget: string };
  /** The routing fee's terms, which the default and custom limits also approve. */
  routingFee: string;
  /** What the agent does with each answer. */
  next: string;
  /** The default's command: this install again with `--yes`, as the selector's "Use these limits". */
  approve: string;
}

/** The one rule for every step the agent relays from install. */
export const SHOW_NOT_RUN =
  'Show the person links and addresses, and never ask them to run a command.';

/**
 * An agent runs install with `--json` or in a shell with no terminal, so the
 * CLI cannot ask. The agent can: this is what the selector would have shown
 * (the limits and the routing fee) and what to run for each answer, the same
 * shape as the `request` tool's `needs_input` step. A script or CI ignores
 * it, and the zero holds.
 */
function spendApproval(config: PartialConfig, args: RouterInstallArgs): SpendApproval {
  const limits = shownLimits(config);
  const options = spendOptions(limits, installCommand(args));
  const [byDefault, custom] = options as [SpendOption, SpendOption, SpendOption];
  const approve = byDefault.command ?? '';
  return {
    question: spendChoiceQuestion(),
    options,
    limits: limitsUsd(limits),
    routingFee: ROUTING_FEE_TERMS,
    next: `In this session, ask the person this question with your question tool before you change any limit, offering these three options in order with the default marked recommended. Default: run \`${approve}\`. Custom limits: ask for the most per call and the most per day in USD (or none for no daily limit), then run \`${custom.command ?? ''}\` with their amounts. No automatic spending: run nothing, and ${DECLINED}. Run the command alone, never joined with another command, and do not ask again a question its output repeats. ${SHOW_NOT_RUN}`,
    approve,
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
function namedLimits(args: RouterInstallArgs): {
  limits: Partial<RouterLimits>;
  keys: (keyof RouterLimits)[];
} {
  const flags = [
    ['maxAutoSpend', '--max-auto-spend', args.maxAutoSpend, false],
    ['sessionBudget', '--session-budget', args.sessionBudget, true],
  ] as const;
  const limits: Partial<RouterLimits> = {};
  const keys: (keyof RouterLimits)[] = [];
  for (const [key, flag, raw, allowNone] of flags) {
    if (raw === undefined) continue;
    if (args.refresh === true) {
      throw new CliError('USAGE', `${flag} sets a spend limit, and --refresh writes none.`, {
        fix: `Run \`tenjin install ${flag} ${raw}\` without --refresh.`,
      });
    }
    const parsed = parseLimit(raw, allowNone);
    if ('refusal' in parsed) {
      throw new CliError('USAGE', `${flag} ${raw}: ${parsed.refusal}`, {
        fix: allowNone
          ? `Give a positive USD amount or none, for example \`${flag} 5\`.`
          : `Give a positive USD amount, for example \`${flag} 0.25\`.`,
      });
    }
    limits[key] = parsed.value;
    keys.push(key);
  }
  return { limits, keys };
}

/** The funding question an agent's install hands over after the spend question. */
export const FUND_QUESTION = 'Do you want to add funds to your Tenjin wallet now?';
/** Its yes: the agent runs this alone, in the turn the person answered. */
export const FUND_COMMAND = 'tenjin wallet fund';

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

/** The funding question, with what the person needs to add funds later. */
export interface FundStep extends QuestionStep {
  id: 'fund';
  address: string;
  /** The wallet's fund page, or null when no link could be minted. */
  url: string | null;
  /** When `url` stops working, ISO 8601. */
  expiresAt: string | null;
  /** The link and the address, for the agent to show the person as written. */
  show: string;
  /** Why no link was minted. */
  reason?: string;
}

function spendStep(approval: SpendApproval): QuestionStep {
  return {
    id: 'spend',
    question: approval.question,
    options: approval.options,
    next: approval.next,
  };
}

/**
 * THE QUESTION BEFORE THE ACTION. Under an agent harness, install opens no
 * browser and pays nothing: it hands the agent the funding question, after
 * the spend question, so every real-world step follows an answer the person
 * gave in the session. It mints the same signed link `tenjin wallet fund`
 * does (a read: nothing moves until the person pays on the page) for the
 * person to keep. A wallet that already holds USDC gets no question; a link
 * that cannot be minted leaves the address.
 */
async function fundStep(
  ctx: CommandContext,
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
  const minted = await (deps.fundLink ?? mintInstallFundLink)(ctx, address).then(
    (url) => ({ url }),
    (err: unknown) => ({ reason: err instanceof Error ? err.message : String(err) }),
  );
  const url = 'url' in minted ? minted.url : null;
  const { fundLinkExpiry, isHostedCheckout } = await import('../commands/fund');
  const now = Date.now();
  const expires = url !== null ? fundLinkExpiry(url, now) : null;
  const minutes =
    expires !== null ? Math.max(1, Math.round((expires.getTime() - now) / 60_000)) : 0;
  const where = url !== null && isHostedCheckout(url) ? ' in a browser on this computer' : '';
  const show =
    url !== null
      ? `To add funds, open this link${where} (valid ${minutes} minutes): ${url} Or send USDC on Base to ${address}.`
      : `To add funds, send USDC on Base to ${address}.`;
  return {
    id: 'fund',
    question: FUND_QUESTION,
    options: [
      {
        id: 'fund',
        label: 'Yes, open the funding page',
        recommended: false,
        command: FUND_COMMAND,
      },
      { id: 'later', label: 'Not now', recommended: false, command: null },
    ],
    next: `Ask the person this question with your question tool, after the spend question and before you run anything. On "Yes, open the funding page", run \`${FUND_COMMAND}\` alone, in the same turn, after any spend command. On "Not now", run nothing and show the person this for later: ${show} Never run \`${FUND_COMMAND}\` without this yes. ${SHOW_NOT_RUN}`,
    address,
    url,
    expiresAt: expires?.toISOString() ?? null,
    show,
    ...('reason' in minted ? { reason: minted.reason } : {}),
  };
}

/** Never a passphrase prompt for a link: a wallet that cannot unlock gets the address alone. */
async function mintInstallFundLink(ctx: CommandContext, address: string): Promise<string> {
  const { mintFundLink } = await import('../commands/fund');
  const { resolveWalletProvider } = await import('../lib/wallet');
  const provider = resolveWalletProvider({ ...ctx, io: { ...ctx.io, isTTY: false } });
  return mintFundLink(ctx, await provider.getSigner(), address);
}

function defaultBalance(address: string, rpcUrl: string): Promise<bigint> {
  return getUsdcBalance(address as `0x${string}`, rpcUrl);
}

/** The funding question, as the summary prints it. */
function fundLines(ctx: CommandContext, fund: FundStep): string[] {
  return [
    ...(fund.reason !== undefined
      ? [paint(ctx.io, 'yellow', `! No fund link: ${fund.reason}`)]
      : []),
    `  Then ask the person: ${fund.question}`,
    `  Yes, open the funding page: ${FUND_COMMAND}`,
    `  Not now: run nothing, show them: ${fund.show}`,
  ];
}

/**
 * The one question install asks, before anything is written: approve the
 * automatic spend limits or set your own. Only a key the file does not already
 * name is asked for, because the write fills absent keys and keeps the rest.
 * The question names the routing fee and its deposits too, and either answer
 * approves it. Cancelling at any step writes nothing.
 */
async function approveLimits(
  config: PartialConfig,
  deps: RouterInstallDeps,
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
    fund?: FundStep;
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
          warn('Automatic payments are off until the person chooses spend limits'),
          `  Ask the person in this session: ${s.approval.question}`,
          ...s.approval.options.map(
            (o) =>
              `  ${o.label}${o.recommended ? ' (recommended)' : ''}: ${o.command ?? `run nothing, ${DECLINED.replaceAll('`', '')}`}`,
          ),
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
    ...walletLines(ctx, ok, s.wallet),
    ...spend,
    ...(s.fund !== undefined ? fundLines(ctx, s.fund) : []),
    ...pluginLines(ctx, s.plugin),
    ...claudeLines(ctx, s.claude),
    ...migrationLines(ctx, s.migration),
    ...router,
    '',
    `Next: ${nextStep(s.plugin, s.claude, s.wallet, s.migration, s.fund !== undefined)}`,
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
