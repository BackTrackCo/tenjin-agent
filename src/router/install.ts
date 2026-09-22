import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';
import { claudeAdapter } from '../adapters/claude';
import { persistRouterDefaults, persistRouterProject } from '../commands/config';
import type { RouterDefaultsResult } from '../commands/config';
import { CliError } from '../lib/errors';
import { appendAllowlistRules, claudeSettingsPath } from '../lib/harness-permissions';
import {
  inspectHooksFile,
  ownsHookEntry,
  pruneHooks,
  writeHooks,
  type HooksResult,
} from '../lib/harness-hooks';
import { toMoney } from '../lib/money';
import { resolveContextSettings } from '../lib/settings';
import type { SpendPolicy } from '../lib/policy';
import { onPath } from '../lib/skill-wiring';
import { loadRawConfig } from '../lib/config';
import type { PartialConfig } from '../lib/config';
import type { CommandContext, CommandResult } from '../context';

/**
 * `tenjin install` for the router product: two hook entries, one MCP server,
 * one permission rule, the spend defaults, and the disclosure.
 *
 * WHAT IT WRITES IS WHAT IT SAYS. There is no skill to materialize, no daemon
 * to start and no background process of any kind: the hooks are plain command
 * lines, the tool lives in an MCP server the harness starts per session, and
 * every other key in the settings file is preserved byte for byte.
 */

const exec = promisify(execFile);

export const HOOK_TIMEOUT_SECONDS = 3;
export const MCP_SERVER_NAME = 'x402';
export const ALLOW_RULE = 'mcp__x402__request';
/**
 * The MCP registration follows the SAME SCOPE the hook entries do. A
 * `--project` install that wrote its hooks into the project and then registered
 * the server at user scope would reach into `~/.claude.json` on a run whose
 * whole point is to touch this project and nothing else, and `tenjin uninstall
 * --project` would leave that behind.
 *
 * Project scope writes `<project>/.mcp.json`, so the registration lives beside
 * the settings file that names the hooks and travels with the repository.
 */
export function mcpScope(project: boolean | undefined): 'user' | 'project' {
  return project === true ? 'project' : 'user';
}

export function mcpAddCommand(project?: boolean): string {
  return `claude mcp add ${MCP_SERVER_NAME} -s ${mcpScope(project)} -- tenjin mcp`;
}

export function mcpRemoveCommand(project?: boolean): string {
  return `claude mcp remove ${MCP_SERVER_NAME} -s ${mcpScope(project)}`;
}

/** The user-scope form, kept as the name the docs and the tests already use. */
export const MCP_ADD_COMMAND = mcpAddCommand();

/**
 * Which settings file this machine's router wiring lives in, spelled once so
 * `install`, `uninstall` and `doctor` can never disagree about where to look.
 * A doctor reading the home file on a `--project` install reported a correctly
 * wired machine as unwired and exited 3.
 */
export function routerSettingsPath(
  opts: { project?: boolean; homeDir?: string; cwd?: string } = {},
): string {
  if (opts.project === true) return join(opts.cwd ?? process.cwd(), '.claude', 'settings.json');
  return claudeSettingsPath(opts.homeDir ?? homedir());
}

/** The two entries, spelled once so `uninstall` and the tests read the same list. */
export function routerHookPlan(): unknown[] {
  const handler = (command: string) => [
    { type: 'command', command, timeout: HOOK_TIMEOUT_SECONDS },
  ];
  return [
    { event: 'UserPromptSubmit', hooks: handler('tenjin hook prompt') },
    { event: 'PreToolUse', matcher: 'WebSearch|WebFetch', hooks: handler('tenjin hook native') },
  ];
}

export const DISCLOSURE: readonly string[] = [
  'What leaves this machine: the bounded text of each prompt and each native search query or URL, sent to Tenjin for the free routing gate.',
  'What is kept when a lookup is paid: the capability chosen, a hash of the contract, a hash of the arguments, and your wallet address. No prompt text, no arguments, no hint text.',
  'What never leaves: your private key. It is decrypted in this CLI to sign, and never sent anywhere.',
];

