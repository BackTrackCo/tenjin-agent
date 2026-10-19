import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { persistRouterProject } from '../commands/config';
import { loadRawConfig } from '../lib/config';
import type { CommandContext, CommandResult } from '../context';
import { removeAliveState } from './alive';
import { findClaudeBinary, jsonList, jsonResult, runClaude, type ClaudeBinary } from './claude-cli';
import { settingsInstallPaths } from './install';
import { inspectLegacyInstall, removeLegacyInstall, type LegacyRemoval } from './legacy-install';
import { MARKETPLACE_NAME, PLUGIN_ID } from './names';
import { PLUGIN_DIR } from './plugin-files';
import {
  inspectPluginFolder,
  marketplaceFolderPath,
  removeMarketplaceFolder,
  removePluginFolder,
  type FolderRemoval,
} from './plugin-folder';
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
  /** `unread` when `claude plugin marketplace list` gave no readable answer. */
  marketplace: 'removed' | 'absent' | 'kept' | 'unread';
  folder: FolderRemoval;
  /**
   * The marketplace folder `install` rendered under the data dir: removed once
   * nothing points at it, else kept with the reason. Absent when there was none.
   */
  marketplaceFolder?: FolderRemoval;
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

  const plugin = await removePlugin(binary, scope, env, home, cwd, ctx.dataDir);
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
  dataDir: string,
): Promise<PluginRemoval> {
  const folder = await removePluginFolder(folderFor(scope, env, home, cwd));
  const rendered = marketplaceFolderPath(dataDir);
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
  const listed = await readMarketplaces(run);
  const row = listed?.find((m) => m.name === MARKETPLACE_NAME);
  let marketplace: PluginRemoval['marketplace'] = listed === null ? 'unread' : 'absent';
  if (row !== undefined) {
    if (await ownMarketplace(row, rendered)) {
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
  const marketplaceFolder = await releaseMarketplaceFolder(rendered, {
    marketplace,
    run,
    dataDir,
    cwd,
  });
  return {
    plugin: pluginState,
    marketplace,
    folder,
    ...(marketplaceFolder !== null ? { marketplaceFolder } : {}),
    ...(pluginState === 'kept'
      ? { reason: `claude plugin uninstall did not succeed: ${message}` }
      : {}),
  };
}

/** `claude plugin marketplace list --json`, or null when it gave no readable list. */
async function readMarketplaces(
  run: (a: string[]) => Promise<{ code: number | null; stdout: string }>,
): Promise<Record<string, unknown>[] | null> {
  const out = await run(['plugin', 'marketplace', 'list', '--json']);
  return out.code === 0 ? jsonList(out.stdout) : null;
}

/**
 * THE RENDERED FOLDER IS SHARED. A user install and every project install
 * point their `tenjin` marketplace at the same `<data dir>/claude-plugin`, and
 * Claude Code starts the server from it, so removing it while anything still
 * points there breaks that install's next session. It is removed only when
 * all of these prove nothing does: this scope's marketplace was removed or was
 * never there, a fresh, readable `claude plugin marketplace list` (which shows
 * the user's marketplaces and this directory's) names no marketplace at that
 * folder, and no other project install recorded it in its settings. Any
 * doubt keeps the files and names the reason.
 */
async function releaseMarketplaceFolder(
  rendered: string,
  c: {
    marketplace: PluginRemoval['marketplace'];
    run: (a: string[]) => Promise<{ code: number | null; stdout: string }>;
    dataDir: string;
    cwd: string;
  },
): Promise<FolderRemoval | null> {
  if ((await inspectPluginFolder(join(rendered, PLUGIN_DIR))) !== 'ours') return null;
  const keep = (reason: string): FolderRemoval => ({
    path: rendered,
    removed: false,
    left: [],
    reason,
  });
  if (c.marketplace === 'kept')
    return keep(`the ${MARKETPLACE_NAME} marketplace is still registered`);
  if (c.marketplace === 'unread') {
    return keep('claude plugin marketplace list could not be read, so nothing proves it is unused');
  }
  const after = await readMarketplaces(c.run);
  if (after === null) {
    return keep('claude plugin marketplace list could not be read, so nothing proves it is unused');
  }
  if (after.some((m) => typeof m.path === 'string' && resolve(m.path) === resolve(rendered))) {
    return keep('another Claude Code install still points a marketplace at it');
  }
  const project = await projectStillRegistered(c.dataDir, c.cwd);
  if (project !== null) return keep(`the project install in ${project} still uses it`);
  return removeMarketplaceFolder(rendered);
}

/**
 * A project, other than `cwd`, that `install --project` recorded and whose
 * `.claude/settings.local.json` still names the plugin or its marketplace.
 */
async function projectStillRegistered(dataDir: string, cwd: string): Promise<string | null> {
  const config = await loadRawConfig(dataDir).catch(() => null);
  for (const dir of config?.install?.routerProjects ?? []) {
    if (resolve(dir) === resolve(cwd)) continue;
    const local = await readFile(join(dir, '.claude', 'settings.local.json'), 'utf8')
      .then(
        (raw) =>
          JSON.parse(raw) as {
            enabledPlugins?: Record<string, unknown>;
            extraKnownMarketplaces?: Record<string, unknown>;
          },
      )
      .catch(() => null);
    if (
      local?.enabledPlugins?.[PLUGIN_ID] !== undefined ||
      local?.extraKnownMarketplaces?.[MARKETPLACE_NAME] !== undefined
    ) {
      return dir;
    }
  }
  return null;
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
  if (plugin.marketplace === 'unread') {
    lines.push(
      `marketplace: claude plugin marketplace list could not be read, so the ${MARKETPLACE_NAME} marketplace was left as it is`,
    );
  }
  const rendered = plugin.marketplaceFolder;
  if (rendered?.removed === true) lines.push(`removed the marketplace folder ${rendered.path}`);
  else if (rendered !== undefined) {
    lines.push(
      `kept the marketplace folder ${rendered.path}: ${rendered.reason ?? 'still in use'}`,
    );
  }
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
