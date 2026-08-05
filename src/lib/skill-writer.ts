import { existsSync } from 'node:fs';
import { lstat, readFile, readdir, realpath, stat } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { writeFileAtomic } from './atomic-json';
import { hasCode } from './errno';
import { CliError } from './errors';
import { HOSTED_SKILL_NAME, readSkillFile } from './skill-wiring';

/**
 * Writing one packaged skill into one harness directory, and the path guards that
 * write needs. Its own module, free of the command layer's dependencies, because
 * `install` and the post-command self-heal both write skills and the heal runs on
 * every command: reaching into commands/install would parse the wallet's viem
 * chunk on a `tenjin config`.
 */

export type SkillInstallStatus =
  'installed' | 'updated' | 'up-to-date' | 'would-install' | 'would-update';

export interface SkillInstallResult {
  status: SkillInstallStatus;
  warning?: string;
  /** Was a real copy (a SKILL.md, not just the directory) already on disk before this run? */
  preexisting: boolean;
}

export async function installSkill(
  srcDir: string,
  destDir: string,
  dryRun: boolean,
  name: string,
): Promise<SkillInstallResult> {
  const src = await readTree(srcDir);
  if (src === null) {
    // assertSkillsSource already guards SKILL.md; this is defensive for an empty dir.
    throw new CliError('INTERNAL', `Packaged skill source ${srcDir} is empty`);
  }

  // Only the files this package SHIPS are read and written. Everything else in the
  // directory belongs to the operator: never inspected, listed, or removed. That is
  // what package managers do (npm, dpkg, Homebrew all own their files, not the
  // directory), and wholesale replacement was the single cause behind a run of
  // data-loss, symlink and enumeration bugs.
  //
  // Resolved on BOTH paths, dry run included, so a dry run cannot promise a write
  // the real run refuses.
  const writeTo = new Map<string, string>();
  await assertReachable(destDir, name);
  await assertNoCaseCollision(destDir, name);
  for (const rel of src.keys())
    writeTo.set(rel, await resolveThroughLink(join(destDir, rel), name));

  let differs = false;
  let preexisting = false;
  for (const [rel, content] of src) {
    const current = await readShippedFile(writeTo.get(rel)!, name, destDir);
    if (rel === 'SKILL.md') preexisting = current !== null;
    if (current === null || !current.equals(content)) differs = true;
  }
  const change = !preexisting ? 'create' : differs ? 'update' : 'none';

  if (!dryRun && change !== 'none') {
    for (const [rel, content] of src) {
      const target = writeTo.get(rel)!;
      try {
        // An existing file keeps the mode it has. A skill an operator (or their
        // dotfiles) made group-readable or read-only is theirs to have set that
        // way, and an update is no reason to hand it back at the default 0644.
        const current = await stat(target).catch(() => null);
        await writeFileAtomic(
          target,
          content,
          current === null ? {} : { mode: current.mode & 0o777 },
        );
      } catch (err) {
        // Culprit is derived from the file that FAILED, not assumed to be the
        // skills root: an existing skill directory that refuses the temp file is
        // itself the thing to chmod, and a symlinked SKILL.md fails in the link's
        // TARGET directory, which no path under destDir names.
        throw wrapWriteError(
          err,
          destDir,
          `the ${name} skill`,
          await deepestExisting(dirname(target)),
          { expected: ': a skill is a directory holding SKILL.md' },
        );
      }
    }
  }

  if (change === 'create') return { status: dryRun ? 'would-install' : 'installed', preexisting };
  if (change === 'none') return { status: 'up-to-date', preexisting };
  return {
    status: dryRun ? 'would-update' : 'updated',
    preexisting,
    // The hosted skill is a MIRROR of tenjin.blog/skills.md (roadmap G4), so a
    // differing local copy is a replacement, not the drift warning the CLI skills
    // get. Neither side carries a version or date, so the wording claims no
    // direction: the local file may well be a newer fetch than this package's copy.
    warning:
      name === HOSTED_SKILL_NAME
        ? `${destDir}: the hosted Tenjin skill differed and ${dryRun ? 'would be' : 'was'} replaced by this package's mirror of tenjin.blog/skills.md, which may be older; it stays as the zero-install fallback. Re-fetch it from tenjin.blog/skills.md if you need the current one.`
        : `${destDir}: local edits to ${name}'s SKILL.md ${dryRun ? 'would be' : 'were'} overwritten (the packaged copy is canonical).`,
  };
}

