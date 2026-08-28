import { z } from 'zod';
import { CliError } from './errors';
import { httpRequest, type HttpResult, type ShelfBypass } from './http';
import { ATOMIC_RE, UUID_RE } from './ids';
import { trimSlash } from './url';

/**
 * The search + outcome HTTP contract. Request building and response validation
 * live here; the wire shape is validated defensively, an unknown `schemaVersion`
 * degrades to a parse refusal rather than a guess, and unrecognized candidate
 * fields are ignored (forward-compatible), per spec 10.
 *
 * Search speaks schemaVersion 3 to POST /api/search with `view: "decision"`
 * (tenjin#137). The old POST /api/agent/search is a deprecated alias that the
 * server serves for one release and then answers 410, so nothing here still
 * calls it. v3 also reshaped the envelope: `decision` + `candidates[]` became
 * `matched` + `items[]`, the filters moved under a nested `filters` object, and
 * the MISS `browse[]` tail is gone entirely — a miss is an empty result plus a
 * `hint` pointing at GET /api/articles, not a different kind of answer.
 *
 * These endpoints are anonymous: no wallet, no SIWX. The shared transport's
 * User-Agent is what attributes a later purchase back to the search flow.
 */

const FRESH_WITHIN_RE = /^P(\d+)[DWMY]$/;
const CANONICAL_KEY_RE = /^[a-z][a-z0-9_]{0,31}$/;

/** The DECISION view's `limit` ceiling. The v3 schema admits `limit` up to 100
 *  across views and the server clamps per view (tenjin lib/search/understand.ts
 *  VIEW_LIMITS: decision 10, display 100, suggest 10); the CLI only ever sends
 *  `view: "decision"`, so 10 is the real bound and asking for more would be
 *  silently clamped back to it. Exported because the truncation advice in
 *  `search` has to name it: the response budget scales with the items returned,
 *  so a truncated page is recovered by asking for MORE, and this is the value
 *  to ask for. One definition, so the cap the CLI enforces and the number it
 *  tells the operator to retry with cannot drift apart. */
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

/** The nested v3 filter object. Freshness, price and applicability are no longer
 *  top-level request fields: v3 groups every narrowing under `filters`, and the
 *  server's `filters` schema is a strictObject, so a stray top-level spelling is
 *  stripped into `warnings` and the search runs UNFILTERED. Building it in one
 *  place is what keeps a `--max-price` from silently going nowhere. */
export interface SearchFilters {
  freshWithin?: string;
  maxPrice?: string;
  appliesTo?: Record<string, string[]>;
}

export interface SearchRequestBody {
  schemaVersion: 3;
  /** Pinned rather than defaulted. The server defaults `view` to `decision`, but
   *  a default is the server's to change and this client parses exactly one
   *  projection, so it names the one it can read. */
  view: 'decision';
  /** The DOCUMENTED spelling. `question` and `q` are undocumented compatibility
   *  aliases the server still resolves (precedence question, query, q), and it
   *  echoes the losers in `warnings`; a client written today sends the spelling
   *  the contract publishes. */
  query: string;
  filters?: SearchFilters;
  limit: number;
  /** Which client arm fired the search. A direct `tenjin search` (and the MCP
   *  tool over it) is `cli`, which is also what the server records when the
   *  field is absent; the hook arms send their own names from lib/hook-scripts.ts
   *  askTenjin. Telemetry for the per-trigger use rates (`GET
   *  /api/lookups/stats`); it never changes the result. */
  trigger: 'cli';
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
  const filters: SearchFilters = {
    ...(input.freshWithin !== undefined ? { freshWithin: input.freshWithin } : {}),
    ...(input.maxPrice !== undefined ? { maxPrice: input.maxPrice } : {}),
    ...(input.appliesTo !== undefined ? { appliesTo: input.appliesTo } : {}),
  };
  return {
    schemaVersion: 3,
    view: 'decision',
    query: question,
    // Omitted entirely when nothing narrows, rather than sent as `{}`: an empty
    // object is a filter set that filters nothing, and saying so on the wire only
    // invites a server to read meaning into it.
    ...(Object.keys(filters).length > 0 ? { filters } : {}),
    limit,
    trigger: 'cli',
  };
}

