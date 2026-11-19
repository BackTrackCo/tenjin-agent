import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import type { Settings } from '@anthropic-ai/claude-agent-sdk/core';
import { z } from 'zod';
import { canonicalHash } from '../lib/request-schema';

const pathSchema = z
  .string()
  .min(1)
  .refine((path) => isAbsolute(path) && !path.includes('\0'));
const scopeSchema = z.object({
  version: z.literal(1),
  root: pathSchema,
  workingDirectories: z.array(pathSchema).min(1),
  workingDirectorySpellings: z.array(pathSchema).min(1),
  readExceptions: z.array(pathSchema),
  writeExceptions: z.array(pathSchema),
  // Native additional directories that are no directory now: denied to the worker and named in the offer.
  droppedDirectories: z.array(pathSchema).default([]),
});
export type ClaudeWorkspace = z.infer<typeof scopeSchema>;

export function savedClaudeWorkspace(value: unknown): ClaudeWorkspace | null {
  const parsed = scopeSchema.safeParse(value);
  if (!parsed.success || parsed.data.workingDirectories[0] !== parsed.data.root) return null;
  for (const paths of [
    parsed.data.workingDirectories,
    parsed.data.workingDirectorySpellings,
    parsed.data.readExceptions,
    parsed.data.writeExceptions,
    parsed.data.droppedDirectories,
  ])
    if (new Set(paths).size !== paths.length) return null;
  return parsed.data;
}

/** A scope saved before droppedDirectories existed equals one that dropped nothing. */
export function sameClaudeWorkspace(a: ClaudeWorkspace, b: ClaudeWorkspace): boolean {
  const canonical = (scope: ClaudeWorkspace) => {
    const parsed = scopeSchema.safeParse(scope);
    return canonicalHash(parsed.success ? parsed.data : scope);
  };
  return canonical(a) === canonical(b);
}

/** Every directory the worker reaches, as its offer names them. */
export function modelClaudeRepositories(scope: ClaudeWorkspace): string[] {
  return [
    ...new Set([...scope.workingDirectories, ...scope.readExceptions, ...scope.writeExceptions]),
  ];
}

export const WITHHELD_DIRECTORY = '[withheld directory]';

/**
 * Native settings still name a dropped directory to the worker's model (its working
 * directory list), so its path never leaves in a forwarded request. Matched as a whole
 * path: a longer sibling name, or the same name under another parent, stays as written.
 */
export function withholdDroppedDirectories(text: string, dropped: readonly string[]): string {
  let out = text;
  for (const path of [...dropped].sort((a, b) => b.length - a.length))
    for (const spelling of new Set([path, JSON.stringify(path).slice(1, -1)])) {
      const literal = spelling.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      out = out.replace(new RegExp(`(?<![\\w.-])${literal}(?![\\w.-])`, 'g'), WITHHELD_DIRECTORY);
    }
  return out;
}

/** The sandbox reads these characters in a path as a pattern, not literally. */
const hasGlob = (path: string) => ['*', '?', '[', ']'].some((char) => path.includes(char));
const within = (parent: string, path: string) =>
  path === parent || path.startsWith(parent.endsWith(sep) ? parent : `${parent}${sep}`);
const isDirectory = async (path: string) =>
  (await stat(path).catch(() => null))?.isDirectory() === true;

/**
 * The worker's workspace is the session's own: its root, its native additional
 * directories and its native read and write exceptions. `named` are the directories the
 * person named at consent, for a session inside one of them: each is a working directory
 * too, so a session in one repository of a named workspace reaches its siblings and their
 * checkouts. A native additional directory that is no directory now is dropped and denied
 * to the worker rather than refusing the offer.
 */
