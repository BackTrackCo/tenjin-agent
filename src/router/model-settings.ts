import { realpath } from 'node:fs/promises';
import { sep } from 'node:path';
import { z } from 'zod';
import { loadRawConfig, resolveSettings, type PartialConfig } from '../lib/config';
import { isRecord } from '../lib/guards';
import { routerSettings } from './settings';

/**
 * Who receives a worker's data: Tenjin and DeepSeek its requests, Exa its web search
 * queries and the address of a page its WebFetch could not fetch.
 */
const RECIPIENTS = ['Tenjin', 'DeepSeek', 'Exa'] as const;
/** The recipients a consent named before Exa was named. */
const EARLIER_RECIPIENTS = ['Tenjin', 'DeepSeek'] as const;
const consentFields = {
  routerOrigin: z.url(),
  instructions: z.literal('applicable'),
  /**
   * What a worker may read beyond the directories consent names: the person's
   * global Claude Code folder, session transcripts included. A consent given
   * before a worker could read it has no such field and no longer qualifies.
   */
  reads: z.literal('claude-home'),
  /** A consent that names fewer recipients was given under an earlier disclosure. */
  recipients: z.tuple([z.literal('Tenjin'), z.literal('DeepSeek'), z.literal('Exa')]),
  maxJobAtomic: z.string().regex(/^\d+$/),
  /**
   * Set where the person agreed to the rule and to no amount: a job's cap is their
   * per-call spend limit as it stands at each offer. `maxJobAtomic` then holds that limit
   * as it stood at consent, the ceiling a build from before the rule reads. Absent,
   * `maxJobAtomic` is a ceiling the person named, which a higher per-call limit never lifts.
   */
  maxJob: z.literal('per-call-limit').optional(),
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

/** The person's per-call spend limit, the same one the tool router applies to one paid call. */
export function perCallLimitAtomic(config: PartialConfig): bigint {
  return BigInt(resolveSettings({ config, flags: {}, env: process.env }).maxAutoSpend.value);
}

/**
 * A JOB'S CAP: from the person's side a job is one call, so it is their per-call spend
 * limit, read fresh. A ceiling the person named (`--max-job`, or a consent from before
 * the rule) lowers it and never raises it. A lower limit lowers the next offer and a
 * running job's remaining cap at once. A higher one lifts the cap only where the consent
 * names the rule; a named ceiling stays until the person gives the consent again.
 */
function jobCapAtomic(
  consent: { maxJobAtomic: string; maxJob?: 'per-call-limit' },
  perCall: bigint,
): bigint {
  const named = BigInt(consent.maxJobAtomic);
  return consent.maxJob === 'per-call-limit' || perCall < named ? perCall : named;
}

/**
 * Installation records disclosure, never a directory or a native permission grant. Its
 * question names the rule for the cap, so the record does too.
 */
export function nativeWorkspaceModelConsent(options: {
  routerOrigin: string;
  /** The per-call limit as it stands, for a build from before the rule. */
  maxJobAtomic?: string;
}) {
  return nativeWorkspaceConsentSchema.parse({
    version: 3,
    scope: 'native-workspace',
    instructions: 'applicable',
    reads: 'claude-home',
    recipients: [...RECIPIENTS],
    routerOrigin: options.routerOrigin,
    maxJobAtomic: options.maxJobAtomic ?? '1000000',
    maxJob: 'per-call-limit',
  });
}

/**
 * A consent record given under an earlier disclosure: valid but for what a
 * worker may read today, or for naming Tenjin and DeepSeek without Exa. It
 * qualifies for nothing until the person renews it.
 */
export function outdatedModelConsent(value: unknown) {
  if (modelConsentSchema.safeParse(value).success) return null;
  if (!isRecord(value)) return null;
  const earlier =
    Array.isArray(value.recipients) &&
    value.recipients.length === EARLIER_RECIPIENTS.length &&
    EARLIER_RECIPIENTS.every((name, at) => (value.recipients as unknown[])[at] === name);
  const parsed = modelConsentSchema.safeParse({
    ...value,
    reads: 'claude-home',
    ...(earlier ? { recipients: [...RECIPIENTS] } : {}),
  });
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
  // A named ceiling of zero is no consent to any job. A per-call limit of zero is the
  // person's stop for automatic payments: the cap is then zero, and no job is offered.
  if (
    !disclosureCovers(repositories, root) ||
    (parsed.data.maxJob === undefined && BigInt(parsed.data.maxJobAtomic) <= 0n)
  )
    return null;
  return {
    version: parsed.data.version,
    scope: parsed.data.version === 3 ? ('native-workspace' as const) : ('repositories' as const),
    root,
    repositories,
    githubRepositories: parsed.data.version === 2 ? parsed.data.githubRepositories : [],
    maxJobAtomic: jobCapAtomic(parsed.data, perCallLimitAtomic(config)),
    routerOrigin: parsed.data.routerOrigin,
    context: settings.context.value,
  };
}
export type ModelSettings = NonNullable<Awaited<ReturnType<typeof modelSettings>>>;