// Response schemas. `.passthrough()` on the candidate keeps unknown future fields
// instead of stripping them (forward-compatible), while still requiring the
// contract fields this CLI reads.
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

/** The v3 decision-view result envelope (lib/search/project.ts
 *  SearchResultEnvelope). `items` is the same lean candidate projection v2 put in
 *  `candidates`; what changed is the frame around it.
 *
 *  There is no `decision` field any more, and that is the point of v3: a miss is
 *  an EMPTY result, not a second kind of answer to branch on. `matched` is 0,
 *  `items` is empty, and `hint` says where to browse instead. `browse[]` is gone
 *  with it — the decision view never draws a fallback tail, so this client no
 *  longer has one to render or to record.
 *
 *  Unknown keys are STRIPPED (plain `z.object`), which is why `inspect` and
 *  `warnings` are absent here: they are real contract fields this CLI does not
 *  read, and declaring them would put unbounded server text into `--json` and
 *  into an agent transcript with nothing rendering it. */
export const searchResultSchema = z.object({
  schemaVersion: z.literal(3),
  searchId: z.string().regex(UUID_RE, 'searchId must be a uuid'),
  calibration: z.string(),
  items: z.array(searchCandidateSchema),
  matched: z.number().int().nonnegative(),
  // Present only when `matched` is 0. Server-authored display text, so it rides
  // the same per-field cap as every other free-form string below.
  hint: z.string().optional(),
  // Set only when the server's size backstop dropped trailing items the requested
  // limit had room for; omitted entirely otherwise. There is no cursor, so a retry
  // at a SMALLER limit returns strictly fewer rows; the ceiling scales with the
  // items returned, so a LARGER limit (up to MAX_LIMIT) is what recovers the tail,
  // and at MAX_LIMIT the tail is unrecoverable and narrowing the question is the
  // remedy. `runSearch` picks the half that applies.
  truncated: z.literal(true).optional(),
});

export type SearchResult = z.infer<typeof searchResultSchema>;

export interface AgentApiOptions {
  baseUrl: string;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
  /** Spec 09 §3 evaluation-cohort opt-in: sends X-Tenjin-Eval-Cohort: 1. */
  evalCohort?: boolean;
  /** The team shelf's bypass secret and its origin. The transport attaches the
   *  header only when the request URL is on that origin, so passing it while
   *  searching the public shelf sends nothing. */
  bypass?: ShelfBypass;
}

