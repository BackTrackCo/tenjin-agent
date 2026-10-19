import { lstat, readdir, readFile, rm, rmdir } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import { writeFileAtomic } from '../lib/atomic-json';
import { PLUGIN_NAME } from './names';
import { MARKETPLACE_FILE, OWNER_MARKER, PLUGIN_DIR, PLUGIN_FILES } from './plugin-files';

/**
 * THE FOLDER FALLBACK: the plugin as a folder under a config dir's `skills/`,
 * which Claude Code loads in place as `tenjin@skills-dir` with no `claude`
 * command at all (lab, 2026-10-09: the manifest's name wins over the folder's).
 * `install` writes it only where it cannot run `claude plugin`.
 *
 * OWNERSHIP RULES. Only `tenjin-router/` is ever touched, never `skills/tenjin`,
 * where tenjin.sh tells readers to drop its hosted skill. The folder is ours
 * only when it is a real directory (never followed through a link) whose
 * manifest names `tenjin` and carries the `tenjin-cli` marker. Inside it, only
 * the paths in {@link PLUGIN_FILES} are written or unlinked, so a user's own
 * `skills/` or `commands/` there survive every update and uninstall.
 */

export const FOLDER_NAME = 'tenjin-router';

/** `<base>/skills/tenjin-router`, for a config dir or a project's `.claude`. */
export function pluginFolderPath(base: string): string {
  return join(base, 'skills', FOLDER_NAME);
}

export type FolderState = 'absent' | 'ours' | 'foreign';

export async function inspectPluginFolder(dir: string): Promise<FolderState> {
  const entry = await lstat(dir).catch(() => null);
  if (entry === null) return 'absent';
  if (!entry.isDirectory() || entry.isSymbolicLink()) return 'foreign';
  try {
    const manifest = JSON.parse(
      await readFile(join(dir, '.claude-plugin', 'plugin.json'), 'utf8'),
    ) as { name?: unknown; metadata?: Record<string, unknown> };
    const marked =
      manifest.metadata !== null &&
      typeof manifest.metadata === 'object' &&
      OWNER_MARKER in manifest.metadata;
    return manifest.name === PLUGIN_NAME && marked ? 'ours' : 'foreign';
  } catch {
    return 'foreign';
  }
}

export interface FolderWrite {
  path: string;
  state: 'written' | 'refused';
  reason?: string;
}

/**
 * Write the listed files, each atomically (a temp file in its own directory,
 * renamed over the file), the manifest last. A folder that exists and is not
 * ours is refused and reported, never overwritten.
 */
export async function writePluginFolder(
  dir: string,
  files: Record<string, string>,
): Promise<FolderWrite> {
  const state = await inspectPluginFolder(dir);
  if (state === 'foreign') {
    return {
      path: dir,
      state: 'refused',
      reason: `${dir} exists and is not a folder this CLI wrote, so it was left as it is`,
    };
  }
  try {
    for (const path of PLUGIN_FILES) {
      const body = files[path];
      if (body === undefined) continue;
      await writeFileAtomic(join(dir, path), body);
    }
  } catch (err) {
    return {
      path: dir,
      state: 'refused',
      reason: err instanceof Error ? err.message : String(err),
    };
  }
  return { path: dir, state: 'written' };
}

export interface FolderRemoval {
  path: string;
  /** False when there was no folder of ours to remove. */
  removed: boolean;
  /** What is left in the folder that is not ours, relative to it. */
  left: string[];
  reason?: string;
}

/**
 * Unlink the listed files, remove the subfolders they leave empty, deepest
 * first, and the folder itself only when it is then empty. Never recursive.
 */
export async function removePluginFolder(dir: string): Promise<FolderRemoval> {
  const state = await inspectPluginFolder(dir);
  if (state === 'absent') return { path: dir, removed: false, left: [] };
  if (state === 'foreign') {
    return {
      path: dir,
      removed: false,
      left: [],
      reason: `${dir} is not a folder this CLI wrote, so nothing in it was removed`,
    };
  }
  for (const path of PLUGIN_FILES) await rm(join(dir, path), { force: true });
  const subdirs = [...new Set(PLUGIN_FILES.map((p) => dirname(p)).filter((d) => d !== '.'))].sort(
    (a, b) => b.split('/').length - a.split('/').length,
  );
  for (const sub of subdirs) await rmdir(join(dir, sub)).catch(() => undefined);
  const left = await listFiles(dir);
  if (left.length === 0) await rmdir(dir).catch(() => undefined);
  return { path: dir, removed: true, left };
}

