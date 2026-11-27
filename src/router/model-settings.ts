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
 * THE ONE CONSENT RECORD, written by the fresh-setup answer and by
 * `tenjin config subagents on` alike. ITS SCOPE IS ONE OF TWO, told by `repositories`.
 * Absent, the consent covers the native workspace of every session and grants no
 * directory by itself. Present, the consent is limited to the directories the person
 * named with `--repository` and nothing else: a session outside them gets no offer. A
 * record never moves from the limited scope to the wide one but by the person's own
 * `on` with no `--repository`.
 */
const consentFields = {
  routerOrigin: z.url(),
  instructions: z.literal('applicable'),
  /** A worker reads the person's global Claude Code folder, session transcripts included. */
  reads: z.literal('claude-home'),
  /** The limited scope: only sessions inside these directories, whose workers get all of them. */
  repositories: z.array(z.string()).min(1).optional(),
  /** A ceiling named with `--max-job`. Absent, a job's cap is the per-call spend limit. */
  maxJobAtomic: z.string().regex(/^\d+$/).optional(),
};
export const modelConsentSchema = z.object({
  ...consentFields,
  version: z.literal(2),
  recipients: z.tuple([z.literal('Tenjin'), z.literal('DeepSeek'), z.literal('Exa')]),
});
export type ModelConsent = z.infer<typeof modelConsentSchema>;

/**
 * A NEON JOB HAS NO TENJIN ROUTER AND NO CONSENT RECORD. The router never offers Neon, so a job
 * starts only when the person, or a skill the person runs, asks for it by calling the door.
 * Its settings and its transport carry this fixed marker where a DeepSeek job carries the
 * router's origin. The seller is never named here: a job's seller comes from the provider row
 * the door read, saved with the job.
 */
export const NEON_ROUTER_ORIGIN = 'tenjin:neon';
/** Which provider's consent and worker a job or a call belongs to. */
export type WorkerProvider = 'deepseek' | 'neon';
/** The provider a job runs on: Neon only when its decision says so, else DeepSeek. */
export function providerOf(job: { decision: Record<string, unknown> }): WorkerProvider {
  return job.decision.provider === 'neon' ? 'neon' : 'deepseek';
}

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

/**
 * The directories a saved consent names for `routerOrigin` that still resolve, as their
 * real paths. Null where it names none: a wide consent, another router's, or no consent.
 */
export function namedDirectories(consent: unknown, routerOrigin?: string): string[] | null {
  const parsed = modelConsentSchema.safeParse(consent);
  if (!parsed.success || parsed.data.repositories === undefined) return null;
  if (routerOrigin !== undefined && parsed.data.routerOrigin !== routerOrigin) return null;
  return parsed.data.repositories.flatMap((path) => {
    if (!isAbsolute(path)) return [];
    try {
      return [realpathSync(path)];
    } catch {
      return [];
    }
  });
}

/**
 * The record a turn-on writes. With `repositories` it is limited to them; without, it
 * covers every session's workspace. The ceiling is this turn-on's own, so one without
 * `--max-job` follows the per-call limit again.
 */
export function modelConsent(options: {
  routerOrigin: string;
  /** Real paths: the limited scope. */
  repositories?: readonly string[];
  maxJobAtomic?: string;
}): ModelConsent {
  return modelConsentSchema.parse({
    version: 2,
    instructions: 'applicable',
    reads: 'claude-home',
    recipients: [...RECIPIENTS],
    routerOrigin: options.routerOrigin,
    ...(options.repositories?.length ? { repositories: [...new Set(options.repositories)] } : {}),
    ...(options.maxJobAtomic === undefined ? {} : { maxJobAtomic: options.maxJobAtomic }),
  });
}

/** A named directory covers its descendants, never its parent or a sibling prefix. */
export function disclosureCovers(repositories: readonly string[], path: string): boolean {
  return repositories.some(
    (root) => path === root || path.startsWith(root.endsWith(sep) ? root : `${root}${sep}`),
  );
}
/**
 * What a worker's job runs under. A DeepSeek job needs the person's saved consent. A Neon job
 * needs none: the person or a skill they run asks for it, and only the router's own off switch
 * and the person's spend limits apply. Legacy native-tier/effort settings grant nothing.
 */
export async function modelSettings(
  dataDir: string,
  cwd: string,
  provider: WorkerProvider = 'deepseek',
) {
  const config = await loadRawConfig(dataDir);
  const settings = await routerSettings({ cwd, dataDir, config });
  if (provider === 'neon') {
    const root = settings.enabled.value ? await realpath(cwd).catch(() => null) : null;
    if (!root) return null;
    return {
      version: 1 as const,
      scope: 'native-workspace' as const,
      root,
      repositories: [root],
      maxJobAtomic: jobCapAtomic(undefined, perCallLimitAtomic(config)),
      routerOrigin: NEON_ROUTER_ORIGIN as string,
      context: settings.context.value,
    };
  }
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
  // A limited consent whose directories are all gone covers nothing: never the wide scope.
  const named = namedDirectories(parsed.data);
  if (named && !disclosureCovers(named, root)) return null;
  return {
    version: parsed.data.version,
    scope: named ? ('repositories' as const) : ('native-workspace' as const),
    root,
    repositories: named ?? [root],
    maxJobAtomic: jobCapAtomic(parsed.data.maxJobAtomic, perCallLimitAtomic(config)),
    routerOrigin: parsed.data.routerOrigin,
    context: settings.context.value,
  };
}
export type ModelSettings = NonNullable<Awaited<ReturnType<typeof modelSettings>>>;
