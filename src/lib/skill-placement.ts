import { lstatSync } from 'node:fs';
import { constants, open, readdir, rm, rmdir } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { hasCode } from './errno';

/**
 * What a refresh takes back from each harness's skills directory: the retired
 * `tenjin-pay`, and the shelf's CLI skills, whose `tenjin search` and
 * `tenjin publish` commands the router CLI does not ship.
 */
const RETIRED_SKILL_NAMES = ['tenjin-pay', 'tenjin-search', 'tenjin-publish'] as const;

/**
 * Every file each retired skill shipped, as a path relative to the skill
 * directory. DECLARED rather than discovered, because the packaged source is
 * gone, and "remove exactly the files an earlier install wrote" is not a
 * question a refresh can answer by listing the operator's directory:
 * everything else in there is theirs.
 */
const SHIPPED_SKILL_FILES: Readonly<Record<string, readonly string[]>> = {
  'tenjin-pay': ['SKILL.md'],
  'tenjin-search': ['SKILL.md', 'references/permissions.md'],
  'tenjin-publish': ['SKILL.md', 'references/maintain.md'],
};

/** Every skills directory a harness on this machine reads. */
function skillsDirsFor(home: string): string[] {
  return [join(home, '.claude', 'skills'), join(home, '.agents', 'skills')];
}

function isRealDirectory(path: string): boolean {
  try {
    return lstatSync(path, { throwIfNoEntry: false })?.isDirectory() === true;
  } catch (err) {
    // Linux reports ENOTDIR when an ancestor is a regular file. Nothing can
    // be installed below it, just as with an absent path. Do not follow symlinks.
    if (hasCode(err, 'ENOENT') || hasCode(err, 'ENOTDIR')) return false;
    throw err;
  }
}

/**
 * What reading a SKILL.md found. A skill path is operator-controlled, so it is not
 * necessarily a file at all.
 */
type SkillFileRead =
  | { kind: 'ok'; bytes: Buffer }
  | { kind: 'absent' }
  | { kind: 'not-regular' }
  | { kind: 'unreadable'; err: unknown };

/**
 * Read a SKILL.md through ONE descriptor, and only when it is a regular file.
 *
 * `readFile` on a FIFO blocks until a writer appears, and on a character device it
 * streams without end; neither call fails, so no error handling reaches them. A
 * pipe at a wired SKILL.md path hung `tenjin install` past SIGTERM. Opening
 * non-blocking returns immediately whatever the node type is, `fstat` on that
 * descriptor says what it actually is, and only a regular file is read. Checking
 * the pathname and then reading the pathname would let the two answer about
 * different files.
 *
 * O_NONBLOCK does not exist on Windows, where it degrades to 0; FIFOs are not a
 * meaningful case there.
 */
async function readSkillFile(path: string): Promise<SkillFileRead> {
  let handle: FileHandle;
  try {
    handle = await open(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
  } catch (err) {
    if (hasCode(err, 'ENOENT')) return { kind: 'absent' };
    return { kind: 'unreadable', err };
  }
  try {
    if (!(await handle.stat()).isFile()) return { kind: 'not-regular' };
    return { kind: 'ok', bytes: await handle.readFile() };
  } catch (err) {
    return { kind: 'unreadable', err };
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/**
 * The `name:` a SKILL.md declares in its leading frontmatter, or null when it
 * declares none. It is what a harness registers the skill AS, so it is also the
 * cheapest evidence that a file at one of our paths is one of ours. Deliberately
 * not a general YAML parse: only the leading `---` block is read.
 */
function skillFrontmatterName(skillMd: string): string | null {
  // Tolerate a UTF-8 BOM, CRLF, and leading blank lines before the opening fence.
  const lines = skillMd.replace(/^\uFEFF/, '').split(/\r?\n/);
  const start = lines.findIndex((l) => l.trim().length > 0);
  if (start === -1 || lines[start]?.trim() !== '---') return null;
  const end = lines.findIndex((l, i) => i > start && l.trim() === '---');
  if (end === -1) return null;
  for (const line of lines.slice(start + 1, end)) {
    const m = /^name:\s*(.+?)\s*$/.exec(line);
    if (m !== null) return (m[1] ?? '').replace(/^["']|["']$/g, '');
  }
  return null;
}

/**
 * Remove only the files our named skill shipped (SKILL.md last, as the ownership
 * proof), then any directory they leave empty; preserve foreign skills and
 * adjacent user files.
 */
export async function removeOwnedSkill(
  name: string,
  skillsDir: string,
): Promise<{ changed: boolean }> {
  if (!isRealDirectory(skillsDir)) {
    return { changed: false };
  }
  const skillDir = join(skillsDir, name);
  if (!isRealDirectory(skillDir)) {
    return { changed: false };
  }
  const path = join(skillDir, 'SKILL.md');
  const read = await readSkillFile(path);
  if (read.kind === 'absent') return { changed: false };
  if (read.kind !== 'ok' || skillFrontmatterName(read.bytes.toString('utf8')) !== name) {
    return { changed: false }; // not ours to delete for sitting at our path
  }
  const shipped = SHIPPED_SKILL_FILES[name] ?? [];
  const subdirs = new Set<string>();
  for (const rel of shipped) {
    if (rel === 'SKILL.md') continue;
    const file = join(skillDir, rel);
    // A symlinked `references/` would route the delete outside the skill.
    if (!isRealDirectory(dirname(file))) continue;
    subdirs.add(dirname(file));
    if (lstatSync(file, { throwIfNoEntry: false })?.isFile() === true) await rm(file);
  }
  await rm(path, { force: true });
  for (const dir of [...subdirs, skillDir].sort((a, b) => b.length - a.length)) {
    const rest = await readdir(dir).catch(() => null);
    if (rest !== null && rest.length === 0) await rmdir(dir).catch(() => undefined);
  }
  return { changed: true };
}

/**
 * Refresh retires obsolete skills without needing their old packaged source:
 * see {@link RETIRED_SKILL_NAMES}.
 */
export async function removeRetiredSkills(home: string, project?: string): Promise<string[]> {
  const removed: string[] = [];
  const dirs = [...skillsDirsFor(home), ...(project ? skillsDirsFor(project) : [])];
  for (const dir of new Set(dirs)) {
    for (const name of RETIRED_SKILL_NAMES) {
      if ((await removeOwnedSkill(name, dir)).changed) removed.push(join(dir, name));
    }
  }
  return removed;
}
