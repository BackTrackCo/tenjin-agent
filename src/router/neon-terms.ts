import { z } from 'zod';
import { INFERENCE_ACCEPT, requestToolSpec, type DecisionDeps, type OfferSpec } from './decision';

/**
 * THE TERMS OF THE NEON WORKER'S SELLER, all of them from the Tenjin router's provider row. The
 * CLI names no seller, URL, payee, model or price: the door reads the row through the router's
 * free `{tool}` lookup, keeps these terms with the job, and every call and every refund of that
 * job uses the saved terms, so a later change of the row never moves a running job's money.
 * This file is the one place that reads the row's wire fields.
 */
const atomic = z.string().regex(/^\d{1,30}$/);
export const neonTermsSchema = z.object({
  /** The row's id, which names the row in a lookup. */
  rowId: z.string().min(1).max(200),
  /** The display name of the row's model. */
  label: z.string().min(1).max(64),
  /** Where a chat completion is posted: the row's `request.url`. */
  url: z.url().max(2_048),
  /** The payee every payment goes to: the row's `payTo`. */
  payTo: z.string().min(1).max(200),
  network: z.string().min(1).max(64),
  asset: z.string().min(1).max(200),
  model: z.string().min(1).max(200),
  /** The wire shape and payment scheme this build has an adapter for. */
  wire: z.literal('chat'),
  scheme: z.literal('batch-settlement'),
  /** How the reply names its tokens: `nanogpt` adds a cache block of its own. */
  usage: z.enum(['nanogpt', 'standard']),
  /** The price rule, atomic USDC per million tokens. */
  inputAtomicPerMillion: atomic,
  outputAtomicPerMillion: atomic,
  cacheReadAtomicPerMillion: atomic,
});
export type NeonTerms = z.infer<typeof neonTermsSchema>;

/** The row's id in a lookup. EVAL ONLY: `TENJIN_NEON_MODEL` names another row. */
export const NEON_ROW_ID = 'x402inference-gemini-4-neon';
export const NEON_ROW_ENV = 'TENJIN_NEON_MODEL';
export function neonRowId(env: NodeJS.ProcessEnv = process.env): string {
  const asked = env[NEON_ROW_ENV];
  return asked !== undefined && /^[A-Za-z0-9._:-]{1,200}$/.test(asked) ? asked : NEON_ROW_ID;
}

/** The row could not be read, or this build cannot run it. Nothing was sent or paid. */
export class NeonLookupFailed extends Error {}

/** A spec as terms, or why this build cannot run it. */
export function neonTermsOfSpec(rowId: string, spec: OfferSpec): NeonTerms {
  const row = spec.inference;
  if (!row) throw new NeonLookupFailed('The provider row has no inference terms');
  if (row.wire !== 'chat' || row.scheme !== 'batch-settlement')
    throw new NeonLookupFailed(
      `This build has no adapter for the row's wire shape ${row.wire} with payment scheme ${row.scheme}`,
    );
  const parsed = neonTermsSchema.safeParse({
    rowId,
    label: spec.label ?? spec.provider.slice(0, 64),
    url: spec.request.url,
    payTo: spec.payTo,
    network: spec.network,
    asset: spec.asset,
    model: row.model,
    wire: row.wire,
    scheme: row.scheme,
    usage: row.usage,
    inputAtomicPerMillion: row.price.inputAtomicPerMillion,
    outputAtomicPerMillion: row.price.outputAtomicPerMillion,
    cacheReadAtomicPerMillion: row.price.cacheReadAtomicPerMillion,
  });
  if (!parsed.success) throw new NeonLookupFailed('The provider row is not usable');
  if (new URL(parsed.data.url).protocol !== 'https:')
    throw new NeonLookupFailed('The provider row names a URL that is not https');
  if (spec.request.method !== 'POST')
    throw new NeonLookupFailed('The provider row is not a POST endpoint');
  return parsed.data;
}

/** The seller's host: the name its calls carry in the paid ledger and the spend window. */
export const neonHost = (terms: Pick<NeonTerms, 'url'>) => new URL(terms.url).host;

/**
 * THE DOOR'S LOOKUP: one free `{tool}` call for the row, sent with the `inference` token that
 * only a build with the adapters sends. A failed lookup is a failed job with nothing sent, and
 * there is no seller to fall back to.
 */
export async function lookupNeonTerms(
  deps: Omit<DecisionDeps, 'route'>,
  rowId = neonRowId(),
): Promise<NeonTerms> {
  let outcome;
  try {
    outcome = await requestToolSpec(rowId, deps, undefined, [INFERENCE_ACCEPT]);
  } catch {
    throw new NeonLookupFailed('The Tenjin router could not be reached for the provider row');
  }
  if (outcome.status !== 'decided')
    throw new NeonLookupFailed('The Tenjin router did not give the provider row');
  const decision = outcome.decision.decision;
  if (decision.action !== 'spec' || !('inference' in decision.spec))
    throw new NeonLookupFailed('The Tenjin router gave no inference terms for that row');
  const spec: OfferSpec = { ...decision.spec, id: decision.id };
  if (spec.capabilityId !== rowId)
    throw new NeonLookupFailed('The Tenjin router answered with another row');
  return neonTermsOfSpec(rowId, spec);
}

/** `tokens` at `perMillion` atomic USDC, rounded up. */
export const tokenCostAtomic = (tokens: bigint | number, perMillion: string): bigint =>
  (BigInt(tokens) * BigInt(perMillion) + 999_999n) / 1_000_000n;

/** The name a Neon job shows: the label of the row it was started under. */
export function neonJobLabel(decision: Record<string, unknown>): string {
  const terms = neonTermsSchema.safeParse(decision.neonTerms);
  return terms.success ? terms.data.label : 'Neon writer';
}
