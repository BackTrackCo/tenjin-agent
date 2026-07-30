import { z } from 'zod';
import { CliError } from './errors';
import { httpRequest, type HttpResult } from './http';
import { CLIENT_HEADER } from './client-meta';
import { ATOMIC_RE, UUID_RE } from './ids';
import { trimSlash } from './url';

/**
 * The search + outcome HTTP contract (A2, tenjin#370). Request building and
 * response validation live here; the wire shape is validated defensively, an
 * unknown `schemaVersion` degrades to a parse refusal rather than a guess, and
 * unrecognized candidate fields are ignored (forward-compatible), per spec 10.
 *
 * These endpoints are anonymous: no wallet, no SIWX. The only header of note is
 * `X-Tenjin-Client`, which attributes a later purchase back to the search flow.
 */

const FRESH_WITHIN_RE = /^P(\d+)[DWMY]$/;
const CANONICAL_KEY_RE = /^[a-z][a-z0-9_]{0,31}$/;

/** The server's `limit` ceiling. Exported because the truncation advice in
 *  `search` has to name it: past search v2 the response budget scales with the
 *  candidates returned, so a truncated page is recovered by asking for MORE, and
 *  this is the value to ask for. One definition, so the cap the CLI enforces and
 *  the number it tells the operator to retry with cannot drift apart. */
export const MAX_LIMIT = 10;

/** Client-side search request (mirrors the server lookupRequestSchema bounds
 *  so a malformed flag fails locally as USAGE, before a round trip). */
export interface SearchInput {
  question: string;
  freshWithin?: string;
  maxPrice?: string;
  appliesTo?: Record<string, string[]>;
  limit?: number;
}

export interface SearchRequestBody {
  schemaVersion: 2;
  question: string;
  freshWithin?: string;
  maxPrice?: string;
  appliesTo?: Record<string, string[]>;
  limit: number;
}

