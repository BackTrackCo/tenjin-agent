import { lstat, readFile, readdir, rm, rmdir, realpath } from 'node:fs/promises';
import { lstatSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { writeFileAtomic } from './atomic-json';
import {
  claudeSettingsPath,
  FREE_VERB_RULES,
  LEGACY_ALLOWLIST_RULES,
  MODE_GATED_RULES,
} from './harness-permissions';
import { STOP_HOOK_FILE, WEBSEARCH_HOOK_FILE } from './hook-scripts';
import { hooksDir } from './paths';
import { SHIPPED_SKILL_FILES } from './skills-source';
import { resolveThroughLink } from './skill-writer';
import {
  CLI_SKILL_NAMES,
  HOSTED_SKILL_NAME,
  readSkillFile,
  skillFrontmatterName,
  skillsDirsFor,
} from './skill-wiring';

/**
 * The reverse of `install`, and ONLY of `install`.
 *
 * Every removal here is gated on OWNERSHIP rather than position or path alone,
 * reusing the rules the writers already use: a hook entry is ours when its
 * command names one of our two script filenames (lib/harness-hooks.ts), a skill
 * directory is ours when its SKILL.md frontmatter claims our skill's name
 * (lib/skill-heal.ts), a permission rule is ours when it is one of the free-verb
 * rules we wrote. Anything that merely sits at one of our paths belongs to
 * somebody else and is left alone.
 *
 * WHAT IS NEVER TOUCHED: anything under the data dir. The wallet, the config,
 * the library receipts, the search ledger, and whatever an older version left
 * in `candidates/` are all the operator's property, and their loss is
 * unrecoverable (a wallet holds funds). `install` did not create them, so
 * uninstall does not remove them, and the command says so in its own output
 * rather than leaving it to the docs.
 *
 * SETTINGS.JSON IS EDITED IN ONE PASS. Hooks and permission rules live in the
 * same file, so removing them separately would mean two whole-file
 * read-modify-writes and two chances to lose a concurrent edit by Claude Code.
 * One pass, one optimistic-concurrency check, one refusal.
 */

/** Everything the command found and acted on, for both the receipt and the JSON. */
export interface UninstallReport {
  settings: SettingsOutcome;
  skills: string[];
  scripts: string[];
  hooksDir?: string;
  markers: string[];
  kept: string[];
}

export interface SettingsOutcome {
  path: string;
  /** Hook events whose entry was ours and was removed. */
  hooks: string[];
  /** Free-verb rules removed from `permissions.allow`. */
  rules: string[];
  /** Absent when the file was edited (or had nothing of ours in it). */
  skipped?: SettingsSkipReason;
  warning?: string;
}

export type SettingsSkipReason =
  | 'absent'
  | 'unresolvable'
  | 'unreadable'
  | 'unparsable'
  | 'unexpected-shape'
  | 'changed-since-read';

/**
 * What uninstall deliberately leaves behind, named in the output every run.
 *
 * Stated as ONE rule rather than an inventory: everything under the data dir is
 * the operator's, so a list that has to be edited every time a file is added or
 * retired is a list that will eventually be wrong. `candidates/` is named
 * explicitly because it is the one directory nothing writes any more — an older
 * version's parked drafts are still sitting there, and someone who wants them
 * needs the path.
 */
export const KEPT_ITEMS: readonly string[] = [
  'everything under ~/.tenjin: your wallet, config, library, and search history',
  'anything an older version left in ~/.tenjin/candidates (nothing reads it now)',
];

/** The legacy pointer line `install` used to write into CLAUDE.md / AGENTS.md. */
export const SKILLS_MARKER = '<!-- tenjin-cli:skills -->';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Ours by the same rule that wrote it: the command names one of our scripts. */
function ownsHookEntry(entry: unknown): boolean {
  if (!isPlainObject(entry)) return false;
  const handlers = entry.hooks;
  if (!Array.isArray(handlers)) return false;
  return handlers.some(
    (h) =>
      isPlainObject(h) &&
      typeof h.command === 'string' &&
      (h.command.includes(WEBSEARCH_HOOK_FILE) || h.command.includes(STOP_HOOK_FILE)),
  );
}

/**
 * Strip our hook entries and our free-verb rules from ~/.claude/settings.json,
 * leaving every other entry, rule, and key exactly where it was.
 *
 * Removal is BY OWNERSHIP, never by index: an entry we did not write keeps its
 * position even when one of ours is removed from in front of it. An emptied
 * `hooks.<event>` array is dropped rather than left as `[]`, and an emptied
 * `hooks` or `permissions.allow` likewise, so a full uninstall leaves the file
 * as it would have been had install never run — but only when WE emptied them.
 */
export async function removeFromSettings(homeDir: string): Promise<SettingsOutcome> {
  const declaredPath = claudeSettingsPath(homeDir);
  const skip = (path: string, skipped: SettingsSkipReason, warning?: string): SettingsOutcome => ({
    path,
    hooks: [],
    rules: [],
    skipped,
    ...(warning !== undefined ? { warning } : {}),
  });

  const entry = await lstat(declaredPath).catch(() => null);
  if (entry === null) return skip(declaredPath, 'absent');

  let path: string;
  try {
    path = await realpath(declaredPath);
  } catch (err) {
    return skip(
      declaredPath,
      'unresolvable',
      `${declaredPath} could not be resolved (${(err as Error).message}); it was left exactly as it is.`,
    );
  }

  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (err) {
    return skip(
      path,
      'unreadable',
      `${path} could not be read (${(err as Error).message}); it was left exactly as it is.`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return skip(
      path,
      'unparsable',
      `${path} is not valid JSON (${(err as Error).message}); it was left exactly as it is.`,
    );
  }
  if (!isPlainObject(parsed)) {
    return skip(path, 'unexpected-shape', `${path} is not a JSON object; it was left as it is.`);
  }

  const settings = parsed;
  const removedHooks: string[] = [];
  const removedRules: string[] = [];
  let next: Record<string, unknown> = settings;

  const hooksValue = settings.hooks;
  if (hooksValue !== undefined && !isPlainObject(hooksValue)) {
    return skip(
      path,
      'unexpected-shape',
      `${path} has a "hooks" key that is not an object; it was left exactly as it is.`,
    );
  }
  if (isPlainObject(hooksValue)) {
    const nextHooks: Record<string, unknown> = {};
    for (const [event, value] of Object.entries(hooksValue)) {
      if (!Array.isArray(value)) {
        nextHooks[event] = value;
        continue;
      }
      const kept = value.filter((e) => !ownsHookEntry(e));
      if (kept.length !== value.length) removedHooks.push(event);
      // An event WE emptied loses its key entirely; one that still holds someone
      // else's entry keeps it, and an array that was already empty before we
      // looked is left as we found it.
      const emptiedByUs = kept.length === 0 && value.length > 0;
      if (!emptiedByUs) nextHooks[event] = kept;
    }
    next = { ...next, hooks: nextHooks };
    if (Object.keys(nextHooks).length === 0) delete next.hooks;
  }

  const permissions = settings.permissions;
  if (isPlainObject(permissions) && Array.isArray(permissions.allow)) {
    // What THIS version writes, plus what any prior version wrote. A rule we
    // retired is still a rule we put there, and leaving it behind would strand a
    // dead allow-line for a command that no longer exists. The mode-gated pair is
    // reclaimed WHATEVER the mode says: uninstall removes what this CLI wrote,
    // and the mode that justified those rules is about to have no CLI behind it.
    const ours = new Set<string>([
      ...FREE_VERB_RULES,
      ...LEGACY_ALLOWLIST_RULES,
      ...MODE_GATED_RULES,
    ]);
    const kept = permissions.allow.filter((r) => !(typeof r === 'string' && ours.has(r)));
    if (kept.length !== permissions.allow.length) {
      for (const rule of permissions.allow) {
        if (typeof rule === 'string' && ours.has(rule)) removedRules.push(rule);
      }
      const nextPermissions: Record<string, unknown> = { ...permissions, allow: kept };
      if (kept.length === 0) delete nextPermissions.allow;
      next = { ...next, permissions: nextPermissions };
      if (Object.keys(nextPermissions).length === 0) delete next.permissions;
    }
  }

  if (removedHooks.length === 0 && removedRules.length === 0) {
    return { path, hooks: [], rules: [] };
  }

  // The same optimistic-concurrency contract the writers hold: this is a
  // whole-file replacement built from a snapshot, and Claude Code writes this
  // file too, so a change that landed underneath us is refused rather than
  // erased.
  const current = await readFile(path, 'utf8').catch(() => null);
  if (current !== raw) {
    return skip(
      path,
      'changed-since-read',
      `${path} changed while it was being updated, so nothing was removed from it. Re-run \`tenjin uninstall\`.`,
    );
  }
  await writeFileAtomic(path, `${JSON.stringify(next, null, 2)}\n`);
  return { path, hooks: removedHooks, rules: removedRules };
}

/**
 * Delete the generated hook scripts and, when it is left empty, the directory
 * that held them. Only our two filenames: a file someone else parked in there is
 * both left alone and reason to keep the directory.
 */
export async function removeHookScripts(dataDir: string): Promise<{
  scripts: string[];
  removedDir?: string;
}> {
  const dir = hooksDir(dataDir);
  const removed: string[] = [];
  for (const file of [WEBSEARCH_HOOK_FILE, STOP_HOOK_FILE]) {
    const path = join(dir, file);
    // isFile, not mere existence: a directory parked at a script path would make
    // the non-recursive `rm` throw EISDIR and abort the uninstall halfway.
    if (lstatSync(path, { throwIfNoEntry: false })?.isFile() !== true) continue;
    await rm(path, { force: true });
    removed.push(path);
  }
  const rest = await readdir(dir).catch(() => null);
  if (rest !== null && rest.length === 0) {
    // `rmdir`, not a recursive `rm`: it removes an EMPTY directory and nothing
    // else, so a file that appeared between the listing and this call keeps the
    // directory instead of being swept away with it.
    const gone = await rmdir(dir).then(
      () => true,
      () => false,
    );
    if (gone) return { scripts: removed, removedDir: dir };
  }
  return { scripts: removed };
}

/**
 * Remove the skills we installed, in every harness location.
 *
 * REMOVES THE FILES WE SHIPPED, NOT THE DIRECTORY THEY SIT IN. Everything else in
 * that directory belongs to the operator — notes, a local override, anything
 * they put beside our files — and a recursive delete of a directory we only
 * partly own is the data-loss shape this repo already unlearned once on the
 * write side (see lib/skill-writer.ts: "Only the files this package SHIPS are
 * read and written"). So: unlink each path in {@link SHIPPED_SKILL_FILES}, then
 * remove a directory only if nothing is left in it, exactly as
 * `removeHookScripts` does one function up. A skill that ships a `references/`
 * subdirectory has that pruned the same way, deepest first — an operator file
 * beside ours keeps both itself and the directory it is in.
 *
 * Ours means the SKILL.md frontmatter still claims the name we wrote, the rule
 * `skill-heal` uses to decide it may rewrite a file. A skill someone replaced
 * with their own is not ours to delete just for sitting at our path, and neither
 * is a directory reached through a symlink.
 */
export async function removeSkills(homeDir: string): Promise<string[]> {
  const removed: string[] = [];
  const names = [...CLI_SKILL_NAMES, HOSTED_SKILL_NAME];
  for (const dir of skillsDirsFor(homeDir)) {
    if (lstatSync(dir, { throwIfNoEntry: false })?.isDirectory() !== true) continue;
    for (const name of names) {
      const skillDir = join(dir, name);
      if (lstatSync(skillDir, { throwIfNoEntry: false })?.isDirectory() !== true) continue;
      const path = join(skillDir, 'SKILL.md');
      if (lstatSync(path, { throwIfNoEntry: false })?.isFile() !== true) continue;
      const read = await readSkillFile(path);
      if (read.kind !== 'ok') continue;
      if (skillFrontmatterName(read.bytes.toString('utf8')) !== name) continue;
      // SKILL.md is the ownership proof, so it is checked first and removed
      // last: a run that dies partway leaves the frontmatter that lets the next
      // one recognize the directory as ours.
      const shipped = SHIPPED_SKILL_FILES[name];
      const subdirs = new Set<string>();
      for (const rel of shipped) {
        if (rel === 'SKILL.md') continue;
        const file = join(skillDir, rel);
        // The directory is a prune CANDIDATE whether or not our file is still in
        // it: an operator who deleted the file by hand would otherwise be left
        // with an empty `references/` that nothing ever clears.
        subdirs.add(dirname(file));
        if (lstatSync(file, { throwIfNoEntry: false })?.isFile() !== true) continue;
        await rm(file, { force: true });
      }
      await rm(path, { force: true });
      // Only when OUR files were the only things in there. An operator file keeps
      // both itself and the directory; `rmdir` refuses a non-empty one anyway,
      // so the check and the call agree even if something lands in between.
      // Deepest first, so an emptied `references/` cannot keep its parent alive.
      for (const dir of [...subdirs].sort((a, b) => b.length - a.length)) {
        const left = await readdir(dir).catch(() => null);
        if (left !== null && left.length === 0) await rmdir(dir).catch(() => undefined);
      }
      const rest = await readdir(skillDir).catch(() => null);
      if (rest !== null && rest.length === 0) {
        await rmdir(skillDir).catch(() => undefined);
      }
      removed.push(skillDir);
    }
  }
  return removed;
}

/**
 * Drop the legacy pointer line from the files an older `install` wrote it into.
 * The line is found by its marker, never by exact text, so a drifted copy from
 * any earlier version is recognized; everything around it is preserved byte for
 * byte, because these files are the operator's own notes.
 *
 * Written through the link for the same reason the writers were: `writeFileAtomic`
 * commits with a rename, so committing at a declared path would replace a
 * dotfiles-managed symlink with a regular file and strand its target. A file we
 * cannot read, or one that is not a regular file, is skipped rather than fixed.
 */
export async function removeMarkerLines(homeDir: string): Promise<string[]> {
  const cleaned: string[] = [];
  for (const path of markerFiles(homeDir)) {
    const read = await readSkillFile(path);
    if (read.kind !== 'ok') continue;
    const text = read.bytes.toString('utf8');
    if (!text.split('\n').some((l) => l.startsWith(SKILLS_MARKER))) continue;
    // ANCHORED to the start of the line, which is the only way install ever
    // wrote it. `includes` would take a whole line of the operator's own prose
    // for quoting the marker inside a sentence or a code fence.
    const kept = text.split('\n').filter((l) => !l.startsWith(SKILLS_MARKER));
    const writeTo = await resolveThroughLink(path, 'the Tenjin pointer');
    // A file that held nothing but our line is emptied rather than deleted:
    // install created it in that case, but the operator may have pointed a
    // dotfiles link at it since, and an empty file is inert either way.
    await writeFileAtomic(writeTo, kept.join('\n'));
    cleaned.push(path);
  }
  return cleaned;
}

/** Every file `install` has ever written the pointer line into. */
export function markerFiles(homeDir: string): string[] {
  return [
    join(homeDir, '.claude', 'CLAUDE.md'),
    join(homeDir, '.agents', 'AGENTS.md'),
    join(homeDir, '.codex', 'AGENTS.md'),
  ];
}
