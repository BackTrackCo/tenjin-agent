import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';
import { claudeAdapter } from '../adapters/claude';
import { persistRouterDefaults } from '../commands/config';
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
  const settingsPath = routerSettingsPath({
    ...(args.project === true ? { project: true } : {}),
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
  if (args.refresh === true) {
    return {
      data: { settingsPath, hooks, refresh: true },
      humanLines: [`Refreshed ${hooks.entries} hook entries in ${settingsPath}.`],
    };
  }
  const permissions = await ensureAllowRule(settingsPath);
  const spend = await persistRouterDefaults(ctx.dataDir);
  const mcp = await registerMcpServer(deps, env, args.project === true, cwd);
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

async function hasOurEntries(path: string, dataDir: string): Promise<boolean> {
  const found = await inspectHooksFile(path);
  if ('refusal' in found) return false;
  return Object.values(found.hooks).some((list) =>
    list.some((entry) => ownsHookEntry(entry, dataDir)),
  );
}

/** Shared with `uninstall`: the prune this module's writer already performs. */
export { pruneHooks };
