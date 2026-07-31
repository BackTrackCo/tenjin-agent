import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import pkg from '../../package.json';
import { writeFileAtomic } from './atomic-json';
import { skillsSyncPath } from './paths';
import type { Io } from './output';

/**
 * Self-healing skills: `npm i -g tenjin-cli` updates the binary but not the
 * copies `tenjin install` wired into `~/.claude/skills` / `~/.agents/skills`, so
 * without this every update silently leaves agents running last release's
 * skills. Nobody re-runs install after an update (doctor-style rituals are
 * break-glass, not maintenance), so the CLI heals itself the way Homebrew or
 * corepack do: on the first command after a version change, re-wire and say so
 * in one line.
 *
 * Consent and blast radius:
 *  - Runs ONLY when a stamp exists, and install is the only writer of the first
 *    stamp — a machine whose operator never ran install is never touched.
 *  - Re-wires ONLY directories that are already wired (a Tenjin skill is
 *    present); it never creates a new harness directory.
 *  - Touches ONLY directory names Tenjin ships or once shipped
 *    ({@link RETIRED_SKILL_NAMES}); a user's other skills are structurally out
 *    of reach because nothing iterates them.
 *  - Never affects the command that triggered it: every failure is swallowed,
 *    like the update nudge beside it in cli.ts.
 */

/**
 * Skill directory names Tenjin PREVIOUSLY shipped and no longer does. A rename
 * or retirement adds the old name here, and the next sync removes the stale
 * copy instead of stacking a second skill beside it. Empty today; the mechanism
 * and its tests exist so the first rename cannot forget the cleanup.
 */
export const RETIRED_SKILL_NAMES: readonly string[] = [];

/** The stamp is a pure marker: which CLI version last wired the skills. */
const StampSchema = z.object({
  schemaVersion: z.literal(1),
  cliVersion: z.string(),
});
export type SkillsStamp = z.infer<typeof StampSchema>;

/** Null for absent or unparsable: both mean "install has not stamped here". */
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

export async function writeSkillsStamp(dir: string, cliVersion: string): Promise<void> {
  const stamp: SkillsStamp = { schemaVersion: 1, cliVersion };
  await writeFileAtomic(skillsSyncPath(dir), `${JSON.stringify(stamp, null, 2)}\n`, {
    mode: 0o600,
    dirMode: 0o700,
  });
}

export interface SkillSyncDeps {
  /** The Tenjin data dir (stamp location). */
  dir: string;
  io: Io;
  /** The global --json flag; suppresses the human notice, never the sync. */
  json: boolean;
  /** Version seam for tests; defaults to the package version. */
  currentVersion?: string;
  /** Resync seam for tests; defaults to install's resyncWiredSkills. */
  resync?: (homeDir?: string) => Promise<{ refreshed: string[]; removed: string[] }>;
  /** Home seam for tests, forwarded to the default resync. */
  homeDir?: string;
}

/**
 * The post-command hook. Cheap when there is nothing to do: one small file read
 * and a string compare. The sync itself runs in EVERY output mode — an agent's
 * `--json` run is exactly the caller whose skills must not go stale — but the
 * notice is human-mode only.
 */
export async function maybeResyncSkills(deps: SkillSyncDeps): Promise<void> {
  try {
    const current = deps.currentVersion ?? pkg.version;
    const stamp = await readSkillsStamp(deps.dir);
    if (stamp === null || stamp.cliVersion === current) return;

    const resync =
      deps.resync ??
      (async (home?: string) => {
        const { resyncWiredSkills } = await import('../commands/install');
        return resyncWiredSkills(home);
      });
    const { refreshed, removed } = await resync(deps.homeDir);
    // Stamp AFTER a successful pass, so a failed sync retries on the next
    // command instead of going quiet until the next release.
    await writeSkillsStamp(deps.dir, current);

    if (deps.io.isTTY && !deps.json && (refreshed.length > 0 || removed.length > 0)) {
      const removedNote = removed.length > 0 ? `; removed ${removed.join(', ')}` : '';
      deps.io.stderr.write(`tenjin skills refreshed for ${current}${removedNote}\n`);
    }
  } catch {
    // Best-effort by contract: the triggering command's output and exit code
    // are never this hook's to change.
  }
}
