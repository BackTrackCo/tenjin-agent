import { realpath } from 'node:fs/promises';
import { sep } from 'node:path';
import { z } from 'zod';
import { loadRawConfig } from '../lib/config';
import { routerSettings } from './settings';

export const modelConsentSchema = z.object({
  routerOrigin: z.url(),
  version: z.literal(2),
  instructions: z.literal('applicable'),
  recipients: z.tuple([z.literal('Tenjin'), z.literal('DeepSeek')]),
  repositories: z.array(z.string()).min(1),
  githubRepositories: z
    .array(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_][A-Za-z0-9._-]{0,99}$/))
    .default([]),
  maxJobAtomic: z.string().regex(/^\d+$/),
});

/** A named directory covers its descendants, never its parent or a sibling prefix. */
export function disclosureCovers(repositories: readonly string[], path: string): boolean {
  return repositories.some(
    (root) => path === root || path.startsWith(root.endsWith(sep) ? root : `${root}${sep}`),
  );
}
/** Separate inference consent: legacy native-tier/effort settings grant nothing. */
export async function modelSettings(dataDir: string, cwd: string) {
  const config = await loadRawConfig(dataDir);
  const settings = await routerSettings({ cwd, dataDir, config });
  const block = config.router as Record<string, unknown> | undefined;
  const parsed = modelConsentSchema.safeParse(block?.subagentConsent);
  if (
    !settings.enabled.value ||
    !settings.subagents.value ||
    block?.subagents !== true ||
    !parsed.success
  )
    return null;
  const root = await realpath(cwd).catch(() => null);
  if (!root) return null;
  const roots = await Promise.all(
    parsed.data.repositories.map((p) => realpath(p).catch(() => null)),
  );
  const repositories = [...new Set(roots.filter((path): path is string => path !== null))];
  if (!disclosureCovers(repositories, root) || BigInt(parsed.data.maxJobAtomic) <= 0n) return null;
  return {
    root,
    repositories,
    githubRepositories: parsed.data.githubRepositories,
    maxJobAtomic: BigInt(parsed.data.maxJobAtomic),
    routerOrigin: parsed.data.routerOrigin,
    context: settings.context.value,
  };
}
