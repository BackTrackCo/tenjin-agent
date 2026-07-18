import { z } from 'zod';
import { CliError } from './errors';
import { httpRequest, type HttpResult } from './http';
import { CLIENT_HEADER } from './client-meta';

/**
 * The lookup + outcome HTTP contract (A2, tenjin#370). Request building and
 * response validation live here; the wire shape is validated defensively, an
 * unknown `schemaVersion` degrades to a parse refusal rather than a guess, and
 * unrecognized candidate fields are ignored (forward-compatible), per spec 10.
 *
 * These endpoints are anonymous: no wallet, no SIWX. The only header of note is
 * `X-Tenjin-Client`, which attributes a later purchase back to the lookup flow.
 */

const FRESH_WITHIN_RE = /^P\d{1,4}[DWMY]$/;
const ATOMIC_RE = /^\d{1,39}$/;
const CANONICAL_KEY_RE = /^[a-z][a-z0-9_]{0,31}$/;

/** Client-side lookup request (mirrors lib/lookup.ts lookupRequestSchema bounds
 *  so a malformed flag fails locally as USAGE, before a round trip). */
export interface LookupInput {
  question: string;
  freshWithin?: string;
  maxPrice?: string;
  appliesTo?: Record<string, string[]>;
  limit?: number;
}

export interface LookupRequestBody {
  schemaVersion: 1;
  question: string;
  freshWithin?: string;
  maxPrice?: string;
  appliesTo?: Record<string, string[]>;
  limit: number;
}

export function buildLookupRequest(input: LookupInput): LookupRequestBody {
  const question = input.question.trim();
  if (question.length === 0 || question.length > 512) {
    throw new CliError('USAGE', 'question must be 1 to 512 characters', {
      fix: 'Pass a non-empty question under 512 characters.',
    });
  }
  if (input.freshWithin !== undefined && !FRESH_WITHIN_RE.test(input.freshWithin)) {
    throw new CliError('USAGE', `Invalid --fresh-within: ${JSON.stringify(input.freshWithin)}`, {
      fix: 'Use an ISO-like window P<n>[DWMY], e.g. P30D, P2W, P1Y.',
    });
  }
  if (input.maxPrice !== undefined && !ATOMIC_RE.test(input.maxPrice)) {
    throw new CliError('USAGE', `Invalid --max-price: ${JSON.stringify(input.maxPrice)}`, {
      fix: 'Pass an atomic USDC integer, e.g. 100000 for $0.10.',
    });
  }
  const limit = input.limit ?? 5;
  if (!Number.isInteger(limit) || limit < 1 || limit > 10) {
    throw new CliError('USAGE', `Invalid --limit: ${JSON.stringify(input.limit)}`, {
      fix: 'Pass an integer between 1 and 10.',
    });
  }
  if (input.appliesTo !== undefined) {
    for (const [key, values] of Object.entries(input.appliesTo)) {
      if (!CANONICAL_KEY_RE.test(key)) {
        throw new CliError('USAGE', `Invalid appliesTo key: ${JSON.stringify(key)}`, {
          fix: 'Keys must be canonical lowercase identifiers, e.g. products=Vercel.',
        });
      }
      if (values.length === 0) {
        throw new CliError('USAGE', `appliesTo key ${JSON.stringify(key)} has no values`, {
          fix: 'Give each --applies-to key at least one value.',
        });
      }
    }
  }
  return {
    schemaVersion: 1,
    question,
    ...(input.freshWithin !== undefined ? { freshWithin: input.freshWithin } : {}),
    ...(input.maxPrice !== undefined ? { maxPrice: input.maxPrice } : {}),
    ...(input.appliesTo !== undefined ? { appliesTo: input.appliesTo } : {}),
    limit,
  };
}

// Response schemas. `.passthrough()` on the candidate keeps unknown future fields
// instead of stripping them (forward-compatible), while still requiring the
// contract fields this CLI reads. `decision` is uppercase on the wire.
const lookupCandidateSchema = z
  .object({
    resourceId: z.string(),
    url: z.string(),
    title: z.string(),
    artifactType: z.string(),
    price: z.string(),
    asOf: z.string().nullable(),
    validUntil: z.string().nullable(),
    temporalMode: z.string(),
    appliesTo: z.record(z.string(), z.array(z.string())),
    questionsAnswered: z.array(z.string()),
    tasksSupported: z.array(z.string()),
    scope: z.string().nullable(),
    exclusions: z.string().nullable(),
    matchReasons: z.array(z.string()),
    estimatedTokens: z.number(),
    creator: z.object({ handle: z.string() }).passthrough(),
  })
  .passthrough();

export type LookupCandidate = z.infer<typeof lookupCandidateSchema>;

const lookupResponseSchema = z.object({
  schemaVersion: z.literal(1),
  lookupId: z.string(),
  decision: z.enum(['CANDIDATES', 'MISS']),
  calibration: z.string(),
  candidates: z.array(lookupCandidateSchema).optional(),
});

export type LookupResponse = z.infer<typeof lookupResponseSchema>;

export interface AgentApiOptions {
  baseUrl: string;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
}

function trimSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

/** Turn a non-2xx / transport HttpResult into the CLI error contract. */
function apiFailure(url: string, result: Exclude<HttpResult, { ok: true }>): CliError {
  const code =
    result.kind === 'network' || result.kind === 'timeout' ? 'NETWORK_ERROR' : 'API_UNREACHABLE';
  return new CliError(code, `${url}: ${result.message}`, {
    fix: 'Check --base-url and your network, then retry.',
  });
}

