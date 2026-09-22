import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { readFile, stat } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';
import { claudeAdapter } from '../adapters/claude';
import { persistRouterDefaults, ROUTER_DEFAULTS } from '../commands/config';
import type { RouterDefaultsResult } from '../commands/config';
import { writeFileAtomic } from '../lib/atomic-json';
import { CliError } from '../lib/errors';
import { claudeSettingsPath } from '../lib/harness-permissions';
import {
  inspectHooksFile,
  ownsHookEntry,
  pruneHooks,
  writeHooks,
  type HooksResult,
} from '../lib/harness-hooks';
import { toMoney } from '../lib/money';
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
export const MCP_ADD_COMMAND = `claude mcp add ${MCP_SERVER_NAME} -s user -- tenjin mcp`;

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
  /** Runs `claude mcp add`; tests inject it so no binary is spawned. */
  registerMcp?: (command: string) => Promise<void>;
}

export interface McpRegistration {
  name: string;
  registered: boolean;
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
  const settingsPath =
    args.project === true
      ? join(deps.cwd ?? process.cwd(), '.claude', 'settings.json')
      : claudeSettingsPath(home);

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
  const mcp = await registerMcpServer(deps, env);

  const data = { settingsPath, hooks, permissions, spend, mcp, disclosure: DISCLOSURE };
  return { data, humanLines: lines(settingsPath, hooks, permissions, spend, mcp) };
}

export interface AllowRuleResult {
  path: string;
  rule: string;
  added: boolean;
  /** Set when the file could not be written; the rule is then not in force. */
  warning?: string;
}

/**
 * Add the one permission rule, keeping every other key. Read-modify-write over
 * the same file the hooks went into, one step later: a rule that is already
 * there is left alone and the file is not rewritten.
 */
async function ensureAllowRule(path: string): Promise<AllowRuleResult> {
  let settings: Record<string, unknown> = {};
  let raw: string | null = null;
  try {
    raw = await readFile(path, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { path, rule: ALLOW_RULE, added: false, warning: `${path} is not a JSON object.` };
    }
    settings = parsed as Record<string, unknown>;
  } catch (err) {
    if (raw !== null) {
      return {
        path,
        rule: ALLOW_RULE,
        added: false,
        warning: `${path} could not be parsed (${err instanceof Error ? err.message : String(err)}).`,
      };
    }
  }
  const permissions =
    settings.permissions !== null &&
    typeof settings.permissions === 'object' &&
    !Array.isArray(settings.permissions)
      ? (settings.permissions as Record<string, unknown>)
      : {};
  const allow = Array.isArray(permissions.allow) ? permissions.allow : [];
  if (allow.includes(ALLOW_RULE)) return { path, rule: ALLOW_RULE, added: false };
  const next = {
    ...settings,
    permissions: { ...permissions, allow: [...allow, ALLOW_RULE] },
  };
  const mode = await stat(path)
    .then((found) => ({ mode: found.mode & 0o777 }))
    .catch(() => ({}));
  try {
    await writeFileAtomic(path, `${JSON.stringify(next, null, 2)}\n`, mode);
  } catch (err) {
    return {
      path,
      rule: ALLOW_RULE,
      added: false,
      warning: `${path} could not be written (${err instanceof Error ? err.message : String(err)}).`,
    };
  }
  return { path, rule: ALLOW_RULE, added: true };
}

async function registerMcpServer(
  deps: RouterInstallDeps,
  env: NodeJS.ProcessEnv,
): Promise<McpRegistration> {
  const which = deps.which ?? ((bin: string) => onPath(bin, env));
  if (!which('claude')) {
    return {
      name: MCP_SERVER_NAME,
      registered: false,
      command: MCP_ADD_COMMAND,
      reason: 'the `claude` binary is not on PATH',
    };
  }
  try {
    await (deps.registerMcp ?? runClaudeMcpAdd)(MCP_ADD_COMMAND);
    return { name: MCP_SERVER_NAME, registered: true, command: MCP_ADD_COMMAND };
  } catch (err) {
    return {
      name: MCP_SERVER_NAME,
      registered: false,
      command: MCP_ADD_COMMAND,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

async function runClaudeMcpAdd(): Promise<void> {
  await exec('claude', ['mcp', 'add', MCP_SERVER_NAME, '-s', 'user', '--', 'tenjin', 'mcp'], {
    timeout: 20_000,
  });
}

function lines(
  settingsPath: string,
  hooks: HooksResult,
  permissions: AllowRuleResult,
  spend: RouterDefaultsResult,
  mcp: McpRegistration,
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
    `spend: at most ${toMoney(ROUTER_DEFAULTS.maxAutoSpend).usd} USD per call inside ${toMoney(ROUTER_DEFAULTS.sessionBudget).usd} USD a day` +
      (spend.kept.length > 0 ? ` (kept your ${spend.kept.join(', ')})` : ''),
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
