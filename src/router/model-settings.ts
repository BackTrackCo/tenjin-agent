import { realpathSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { isAbsolute, sep } from 'node:path';
import { z } from 'zod';
import { loadRawConfig, resolveSettings, type PartialConfig } from '../lib/config';
import { routerSettings } from './settings';

/**
 * Who receives a worker's data: Tenjin and DeepSeek its requests, Exa its web search
 * queries and the address of a page its WebFetch could not fetch.
 */
const RECIPIENTS = ['Tenjin', 'DeepSeek', 'Exa'] as const;
/**
 * THE ONE CONSENT, written by the fresh-setup answer and by `tenjin config subagents on`
 * alike. It covers the native workspace of whatever session a call comes from, and grants
 * no directory by itself. Two additions are optional, and each is the person's own word.
 */
export const modelConsentSchema = z.object({
  version: z.literal(2),
  routerOrigin: z.url(),
  instructions: z.literal('applicable'),
  /** A worker reads the person's global Claude Code folder, session transcripts included. */
  reads: z.literal('claude-home'),
  recipients: z.tuple([z.literal('Tenjin'), z.literal('DeepSeek'), z.literal('Exa')]),
  /**
   * Directories named with `--repository`. A session inside one gives its worker all of
   * them as working directories, beside its own native workspace.
   */
  repositories: z.array(z.string()).min(1).optional(),
  /** A ceiling named with `--max-job`. Absent, a job's cap is the per-call spend limit. */
  maxJobAtomic: z.string().regex(/^\d+$/).optional(),
});
export type ModelConsent = z.infer<typeof modelConsentSchema>;

/** The person's per-call spend limit, the same one the tool router applies to one paid call. */
export function perCallLimitAtomic(config: PartialConfig): bigint {
  return BigInt(resolveSettings({ config, flags: {}, env: process.env }).maxAutoSpend.value);
}

/**
 * A JOB'S CAP: from the person's side a job is one call, so it is their per-call spend
 * limit, read fresh. A ceiling the person named with `--max-job` lowers it and never
 * raises it. A lower limit lowers the next offer and a running job's remaining cap at once.
 */
function jobCapAtomic(named: string | undefined, perCall: bigint): bigint {
  return named !== undefined && BigInt(named) < perCall ? BigInt(named) : perCall;
}

/** The directories a consent names that still resolve, as their real paths. */
function namedDirectories(consent: unknown): string[] {
  const parsed = modelConsentSchema.safeParse(consent);
  if (!parsed.success) return [];
  return (parsed.data.repositories ?? []).flatMap((path) => {
    if (!isAbsolute(path)) return [];
    try {
      return [realpathSync(path)];
    } catch {
      return [];
    }
  });
}

/**
 * The record a turn-on writes. Directories named earlier at the same router are kept and
 * `repository` joins them; the ceiling is this turn-on's own, so one without `--max-job`
 * follows the per-call limit again.
 */
export function modelConsent(options: {
  routerOrigin: string;
  /** The consent already saved, whose named directories are kept. */
  prior?: unknown;
  /** A real path named with `--repository`. */
  repository?: string;
  maxJobAtomic?: string;
}): ModelConsent {
  const earlier = modelConsentSchema.safeParse(options.prior);
  const kept =
    earlier.success && earlier.data.routerOrigin === options.routerOrigin
      ? namedDirectories(earlier.data)
      : [];
  const repositories = [
    ...new Set([...kept, ...(options.repository === undefined ? [] : [options.repository])]),
  ];
  return modelConsentSchema.parse({
    version: 2,
    instructions: 'applicable',
    reads: 'claude-home',
    recipients: [...RECIPIENTS],
    routerOrigin: options.routerOrigin,
    ...(repositories.length ? { repositories } : {}),
    ...(options.maxJobAtomic === undefined ? {} : { maxJobAtomic: options.maxJobAtomic }),
  });
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
  const named = namedDirectories(parsed.data);
  return {
    version: parsed.data.version,
    root,
    // Named directories join the worker's own only for a session that is inside one.
    repositories: disclosureCovers(named, root) ? named : [],
    maxJobAtomic: jobCapAtomic(parsed.data.maxJobAtomic, perCallLimitAtomic(config)),
    routerOrigin: parsed.data.routerOrigin,
    context: settings.context.value,
  };
}
export type ModelSettings = NonNullable<Awaited<ReturnType<typeof modelSettings>>>;
