import { realpath } from 'node:fs/promises';
import { z } from 'zod';
import { loadRawConfig } from '../lib/config';
import { routerSettings } from './settings';

const consentSchema = z.object({
  routerOrigin: z.url(),
  version: z.literal(1),
  recipients: z.tuple([z.literal('Tenjin'), z.literal('DeepSeek')]),
  repositories: z.array(z.string()).min(1),
  maxJobAtomic: z.string().regex(/^\d+$/),
});
/** Separate inference consent: legacy native-tier/effort settings grant nothing. */
export async function modelSettings(dataDir: string, cwd: string) {
  const config = await loadRawConfig(dataDir);
  const settings = await routerSettings({ cwd, dataDir, config });
  const block = config.router as Record<string, unknown> | undefined;
  const parsed = consentSchema.safeParse(block?.subagentConsent);
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
  if (!roots.includes(root) || BigInt(parsed.data.maxJobAtomic) <= 0n) return null;
  return {
    root,
    maxJobAtomic: BigInt(parsed.data.maxJobAtomic),
    routerOrigin: parsed.data.routerOrigin,
    context: settings.context.value,
  };
}