export function buildSearchRequest(input: SearchInput): SearchRequestBody {
  const question = input.question.trim();
  if (question.length === 0 || question.length > 512) {
    throw new CliError('USAGE', 'question must be 1 to 512 characters', {
      fix: 'Pass a non-empty question under 512 characters.',
    });
  }
  if (input.freshWithin !== undefined) {
    // The server rejects ANY zero-valued duration (P0D, P0W, P00M, ...), so a
    // zero window fails here as USAGE instead of a remote 400.
    const digits = FRESH_WITHIN_RE.exec(input.freshWithin)?.[1];
    if (digits === undefined || Number(digits) === 0) {
      throw new CliError('USAGE', `Invalid --fresh-within: ${JSON.stringify(input.freshWithin)}`, {
        fix: 'Use a nonzero ISO-like window P<n>[DWMY], e.g. P30D, P2W, P1Y.',
      });
    }
  }
  if (input.maxPrice !== undefined && !ATOMIC_RE.test(input.maxPrice)) {
    throw new CliError('USAGE', `Invalid --max-price: ${JSON.stringify(input.maxPrice)}`, {
      fix: 'Pass an atomic USDC integer, e.g. 100000 for $0.10.',
    });
  }
  const limit = input.limit ?? 5;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new CliError('USAGE', `Invalid --limit: ${JSON.stringify(input.limit)}`, {
      fix: `Pass an integer between 1 and ${MAX_LIMIT}.`,
    });
  }
  if (input.appliesTo !== undefined) {
    // Mirror the server's strictObject bounds (<=8 keys, <=20 values/key,
    // 1..120 chars/value) so a bad filter fails locally, never as a remote 400.
    const keys = Object.keys(input.appliesTo);
    if (keys.length > 8) {
      throw new CliError('USAGE', 'Too many --applies-to keys (max 8).');
    }
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
      if (values.length > 20) {
        throw new CliError('USAGE', `Too many --applies-to values for ${key} (max 20).`);
      }
      for (const value of values) {
        if (value.length === 0 || value.length > 120) {
          throw new CliError(
            'USAGE',
            `Invalid --applies-to value for ${key}: must be 1 to 120 characters.`,
          );
        }
      }
    }
  }
  return {
    schemaVersion: 2,
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
//
// A candidate is a LEAN hit (search v2): identity, price, freshness and why it
// matched, and nothing more. The full answer card is one free unpaid GET of `url`
// away, which is what `tenjin inspect` does, so breadth here costs no depth there.
export const searchCandidateSchema = z
  .object({
    resourceId: z.string().regex(UUID_RE, 'resourceId must be a uuid'),
    url: z.string(),
    slug: z.string(),
    title: z.string(),
    artifactType: z.string(),
    price: z.string().regex(ATOMIC_RE, 'price must be an atomic integer string'),
    asOf: z.string().nullable(),
    validUntil: z.string().nullable(),
    matchReasons: z.array(z.string()),
    estimatedTokens: z.number(),
    creator: z.object({ handle: z.string() }).passthrough(),
  })
  .passthrough();

export type SearchCandidate = z.infer<typeof searchCandidateSchema>;

/** Per-field caps for a browse pointer's free-form strings. `url` gets its own,
 *  looser bound so a legitimate read URL is never mangled while an invented one
 *  still cannot run away. Declared above the schema because the schema enforces
 *  the `url` bound at parse time (see below). */
const BROWSE_BOUNDS = { title: 200, url: 512, handle: 64 } as const;

// A browse pointer, carried ONLY on a MISS (tenjin#460): a piece from the broad
// discoverable corpus with deliberately NO matchReasons, NO estimatedTokens and
// no confidence field. It is a "you might browse this" hint, never a scored
// answer candidate, so it is kept strictly out of `candidates` and never
// recorded in the local search store.
//
// That store exclusion makes `inspect`/`buy`/`outcome` unreachable BY
// `resourceId` (resolveResourceRef's uuid arm needs a store hit and fails with
// RESOURCE_NOT_FOUND), but NOT by url: resolveResourceRef's URL arm is gated on
// origin alone and never consults the store, so `tenjin buy <browse url>` does
// pay. That is by design here, since the url is the payable read endpoint and
// the contract re-emits it verbatim, but it is a real spend path, so the human
// hint line carries the price and every spend gate still applies. Do not
// restate the old "never reachable by inspect/buy/outcome" claim: it was false.
//
// A malformed pointer fails the WHOLE response into CONTRACT_MISMATCH rather
// than being dropped. Deliberate: this client is fail-closed on every other
// contract deviation, and silently swallowing a bad tail would hide server
// drift that contract.test.ts exists to catch. Pinned in agent-api.test.ts.
//
// The `url` bound is enforced HERE rather than by truncation in the projection
// below, and that asymmetry with `title`/`handle` is deliberate. Those two are
// display strings: clipping one degrades gracefully and the human still reads
// something true. `url` is an actionable payable pointer, and a clipped url is
// not a shorter url, it is a DIFFERENT and broken one that still looks payable
// in `--json`. Refusing is also the only ordering-independent answer: capping
// first would hand the origin assertion in `runSearch` a string the server never
// sent. 512 is far above any real read endpoint, so exceeding it is server drift.
export const searchBrowseSchema = z
  .object({
    resourceId: z.string().regex(UUID_RE, 'resourceId must be a uuid'),
    url: z.string().max(BROWSE_BOUNDS.url, `url must be at most ${BROWSE_BOUNDS.url} characters`),
    title: z.string(),
    price: z.string().regex(ATOMIC_RE, 'price must be an atomic integer string'),
    creator: z.object({ handle: z.string() }).passthrough(),
  })
  .passthrough();

export type SearchBrowse = z.infer<typeof searchBrowseSchema>;

export const searchResponseSchema = z.object({
  schemaVersion: z.literal(2),
  searchId: z.string().regex(UUID_RE, 'searchId must be a uuid'),
  decision: z.enum(['CANDIDATES', 'MISS']),
  calibration: z.string(),
  candidates: z.array(searchCandidateSchema).optional(),
  // Set only when the server's size backstop dropped trailing candidates the
  // requested limit had room for; omitted entirely otherwise. There is no cursor,
  // so the dropped tail is UNRECOVERABLE: the remedy is a narrower question, never
  // a retry at a smaller limit.
  truncated: z.literal(true).optional(),
  // Omitted entirely by the server when empty, and only ever present on a MISS.
  // Not enforced here (a stricter schema would reject an otherwise-usable
  // response); truncateResponse drops it on a CANDIDATES decision instead.
  browse: z.array(searchBrowseSchema).optional(),
});

export type SearchResponse = z.infer<typeof searchResponseSchema>;

export interface AgentApiOptions {
  baseUrl: string;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
  /** Spec 09 §3 evaluation-cohort opt-in: sends X-Tenjin-Eval-Cohort: 1. */
  evalCohort?: boolean;
}

/** Turn a non-2xx / transport HttpResult into the CLI error contract. */
function apiFailure(url: string, result: Exclude<HttpResult, { ok: true }>): CliError {
  const code =
    result.kind === 'network' || result.kind === 'timeout' ? 'NETWORK_ERROR' : 'API_UNREACHABLE';
  return new CliError(code, `${url}: ${result.message}`, {
    fix: 'Check --base-url and your network, then retry.',
  });
}

/** 429 with Retry-After: a recoverable pause, not an outage; agents branch on it. */
export function rateLimitError(
  url: string,
  header: (name: string) => string | undefined,
): CliError {
  const retryAfter = header('retry-after');
  const seconds = retryAfter !== undefined ? Number(retryAfter) : undefined;
  return new CliError('RATE_LIMITED', `${url}: rate limited by the server.`, {
    fix:
      seconds !== undefined && Number.isFinite(seconds)
        ? `Retry after ${seconds}s.`
        : 'Back off and retry shortly.',
    details: {
      ...(seconds !== undefined && Number.isFinite(seconds) ? { retryAfterSeconds: seconds } : {}),
    },
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

export async function postSearch(
  body: SearchRequestBody,
  opts: AgentApiOptions,
): Promise<SearchResponse> {
  const url = `${trimSlash(opts.baseUrl)}/api/agent/search`;
  const res = await httpRequest(url, {
    method: 'POST',
    timeoutMs: opts.timeoutMs,
    headers: {
      'x-tenjin-client': CLIENT_HEADER,
      ...(opts.evalCohort === true ? { 'x-tenjin-eval-cohort': '1' } : {}),
    },
    jsonBody: body,
    fetchImpl: opts.fetchImpl,
  });
  if (!res.ok) throw apiFailure(url, res);
  if (res.status === 429) throw rateLimitError(url, (n) => res.header(n));
  if (res.status !== 200) {
    // The REQUEST gate is where a pre-v2 server actually refuses us, and it is
    // the arm that fires in practice. Old tenjin declares `schemaVersion:
    // z.literal(1)` inside a strictObject, so a v2 request never reaches the
    // handler: it comes back 400 "Invalid request body" with the zod flatten in
    // `error.details`, and the response check further down can never see it.
    // Without this the operator is told to retry a request that cannot succeed.
    if (res.status === 400 && rejectedSchemaVersion(res.json)) {
      throw outdatedServerError('The server rejected schemaVersion 2: it predates search v2.', {
        details: res.json,
      });
    }
    throw new CliError(
      'API_UNREACHABLE',
      serverErrorMessage(res.json) ?? `Search failed (${res.status})`,
      {
        fix: 'Retry; if it persists the search endpoint may be unavailable.',
        details: res.json,
      },
    );
  }
  const parsed = searchResponseSchema.safeParse(res.json);
  if (!parsed.success) {
    // The other way a stale server surfaces: it answered 200 with a v1 body.
    // Unreachable against today's old tenjin (the request gate above refuses
    // first), but correct for anything that accepts the request and replies v1.
    const served = serverSchemaVersion(res.json);
    if (served !== undefined && served !== 2) {
      throw outdatedServerError(
        `Search response is schemaVersion ${served}; this CLI requires 2 (search v2).`,
        { details: parsed.error.issues },
      );
    }
    throw new CliError('CONTRACT_MISMATCH', 'Search response did not match the expected contract', {
      fix: 'Update tenjin-cli; the server contract may have changed.',
      details: parsed.error.issues,
    });
  }
  return truncateResponse(parsed.data);
}

/** One wording for both ways a pre-v2 server refuses this CLI, so the request-gate
 *  arm and the response arm can never drift apart. */
function outdatedServerError(message: string, opts: { details: unknown }): CliError {
  return new CliError('CONTRACT_MISMATCH', message, {
    fix: 'The server predates search v2. Point --base-url at an updated deployment, or install an older tenjin-cli.',
    details: opts.details,
  });
}

/** True when a 400 body is the old server's request-gate refusal of our
 *  `schemaVersion`: an ApiError envelope whose zod `flatten()` details carry a
 *  `schemaVersion` fieldError. Keyed on the field, never the message text. */
function rejectedSchemaVersion(json: unknown): boolean {
  const record = (v: unknown): Record<string, unknown> | undefined =>
    typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : undefined;
  const fieldErrors = record(record(record(json)?.error)?.details)?.fieldErrors;
  return Array.isArray(record(fieldErrors)?.schemaVersion);
}

/** The `schemaVersion` an unparsed body claims, when it claims a number at all. */
function serverSchemaVersion(json: unknown): number | undefined {
  if (typeof json !== 'object' || json === null) return undefined;
  const v = (json as { schemaVersion?: unknown }).schemaVersion;
  return typeof v === 'number' ? v : undefined;
}

/**
 * The server bounds every free-form candidate string (spec 09); re-apply the same
 * caps defensively so a misbehaving server cannot blow up an agent transcript
 * through the CLI (spec 10 response-size discipline).
 *
 * `slug` is deliberately absent: it is an identifier, not display text, so
 * clipping it would not shorten it but change it into a slug that resolves to
 * nothing while still looking usable in `--json`. The server tolerates an
 * uncapped slug for the same reason (that is the one case its `truncated` flag
 * exists for), so capping here would fail on a response the server calls valid.
 */
const CAND_BOUNDS = {
  title: 200,
  matchReasons: 3,
  matchReasonChars: 80,
} as const;

const cap = (s: string, n: number): string => (s.length > n ? s.slice(0, n) : s);

function truncateResponse(res: SearchResponse): SearchResponse {
  const out: SearchResponse = { ...res };
  if (res.candidates !== undefined) out.candidates = res.candidates.map(truncateCandidate);
  // Browse pointers ride the same defensive discipline, and then some. The
  // schema is `.passthrough()` so a server-invented key would otherwise survive
  // at unbounded length into `--json` and MCP structuredContent; we rebuild each
  // pointer explicitly from the five contract fields instead of spreading, which
  // drops unknown keys and is what makes the contract.test.ts "no score-like
  // field" pin hold at runtime and not just against the fixture. Count is capped
  // at the server's BROWSE_MAX, and every free-form string (title, url, handle)
  // at its own bound.
  //
  // `browse` is MISS-only by contract; drop it outright on a CANDIDATES decision
  // rather than trust the server, since humanLines renders no hint line there and
  // it would otherwise be an unrendered channel of server text and payable urls.
  if (res.browse !== undefined && res.decision === 'MISS') {
    out.browse = res.browse.slice(0, BROWSE_MAX).map((b) => ({
      resourceId: b.resourceId,
      // Not capped: the schema already refused anything over BROWSE_BOUNDS.url,
      // so this is the url the server sent, verbatim and payable.
      url: b.url,
      title: cap(b.title, BROWSE_BOUNDS.title),
      price: b.price,
      creator: { handle: cap(b.creator.handle, BROWSE_BOUNDS.handle) },
    }));
  } else {
    delete out.browse;
  }
  return out;
}

/** Mirrors the server's BROWSE_MAX (lib/search-browse.ts): a MISS carries at
 *  most three browse pointers. */
const BROWSE_MAX = 3;

function truncateCandidate(c: SearchCandidate): SearchCandidate {
  return {
    ...c,
    title: cap(c.title, CAND_BOUNDS.title),
    matchReasons: c.matchReasons
      .slice(0, CAND_BOUNDS.matchReasons)
      .map((r) => cap(r, CAND_BOUNDS.matchReasonChars)),
  };
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
      fix: 'Pass the resourceId (a uuid) from a search candidate.',
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

const SEARCH_ID_RE = UUID_RE;

export async function postOutcomes(
  searchId: string,
  items: OutcomeBodyItem[],
  opts: AgentApiOptions,
): Promise<{ accepted: number }> {
  if (!SEARCH_ID_RE.test(searchId)) {
    throw new CliError('USAGE', `Invalid search id: ${JSON.stringify(searchId)}`, {
      fix: 'Pass the searchId from a prior search (or use --last).',
    });
  }
  if (items.length === 0 || items.length > 10) {
    throw new CliError('USAGE', 'An outcome report carries 1 to 10 items', {
      fix: 'Report between 1 and 10 outcomes per call.',
    });
  }
  const url = `${trimSlash(opts.baseUrl)}/api/agent/searches/${searchId}/outcomes`;
  const res = await httpRequest(url, {
    method: 'POST',
    timeoutMs: opts.timeoutMs,
    headers: { 'x-tenjin-client': CLIENT_HEADER },
    jsonBody: items.length === 1 ? items[0] : items,
    fetchImpl: opts.fetchImpl,
  });
  if (!res.ok) throw apiFailure(url, res);
  if (res.status === 429) throw rateLimitError(url, (n) => res.header(n));
  // 202 is the only success; the body is a uniform { accepted } regardless of
  // whether the searchId existed (no existence oracle, by design).
  if (res.status !== 202) {
    throw new CliError(
      'API_UNREACHABLE',
      serverErrorMessage(res.json) ?? `Outcome report failed (${res.status})`,
      {
        fix: 'Check the status vocabulary and search id, then retry.',
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
