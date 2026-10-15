import { homedir } from 'node:os';
import { isAbsolute } from 'node:path';
import { persistRouterProject } from '../commands/config';
import type { CommandContext, CommandResult } from '../context';
import { removeAliveState } from './alive';
import { findClaudeBinary, jsonList, jsonResult, runClaude, type ClaudeBinary } from './claude-cli';
import { settingsInstallPaths } from './install';
import { inspectLegacyInstall, removeLegacyInstall, type LegacyRemoval } from './legacy-install';
import { MARKETPLACE_NAME, PLUGIN_ID } from './names';
import { removePluginFolder, type FolderRemoval } from './plugin-folder';
import { folderFor, ownMarketplace, type PluginScope } from './plugin-registration';

/**
 * `tenjin uninstall`: take out the plugin and anything a settings install of
 * an earlier release left, and nothing else.
 *
 * THE PLUGIN goes through Claude Code's own commands (`claude plugin
 * uninstall`, then `claude plugin marketplace remove` for the marketplace
 * `install` added), and a plugin folder of ours loses its listed files. The
 * settings install's hook entries, rules, status line and `x402` server go
 * under the exact-shape rules of `legacy-install.ts`.
 *
 * THE WALLET AND `spend.json` STAY. Removing an integration is not a reason to
 * destroy a key that holds funds or a ledger that records what was spent; both
 * are the user's, and `tenjin wallet` is where they go to move either.
 */

export interface RouterUninstallArgs {
  project?: boolean;
}

export interface RouterUninstallDeps {
  homeDir?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  findClaude?: (env: NodeJS.ProcessEnv) => ClaudeBinary | null;
}

export interface PluginRemoval {
  /** `removed`, `absent` (it was not installed), or `kept` with the reason. */
  plugin: 'removed' | 'absent' | 'kept';
  marketplace: 'removed' | 'absent' | 'kept';
  folder: FolderRemoval;
  reason?: string;
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
  const project = args.project === true;
  const scope: PluginScope = project ? 'local' : 'user';
  const binary = (deps.findClaude ?? findClaudeBinary)(env);

  const plugin = await removePlugin(binary, scope, env, home, cwd);
  const paths = settingsInstallPaths(project, env, home, cwd);
  const legacy = await inspectLegacyInstall(paths.settingsPath, paths.mcpFile);
  const settings: LegacyRemoval | null = legacy.present
    ? await removeLegacyInstall(legacy, { binary, env, cwd, mcpScope: paths.mcpScope })
    : null;
  const alive = await removeAliveState(ctx.dataDir);
  // Forgotten, so a later `tenjin update` does not go looking for a project
  // this machine no longer wires.
  if (project) await persistRouterProject(ctx.dataDir, cwd, false).catch(() => undefined);
  const data = {
    plugin,
    settings: { path: paths.settingsPath, found: legacy.present, removed: settings },
    aliveRemoved: alive,
    kept: ['wallet.json', 'spend.json', 'config.json'],
  };
  return { data, humanLines: uninstallLines(plugin, paths.settingsPath, settings) };
}

async function removePlugin(
  binary: ClaudeBinary | null,
  scope: PluginScope,
  env: NodeJS.ProcessEnv,
  home: string,
  cwd: string,
): Promise<PluginRemoval> {
  const folder = await removePluginFolder(folderFor(scope, env, home, cwd));
  if (binary === null) {
    return {
      plugin: 'kept',
      marketplace: 'kept',
      folder,
      reason: `no claude binary on PATH or in CLAUDE_CODE_EXECPATH, so ${PLUGIN_ID} could not be checked; if Claude Code still lists it, type /plugin uninstall ${PLUGIN_ID} in a Claude Code session`,
    };
  }
  const run = (a: string[]) => runClaude(binary, a, { env, cwd });
  const uninstall = await run(['plugin', 'uninstall', PLUGIN_ID, '--scope', scope, '--json']);
  const result = jsonResult(uninstall.stdout);
  const pluginState: PluginRemoval['plugin'] =
    uninstall.code === 0 ? 'removed' : result?.failureCode === 'not_installed' ? 'absent' : 'kept';
  // THE MARKETPLACE GOES ONLY WHEN IT IS THE ONE `install` ADDED. A marketplace
  // of the same name from anywhere else is somebody else's.
  const listed = jsonList((await run(['plugin', 'marketplace', 'list', '--json'])).stdout) ?? [];
  const row = listed.find((m) => m.name === MARKETPLACE_NAME);
  let marketplace: PluginRemoval['marketplace'] = 'absent';
  if (row !== undefined) {
    if (await ownMarketplace(row)) {
      // Named only for a project install, as `install` added it.
      const scoped = scope === 'user' ? [] : ['--scope', scope];
      const removed = await run([
        'plugin',
        'marketplace',
        'remove',
        MARKETPLACE_NAME,
        ...scoped,
        '--json',
      ]);
      marketplace = removed.code === 0 ? 'removed' : 'kept';
    } else marketplace = 'kept';
  }
  const message =
    typeof result?.message === 'string' ? result.message : uninstall.stderr.trim().slice(0, 200);
  return {
    plugin: pluginState,
    marketplace,
    folder,
    ...(pluginState === 'kept'
      ? { reason: `claude plugin uninstall did not succeed: ${message}` }
      : {}),
  };
}

function uninstallLines(
  plugin: PluginRemoval,
  settingsPath: string,
  settings: LegacyRemoval | null,
): string[] {
  const lines: string[] = [
    plugin.plugin === 'removed'
      ? `removed the ${PLUGIN_ID} plugin`
      : plugin.plugin === 'absent'
        ? `plugin: ${PLUGIN_ID} was not installed`
        : `plugin: ${plugin.reason ?? 'left in place'}`,
  ];
  if (plugin.marketplace === 'removed') lines.push(`removed the ${MARKETPLACE_NAME} marketplace`);
  if (plugin.folder.removed) {
    lines.push(
      plugin.folder.left.length === 0
        ? `removed the plugin folder ${plugin.folder.path}`
        : `removed the plugin's files from ${plugin.folder.path}; kept what is not Tenjin's: ${plugin.folder.left.join(', ')}`,
    );
  } else if (plugin.folder.reason !== undefined) lines.push(`folder: ${plugin.folder.reason}`);
  if (settings !== null) {
    const parts = [
      ...(settings.events.length > 0 ? [`hook entries (${settings.events.join(', ')})`] : []),
      ...(settings.allowRule || settings.denyRule ? ['the permission rules'] : []),
      ...(settings.statusLine !== 'kept' ? ['the status line'] : []),
      ...(settings.mcp === 'removed' ? ['the x402 MCP server'] : []),
    ];
    if (parts.length > 0) {
      lines.push(`removed the settings install's ${parts.join(', ')} from ${settingsPath}`);
    }
    lines.push(...settings.warnings.map((w) => `settings: ${w}`));
  }
  lines.push('Your wallet, spend ledger and config are kept.');
  return lines;
}
