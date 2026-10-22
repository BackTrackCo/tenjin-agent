import { readFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { versionFreeEntry } from '../commands/update';
import {
  claudeConfigDir,
  jsonList,
  jsonResult,
  runClaude,
  type ClaudeBinary,
  type ClaudeRun,
} from './claude-cli';
import { MARKETPLACE_NAME, PLUGIN_ID, PLUGIN_NAME, SKILLS_DIR_PLUGIN_ID } from './names';
import { PLUGIN_DIR, renderPluginFiles } from './plugin-files';
import {
  inspectPluginFolder,
  pluginFolderPath,
  removePluginFolder,
  writePluginFolder,
  type FolderRemoval,
} from './plugin-folder';

/**
 * REGISTERING THE PLUGIN, WITH NO STEP LEFT TO THE PERSON. With a `claude`
 * binary (on PATH, or the one Claude Code names in `CLAUDE_CODE_EXECPATH`):
 *
 *   claude plugin marketplace add <package>/dist/hosts/claude --json
 *   claude plugin install tenjin@tenjin --scope <scope> --json
 *   claude plugin update tenjin@tenjin --scope <scope> --json   (only when the version moved)
 *
 * The marketplace is a `directory` source read in place from the installed
 * package, so there is no git or network step and the plugin is the CLI's own
 * build. Each command is non-interactive, idempotent and answers one JSON line
 * (lab, Claude Code 2.1.296): a second `add` of the same folder is a no-op, an
 * `add` of a moved folder repoints the marketplace, and `install` of an
 * installed plugin reports both versions. No binary, or a command that fails:
 * the plugin is written as a folder under the config dir's `skills/`, which
 * Claude Code loads with no command at all.
 */

export type PluginScope = 'user' | 'local';

export interface RegistrationStep {
  command: string;
  ok: boolean;
  detail?: string;
}

export interface PluginRegistration {
  /** `plugin` through Claude's commands, `skills-dir` as a folder, `none` when neither worked. */
  method: 'plugin' | 'skills-dir' | 'none';
  /** The id Claude Code lists it under. */
  id: string | null;
  scope: PluginScope;
  /**
   * `installed` (new), `updated` (the version moved), `current` (already this
   * build), `written` (the folder), `deferred` (left for a newer Claude Code,
   * with a settings install still routing), or `failed` (nothing registered).
   */
  state: 'installed' | 'updated' | 'current' | 'written' | 'deferred' | 'failed';
  /** The marketplace folder or the plugin folder. */
  path?: string;
  version: string;
  steps: RegistrationStep[];
  /** Why the folder was written instead of running the commands. */
  fallbackReason?: string;
  /** Why nothing was registered. */
  reason?: string;
  /** A folder an earlier fallback wrote, removed because the commands now registered the plugin. */
  supersededFolder?: FolderRemoval;
}

export interface RegisterOptions {
  binary: ClaudeBinary | null;
  scope: PluginScope;
  /** The CLI version the plugin files carry. */
  version: string;
  env: NodeJS.ProcessEnv;
  home: string;
  cwd: string;
  /** The marketplace folder; defaults to this package's `dist/hosts/claude`. */
  hostsDir?: string | null;
  /** The CLI entry the folder fallback's commands run. Defaults to this package's `dist/index.js`. */
  cliEntry?: string;
}

/** Where the folder fallback lives for this scope. */
export function folderFor(scope: PluginScope, env: NodeJS.ProcessEnv, home: string, cwd: string) {
  return pluginFolderPath(scope === 'local' ? join(cwd, '.claude') : claudeConfigDir(env, home));
}

export async function registerPlugin(opts: RegisterOptions): Promise<PluginRegistration> {
  const folder = folderFor(opts.scope, opts.env, opts.home, opts.cwd);
  const steps: RegistrationStep[] = [];
  let fallbackReason: string;
  if (opts.binary !== null) {
    const hosts = opts.hostsDir === undefined ? await packageHostsDir() : opts.hostsDir;
    if (hosts === null) {
      fallbackReason = 'this build carries no plugin marketplace folder (dist/hosts/claude)';
    } else {
      const done = await viaPluginCommands(opts.binary, hosts, opts, steps);
      if (done.ok) {
        // A folder an earlier fallback wrote would load as a second copy.
        const superseded = await removePluginFolder(folder);
        return {
          method: 'plugin',
          id: PLUGIN_ID,
          scope: opts.scope,
          state: done.state,
          path: hosts,
          version: opts.version,
          steps,
          ...(superseded.removed ? { supersededFolder: superseded } : {}),
        };
      }
      fallbackReason = done.reason;
    }
    // NO SECOND COPY. A plugin Claude Code already has (an earlier install
    // whose update just failed, or a `tenjin` from another marketplace) would
    // load beside the folder, and every event would run both sets of legs and
    // pay twice. It is left as it is, and the run reports the failure.
    const existing = await existingCopy(opts.binary, opts.env, opts.home, opts.cwd);
    if (existing !== null) {
      return {
        method: 'none',
        id: existing,
        scope: opts.scope,
        state: 'failed',
        version: opts.version,
        steps,
        reason: `${fallbackReason}; ${existing} is already in Claude Code and was left as it is, so no second copy was written`,
      };
    }
  } else {
    fallbackReason = 'no claude binary on PATH or in CLAUDE_CODE_EXECPATH';
    // A plugin Claude's commands registered earlier must not get a second copy.
    if (await installedThroughCommands(opts.env, opts.home)) {
      return {
        method: 'plugin',
        id: PLUGIN_ID,
        scope: opts.scope,
        state: 'current',
        version: opts.version,
        steps,
        fallbackReason: `${fallbackReason}; ${PLUGIN_ID} is already registered, so it was left as it is`,
      };
    }
  }
  const written = await writePluginFolder(
    folder,
    renderPluginFiles(opts.version, opts.cliEntry ?? packageCliEntry()),
  );
  if (written.state === 'written') {
    return {
      method: 'skills-dir',
      id: SKILLS_DIR_PLUGIN_ID,
      scope: opts.scope,
      state: 'written',
      path: folder,
      version: opts.version,
      steps,
      fallbackReason,
    };
  }
  return {
    method: 'none',
    id: null,
    scope: opts.scope,
    state: 'failed',
    path: folder,
    version: opts.version,
    steps,
    fallbackReason,
    reason: written.reason ?? 'the plugin folder could not be written',
  };
}

type CommandsOutcome =
  { ok: true; state: 'installed' | 'updated' | 'current' } | { ok: false; reason: string };

async function viaPluginCommands(
  binary: ClaudeBinary,
  hosts: string,
  opts: RegisterOptions,
  steps: RegistrationStep[],
): Promise<CommandsOutcome> {
  const run = (args: string[]) => runClaude(binary, args, { env: opts.env, cwd: opts.cwd });
  const scopeArgs = ['--scope', opts.scope];
  // The marketplace is declared at user scope by default, the form every
  // release since 2.1.287 takes; only a project install names its scope.
  const marketplaceScope = opts.scope === 'user' ? [] : scopeArgs;

  // A marketplace called `tenjin` that is not this package's is somebody
  // else's, and `add` would repoint it: it is left alone. So is every
  // marketplace when the list cannot be read, because an unread list cannot
  // prove there is no such marketplace to repoint.
  const known = await run(['plugin', 'marketplace', 'list', '--json']);
  const listed = known.code === 0 ? jsonList(known.stdout) : null;
  steps.push({
    command: 'claude plugin marketplace list --json',
    ok: listed !== null,
    ...(listed === null ? { detail: commandDetail(known) } : {}),
  });
  if (listed === null) {
    return {
      ok: false,
      reason: `claude plugin marketplace list could not be read (${commandDetail(known)}), so no marketplace was added or repointed`,
    };
  }
  const existing = listed.find((m) => m.name === MARKETPLACE_NAME);
  if (existing !== undefined && !(await ownMarketplace(existing))) {
    return {
      ok: false,
      reason: `a marketplace named ${MARKETPLACE_NAME} that this CLI did not add is already configured, so it was left as it is`,
    };
  }

  const add = await step(
    steps,
    ['plugin', 'marketplace', 'add', hosts, '--json', ...marketplaceScope],
    run,
  );
  if (!add.ok) return { ok: false, reason: `claude plugin marketplace add failed: ${add.detail}` };
  const install = await step(steps, ['plugin', 'install', PLUGIN_ID, ...scopeArgs, '--json'], run);
  if (!install.ok) return { ok: false, reason: `claude plugin install failed: ${install.detail}` };
  const installed = install.result?.installedVersion;
  const available = install.result?.availableVersion;
  if (typeof installed !== 'string' || typeof available !== 'string') {
    return { ok: true, state: 'installed' };
  }
  if (installed === available) return { ok: true, state: 'current' };
  const update = await step(steps, ['plugin', 'update', PLUGIN_ID, ...scopeArgs, '--json'], run);
  if (!update.ok) return { ok: false, reason: `claude plugin update failed: ${update.detail}` };
  return { ok: true, state: 'updated' };
}

async function step(
  steps: RegistrationStep[],
  args: string[],
  run: (args: string[]) => Promise<ClaudeRun>,
): Promise<{ ok: boolean; detail: string; result: Record<string, unknown> | null }> {
  const out = await run(args);
  const result = jsonResult(out.stdout);
  const ok =
    out.code === 0 && (result === null || result.outcome === undefined || result.outcome === 'ok');
  const detail = commandDetail(out, result);
  steps.push({ command: `claude ${args.join(' ')}`, ok, ...(ok ? {} : { detail }) });
  return { ok, detail, result };
}

/** What a failed command said: its JSON message, else its output, else how it ended. */
function commandDetail(out: ClaudeRun, result: Record<string, unknown> | null = null): string {
  if (typeof result?.message === 'string') return result.message;
  const text = (out.stderr || out.stdout).trim().slice(0, 300);
  if (text.length > 0) return text;
  return out.code === null ? 'the command could not be run' : `exit ${out.code}`;
}

/**
 * Is this marketplace one `install` added? A directory source whose plugin
 * folder carries the `tenjin-cli` marker in its manifest, or, when that folder
 * is gone (a package manager removed the old version's directory), one whose
 * path is a `tenjin-cli` package's `dist/hosts/claude`.
 */
export async function ownMarketplace(row: Record<string, unknown>): Promise<boolean> {
  const path = typeof row.path === 'string' ? row.path : undefined;
  if (row.source !== 'directory' || path === undefined) return false;
  if ((await stat(path).catch(() => null)) === null) {
    return /tenjin-cli[\\/]dist[\\/]hosts[\\/]claude$/.test(path);
  }
  return (await inspectPluginFolder(join(path, PLUGIN_DIR))) === 'ours';
}

/**
 * A `tenjin` plugin Claude Code already holds that a folder would duplicate:
 * any enabled `tenjin@<marketplace>`. The folder's own `tenjin@skills-dir` is
 * not a duplicate, since writing the folder updates it in place. When the list
 * cannot be read, Claude Code's own record of installed plugins answers.
 */
async function existingCopy(
  binary: ClaudeBinary,
  env: NodeJS.ProcessEnv,
  home: string,
  cwd: string,
): Promise<string | null> {
  const out = await runClaude(binary, ['plugin', 'list', '--json'], { env, cwd });
  const listed = out.code === 0 ? jsonList(out.stdout) : null;
  if (listed === null) return (await installedThroughCommands(env, home)) ? PLUGIN_ID : null;
  const row = listed.find(
    (p) =>
      typeof p.id === 'string' &&
      p.id.startsWith(`${PLUGIN_NAME}@`) &&
      p.id !== SKILLS_DIR_PLUGIN_ID &&
      p.enabled === true,
  );
  return typeof row?.id === 'string' ? row.id : null;
}

/** Claude Code's own record of installed plugins, read when no binary can be asked. */
async function installedThroughCommands(env: NodeJS.ProcessEnv, home: string): Promise<boolean> {
  try {
    const raw = await readFile(
      join(claudeConfigDir(env, home), 'plugins', 'installed_plugins.json'),
      'utf8',
    );
    const plugins = (JSON.parse(raw) as { plugins?: unknown }).plugins;
    return plugins !== null && typeof plugins === 'object' && PLUGIN_ID in plugins;
  } catch {
    return false;
  }
}

/**
 * THIS PACKAGE'S MARKETPLACE FOLDER, `dist/hosts/claude`, beside the bundle
 * that is running. Under pnpm the running path pins a version
 * (`.pnpm/tenjin-cli@<v>/...`), and a marketplace registered there would point
 * at a directory the next upgrade deletes, so the version-free path beside the
 * store is used when it exists, as `tenjin update` does for its re-exec.
 */
export async function packageHostsDir(
  moduleDir: string = dirname(fileURLToPath(import.meta.url)),
): Promise<string | null> {
  const catalog = join(moduleDir, 'hosts', 'claude', '.claude-plugin', 'marketplace.json');
  const stable = versionFreeEntry(catalog) ?? catalog;
  if ((await stat(stable).catch(() => null))?.isFile() !== true) return null;
  return dirname(dirname(stable));
}

/**
 * THIS PACKAGE'S CLI ENTRY, `dist/index.js` beside the running bundle, for a
 * plugin folder outside the package. The version-free path under pnpm, as
 * {@link packageHostsDir} uses, so an upgrade does not strand it.
 */
export function packageCliEntry(
  moduleDir: string = dirname(fileURLToPath(import.meta.url)),
): string {
  const entry = join(moduleDir, 'index.js');
  return versionFreeEntry(entry) ?? entry;
}

/** Doctor's and the migration's read: is the plugin installed and enabled? */
export interface PluginListing {
  /** The row for `tenjin@tenjin` or `tenjin@skills-dir`, when Claude Code lists one. */
  id: string | null;
  enabled: boolean;
  version: string | null;
  /** False when the list itself could not be read. */
  read: boolean;
  /** The chosen row's scope (`user`, `project`, `local`), or null when it names none. */
  scope: string | null;
  /**
   * The projects a `tenjin@tenjin` install is recorded for and NOT enabled
   * here: each row's `projectPath`. A `local` install made in one project is
   * listed from every other directory as disabled, and enabling it there is
   * not the fix; running from that project is. Empty when the list was not
   * read or names none.
   */
  projects: string[];
}

export async function readPluginListing(
  binary: ClaudeBinary,
  env: NodeJS.ProcessEnv,
  cwd: string,
): Promise<PluginListing> {
  const out = await runClaude(binary, ['plugin', 'list', '--json'], { env, cwd });
  const rows = out.code === 0 ? jsonList(out.stdout) : null;
  if (rows === null) {
    return { id: null, enabled: false, version: null, read: false, scope: null, projects: [] };
  }
  const projects = rows
    .filter(
      (r) =>
        r.id === PLUGIN_ID &&
        r.enabled !== true &&
        typeof r.projectPath === 'string' &&
        r.projectPath.length > 0,
    )
    .map((r) => r.projectPath as string);
  const row =
    rows.find((r) => r.id === PLUGIN_ID && r.enabled === true) ??
    rows.find((r) => r.id === SKILLS_DIR_PLUGIN_ID && r.enabled === true) ??
    rows.find((r) => r.id === PLUGIN_ID || r.id === SKILLS_DIR_PLUGIN_ID);
  if (row === undefined) {
    return { id: null, enabled: false, version: null, read: true, scope: null, projects };
  }
  return {
    id: String(row.id),
    enabled: row.enabled === true,
    version: typeof row.version === 'string' ? row.version : null,
    read: true,
    scope: typeof row.scope === 'string' ? row.scope : null,
    projects,
  };
}

/** Is a folder of ours there for this scope? */
export async function folderState(
  scope: PluginScope,
  env: NodeJS.ProcessEnv,
  home: string,
  cwd: string,
): Promise<{ path: string; state: 'absent' | 'ours' | 'foreign' }> {
  const path = folderFor(scope, env, home, cwd);
  return { path, state: await inspectPluginFolder(path) };
}
