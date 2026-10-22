import { lstat, readdir, readFile, rm, rmdir } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import { writeFileAtomic } from '../lib/atomic-json';
import { PLUGIN_NAME } from './names';
import { MOD_FILES, OWNER_MARKER, PLUGIN_FILES, type ModSources } from './plugin-files';

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

/**
 * The mod's files from a plugin folder that carries them (the package's own
 * `dist/hosts/claude/tenjin`), or undefined when any is missing: the folder
 * fallback then writes the legs and the server without the mod.
 */
export async function readModSources(pluginDir: string): Promise<ModSources | undefined> {
  const entries = await Promise.all(
    MOD_FILES.map(async (path) => [path, await readFile(join(pluginDir, path), 'utf8')] as const),
  ).catch(() => null);
  return entries === null ? undefined : (Object.fromEntries(entries) as ModSources);
}

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
