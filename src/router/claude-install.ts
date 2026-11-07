import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { userMcpFile, userSettingsPath } from './claude-cli';
import { inspectLegacyInstall, projectMcpFile } from './legacy-install';
import { PLUGIN_ID } from './names';
import { folderState, installedThroughCommands, type PluginScope } from './plugin-registration';

/**
 * Is Tenjin installed for Claude Code here? Read from disk, with no `claude`
 * binary asked. Install, uninstall, doctor and the host record each count
 * different signs of an install, so each caller names the ones it counts.
 */

/**
 * What shows an install of ours, read in this order and only when named. A
 * file that cannot be read shows nothing.
 *
 * - `record`: Claude Code's own `plugins/installed_plugins.json` lists
 *   `tenjin@tenjin`, in any scope.
 * - `enabled`: the project's `.claude/settings.local.json` enables it (a
 *   project only).
 * - `folder`: the plugin folder of ours for the scope.
 * - `settings`: anything the settings install of an earlier release left in
 *   the scope: its hook entries, rules, status line or `x402` server.
 * - `settings-hooks`: only that settings install's hook entries.
 *
 * SHIM: the two settings signs go with `legacy-install.ts`, on or after 2026-12-01.
 */
export type InstallSign = 'record' | 'enabled' | 'folder' | 'settings' | 'settings-hooks';

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

/** Does any of `signs` show an install of ours at `scope` (for a project, the one in `cwd`)? */
export async function claudeInstallAt(
  scope: PluginScope,
  env: NodeJS.ProcessEnv,
  home: string,
  cwd: string,
  signs: readonly InstallSign[],
): Promise<boolean> {
  const counts = (sign: InstallSign): boolean => signs.includes(sign);
  if (counts('record') && (await installedThroughCommands(env, home))) return true;
  if (counts('enabled') && scope === 'local' && (await enabledIn(cwd))) return true;
  if (counts('folder') && (await folderState(scope, env, home, cwd)).state === 'ours') return true;
  if (!counts('settings') && !counts('settings-hooks')) return false;
  const paths = settingsInstallPaths(scope === 'local', env, home, cwd);
  const legacy = await inspectLegacyInstall(paths.settingsPath, paths.mcpFile);
  return counts('settings') ? legacy.present : legacy.events.length > 0;
}

/** `tenjin@tenjin` enabled in the project's own `.claude/settings.local.json`. */
async function enabledIn(dir: string): Promise<boolean> {
  const local = await readFile(join(dir, '.claude', 'settings.local.json'), 'utf8')
    .then((raw) => JSON.parse(raw) as { enabledPlugins?: Record<string, unknown> })
    .catch(() => null);
  return local?.enabledPlugins?.[PLUGIN_ID] === true;
}