/**
 * Read a shipped file, or null when it is not there.
 *
 * The node-type guard lives in `readSkillFile`, shared with the wiring check and
 * the staleness check, because all three read the same operator-controlled paths
 * and a pipe at one of them used to hang whichever command got there first.
 */
async function readShippedFile(
  path: string,
  name: string,
  destDir: string,
): Promise<Buffer | null> {
  const read = await readSkillFile(path);
  if (read.kind === 'absent') return null;
  if (read.kind === 'ok') return read.bytes;
  if (read.kind === 'not-regular') {
    throw new CliError('INTERNAL', `${path} is not a regular file, so ${name} was not written.`, {
      fix: `A skill file must be a regular file. Check what is there (\`ls -l ${path}\`) and remove or replace it, then re-run \`tenjin install\`.`,
    });
  }
  // Names the FILE, not its directory: this is a read failure, and pointing at a
  // perfectly writable parent is what sent operators to chmod the wrong thing.
  throw wrapWriteError(read.err, destDir, `the ${name} skill`, path, { verb: 'read' });
}

/**
 * A destination the operator manages through a symlink is written THROUGH it, so
 * their link survives and their target is what actually changes. Same call the
 * settings.json writer makes, and the same reason: committing with `rename` over a
 * link would replace it with a regular file and strand the target.
 */
export async function resolveThroughLink(path: string, name: string): Promise<string> {
  const entry = await lstat(path).catch(() => null);
  if (entry === null || !entry.isSymbolicLink()) return path;
  const target = await realpath(path).catch(() => null);
  if (target !== null) return target;
  throw new CliError('INTERNAL', `${path} is a broken symlink, so ${name} was not written.`, {
    fix: `Point it at a path that exists, or remove it (\`ls -ld ${path}\`), then re-run \`tenjin install\`.`,
  });
}

/**
 * On a case-insensitive filesystem (the macOS default), a user directory named a
 * case variant of a shipped skill ALIASES the skill's path, so the write would
 * replace the user's own SKILL.md under a warning naming a path that is not on
 * disk. Detected by the alias itself: the destination resolves but the parent
 * lists only a differently-cased entry, which also means a case-SENSITIVE
 * filesystem (where both names can coexist) never trips this. Dry runs too.
 */
async function assertNoCaseCollision(destDir: string, name: string): Promise<void> {
  if (!existsSync(destDir)) return;
  const entries = await readdir(dirname(destDir)).catch(() => null);
  if (entries === null || entries.includes(name)) return;
  const variant = entries.find((e) => e.toLowerCase() === name.toLowerCase());
  if (variant === undefined) return;
  const actual = join(dirname(destDir), variant);
  throw new CliError(
    'INTERNAL',
    `${actual} is a case variant of the ${name} skill and this filesystem treats them as the same directory, so ${name} was not written.`,
    {
      fix: `Rename or remove ${actual}, then re-run \`tenjin install\`.`,
    },
  );
}

/**
 * Fail a destination directory that is a BROKEN SYMLINK, on dry runs too, so a dry
 * run cannot report `would-install` where the real run cannot write. It checks only
 * that: an unwritable but real directory passes here and fails at the write, with
 * the permission-denied error.
 */