/** Turn a non-2xx / transport HttpResult into the CLI error contract. */
function apiFailure(url: string, result: Exclude<HttpResult, { ok: true }>): CliError {
  const code =
    result.kind === 'network' || result.kind === 'timeout' ? 'NETWORK_ERROR' : 'API_UNREACHABLE';
  return new CliError(code, `${url}: ${result.message}`, {
    fix: 'Check your network and the configured base URL (`tenjin config get baseUrl`), then retry.',
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
): Promise<SearchResult> {
  const url = `${trimSlash(opts.baseUrl)}/api/search`;
  const res = await httpRequest(url, {
    method: 'POST',
    timeoutMs: opts.timeoutMs,
    headers: opts.evalCohort === true ? { 'x-tenjin-eval-cohort': '1' } : {},
    ...(opts.bypass !== undefined ? { bypass: opts.bypass } : {}),
    jsonBody: body,
    fetchImpl: opts.fetchImpl,
  });
  if (!res.ok) throw apiFailure(url, res);
  if (res.status === 429) throw rateLimitError(url, (n) => res.header(n));
  if (res.status !== 200) {
    // A deployment that predates v3 has no route here AT ALL, so it answers 404
    // from the Next router rather than anything contract-shaped. That is the arm
    // that fires in practice against a stale server, and without it the operator
    // is told to "retry" a path that will never exist on that deploy. A 404 is
    // equally what a wrong base URL path or a gateway that does not route
    // POST /api/search answers, so the remedy names both causes rather than
    // asserting the server's age.
    if (res.status === 404) {
      throw new CliError(
        'CONTRACT_MISMATCH',
        `${url} answered 404: either this server predates search v3, or the configured base URL does not route POST /api/search.`,
        {
          fix: 'Check the base URL (`tenjin config get baseUrl`; `tenjin doctor` probes it), then point it at an updated deployment or install an older tenjin-cli.',
          details: res.json,
        },
      );
    }
    // The REQUEST gate: a server that HAS the route but pins an older
    // `schemaVersion` refuses the body before the handler runs. The v2 alias
    // answers with a zod flatten under `error.details.fieldErrors`; the v3 route
    // drops `fieldErrors` and states the same thing as sentences in
    // `error.details.problems`. Both spellings are read, keyed on the FIELD name
    // rather than on any message text.
    if (res.status === 400 && rejectedSchemaVersion(res.json)) {
      throw outdatedServerError('The server rejected schemaVersion 3: it predates search v3.', {
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
  const parsed = searchResultSchema.safeParse(res.json);
  if (!parsed.success) {
    // The other way a stale server surfaces: it accepted the request and answered
    // 200 with an older envelope. The v2 alias does exactly this if a base URL
    // ever points at it, so the version it served is named rather than reported
    // as an anonymous shape mismatch.
    const served = serverSchemaVersion(res.json);
    if (served !== undefined && served !== 3) {
      throw outdatedServerError(
        `Search response is schemaVersion ${served}; this CLI requires 3 (search v3).`,
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

/** One wording for all three ways a pre-v3 server refuses this CLI (no route, a
 *  request-gate 400, a v2 envelope in a 200), so the arms can never drift apart. */
function outdatedServerError(message: string, opts: { details: unknown }): CliError {
  return new CliError('CONTRACT_MISMATCH', message, {
    fix: 'The server predates search v3. Point the configured base URL (`tenjin config set baseUrl`) at an updated deployment, or install an older tenjin-cli.',
    details: opts.details,
  });
}

/** True when a 400 body is an older server's request-gate refusal of our
 *  `schemaVersion`. Two shapes, because the two surfaces report differently: the
 *  v2 alias carries a zod `flatten()` under `error.details.fieldErrors`, while
 *  the v3 route drops that map and lists sentences under `error.details.problems`
 *  instead. Both are keyed on the FIELD NAME appearing where the server puts its
 *  per-field complaints, never on message wording. */
function rejectedSchemaVersion(json: unknown): boolean {
  const record = (v: unknown): Record<string, unknown> | undefined =>
    typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : undefined;
  const details = record(record(record(json)?.error)?.details);
  if (Array.isArray(record(details?.fieldErrors)?.schemaVersion)) return true;
  const problems = details?.problems;
  return (
    Array.isArray(problems) &&
    problems.some((p) => typeof p === 'string' && p.startsWith('schemaVersion'))
  );
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

/** The miss `hint` is one fixed server sentence today, but it is server-authored
 *  display text like any other, so it is bounded rather than trusted. */
const HINT_MAX = 200;

const cap = (s: string, n: number): string => (s.length > n ? s.slice(0, n) : s);

function truncateResponse(res: SearchResult): SearchResult {
  const out: SearchResult = { ...res, items: res.items.map(truncateCandidate) };
  if (res.hint !== undefined) out.hint = cap(res.hint, HINT_MAX);
  return out;
}

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
  const url = `${trimSlash(opts.baseUrl)}/api/searches/${searchId}/outcomes`;
  const res = await httpRequest(url, {
    method: 'POST',
    timeoutMs: opts.timeoutMs,
    ...(opts.bypass !== undefined ? { bypass: opts.bypass } : {}),
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

/**
 * One arm's demand and reuse over a window, as the shelf sees it.
 *
 * The counts a machine could sum from its own outcome reports, summed across
 * every caller — which is the whole point: `tenjin push grade` says what THIS
 * machine's injections did, and this says whether the arm earns its keep at all.
 * Keyless and aggregate-only on the server side (no query text, no post ids), so
 * it needs nothing but the base URL and, on a team shelf, the bypass the
 * transport attaches by origin.
 */
export interface TriggerStats {
  trigger: string;
  /** Decision-view searches this arm fired in the window, MISS and CANDIDATES. */
  lookups: number;
  /** Of those, how many surfaced at least one candidate. */
  hits: number;
  /** Candidate rows shown across those lookups. */
  candidates: number;
  /** Lookups with at least one used / partially_used outcome. */
  used: number;
  /** Lookups with at least one rejected / regenerated outcome. */
  wrong: number;
  /** used / hits, or null with no hits. */
  useRate: number | null;
}

export interface LookupStats {
  windowDays: number;
  triggers: TriggerStats[];
}

/**
 * Unknown keys are stripped, like every other response this module parses: the
 * server may grow a column before this CLI reads it.
 *
 * `trigger` IS BOUNDED, unlike the rest of the strings this file accepts,
 * because it is the one field of this response that gets printed: `push status`
 * draws a line per trigger, and an unconstrained `z.string()` lets a shelf paint
 * a megabyte of anything into the operator's terminal. A pattern rather than the
 * arm names, so a shelf that adds an arm still renders instead of failing the
 * whole block with a contract mismatch. The printer sanitizes it as well —
 * a length bound is not an escape-sequence bound.
 */
const TRIGGER_RE = /^[a-z]{1,16}$/;

const lookupStatsSchema = z.object({
  windowDays: z.number().int().positive(),
  triggers: z.array(
    z.object({
      trigger: z.string().regex(TRIGGER_RE),
      lookups: z.number().int().nonnegative(),
      hits: z.number().int().nonnegative(),
      candidates: z.number().int().nonnegative(),
      used: z.number().int().nonnegative(),
      wrong: z.number().int().nonnegative(),
      useRate: z.number().nullable(),
    }),
  ),
});

/**
 * GET /api/lookups/stats?days=N.
 *
 * NO RETRY, and every failure throws: this is one optional block under `push
 * status`, and the caller renders "unavailable" rather than failing the command
 * or making an operator wait out a backoff for a number they were reading in
 * passing.
 */
export async function getLookupStats(days: number, opts: AgentApiOptions): Promise<LookupStats> {
  const url = `${trimSlash(opts.baseUrl)}/api/lookups/stats?days=${encodeURIComponent(String(days))}`;
  const res = await httpRequest(url, {
    method: 'GET',
    timeoutMs: opts.timeoutMs,
    ...(opts.bypass !== undefined ? { bypass: opts.bypass } : {}),
    fetchImpl: opts.fetchImpl,
  });
  if (!res.ok) throw apiFailure(url, res);
  if (res.status === 429) throw rateLimitError(url, (n) => res.header(n));
  if (res.status !== 200) {
    throw new CliError(
      'API_UNREACHABLE',
      serverErrorMessage(res.json) ?? `Lookup stats failed (${res.status})`,
      { fix: 'Check the base URL, then retry.', details: res.json },
    );
  }
  const parsed = lookupStatsSchema.safeParse(res.json);
  if (!parsed.success) {
    throw new CliError('CONTRACT_MISMATCH', `${url} answered a shape this CLI cannot read.`, {
      fix: 'Update tenjin-cli, or point the base URL at a matching deployment.',
      details: parsed.error.issues,
    });
  }
  return parsed.data;
}
