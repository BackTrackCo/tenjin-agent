import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { z } from 'zod';
import pkg from '../../package.json';
import { writeFileAtomic } from './atomic-json';
import { withFileLock } from './lock';
import { skillsSyncLockPath, skillsSyncPath } from './paths';
import { CLI_SKILL_NAMES, HARNESS_TARGETS, harnessTargetDir } from './skill-wiring';
import type { Io } from './output';

/**
 * Self-healing skills: `npm i -g tenjin-cli` updates the binary but not the
 * copies `tenjin install` wired into a harness, so without this every update
 * leaves agents running last release's skills.
 *
 * Consent and blast radius:
 *  - Writes ONLY to the directories recorded in the stamp's `dirs`. That list is
 *    what install actually wired, so a `--harness claude` machine can never have
 *    its shared `~/.agents/skills` written by a later update.
 *  - Re-wires ONLY directories still wired (a Tenjin SKILL.md is present); it
 *    never creates a harness directory.
 *  - Touches ONLY directory names Tenjin ships or once shipped
 *    ({@link RETIRED_SKILL_NAMES}); a user's other skills are structurally out
 *    of reach because nothing iterates them.
 *  - Never affects the command that triggered it: every failure is swallowed.
 */

/**
 * Names Tenjin once shipped and no longer does; a rename adds the old name here
 * so the next sync removes the stale copy instead of stacking a second skill.
 */
export const RETIRED_SKILL_NAMES: readonly string[] = [];

/** `dirs` is the consent record: the only paths the self-heal may write to. */
const StampSchema = z.object({
  schemaVersion: z.literal(1),
  cliVersion: z.string(),
  dirs: z.array(z.string()),
});
export type SkillsStamp = z.infer<typeof StampSchema>;

/**
 * Null for absent or unparsable, which deliberately includes the pre-`dirs`
 * shape: an unknown shape carries no consent record, so it authorizes no write
 * and the machine goes through adoption instead.
 */
export async function readSkillsStamp(dir: string): Promise<SkillsStamp | null> {
  let raw: string;
  try {
    raw = await readFile(skillsSyncPath(dir), 'utf8');
  } catch {
    return null;
  }
  try {
    const parsed = StampSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export async function writeSkillsStamp(
  dir: string,
  cliVersion: string,
  dirs: readonly string[],
): Promise<void> {
  const stamp: SkillsStamp = { schemaVersion: 1, cliVersion, dirs: [...dirs] };
  await writeFileAtomic(skillsSyncPath(dir), `${JSON.stringify(stamp, null, 2)}\n`, {
    mode: 0o600,
    dirMode: 0o700,
  });
}

/**
 * The directories a pre-feature install left behind, for machines with no usable
 * stamp. A CLI ADAPTER skill is the evidence, because only `tenjin install`
 * places one. A hosted-only `tenjin` copy is not: anyone can fetch that mirror
 * from tenjin.blog, and adopting it would let an update overwrite a file install
 * never placed.
 */
export function adoptableSkillDirs(home: string): string[] {
  const dirs: string[] = [];
  for (const target of HARNESS_TARGETS) {
    const dir = harnessTargetDir(home, target);
    if (dirs.includes(dir)) continue; // codex and shared are one directory
    const managed = CLI_SKILL_NAMES.some((name) => existsSync(join(dir, name, 'SKILL.md')));
    if (managed) dirs.push(dir);
  }
  return dirs;
}

export interface SkillSyncDeps {
  /** The Tenjin data dir (stamp location). */
  dir: string;
  io: Io;
  /** The global --json flag; suppresses the human notice, never the sync. */
  json: boolean;
  currentVersion?: string;
  /** Resync seam for tests; defaults to install's resyncWiredSkills. */
  resync?: (dirs: readonly string[]) => Promise<{ refreshed: string[]; removed: string[] }>;
  /** Home seam for tests, used by the adoption scan. */
  homeDir?: string;
}

/**
 * The post-command hook. Cheap when there is nothing to do: one small file read
 * and a string compare, before any lock. The sync runs in every output mode (an
 * agent's `--json` run is exactly the caller whose skills must not go stale);
 * only the notice is human-mode.
 */
export async function maybeResyncSkills(deps: SkillSyncDeps): Promise<void> {
  try {
    const current = deps.currentVersion ?? pkg.version;
    const stamp = await readSkillsStamp(deps.dir);
    if (stamp !== null && stamp.cliVersion === current) return;

    // Serialized: otherwise one process can stamp the version current while
    // another is still mid-swap, and the stamp suppresses the loser's retry.
    await withFileLock(skillsSyncLockPath(deps.dir), async () => {
      const fresh = await readSkillsStamp(deps.dir); // the holder we queued behind may have done it
      if (fresh !== null && fresh.cliVersion === current) return;

      // No usable stamp is either a pre-feature install or a fresh machine, and
      // only the first is adopted; the second stays unstamped so `tenjin install`
      // remains the first thing that ever consents here.
      const dirs = fresh?.dirs ?? adoptableSkillDirs(deps.homeDir ?? homedir());
      if (dirs.length === 0) return;

      const resync =
        deps.resync ??
        (async (targets: readonly string[]) => {
          const { resyncWiredSkills } = await import('../commands/install');
          return resyncWiredSkills(targets);
        });
      const { refreshed, removed } = await resync(dirs);
      // Stamp AFTER a successful pass, so a failed sync retries on the next
      // command instead of going quiet until the next release.
      await writeSkillsStamp(deps.dir, current, dirs);

      if (deps.io.isTTY && !deps.json && (refreshed.length > 0 || removed.length > 0)) {
        const removedNote = removed.length > 0 ? `; removed ${removed.join(', ')}` : '';
        deps.io.stderr.write(`tenjin skills refreshed for ${current}${removedNote}\n`);
      }
    });
  } catch {
    // Best-effort by contract: the triggering command's output and exit code
    // are never this hook's to change.
  }
}
