import { realpath } from 'node:fs/promises';
import { sep } from 'node:path';
import { z } from 'zod';
import { loadRawConfig } from '../lib/config';
import { routerSettings } from './settings';

const consentFields = {
  routerOrigin: z.url(),
  instructions: z.literal('applicable'),
  /**
   * What a worker may read beyond the directories consent names: the person's
   * global Claude Code folder, session transcripts included. A consent given
   * before a worker could read it has no such field and no longer qualifies.
   */
  reads: z.literal('claude-home'),
  recipients: z.tuple([z.literal('Tenjin'), z.literal('DeepSeek')]),
  maxJobAtomic: z.string().regex(/^\d+$/),
};
const repositoryConsentSchema = z.object({
  ...consentFields,
  version: z.literal(2),
  repositories: z.array(z.string()).min(1),
  githubRepositories: z
    .array(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_][A-Za-z0-9._-]{0,99}$/))
    .default([]),
});
const nativeWorkspaceConsentSchema = z
  .object({ ...consentFields, version: z.literal(3), scope: z.literal('native-workspace') })
  .strict();
export const modelConsentSchema = z.discriminatedUnion('version', [
  repositoryConsentSchema,
  nativeWorkspaceConsentSchema,
]);

/** Installation records disclosure, never a directory or a native permission grant. */
export function nativeWorkspaceModelConsent(options: {
  routerOrigin: string;
  maxJobAtomic?: string;
}) {
  return nativeWorkspaceConsentSchema.parse({
    version: 3,
    scope: 'native-workspace',
    instructions: 'applicable',
    reads: 'claude-home',
    recipients: ['Tenjin', 'DeepSeek'],
    routerOrigin: options.routerOrigin,
    maxJobAtomic: options.maxJobAtomic ?? '1000000',
  });
}

/**
 * A consent record given under an earlier disclosure: valid but for what a
 * worker may read today. It qualifies for nothing until the person renews it.
 */
export function outdatedModelConsent(value: unknown) {
  if (modelConsentSchema.safeParse(value).success) return null;
  const renewed = value && typeof value === 'object' ? { ...value, reads: 'claude-home' } : value;
  const parsed = modelConsentSchema.safeParse(renewed);
  return parsed.success ? parsed.data : null;
}

/** Whether subagent routing is on with a consent that predates the current disclosure. */
export async function modelConsentOutdated(dataDir: string): Promise<boolean> {
  const block = (await loadRawConfig(dataDir).catch(() => null))?.router as
    Record<string, unknown> | undefined;
  return block?.subagents === true && outdatedModelConsent(block.subagentConsent) !== null;
}

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
  const roots =
    parsed.data.version === 3
      ? [root]
      : await Promise.all(parsed.data.repositories.map((p) => realpath(p).catch(() => null)));
  const repositories = [...new Set(roots.filter((path): path is string => path !== null))];
  if (!disclosureCovers(repositories, root) || BigInt(parsed.data.maxJobAtomic) <= 0n) return null;
  return {
    version: parsed.data.version,
    scope: parsed.data.version === 3 ? ('native-workspace' as const) : ('repositories' as const),
    root,
    repositories,
    githubRepositories: parsed.data.version === 2 ? parsed.data.githubRepositories : [],
    maxJobAtomic: BigInt(parsed.data.maxJobAtomic),
    routerOrigin: parsed.data.routerOrigin,
    context: settings.context.value,
  };
}
export type ModelSettings = NonNullable<Awaited<ReturnType<typeof modelSettings>>>;