async function listFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (current: string): Promise<void> => {
    for (const entry of await readdir(current, { withFileTypes: true }).catch(() => [])) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) await walk(path);
      else out.push(relative(dir, path).split(sep).join('/'));
    }
  };
  await walk(dir);
  return out.sort();
}

/**
 * THE MARKETPLACE FOLDER `install` RENDERS, `<data dir>/claude-plugin`: the
 * catalog and the plugin under {@link PLUGIN_DIR}, with every command pinned to
 * absolute paths. It is a `directory` marketplace, which Claude Code reads in
 * place, so these files are what runs, not a cache copy a plugin update
 * replaces. Only {@link MARKETPLACE_FILE} and the plugin's
 * {@link PLUGIN_FILES} are ever written or unlinked here.
 */
export const MARKETPLACE_FOLDER = 'claude-plugin';

export function marketplaceFolderPath(dataDir: string): string {
  return join(dataDir, MARKETPLACE_FOLDER);
}

/** The plugin's files out of a marketplace render (`<plugin dir>/<path>`), by plugin path. */
function pluginPart(files: Record<string, string>): Record<string, string> {
  const prefix = `${PLUGIN_DIR}/`;
  return Object.fromEntries(
    Object.entries(files)
      .filter(([path]) => path.startsWith(prefix))
      .map(([path, body]) => [path.slice(prefix.length), body]),
  );
}

/**
 * Write a marketplace render: the plugin first (its manifest last), then the
 * catalog, so Claude Code never reads a catalog naming a plugin that is not
 * there yet. A plugin folder there that is not ours is refused.
 */
export async function writeMarketplaceFolder(
  dir: string,
  files: Record<string, string>,
): Promise<FolderWrite> {
  const plugin = await writePluginFolder(join(dir, PLUGIN_DIR), pluginPart(files));
  if (plugin.state !== 'written') return { ...plugin, path: dir };
  const catalog = files[MARKETPLACE_FILE];
  try {
    if (catalog !== undefined) await writeFileAtomic(join(dir, MARKETPLACE_FILE), catalog);
  } catch (err) {
    return {
      path: dir,
      state: 'refused',
      reason: err instanceof Error ? err.message : String(err),
    };
  }
  return { path: dir, state: 'written' };
}

/**
 * Bring a marketplace folder of ours up to `files`, rewriting only when a byte
 * differs. Nothing is created: no folder of ours here means `install` did not
 * register one, and nothing then points Claude Code at this path.
 */
export async function refreshMarketplaceFolder(
  dir: string,
  files: Record<string, string>,
): Promise<'absent' | 'current' | 'rewritten' | 'refused'> {
  if ((await inspectPluginFolder(join(dir, PLUGIN_DIR))) !== 'ours') return 'absent';
  const differs = await Promise.all(
    Object.entries(files).map(async ([path, body]) => {
      const now = await readFile(join(dir, path), 'utf8').catch(() => null);
      return now !== body;
    }),
  );
  if (!differs.includes(true)) return 'current';
  return (await writeMarketplaceFolder(dir, files)).state === 'written' ? 'rewritten' : 'refused';
}

/** Remove a marketplace folder of ours: the plugin's files, the catalog, then the folders they leave empty. */
export async function removeMarketplaceFolder(dir: string): Promise<FolderRemoval> {
  const plugin = await removePluginFolder(join(dir, PLUGIN_DIR));
  if (!plugin.removed) return { ...plugin, path: dir };
  await rm(join(dir, MARKETPLACE_FILE), { force: true });
  await rmdir(join(dir, dirname(MARKETPLACE_FILE))).catch(() => undefined);
  const left = await listFiles(dir);
  if (left.length === 0) await rmdir(dir).catch(() => undefined);
  return { path: dir, removed: true, left };
}
