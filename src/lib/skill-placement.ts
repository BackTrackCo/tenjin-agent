import { lstatSync } from 'node:fs';
import { readdir, rm, rmdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { emitWriteNotice } from './output';
import type { Io } from './output';
import { readSkillFile, skillFrontmatterName, skillsDirsFor } from './skill-wiring';
import { installSkill } from './skill-writer';
import { OPTIONAL_PAY_SKILL, SKILL_NAMES, resolveSkillsSource } from './skills-source';

/**
 * Optional skills, where PRESENCE is the whole mechanism: the tenjin-pay skill
 * is on disk exactly while the `bazaarPay` toggle is on, so an agent is never
 * taught a lane the operator turned off, and turning the lane on is what makes
 * the teaching appear. No conditional content, no markers: the unit of
 * consent stays the one the whole pipeline already has, a skill directory.
 *
 * Removal follows `uninstall`'s rules exactly (lib/uninstall removeSkills):
 * only a SKILL.md whose frontmatter still claims our name is ours to delete,
 * and the directory goes only when our file was the only thing in it, so an
 * operator's own files beside it survive a toggle-off.
 */

/** Ensure `name` is present or absent under one skills directory. */
export async function placeOptionalSkill(
  name: string,
  skillsDir: string,
  skillsSource: string,
  present: boolean,
): Promise<{ changed: boolean }> {
  const skillDir = join(skillsDir, name);
  if (present) {
    const { status } = await installSkill(join(skillsSource, name), skillDir, false, name);
    return { changed: status !== 'up-to-date' };
  }
  if (lstatSync(skillDir, { throwIfNoEntry: false })?.isDirectory() !== true) {
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

/**
 * The `config set bazaarPay` twin of the heal: converge the tenjin-pay skill's
 * presence with the toggle across every skills directory a tenjin skill is
 * already wired into (presence of any shipped skill is the operator's consent
 * to a directory; an unwired directory is never created). Operator act, so
 * failures degrade per directory and doctor reports what remains.
 */
export async function syncBazaarSkill(
  enabled: boolean,
  deps: { io: Io; homeDir?: string; skillsSourceDir?: string },
): Promise<void> {
  const home = deps.homeDir ?? homedir();
  if (!isAbsolute(home)) return;
  let source: string;
  try {
    source =
      deps.skillsSourceDir ?? resolveSkillsSource(fileURLToPath(new URL('.', import.meta.url)));
  } catch {
    return; // no readable source: nothing safe to write, nothing to remove FROM
  }
  const touched: string[] = [];
  for (const dir of skillsDirsFor(home)) {
    try {
      if (lstatSync(dir, { throwIfNoEntry: false })?.isDirectory() !== true) continue;
      const consented = SKILL_NAMES.some(
        (name) =>
          lstatSync(join(dir, name, 'SKILL.md'), { throwIfNoEntry: false })?.isFile() === true,
      );
      if (!consented) continue;
      const { changed } = await placeOptionalSkill(OPTIONAL_PAY_SKILL, dir, source, enabled);
      if (changed) touched.push(join(dir, OPTIONAL_PAY_SKILL));
    } catch {
      // This directory keeps what it has; `tenjin doctor` reports the drift.
    }
  }
  if (touched.length > 0) {
    emitWriteNotice(
      deps.io,
      `${enabled ? 'Installed' : 'Removed'} ${touched.join(' and ')} to match bazaarPay.`,
    );
  }
}
