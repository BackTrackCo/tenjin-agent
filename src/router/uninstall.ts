import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { readFile, stat } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';
import { writeFileAtomic } from '../lib/atomic-json';
import { claudeSettingsPath } from '../lib/harness-permissions';
import { inspectHooksFile, pruneHooks } from '../lib/harness-hooks';
import { onPath } from '../lib/skill-wiring';
import type { CommandContext, CommandResult } from '../context';
import { ALLOW_RULE, MCP_SERVER_NAME } from './install';

/**
 * `tenjin uninstall`: take out the hook entries, the allow rule and the MCP
 * registration, and nothing else.
 *
 * THE WALLET AND `spend.json` STAY. Removing an integration is not a reason to
 * destroy a key that holds funds or a ledger that records what was spent; both
 * are the user's, and `tenjin wallet` is where they go to move either.
 */

const exec = promisify(execFile);
export const MCP_REMOVE_COMMAND = `claude mcp remove ${MCP_SERVER_NAME} -s user`;

export interface RouterUninstallArgs {
  project?: boolean;
}

export interface RouterUninstallDeps {
  homeDir?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  which?: (bin: string) => boolean;
  removeMcp?: () => Promise<void>;
}

export async function runRouterUninstall(
  args: RouterUninstallArgs,
  ctx: CommandContext,
  deps: RouterUninstallDeps = {},
): Promise<CommandResult> {
  const env = deps.env ?? process.env;
  const home = deps.homeDir ?? homedir();
  if (!isAbsolute(home)) throw new Error('The home directory is not an absolute path.');
  const settingsPath =
    args.project === true
      ? join(deps.cwd ?? process.cwd(), '.claude', 'settings.json')
      : claudeSettingsPath(home);

  const removed = await removeFromSettings(settingsPath, ctx.dataDir);
  const mcp = await removeMcpServer(deps, env);
  const data = {
    settingsPath,
    ...removed,
    mcp,
    kept: ['wallet.json', 'spend.json', 'config.json'],
  };
  return {
    data,
    humanLines: [
      removed.warning === undefined
        ? `removed ${removed.events.length > 0 ? removed.events.join(', ') : 'no'} hook entries and ${removed.ruleRemoved ? 'the' : 'no'} permission rule from ${settingsPath}`
        : `${settingsPath} was left untouched (${removed.warning})`,
      mcp.removed ? `removed the ${MCP_SERVER_NAME} MCP server` : `mcp: run ${MCP_REMOVE_COMMAND}`,
      'Your wallet, spend ledger and config are kept.',
    ],
  };
}

interface SettingsRemoval {
  /** The events an entry of ours was taken out of. */
  events: string[];
  ruleRemoved: boolean;
  wrote: boolean;
  warning?: string;
}

async function removeFromSettings(path: string, dataDir: string): Promise<SettingsRemoval> {
  const found = await inspectHooksFile(path);
  if ('refusal' in found) {
    return { events: [], ruleRemoved: false, wrote: false, warning: found.refusal.reason };
  }
  const { raw, settings, hooks } = found;
  if (raw === null) return { events: [], ruleRemoved: false, wrote: false };
  const pruned = pruneHooks(hooks, dataDir);
  const permissions =
    settings.permissions !== null &&
    typeof settings.permissions === 'object' &&
    !Array.isArray(settings.permissions)
      ? (settings.permissions as Record<string, unknown>)
      : undefined;
  const allow = Array.isArray(permissions?.allow) ? permissions.allow : undefined;
  const ruleRemoved = allow?.includes(ALLOW_RULE) === true;
  const next = {
    ...settings,
    hooks: pruned.next,
    ...(permissions !== undefined && allow !== undefined
      ? { permissions: { ...permissions, allow: allow.filter((r) => r !== ALLOW_RULE) } }
      : {}),
  };
  const body = `${JSON.stringify(next, null, 2)}\n`;
  if (body === raw) {
    return { events: pruned.removed, ruleRemoved, wrote: false };
  }
  const mode = await stat(found.path)
    .then((s) => ({ mode: s.mode & 0o777 }))
    .catch(() => ({}));
  if ((await readFile(found.path, 'utf8').catch(() => null)) !== raw) {
    return { events: [], ruleRemoved: false, wrote: false, warning: 'changed-since-read' };
  }
  try {
    await writeFileAtomic(found.path, body, mode);
  } catch (err) {
    return {
      events: [],
      ruleRemoved: false,
      wrote: false,
      warning: err instanceof Error ? err.message : String(err),
    };
  }
  return { events: pruned.removed, ruleRemoved, wrote: true };
}

async function removeMcpServer(
  deps: RouterUninstallDeps,
  env: NodeJS.ProcessEnv,
): Promise<{ removed: boolean; command: string; reason?: string }> {
  const which = deps.which ?? ((bin: string) => onPath(bin, env));
  if (!which('claude')) {
    return {
      removed: false,
      command: MCP_REMOVE_COMMAND,
      reason: 'the `claude` binary is not on PATH',
    };
  }
  try {
    await (deps.removeMcp ?? runClaudeMcpRemove)();
    return { removed: true, command: MCP_REMOVE_COMMAND };
  } catch (err) {
    return {
      removed: false,
      command: MCP_REMOVE_COMMAND,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

async function runClaudeMcpRemove(): Promise<void> {
  await exec('claude', ['mcp', 'remove', MCP_SERVER_NAME, '-s', 'user'], { timeout: 20_000 });
}