async function assertReachable(destDir: string, name: string): Promise<void> {
  const entry = await lstat(destDir).catch(() => null);
  if (entry?.isSymbolicLink() !== true) return;
  if ((await realpath(destDir).catch(() => null)) !== null) return;
  throw new CliError('INTERNAL', `${destDir} is a broken symlink, so ${name} was not written.`, {
    fix: `Point it at a directory that exists, or remove it (\`ls -ld ${destDir}\`), then re-run \`tenjin install\`.`,
  });
}

/**
 * The directory a denied WRITE should point the operator at: the deepest existing
 * ancestor of the failed target's directory, RESOLVED. An existing skill directory
 * that refuses the temp file names itself; a directory that could not be created
 * names the ancestor that refused to create it, because `ls -ld` on a path that is
 * not there says nothing. Resolved because a destination managed through a symlink
 * denies the write in the link's TARGET, and telling the operator to chmod the
 * link's path leaves them staring at a healthy link.
 */
export async function deepestExisting(dir: string): Promise<string> {
  for (let cur = dir; ; cur = dirname(cur)) {
    if (existsSync(cur)) return realpath(cur).catch(() => cur);
    if (dirname(cur) === cur) return cur;
  }
}

/** A raw errno under INTERNAL reads as a CLI bug and carries no fix. */
export function wrapWriteError(
  err: unknown,
  /** The destination as the operator knows it (the declared path, pre-resolution). */
  dest: string,
  /** What could not be written, e.g. `the tenjin-search skill` or `the Tenjin pointer`. */
  subject: string,
  /**
   * The path to point the operator at. A READ failure names the file itself, which
   * is the thing whose mode is wrong. A WRITE failure names the deepest existing
   * directory on the failed target's resolved path.
   */
  culprit: string,
  opts: {
    /** Which side failed; a read error reported as "could not write" misleads. */
    verb?: 'read' | 'write';
    /** Sentence tail for the wrong-kind fix, telling the operator the expected shape. */
    expected?: string;
  } = {},
): unknown {
  const verb = opts.verb ?? 'write';
  const denied = hasCode(err, 'EACCES') || hasCode(err, 'EPERM');
  const missing = hasCode(err, 'ENOENT');
  // A skills directory that resolves to a regular file, or a SKILL.md that resolves
  // to a directory. Pathological, but a raw ENOTDIR/EISDIR says nothing about which
  // path is the wrong kind of thing.
  const wrongKind = hasCode(err, 'ENOTDIR') || hasCode(err, 'EISDIR');
  if (!denied && !missing && !wrongKind) return err;
  const fix = denied
    ? `Permission denied on ${culprit}. Check it (\`ls -ld ${culprit}\`), then re-run \`tenjin install\`.`
    : wrongKind
      ? `${dest} (or a path inside it) is not the kind of thing it needs to be${opts.expected ?? ''}. Check it (\`ls -ld ${dest}\`), then re-run \`tenjin install\`.`
      : `${dest} could not be created; if it is a symlink, check that its target exists (\`ls -ld ${dest}\`), then re-run \`tenjin install\`.`;
  return new CliError(
    'INTERNAL',
    `Could not ${verb} ${subject} ${verb === 'read' ? 'at' : 'to'} ${dest}.`,
    { fix, cause: err },
  );
}

/**
 * Read a directory tree into a rel-path -> content map, or null when it does not
 * exist. Reads as raw `Buffer`, not `utf8`: today's skills are markdown-only, but
 * this is a general recursive dir-copy, and decoding to a string here would
 * silently corrupt a future non-text asset (an image, a font) on write, or worse,
 * make two different corrupted binaries both decode to U+FFFD and compare equal.
 */
async function readTree(dir: string): Promise<Map<string, Buffer> | null> {
  if (!existsSync(dir)) return null;
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  const files = new Map<string, Buffer>();
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const full = join(entry.parentPath, entry.name);
    files.set(relative(dir, full), await readFile(full));
  }
  return files;
}