function serverErrorMessage(json: unknown): string | undefined {
  if (typeof json === 'object' && json !== null) {
    const rec = json as Record<string, unknown>;
    const err = rec.error;
    if (typeof err === 'string') return err;
    if (typeof err === 'object' && err !== null) {
      const m = (err as Record<string, unknown>).message;
      if (typeof m === 'string') return m;
    }
    if (typeof rec.message === 'string') return rec.message;
  }
  return undefined;
}

export async function postLookup(
  body: LookupRequestBody,
  opts: AgentApiOptions,
): Promise<LookupResponse> {
  const url = `${trimSlash(opts.baseUrl)}/api/agent/lookup`;
  const res = await httpRequest(url, {
    method: 'POST',
    timeoutMs: opts.timeoutMs,
    headers: { 'x-tenjin-client': CLIENT_HEADER },
    jsonBody: body,
    fetchImpl: opts.fetchImpl,
  });
  if (!res.ok) throw apiFailure(url, res);
  if (res.status !== 200) {
    throw new CliError(
      'API_UNREACHABLE',
      serverErrorMessage(res.json) ?? `Lookup failed (${res.status})`,
      {
        fix: 'Retry; if it persists the lookup endpoint may be unavailable.',
        details: res.json,
      },
    );
  }
  const parsed = lookupResponseSchema.safeParse(res.json);
  if (!parsed.success) {
    throw new CliError('CONTRACT_MISMATCH', 'Lookup response did not match the expected contract', {
      fix: 'Update tenjin-cli; the server contract may have changed.',
      details: parsed.error.issues,
    });
  }
  return parsed.data;
}

const OUTCOME_STATUSES = [
  'used',
  'partially_used',
  'rejected',
  'regenerated',
  'purchase_declined',
] as const;
export type OutcomeStatus = (typeof OUTCOME_STATUSES)[number];
export const OUTCOME_STATUS_VALUES: readonly string[] = OUTCOME_STATUSES;

const CONTENT_HASH_RE = /^sha256:[0-9a-f]{64}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface OutcomeInput {
  status: string;
  resourceId?: string;
  contentHash?: string;
}

export interface OutcomeBodyItem {
  status: OutcomeStatus;
  resourceId?: string;
  contentHash?: string;
}

export function buildOutcomeItem(input: OutcomeInput): OutcomeBodyItem {
  if (!OUTCOME_STATUS_VALUES.includes(input.status)) {
    throw new CliError('USAGE', `Invalid outcome status: ${JSON.stringify(input.status)}`, {
      fix: `Use one of: ${OUTCOME_STATUSES.join(', ')}.`,
    });
  }
  if (input.resourceId !== undefined && !UUID_RE.test(input.resourceId)) {
    throw new CliError('USAGE', `Invalid --resource id: ${JSON.stringify(input.resourceId)}`, {
      fix: 'Pass the resourceId (a uuid) from a lookup candidate.',
    });
  }
  if (input.contentHash !== undefined && !CONTENT_HASH_RE.test(input.contentHash)) {
    throw new CliError('USAGE', `Invalid content hash: ${JSON.stringify(input.contentHash)}`, {
      fix: 'A content hash is "sha256:<64 hex>".',
    });
  }
  return {
    status: input.status as OutcomeStatus,
    ...(input.resourceId !== undefined ? { resourceId: input.resourceId } : {}),
    ...(input.contentHash !== undefined ? { contentHash: input.contentHash } : {}),
  };
}

const LOOKUP_ID_RE = UUID_RE;

export async function postOutcomes(
  lookupId: string,
  items: OutcomeBodyItem[],
  opts: AgentApiOptions,
): Promise<{ accepted: number }> {
  if (!LOOKUP_ID_RE.test(lookupId)) {
    throw new CliError('USAGE', `Invalid lookup id: ${JSON.stringify(lookupId)}`, {
      fix: 'Pass the lookupId from a prior lookup (or use --last).',
    });
  }
  if (items.length === 0 || items.length > 10) {
    throw new CliError('USAGE', 'An outcome report carries 1 to 10 items', {
      fix: 'Report between 1 and 10 outcomes per call.',
    });
  }
  const url = `${trimSlash(opts.baseUrl)}/api/agent/lookups/${lookupId}/outcomes`;
  const res = await httpRequest(url, {
    method: 'POST',
    timeoutMs: opts.timeoutMs,
    headers: { 'x-tenjin-client': CLIENT_HEADER },
    jsonBody: items.length === 1 ? items[0] : items,
    fetchImpl: opts.fetchImpl,
  });
  if (!res.ok) throw apiFailure(url, res);
  // 202 is the only success; the body is a uniform { accepted } regardless of
  // whether the lookupId existed (no existence oracle, by design).
  if (res.status !== 202) {
    throw new CliError(
      'API_UNREACHABLE',
      serverErrorMessage(res.json) ?? `Outcome report failed (${res.status})`,
      {
        fix: 'Check the status vocabulary and lookup id, then retry.',
        details: res.json,
      },
    );
  }
  const accepted =
    typeof res.json === 'object' && res.json !== null && 'accepted' in res.json
      ? Number((res.json as { accepted: unknown }).accepted)
      : items.length;
  return { accepted: Number.isFinite(accepted) ? accepted : items.length };
}
