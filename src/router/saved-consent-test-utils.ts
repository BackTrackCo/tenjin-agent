import { realpathSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { isAbsolute, sep } from 'node:path';
import { z } from 'zod';
import { loadRawConfig, resolveSettings, type PartialConfig } from '../lib/config';
import type { ModelSettings } from './model-settings';
import { routerSettings } from './settings';

/**
 * WHAT THE OFFER TESTS STAND ON UNTIL THE OFFER PATH IS REMOVED. The code a DeepSeek offer
 * runs through (the handoff, the transport, the worker) is shared with the manual worker
 * door, so its tests stay. No production code reads `router.subagents` or
 * `router.subagentConsent` any more: a test that drives an offer replaces `modelSettings`
 * with {@link savedModelSettings}, which reads the old saved consent from the test's own
 * config file. The tests of what a saved setting does today never use it (see
 * `saved-subagent-settings.test.ts`).
 */
const RECIPIENTS = ['Tenjin', 'DeepSeek', 'Exa'] as const;
const consentSchema = z.object({
  version: z.literal(2),
  routerOrigin: z.url(),
  instructions: z.literal('applicable'),
  reads: z.literal('claude-home'),
  recipients: z.tuple([z.literal('Tenjin'), z.literal('DeepSeek'), z.literal('Exa')]),
  repositories: z.array(z.string()).min(1).optional(),
  maxJobAtomic: z.string().regex(/^\d+$/).optional(),
});

/** The record an old turn-on wrote. */
export function modelConsent(options: {
  routerOrigin: string;
  repositories?: readonly string[];
  maxJobAtomic?: string;
}) {
  return consentSchema.parse({
    version: 2,
    instructions: 'applicable',
    reads: 'claude-home',
    recipients: [...RECIPIENTS],
    routerOrigin: options.routerOrigin,
    ...(options.repositories?.length ? { repositories: [...new Set(options.repositories)] } : {}),
    ...(options.maxJobAtomic === undefined ? {} : { maxJobAtomic: options.maxJobAtomic }),
  });
}

function perCallLimitAtomic(config: PartialConfig): bigint {
  return BigInt(resolveSettings({ config, flags: {}, env: process.env }).maxAutoSpend.value);
}

function covers(repositories: readonly string[], path: string): boolean {
  return repositories.some(
    (root) => path === root || path.startsWith(root.endsWith(sep) ? root : `${root}${sep}`),
  );
}

function namedDirectories(repositories: readonly string[] | undefined): string[] | null {
  if (repositories === undefined) return null;
  return repositories.flatMap((path) => {
    if (!isAbsolute(path)) return [];
    try {
      return [realpathSync(path)];
    } catch {
      return [];
    }
  });
}

/** The reader the offer path used before no setting turned an offer on. */
export async function savedModelSettings(
  dataDir: string,
  cwd: string,
): Promise<ModelSettings | null> {
  const config = await loadRawConfig(dataDir);
  const settings = await routerSettings({ cwd, dataDir, config });
  const block = config.router as Record<string, unknown> | undefined;
  const parsed = consentSchema.safeParse(block?.subagentConsent);
  if (!settings.enabled.value || block?.subagents !== true || !parsed.success) return null;
  const root = await realpath(cwd).catch(() => null);
  if (!root) return null;
  const named = namedDirectories(parsed.data.repositories);
  if (named && !covers(named, root)) return null;
  const perCall = perCallLimitAtomic(config);
  const ceiling = parsed.data.maxJobAtomic;
  return {
    version: parsed.data.version,
    scope: named ? 'repositories' : 'native-workspace',
    root,
    repositories: named ?? [root],
    maxJobAtomic: ceiling !== undefined && BigInt(ceiling) < perCall ? BigInt(ceiling) : perCall,
    routerOrigin: parsed.data.routerOrigin,
    context: settings.context.value,
  };
}