export interface RouterInstallArgs {
  /** Write into this project's `.claude/settings.json` instead of your home one. */
  project?: boolean;
  /**
   * Bring the entries this machine ALREADY has up to the running build, and
   * add nothing: no config write, no MCP registration, and a refusal when
   * nothing of ours is here. `tenjin update` spawns exactly this after it swaps
   * the binary, so the flag's name and meaning are a compatibility contract.
   */
  refresh?: boolean;
}

export interface RouterInstallDeps {
  homeDir?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** PATH probe for the `claude` binary. */
  which?: (bin: string) => boolean;
  /** Runs `claude mcp add`; tests inject it so no binary is spawned. The scope
   *  and the working directory are passed, because project scope is decided by
   *  where the command runs as much as by the flag. */
  registerMcp?: (
    command: string,
    opts: { scope: 'user' | 'project'; cwd: string },
  ) => Promise<void>;
}

export interface McpRegistration {
  name: string;
  registered: boolean;
  /** Which scope it went to, following the hook entries rather than the flag
   *  being read twice. `project` writes `<project>/.mcp.json`. */
  scope: 'user' | 'project';
  /** The command to run by hand, when this run could not. */
  command: string;
  reason?: string;
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
  const cwd = deps.cwd ?? process.cwd();
  // A refresh converges EVERY install this machine has, in the scope each one
  // was made in. `tenjin update` spawns it from the HOME directory, so looking
  // around cwd would miss a project install entirely; the projects are read
  // from the list `install --project` recorded. A refresh that silently moved a
  // project install to user scope would also leave two installations and
  // double-fire every hook.
  // `project` UNSET means "work it out"; an explicit true or false is a single
  // target, which is what the fan-out below passes back in. Without that
  // distinction the user-scope leg would re-enter here forever.
  if (args.refresh === true && args.project === undefined) {
    return refreshEveryInstall(ctx, deps, home, cwd, env);
  }
  const project = args.project === true;
  const settingsPath = routerSettingsPath({
    ...(project ? { project: true } : {}),
    homeDir: home,
    cwd,
  });

  if (args.refresh === true && !(await hasOurEntries(settingsPath, ctx.dataDir))) {
    throw new CliError(
      'REFUSED',
      `Nothing to refresh in ${settingsPath}: no Tenjin hook entries are registered here.`,
      { fix: 'Run `tenjin install` to set this machine up.' },
    );
  }
  const hooks = await writeHooks({
    adapter: claudeAdapter,
    homeDir: home,
    dataDir: ctx.dataDir,
    env,
    plan: routerHookPlan(),
    settingsPath,
  });
  const permissions = await ensureAllowRule(settingsPath);
  const mcp = await registerMcpServer(deps, env, project, cwd);
  if (args.refresh === true) {
    // The SAME writers, minus the one that decides anything: the entries are
    // rewritten in place by their ownership marker so an upgrade never
    // duplicates them, the rule and the registration are re-checked because a
    // new version can change either, and `config.json`, the wallet and
    // `spend.json` are not touched at all. Widening an agent's spend policy
    // during an unattended upgrade is not a convergence.
    // WRITTEN, not merely re-checked: `claude mcp add` is idempotent and
    // reports no difference either way, so the registration is always a
    // re-check and never counts as a change.
    const rewritten = [
      ...(hooks.wrote ? ['hook entries'] : []),
      ...(permissions.added ? ['the permission rule'] : []),
    ];
    return {
      data: { settingsPath, hooks, permissions, mcp, refresh: true, scope: mcpScope(project) },
      humanLines: [
        rewritten.length === 0
          ? `Already current: ${hooks.entries} hook entries in ${settingsPath}, nothing rewritten.`
          : `Rewrote ${rewritten.join(' and ')} in ${settingsPath}.`,
        mcp.registered
          ? `Re-checked the ${MCP_SERVER_NAME} MCP registration (${mcpScope(project)} scope).`
          : `mcp: run ${mcp.command}`,
        'Your wallet, spend ledger and config were not touched.',
      ],
    };
  }
  const spend = await persistRouterDefaults(ctx.dataDir);
  // Remembered so `tenjin update` can find this project again from anywhere.
  if (project) await persistRouterProject(ctx.dataDir, cwd);
  // Read back AFTER the write: a machine that already carried its own caps
  // keeps them, and a readout quoting the defaults would describe limits this
  // run did not set.
  const effective = await resolveContextSettings(ctx);

