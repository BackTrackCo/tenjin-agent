import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withFileLock } from './lock';
import { emitNotice } from './output';
import type { Io } from './output';
import { skillsHealLockPath } from './paths';
import { installSkill } from './skill-writer';
import { HOSTED_SKILL_NAME, skillsDirsFor } from './skill-wiring';
import { resolveSkillsSource, SKILL_NAMES } from './skills-source';

export interface HealDeps {
  /** Data dir, for the dedup lock. */
  dir: string;
  io: Io;
  /** The global --json flag; the notice is human-mode only. */
  json: boolean;
  /** Home whose skills directories are healed. Tests inject a temp dir. */
  homeDir?: string;
  /** The packaged skills source. Defaults to resolving it from this module's location. */
  skillsSourceDir?: string;
}

/**
 * Refresh every shipped skill that is ALREADY in a harness skills directory, so
 * updating the CLI updates the copies `install` wrote instead of leaving an agent
 * on an older version's instructions. Subordinate to the command that ran, like
 * the update nudge: after the envelope, never on stdout, never a failure.
 *
 * Never creates a skill that is not there. Presence is the operator's consent to
 * a directory, and a `tenjin` in ~/.agents/skills is not permission to start
 * writing into ~/.claude/skills.
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

    await mkdir(deps.dir, { recursive: true, mode: 0o700 });
    await withFileLock(skillsHealLockPath(deps.dir), () => heal(present, source, deps), {
      timeoutMs: 0,
    });
  } catch {
    // The contended lock included: whoever holds it is writing these same bytes,
    // and anything else here is the next command's to retry.
  }
}

function wiredSkills(home: string): { dir: string; name: string }[] {
  const found: { dir: string; name: string }[] = [];
  for (const dir of skillsDirsFor(home)) {
    for (const name of SKILL_NAMES) {
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
  let hostedReplaced = false;
  for (const { dir, name } of present) {
    try {
      const { status } = await installSkill(join(source, name), join(dir, name), false, name);
      if (status === 'up-to-date') continue;
      if (!updated.includes(dir)) updated.push(dir);
      if (name === HOSTED_SKILL_NAME) hostedReplaced = true;
    } catch {
      // A FIFO at the path, a denied write, a case collision: that skill keeps
      // what it has, and the others are still healed.
      failed.push(join(dir, name));
    }
  }
  const notice = noticeFor(updated, failed, hostedReplaced);
  if (notice !== null) emitNotice(deps.io, notice, { json: deps.json });
}

/** One line, or null when every skill was already current. */
function noticeFor(updated: string[], failed: string[], hostedReplaced: boolean): string | null {
  const parts: string[] = [];
  if (updated.length > 0) {
    // Disclosed, not folded into "updated": the operator may have re-fetched the
    // hosted mirror newer than this package ships (`install` warns about it too).
    const hosted = hostedReplaced
      ? `, including this package's mirror of the hosted ${HOSTED_SKILL_NAME} skill`
      : '';
    parts.push(`Updated the Tenjin skills in ${updated.join(' and ')} to match this CLI${hosted}`);
  }
  if (failed.length > 0) {
    parts.push(`could not update ${failed.join(' and ')} (run \`tenjin install\` for the reason)`);
  }
  return parts.length > 0 ? `${parts.join('; ')}.` : null;
}
