import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { readFile, stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { promisify } from 'node:util';
import { persistRouterProject } from '../commands/config';
import { writeFileAtomic } from '../lib/atomic-json';
import { inspectHooksFile, pruneHooks } from '../lib/harness-hooks';
import { onPath } from '../lib/skill-wiring';
import type { CommandContext, CommandResult } from '../context';
import {
  ALLOW_RULE,
  MCP_SERVER_NAME,
  mcpRemoveCommand,
  mcpScope,
  readMcpEntry,
  routerSettingsPath,
  type McpEntryState,
} from './install';
import { removeStatusLine } from './status-line-wiring';

/**
 * `tenjin uninstall`: take out the hook entries, the allow rule and the MCP
 * registration, and nothing else.
 *
 * THE WALLET AND `spend.json` STAY. Removing an integration is not a reason to
 * destroy a key that holds funds or a ledger that records what was spent; both
 * are the user's, and `tenjin wallet` is where they go to move either.
 */

const exec = promisify(execFile);
/** The user-scope form; `--project` removes at project scope symmetrically. */
export const MCP_REMOVE_COMMAND = mcpRemoveCommand();

export interface RouterUninstallArgs {
  project?: boolean;
}

export interface RouterUninstallDeps {
  homeDir?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  which?: (bin: string) => boolean;
  removeMcp?: (opts: { scope: 'user' | 'project'; cwd: string }) => Promise<void>;
  /** Reads the registration the scope's own file holds; tests inject it. */
  readMcpEntry?: (
    scope: 'user' | 'project',
    cwd: string,
    home: string,
  ) => Promise<{ found: boolean; state: McpEntryState }>;
}

export async function runRouterUninstall(
  args: RouterUninstallArgs,
  ctx: CommandContext,
  deps: RouterUninstallDeps = {},
): Promise<CommandResult> {
  const env = deps.env ?? process.env;
  const home = deps.homeDir ?? homedir();
  if (!isAbsolute(home)) throw new Error('The home directory is not an absolute path.');
  const cwd = deps.cwd ?? process.cwd();
  const settingsPath = routerSettingsPath({
    ...(args.project === true ? { project: true } : {}),
    homeDir: home,
    cwd,
  });

  const removed = await removeFromSettings(settingsPath, ctx.dataDir);
  // OURS ALONE, and after the hooks write so the two never touch the file at
  // once. A COMPOSED status line is the user's own text with ours appended:
  // deleting it would take their line with it, so it is reported and kept.
  const statusLine = await removeStatusLine(settingsPath);
  // Forgotten, so a later `tenjin update` does not go looking for a project
  // this machine no longer wires.
  if (args.project === true) {
    await persistRouterProject(ctx.dataDir, cwd, false).catch(() => undefined);
  }
  // The SAME scope the install used, or a `--project` uninstall would leave the
  // project's registration behind and reach into the user's file instead.
  const mcp = await removeMcpServer(deps, env, args.project === true, cwd, home);
  const data = {
    settingsPath,
    ...removed,
    statusLine,
    mcp,
    kept: ['wallet.json', 'spend.json', 'config.json'],
  };
  return {
    data,
    humanLines: [
      removed.warning === undefined
        ? `removed ${removed.events.length > 0 ? removed.events.join(', ') : 'no'} hook entries and ${removed.ruleRemoved ? 'the' : 'no'} permission rule from ${settingsPath}`
        : `${settingsPath} was left untouched (${removed.warning})`,
      statusLine.wrote
        ? 'removed the x402 status line'
        : statusLine.state === 'composed'
          ? 'status line: yours also runs the x402 footer; edit that command to drop it'
          : 'status line: none of ours was registered',
      mcp.removed
        ? `removed the ${MCP_SERVER_NAME} MCP server (${mcp.scope} scope)`
        : mcp.kept !== undefined
          ? `mcp: ${mcp.reason ?? 'left in place'}`
          : `mcp: run ${mcp.command}`,
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
  project: boolean,
  cwd: string,
  home: string,
): Promise<{
  removed: boolean;
  scope: 'user' | 'project';
  command: string;
  reason?: string;
  kept?: 'foreign' | 'unreadable';
}> {
  const scope = mcpScope(project);
  const command = mcpRemoveCommand(project);
  // THE SAME CHECK INSTALL MAKES. The name `x402` proves nothing: another tool
  // can register its own server under it, and install refuses to touch that
  // entry. Uninstall must not remove it either. An absent entry falls through
  // to the remove as before, so nothing changes for a normal install.
  const existing = await (deps.readMcpEntry ?? readMcpEntry)(scope, cwd, home);
  if (existing.state === 'wrong-command') {
    return {
      removed: false,
      scope,
      command,
      kept: 'foreign',
      reason: `an MCP server named ${MCP_SERVER_NAME} at ${scope} scope launches something else; this command will not remove a registration it did not write, so it was left in place`,
    };
  }
  if (existing.state === 'unreadable') {
    return {
      removed: false,
      scope,
      command,
      kept: 'unreadable',
      reason: `the ${scope}-scope registration file could not be read, so nothing was removed from it`,
    };
  }
  const which = deps.which ?? ((bin: string) => onPath(bin, env));
  if (!which('claude')) {
    return { removed: false, scope, command, reason: 'the `claude` binary is not on PATH' };
  }
  try {
    await (deps.removeMcp ?? runClaudeMcpRemove)({ scope, cwd });
    return { removed: true, scope, command };
  } catch (err) {
    return {
      removed: false,
      scope,
      command,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

async function runClaudeMcpRemove(opts: { scope: 'user' | 'project'; cwd: string }): Promise<void> {
  await exec('claude', ['mcp', 'remove', MCP_SERVER_NAME, '-s', opts.scope], {
    timeout: 20_000,
    cwd: opts.cwd,
  });
}