  const data = {
    settingsPath,
    hooks,
    permissions,
    spend: { ...spend, effective: effectiveLimits(effective.policy) },
    mcp,
    disclosure: DISCLOSURE,
  };
  return {
    data,
    humanLines: lines(settingsPath, hooks, permissions, spend, mcp, effective.policy),
  };
}

export interface AllowRuleResult {
  path: string;
  rule: string;
  added: boolean;
  /** Set when the file could not be written; the rule is then not in force. */
  warning?: string;
}

/**
 * The one permission rule, through the shared allowlist writer rather than a
 * third hand-rolled one: it resolves a symlinked settings.json before the
 * rename, refuses a file it cannot parse, and compares the bytes it read before
 * committing, none of which a local copy of the merge would have.
 */
async function ensureAllowRule(path: string): Promise<AllowRuleResult> {
  const result = await appendAllowlistRules(path, [ALLOW_RULE]);
  return {
    path: result.path,
    rule: ALLOW_RULE,
    added: result.added.length > 0,
    ...(result.warning !== undefined
      ? { warning: result.warning }
      : result.skipped !== undefined
        ? { warning: `${result.path} was left untouched (${result.skipped}).` }
        : {}),
  };
}

async function registerMcpServer(
  deps: RouterInstallDeps,
  env: NodeJS.ProcessEnv,
  project: boolean,
  cwd: string,
): Promise<McpRegistration> {
  const scope = mcpScope(project);
  const command = mcpAddCommand(project);
  const which = deps.which ?? ((bin: string) => onPath(bin, env));
  if (!which('claude')) {
    return {
      name: MCP_SERVER_NAME,
      registered: false,
      scope,
      command,
      reason: 'the `claude` binary is not on PATH',
    };
  }
  try {
    await (deps.registerMcp ?? runClaudeMcpAdd)(command, { scope, cwd });
    return { name: MCP_SERVER_NAME, registered: true, scope, command };
  } catch (err) {
    return {
      name: MCP_SERVER_NAME,
      registered: false,
      scope,
      command,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Project scope is decided by the working directory as well as the flag:
 *  `claude` writes `.mcp.json` beside the project it was run in. */
async function runClaudeMcpAdd(
  _command: string,
  opts: { scope: 'user' | 'project'; cwd: string },
): Promise<void> {
  await exec('claude', ['mcp', 'add', MCP_SERVER_NAME, '-s', opts.scope, '--', 'tenjin', 'mcp'], {
    timeout: 20_000,
    cwd: opts.cwd,
  });
}

interface EffectiveLimits {
  maxAutoSpend: string;
  sessionBudget: string;
}

function effectiveLimits(policy: SpendPolicy): EffectiveLimits {
  return {
    maxAutoSpend: toMoney(policy.maxAutoSpendAtomic.toString()).usd,
    sessionBudget:
      policy.sessionBudgetAtomic === 0n
        ? 'no daily ceiling'
        : toMoney(policy.sessionBudgetAtomic.toString()).usd,
  };
}

function lines(
  settingsPath: string,
  hooks: HooksResult,
  permissions: AllowRuleResult,
  spend: RouterDefaultsResult,
  mcp: McpRegistration,
  policy: SpendPolicy,
): string[] {
  const out = [
    hooks.skipped === undefined
      ? `hooks: ${hooks.entries} entries in ${settingsPath}`
      : `hooks: ${settingsPath} was left untouched (${hooks.skipped}); fix it, then re-run: tenjin install`,
    permissions.warning === undefined
      ? `permissions: ${ALLOW_RULE} allowed`
      : `permissions: ${permissions.warning}`,
    mcp.registered
      ? `mcp: ${MCP_SERVER_NAME} registered`
      : `mcp: not registered (${mcp.reason ?? 'unknown'}); run: ${mcp.command}`,
    `spend: at most ${effectiveLimits(policy).maxAutoSpend} USD per call, ${
      policy.sessionBudgetAtomic === 0n
        ? 'no daily ceiling'
        : `${effectiveLimits(policy).sessionBudget} USD a day`
    }` + (spend.kept.length > 0 ? ` (kept your ${spend.kept.join(', ')})` : ''),
    '',
    ...DISCLOSURE,
    '',
    'Fund it with `tenjin wallet fund`, check it with `tenjin status`, undo it with `tenjin uninstall`.',
    'Restart Claude Code to load the hooks.',
  ];
  if (hooks.warning !== undefined) out.push(`! ${hooks.warning}`);
  return out;
}

/**
 * Converge every install on this machine: the user one when it exists, and each
 * recorded project whose settings file still carries our entries. A project
 * that no longer does is forgotten, so the list cannot grow stale.
 *
 * Refusing only when NOTHING was found keeps `tenjin update`'s contract: it
 * reads the child's exit code, and a machine with a project install must not
 * report "nothing is installed here".
 */
async function refreshEveryInstall(
  ctx: CommandContext,
  deps: RouterInstallDeps,
  home: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<CommandResult> {
  const config = await loadRawConfig(ctx.dataDir).catch(() => ({}) as PartialConfig);
  const targets: { project: boolean; dir: string }[] = [];
  if (await hasOurEntries(routerSettingsPath({ homeDir: home }), ctx.dataDir)) {
    targets.push({ project: false, dir: home });
  }
  for (const dir of config.install?.routerProjects ?? []) {
    if (await hasOurEntries(routerSettingsPath({ project: true, cwd: dir }), ctx.dataDir)) {
      targets.push({ project: true, dir });
    } else {
      await persistRouterProject(ctx.dataDir, dir, false).catch(() => undefined);
    }
  }
  // The directory this ran in, when it is a project install nobody recorded: an
  // install from before this list existed still refreshes, and is remembered.
  // Skipped when that path IS the user's file, which is what `cwd` is when
  // `tenjin update` spawns this from the home directory.
  const here = routerSettingsPath({ project: true, cwd });
  if (
    here !== routerSettingsPath({ homeDir: home }) &&
    !targets.some((t) => t.project && t.dir === cwd) &&
    (await hasOurEntries(here, ctx.dataDir))
  ) {
    targets.push({ project: true, dir: cwd });
    await persistRouterProject(ctx.dataDir, cwd).catch(() => undefined);
  }

  if (targets.length === 0) {
    throw new CliError(
      'REFUSED',
      `Nothing to refresh for ${ctx.dataDir}: no Tenjin hook entries are registered here.`,
      { fix: 'Run `tenjin install` to set this machine up.' },
    );
  }

  const results: CommandResult[] = [];
  for (const target of targets) {
    results.push(
      await runRouterInstall({ refresh: true, project: target.project }, ctx, {
        ...deps,
        homeDir: home,
        cwd: target.dir,
        env,
      }),
    );
  }
  return {
    data: { refresh: true, installs: results.map((r) => r.data) },
    humanLines: results.flatMap((r) => r.humanLines ?? []),
  };
}

async function hasOurEntries(path: string, dataDir: string): Promise<boolean> {
  const found = await inspectHooksFile(path);
  if ('refusal' in found) return false;
  return Object.values(found.hooks).some((list) =>
    list.some((entry) => ownsHookEntry(entry, dataDir)),
  );
}

/** Shared with `uninstall`: the prune this module's writer already performs. */
export { pruneHooks };
