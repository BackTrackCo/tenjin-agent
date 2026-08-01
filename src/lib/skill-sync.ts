import { existsSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
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
 * copies `tenjin install` wired into a harness.
 *
 * Two invariants hold the consent boundary:
 *  - `tenjin install` is the ONLY thing that grants ownership of a directory. It
 *    records what it wired in the stamp's `dirs`, and the self-heal writes there
 *    and nowhere else.
 *  - A stamp whose `dirs` is empty authorizes NO writes. That is the shape used
 *    for a machine we have only noticed, never adopted.
 */

/** Names Tenjin once shipped; the next sync removes a stale copy left under one. */
export const RETIRED_SKILL_NAMES: readonly string[] = [];

/** A lock holder that has not touched it in this long has crashed. */
export const SYNC_LOCK_STALE_MS = 10 * 60_000;

const StampSchema = z.object({
  schemaVersion: z.literal(1),
  cliVersion: z.string(),
  /** The directories install wired: the only paths the self-heal may write to. */
  dirs: z.array(z.string()),
  /** The CLI version whose "run install" notice has already been shown. */
  noticedVersion: z.string().optional(),
});
export type SkillsStamp = z.infer<typeof StampSchema>;

export const REINSTALL_NOTICE =
  'tenjin skills from an earlier install found; run `tenjin install` once to enable automatic skill updates.';

/** Null for absent or unparsable, which includes any shape carrying no `dirs`. */
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
  noticedVersion?: string,
): Promise<void> {
  const stamp: SkillsStamp = {
    schemaVersion: 1,
    cliVersion,
    dirs: [...dirs],
    ...(noticedVersion !== undefined ? { noticedVersion } : {}),
  };
  await writeFileAtomic(skillsSyncPath(dir), `${JSON.stringify(stamp, null, 2)}\n`, {
    mode: 0o600,
    dirMode: 0o700,
  });
}

/**
 * Directories holding Tenjin CLI adapter skills. This is a DETECTION, not a
 * claim of ownership: `npx skills add BackTrackCo/tenjin-agent` plants the same
 * adapters, so their presence cannot distinguish a `tenjin install` from another
 * installer's. It is only ever used to decide whether to suggest running
 * install; nothing here authorizes a write.
 */
export function legacySkillDirs(home: string): string[] {
  const dirs: string[] = [];
  for (const target of HARNESS_TARGETS) {
    const dir = harnessTargetDir(home, target);
    if (dirs.includes(dir)) continue;
    if (CLI_SKILL_NAMES.some((name) => existsSync(join(dir, name, 'SKILL.md')))) dirs.push(dir);
  }
  return dirs;
}

export interface SkillSyncDeps {
  dir: string;
  io: Io;
  json: boolean;
  currentVersion?: string;
  resync?: (
    dirs: readonly string[],
  ) => Promise<{ refreshed: string[]; removed: string[]; skippedSymlinks?: string[] }>;
  homeDir?: string;
  /** How long to wait on a live holder. Shortened in tests; the lock default otherwise. */
  lockTimeoutMs?: number;
}

/**
 * The post-command hook. Cheap when there is nothing to do: one small file read
 * and a string compare, before any lock. The sync runs in every output mode (an
 * agent's `--json` run is exactly the caller whose skills must not go stale);
 * the notices are TTY-only.
 */
export async function maybeResyncSkills(deps: SkillSyncDeps): Promise<void> {
  try {
    const current = deps.currentVersion ?? pkg.version;
    const stamp = await readSkillsStamp(deps.dir);
    if ((stamp?.dirs.length ?? 0) > 0) {
      if (stamp!.cliVersion === current) return;
      await syncPass(deps, current, stamp!.dirs);
      return;
    }
    await maybeNoticeLegacy(deps, current, stamp);
  } catch {
    // Best-effort by contract: the triggering command's output and exit code are
    // never this hook's to change.
  }
}

/** Refresh the consented directories, then restamp. */
async function syncPass(
  deps: SkillSyncDeps,
  current: string,
  dirs: readonly string[],
): Promise<void> {
  await underLock(deps, async () => {
    const fresh = await readSkillsStamp(deps.dir);
    if (fresh !== null && fresh.cliVersion === current) return; // a queued twin did it
    const targets = fresh !== null && fresh.dirs.length > 0 ? fresh.dirs : dirs;

    const resync =
      deps.resync ??
      (async (t: readonly string[]) => {
        const { resyncWiredSkills } = await import('../commands/install');
        return resyncWiredSkills(t);
      });
    const { refreshed, removed, skippedSymlinks = [] } = await resync(targets);
    // AFTER a successful pass, so a failure retries on the next command rather
    // than going quiet until the next release.
    await writeSkillsStamp(deps.dir, current, targets);

    if (deps.io.isTTY && !deps.json && (refreshed.length > 0 || removed.length > 0)) {
      const removedNote = removed.length > 0 ? `; removed ${removed.join(', ')}` : '';
      const linkNote =
        skippedSymlinks.length > 0
          ? `; left symlinked (update manually): ${skippedSymlinks.join(', ')}`
          : '';
      deps.io.stderr.write(`tenjin skills refreshed for ${current}${removedNote}${linkNote}\n`);
    }
  });
}

/**
 * A machine with wired skills but no consent record. Adapter files are not
 * provenance, so nothing is written to them: the operator is told once per CLI
 * version to run install, which is the one ceremony that grants ownership.
 */
async function maybeNoticeLegacy(
  deps: SkillSyncDeps,
  current: string,
  stamp: SkillsStamp | null,
): Promise<void> {
  if (stamp?.noticedVersion === current) return;
  if (!deps.io.isTTY || deps.json) return;
  if (legacySkillDirs(deps.homeDir ?? homedir()).length === 0) return;

  await underLock(deps, async () => {
    const fresh = await readSkillsStamp(deps.dir);
    if (fresh?.noticedVersion === current || (fresh?.dirs.length ?? 0) > 0) return;
    await writeSkillsStamp(deps.dir, current, [], current);
    deps.io.stderr.write(`${REINSTALL_NOTICE}\n`);
  });
}

/**
 * The data dir may not exist yet (a pre-feature headless install never created
 * it), and the lock's own mkdir is non-recursive, so create it first or every
 * pass dies on ENOENT and is swallowed.
 */
async function underLock(deps: SkillSyncDeps, fn: () => Promise<void>): Promise<void> {
  await mkdir(deps.dir, { recursive: true, mode: 0o700 });
  await withFileLock(skillsSyncLockPath(deps.dir), fn, {
    staleMs: SYNC_LOCK_STALE_MS,
    ...(deps.lockTimeoutMs !== undefined ? { timeoutMs: deps.lockTimeoutMs } : {}),
  });
}
