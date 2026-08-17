import { existsSync, lstatSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { emitWriteNotice } from './output';
import type { Io } from './output';
import { installSkill } from './skill-writer';
import {
  CLI_SKILL_NAMES,
  readSkillFile,
  skillFrontmatterName,
  skillsDirsFor,
} from './skill-wiring';
import { resolveSkillsSource } from './skills-source';
import { resolveHermesHomeLenient } from './hermes';

export interface HealDeps {
  io: Io;
  /** Environment for the CI and opt-out checks. Defaults to process.env. */
  env?: NodeJS.ProcessEnv;
  /** Home whose skills directories are healed. Tests inject a temp dir. */
  homeDir?: string;
  /**
   * The packaged skills source. Defaults to this build's own, and only that
   * default is checked for being a working tree: passing one is a deliberate act.
   */
  skillsSourceDir?: string;
}

/** The opt-out, in the shape the CLI's other `TENJIN_NO_*` switches take. */
const OPT_OUT = 'TENJIN_NO_SKILL_HEAL';

/**
 * Refresh the CLI adapter skills ALREADY in a harness skills directory, so
 * updating the CLI updates the copies `install` wrote instead of leaving an agent
 * on an older version's instructions. Subordinate to the command that ran, like
 * the update nudge: after the envelope, never on stdout, never a failure.
 *
 * It is an UNATTENDED writer into the operator's home, so it is strictly more
 * conservative than `install`, which a human ran on purpose. What it declines to
 * touch is listed on {@link healable}, and it heals only the two CLI adapters:
 * the hosted `tenjin` skill mirrors tenjin.blog/skills.md, so the copy on disk
 * may be a NEWER fetch than this package ships, and rewriting it would undo that
 * and make install's "re-fetch it from tenjin.blog/skills.md" false. Same domain
 * `doctor`'s staleness check compares.
 *
 * Unlocked, on purpose. Concurrent healers write byte-identical content to the
 * same paths through per-file atomic renames, so there is nothing to serialize;
 * a lock here could only make things worse, because one left behind by a killed
 * process would silently disable healing on this machine forever.
 */
export async function healWiredSkills(deps: HealDeps): Promise<void> {
  try {
    const env = deps.env ?? process.env;
    // The same two doors the update nudge uses: a build log cannot act on this,
    // and an operator who wants their skills left alone says so once.
    if (env.CI !== undefined && env.CI.length > 0) return;
    if (env[OPT_OUT] === '1') return;

    const home = deps.homeDir ?? homedir();
    // An empty or relative HOME (sudo/docker env_reset, systemd units) would make
    // every target below relative, healing paths under the working directory.
    if (!isAbsolute(home)) return;

    const source = deps.skillsSourceDir ?? packagedSource();
    if (source === null) return;
    // Lenient on purpose: an unattended healer is the last place that should
    // refuse to run over a stray relative HERMES_HOME.
    const targets = healable(home, resolveHermesHomeLenient(home, env).home);
    if (targets.length === 0) return;
    await heal(targets, source, deps.io);
  } catch {
    // Whatever it was, it is the next command's to retry; this one is finished.
  }
}

/**
 * This build's packaged skills, or null when they are a working tree's. The
 * published package ships `dist/` and `skills/` with no `src/` beside them, so a
 * `src/` sibling means a checkout, whose skills may be half-edited and are not
 * what anyone agreed to install.
 */
function packagedSource(): string | null {
  const dir = resolveSkillsSource(fileURLToPath(new URL('.', import.meta.url)));
  return existsSync(join(dirname(dir), 'src')) ? null : dir;
}

interface Target {
  dir: string;
  name: string;
  /** The SKILL.md itself: what the gates judged, and what the notice names. */
  path: string;
}

/**
 * The (directory, skill) pairs this may rewrite, which is a deliberately narrow
 * set. A skill that is not there is never created, because presence is the
 * operator's consent to a directory.
 *
 * Nothing here is reached THROUGH a symlink. `install` follows one on purpose,
 * since the operator pointed it somewhere; unattended, following one means a
 * write landing wherever it points and a notice naming a path that is not where
 * it landed. That argument does not get weaker one directory up, so every
 * component this CLI creates is checked with `lstat`, not `stat`: the skills
 * directory, the skill directory, and SKILL.md. Above them is the harness's own
 * home, which every tool including the harness reaches through, so a link there
 * is the operator's name for the place rather than a redirect around us.
 *
 * Gating SKILL.md gates the whole write. It is not the only file a skill ships
 * any more (tenjin-search carries `references/`), but it is the only one whose
 * frontmatter can prove the directory is OURS, and `installSkill` writes the
 * whole packaged tree once that gate passes — so a reference file deleted or
 * edited under a healthy SKILL.md is restored on the same pass. The other gate,
 * that the file is ours at all, needs its content and so lives at the write.
 */
function healable(home: string, hermesHome: string): Target[] {
  const found: Target[] = [];
  for (const dir of skillsDirsFor(home, hermesHome)) {
    if (!isRealDirectory(dir)) continue;
    for (const name of CLI_SKILL_NAMES) {
      if (!isRealDirectory(join(dir, name))) continue;
      const path = join(dir, name, 'SKILL.md');
      if (lstatSync(path, { throwIfNoEntry: false })?.isFile() !== true) continue;
      found.push({ dir, name, path });
    }
  }
  return found;
}

/** A directory, and not a symlink to one. */
function isRealDirectory(path: string): boolean {
  return lstatSync(path, { throwIfNoEntry: false })?.isDirectory() === true;
}

async function heal(targets: readonly Target[], source: string, io: Io): Promise<void> {
  const updated: string[] = [];
  for (const { dir, name, path } of targets) {
    try {
      if (!(await isOurs(path, name))) continue;
      const { status } = await installSkill(join(source, name), join(dir, name), false, name, {
        followSymlinks: false,
      });
      if (status === 'up-to-date') continue;
      updated.push(path);
    } catch {
      // A denied write, a case collision, a file swapped under us: that skill keeps
      // what it has and the others are still healed, and NOTHING is said about it.
      // A cause the next command cannot clear either (a directory at 0500) would
      // otherwise print the same line forever, on every command, with no state to
      // suppress it and no way to dismiss it. `tenjin doctor` is where a skill that
      // is wired but not from this build gets reported, which is exactly this.
    }
  }
  if (updated.length > 0) emitWriteNotice(io, noticeFor(updated));
}

/** Does this file claim to BE the skill we would write over it? Somebody else's
 *  skill is not ours to replace just for sitting at one of our paths. */
async function isOurs(path: string, name: string): Promise<boolean> {
  const read = await readSkillFile(path);
  return read.kind === 'ok' && skillFrontmatterName(read.bytes.toString('utf8')) === name;
}

/**
 * Files, not directories: this line is the only notice that content in the
 * operator's home changed unasked, so it has to say which content. It claims
 * nothing about edits being lost, because it cannot know. Every routine upgrade
 * rewrites these same files, and telling someone their edits are gone when they
 * made none is worse than saying nothing.
 */
function noticeFor(updated: readonly string[]): string {
  return `Updated ${updated.join(' and ')} to match this CLI.`;
}