export async function resolveClaudeWorkspace(
  cwd: string,
  settings: Settings,
  named: readonly string[],
): Promise<ClaudeWorkspace | null> {
  try {
    const root = await realpath(cwd);
    const spelled = (value: string) => {
      if (!value || value !== value.trim() || value.startsWith('~') || value.includes('\0'))
        throw new Error('Unsupported native workspace path');
      return resolve(root, value).normalize('NFC');
    };
    const exceptions = async (values: string[]) => {
      const canonical = await Promise.all(values.map((value) => realpath(spelled(value))));
      return [...new Set(canonical)].sort();
    };
    const nativeAdditional = settings.permissions?.additionalDirectories ?? [];
    const kept: string[] = [];
    const keptSpellings: string[] = [];
    const dropped: string[] = [];
    for (const value of nativeAdditional) {
      const spelling = spelled(value);
      const path = await realpath(spelling).catch(() => null);
      if (path && (await isDirectory(path))) {
        kept.push(path);
        keptSpellings.push(spelling);
      } else dropped.push(spelling, ...(path ? [path] : []));
    }
    const consented = (
      await Promise.all(
        named.map(async (path) =>
          isAbsolute(path) && !hasGlob(path) && (await isDirectory(path)) ? path : null,
        ),
      )
    ).filter((path): path is string => path !== null);
    const readExceptions = await exceptions(settings.sandbox?.filesystem?.allowRead ?? []);
    const writeExceptions = await exceptions(settings.sandbox?.filesystem?.allowWrite ?? []);
    const additional = [...new Set([...consented, ...kept])].filter((path) => path !== root).sort();
    const droppedDirectories = [...new Set(dropped)].sort();
    return scopeSchema.parse({
      version: 1,
      root,
      workingDirectories: [root, ...additional],
      // Native settings retain raw --add-dir spellings too. Freezing only their
      // realpaths leaves a raw symlink grant free to retarget on first use.
      workingDirectorySpellings: [
        ...new Set([root.normalize('NFC'), ...additional, ...keptSpellings]),
      ].sort(),
      readExceptions,
      writeExceptions,
      droppedDirectories,
    });
  } catch {
    return null;
  }
}

const MAX_WORKTREES = 256;

/**
 * Linked git worktrees of the repositories in the workspace roots and their direct
 * children, inside those roots. The sandbox keeps `.git/worktrees`
 * read-only except for a session's own worktrees, which are the ones named as working
 * directories, so a commit in a sibling checkout needs it named. Read at job start and not
 * frozen in the scope: another session adding a worktree must not stop this job.
 */
export async function claudeWorkspaceWorktrees(scope: ClaudeWorkspace): Promise<string[]> {
  const covered = (path: string) =>
    scope.workingDirectories.some((directory) => within(directory, path));
  const repositories = new Set<string>();
  for (const directory of scope.workingDirectories) {
    if (await isDirectory(join(directory, '.git'))) repositories.add(directory);
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries)
      if (entry.isDirectory() && (await isDirectory(join(directory, entry.name, '.git'))))
        repositories.add(join(directory, entry.name));
  }
  const found = new Set<string>();
  for (const repository of repositories) {
    const admin = join(repository, '.git', 'worktrees');
    for (const name of await readdir(admin).catch(() => [] as string[])) {
      if (found.size >= MAX_WORKTREES) break;
      const gitdir = (await readFile(join(admin, name, 'gitdir'), 'utf8').catch(() => '')).trim();
      if (!isAbsolute(gitdir) || basename(gitdir) !== '.git') continue;
      const path = await realpath(dirname(gitdir)).catch(() => null);
      if (!path || hasGlob(path) || !covered(path) || !(await isDirectory(path))) continue;
      // The checkout must name this administrative directory back.
      const back = (await readFile(join(path, '.git'), 'utf8').catch(() => '')).trim();
      const target = back.startsWith('gitdir: ') ? back.slice('gitdir: '.length) : '';
      if (
        !isAbsolute(target) ||
        (await realpath(target).catch(() => null)) !== (await realpath(join(admin, name)))
      )
        continue;
      found.add(path);
    }
  }
  return [...found].filter((path) => !scope.workingDirectories.includes(path)).sort();
}
