import { lstatSync } from 'node:fs';
import { readdir, rm, rmdir } from 'node:fs/promises';
import { join } from 'node:path';
import { readSkillFile, skillFrontmatterName, skillsDirsFor } from './skill-wiring';
import { RETIRED_SKILL_NAMES } from './skills-source';
import { hasCode } from './errno';

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

/** Remove only our named skill file; preserve foreign skills and adjacent user files. */
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
  await rm(path, { force: true });
  const rest = await readdir(skillDir).catch(() => null);
  if (rest !== null && rest.length === 0) await rmdir(skillDir).catch(() => undefined);
  return { changed: true };
}

/** Refresh retires obsolete skills without needing their old packaged source. */
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
