import { realpath, stat } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import type { Settings } from '@anthropic-ai/claude-agent-sdk/core';
import { z } from 'zod';
import { canonicalHash } from '../lib/request-schema';
import { disclosureCovers, type ModelSettings } from './model-settings';

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
  ])
    if (new Set(paths).size !== paths.length) return null;
  return parsed.data;
}

export function sameClaudeWorkspace(a: ClaudeWorkspace, b: ClaudeWorkspace): boolean {
  return canonicalHash(a) === canonicalHash(b);
}

export function claudeWorkspaceCovered(
  scope: ClaudeWorkspace,
  repositories: readonly string[],
): boolean {
  return [...scope.workingDirectories, ...scope.readExceptions, ...scope.writeExceptions].every(
    (path) => disclosureCovers(repositories, path),
  );
}

/** The native scope is already canonical and validated; disclosure never supplies its paths. */
export function modelClaudeWorkspaceCovered(scope: ClaudeWorkspace, settings: ModelSettings) {
  return (
    settings.scope === 'native-workspace' || claudeWorkspaceCovered(scope, settings.repositories)
  );
}

export function modelClaudeRepositories(scope: ClaudeWorkspace, settings: ModelSettings): string[] {
  return settings.scope === 'native-workspace'
    ? [...new Set([...scope.workingDirectories, ...scope.readExceptions, ...scope.writeExceptions])]
    : settings.repositories;
}

/** Native settings supply authority. Disclosure anchors only restrict its use. */
export async function resolveClaudeWorkspace(
  cwd: string,
  settings: Settings,
  repositories: readonly string[] | 'native-workspace',
): Promise<ClaudeWorkspace | null> {
  try {
    const root = await realpath(cwd);
    const paths = async (values: string[], directories: boolean) => {
      const canonical = await Promise.all(
        values.map(async (value) => {
          if (!value || value !== value.trim() || value.startsWith('~') || value.includes('\0'))
            throw new Error('Unsupported native workspace path');
          const path = await realpath(resolve(root, value).normalize('NFC'));
          if (directories && !(await stat(path)).isDirectory())
            throw new Error('Native working directory is unavailable');
          if (repositories !== 'native-workspace' && !disclosureCovers(repositories, path))
            throw new Error('Native workspace is outside disclosure scope');
          return path;
        }),
      );
      return [...new Set(canonical)].sort();
    };
    if (repositories !== 'native-workspace' && !disclosureCovers(repositories, root)) return null;
    const nativeAdditional = settings.permissions?.additionalDirectories ?? [];
    const additional = await paths(nativeAdditional, true);
    const readExceptions = await paths(settings.sandbox?.filesystem?.allowRead ?? [], false);
    const writeExceptions = await paths(settings.sandbox?.filesystem?.allowWrite ?? [], false);
    return scopeSchema.parse({
      version: 1,
      root,
      workingDirectories: [root, ...additional.filter((path) => path !== root)],
      // Native settings retain raw --add-dir spellings too. Freezing only their
      // realpaths leaves a raw symlink grant free to retarget on first use.
      workingDirectorySpellings: [
        ...new Set([
          root.normalize('NFC'),
          ...additional.map((path) => path.normalize('NFC')),
          ...nativeAdditional.map((path) => resolve(root, path).normalize('NFC')),
        ]),
      ].sort(),
      readExceptions,
      writeExceptions,
    });
  } catch {
    return null;
  }
}
