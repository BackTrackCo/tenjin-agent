import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { emitNotice } from './output';
import type { Io } from './output';
import { installSkill } from './skill-writer';
import { CLI_SKILL_NAMES, skillsDirsFor } from './skill-wiring';
import { resolveSkillsSource } from './skills-source';

export interface HealDeps {
  io: Io;
  /** The global --json flag; the notice is human-mode only. */
  json: boolean;
  /** Home whose skills directories are healed. Tests inject a temp dir. */
  homeDir?: string;
  /** The packaged skills source. Defaults to resolving it from this module's location. */
  skillsSourceDir?: string;
}

/**
 * Refresh the CLI adapter skills ALREADY in a harness skills directory, so
 * updating the CLI updates the copies `install` wrote instead of leaving an agent
 * on an older version's instructions. Subordinate to the command that ran, like
 * the update nudge: after the envelope, never on stdout, never a failure.
 *
 * Two things it never touches. A skill that is not there is never created:
 * presence is the operator's consent to a directory, and a `tenjin` in
 * ~/.agents/skills is not permission to start writing into ~/.claude/skills. And
 * the hosted `tenjin` mirror is left exactly as found: it mirrors
 * tenjin.blog/skills.md, so an operator may hold a NEWER copy than this package
 * ships, and healing it would undo that and make install's "re-fetch it from
 * tenjin.blog/skills.md" false. Same domain `doctor`'s staleness check compares.
 *
 * Unlocked, on purpose. Concurrent healers write byte-identical content to the
 * same paths through per-file atomic renames, so there is nothing to serialize;
 * a lock here could only make things worse, because one left behind by a killed
 * process would silently disable healing on this machine forever.
 */
export async function healWiredSkills(deps: HealDeps): Promise<void> {
  try {
    const home = deps.homeDir ?? homedir();
    // An empty or relative HOME (sudo/docker env_reset, systemd units) would make
    // every target below relative, healing paths under the working directory.
    if (!isAbsolute(home)) return;

    const present = wiredSkills(home);
    if (present.length === 0) return;
    const source =
      deps.skillsSourceDir ?? resolveSkillsSource(fileURLToPath(new URL('.', import.meta.url)));
    await heal(present, source, deps);
  } catch {
    // Whatever it was, it is the next command's to retry; this one is finished.
  }
}

function wiredSkills(home: string): { dir: string; name: string }[] {
  const found: { dir: string; name: string }[] = [];
  for (const dir of skillsDirsFor(home)) {
    for (const name of CLI_SKILL_NAMES) {
      if (existsSync(join(dir, name, 'SKILL.md'))) found.push({ dir, name });
    }
  }
  return found;
}

async function heal(
  present: readonly { dir: string; name: string }[],
  source: string,
  deps: HealDeps,
): Promise<void> {
  const updated: string[] = [];
  const failed: string[] = [];
  for (const { dir, name } of present) {
    try {
      const { status } = await installSkill(join(source, name), join(dir, name), false, name);
      if (status === 'up-to-date') continue;
      if (!updated.includes(dir)) updated.push(dir);
    } catch {
      // A FIFO at the path, a denied write, a case collision: that skill keeps
      // what it has, and the others are still healed.
      failed.push(join(dir, name));
    }
  }
  const notice = noticeFor(updated, failed);
  if (notice !== null) emitNotice(deps.io, notice, { json: deps.json });
}

/** One line, or null when every skill was already current. */
function noticeFor(updated: string[], failed: string[]): string | null {
  const parts: string[] = [];
  if (updated.length > 0) {
    parts.push(`Updated the Tenjin skills in ${updated.join(' and ')} to match this CLI`);
  }
  if (failed.length > 0) {
    parts.push(`could not update ${failed.join(' and ')} (run \`tenjin install\` for the reason)`);
  }
  return parts.length > 0 ? `${parts.join('; ')}.` : null;
}
