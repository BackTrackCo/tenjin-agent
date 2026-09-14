import {
  buildSearchRequest,
  searchResultSchema,
  shelfSearchResponseSchema,
  type SearchCandidate,
  type SearchResult,
} from '../../lib/agent-api';
import { httpRequest } from '../../lib/http';
import { trimSlash } from '../../lib/url';
import type { Answer, KernelConfig, LegResult, LegStatus, Shelf, Leg, Trigger } from '../types';

/**
 * ONE QUESTION IS ONE HTTP REQUEST (00-principles.md, "Do not double count").
 *
 * It used to be two: a team origin and a public origin, raced in one stage. A
 * shelf is now a row on the one deployment, so the request goes to
 * `/api/shelves/<slug>/search`, signed, and comes back with TWO candidate sets:
 * the shelf's and the marketplace's. `searchLeg` therefore returns a
 * {@link LegResult} PER SET, not per request, and `ask.ts` writes one `legs`
 * row per set from them. `legs.shelf` keeps its name and its three values.
 *
 * THIS LEG NEVER THROWS. A bad response is one row in a ledger. So every
 * failure becomes a {@link LegStatus}: a timeout, an abort, a rejected
 * signature, a non-JSON body and a JSON body of the wrong shape are five
 * different facts and used to be one silent miss.
 *
 * THE LEG SENDS `Question.text` WHOLE. The cut to the trigger's bound is
 * `question()`'s, made once when the plan is built, so what the leg sends, what
 * the ledger stores and what the claim key hashes are one string.
 */

/** Candidates asked for, so a search `verdict` can take a strong rank 2 or 3
 *  over an un-strong rank 1; the keys resolve asks for the same. */
const SEARCH_LIMIT = 3;

/** What the transport saw, for the failure map below. Captured off the
 *  Response because `httpRequest` reports the CLI's failure contract, which
 *  collapses a gate page and a missing field into one code. */
interface Seen {
  status: number;
  json: boolean;
}

/**
 * Why this call produced no answer.
 *
 * ONE CLOCK. The leg starts no timer of its own: `ask` already hands in
 * `AbortSignal.any([fire.signal, AbortSignal.timeout(budget)])`, and the abort
 * REASON says which of the two ended it.
 *
 * The order is the order of certainty: a request that never returned beats one
 * we misread, and a status beats a body. 401 and 403 are `refused` and now mean
 * ONE thing: the signature was rejected. A 404 is `refused` too, and means this
 * wallet is not a member of the configured shelf, or the slug names nothing —
 * the route answers the same either way on purpose, and `tenjin doctor` is
 * where a user learns which it was.
 */
function statusOf(seen: Seen | null, signal: AbortSignal): LegStatus {
  if (signal.aborted) {
    const name = (signal.reason as { name?: unknown } | undefined)?.name;
    return name === 'TimeoutError' ? 'timeout' : 'aborted';
  }
  if (seen === null) return 'error';
  if (seen.status === 401 || seen.status === 403 || seen.status === 404) return 'refused';
  if (seen.status !== 200) return `http_${seen.status}`;
  // A 200 that is not JSON is a page where an answer should be — a gate, an
  // error template, a proxy. A 200 that IS JSON and still failed to parse is
  // the contract drifting, which is the same fact as a missing field.
  return seen.json ? 'bad_shape' : 'bad_json';
}

function readString(candidate: SearchCandidate, key: string): string | undefined {
  const value = (candidate as unknown as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : undefined;
}

function answerOf(shelf: Shelf, candidate: SearchCandidate, searchId: string): Answer {
  const handle = candidate.creator.handle;
  const excerpt = readString(candidate, 'excerpt');
  return {
    shelf,
    resourceId: candidate.resourceId,
    title: candidate.title,
    url: candidate.url,
    form: candidate.artifactType,
    price: candidate.price,
    searchId,
    ...(candidate.body !== undefined ? { text: candidate.body.text } : {}),
    ...(handle.length > 0 ? { handle } : {}),
    ...(excerpt !== undefined && excerpt.length > 0 ? { excerpt } : {}),
    // The server's stamp, copied and never inferred from which list it was in.
    ...(candidate.shelf !== undefined ? { shelfRef: candidate.shelf } : {}),
  };
}

/**
 * THE VERDICT IS THE ONLY THING THAT DECIDES WHETHER AN AGENT SEES A PIECE,
 * and it is the shelf's decision, not this machine's: the FIRST candidate the
 * server marked `strong` is the answer. Strong means its meaning leg was medium
 * or better and its word leg corroborated it, which is a rule with the
 * embeddings and the full body behind it; the hook has forty words of public
 * text and used to guess with them, wrongly, 12 times out of 12.
 *
 * THIS MACHINE HAS NO QUALITY RULE OF ITS OWN, so there is no fallback to fall
 * back to: a response the shelf vouched for nothing in is a MISS, and the fire
 * records `no-hit` rather than speaking rank 1 on nobody's word.
 */
function strongestOf(shelf: Shelf, result: SearchResult): Answer | null {
  const winner = result.items.find((c) => c.strong === true);
  return winner === undefined ? null : answerOf(shelf, winner, result.searchId);
}

/** A key hit is exact, so there is nothing to select: the first item wins. */
function firstOf(shelf: Shelf, result: SearchResult): Answer | null {
  const top = result.items[0];
  return top === undefined ? null : answerOf(shelf, top, result.searchId);
}

/** One set's `LegResult`, built from one parsed envelope. */
function resultOf(
  shelf: Shelf,
  envelope: SearchResult,
  verdict: (shelf: Shelf, r: SearchResult) => Answer | null,
  extra: { authError?: string },
): LegResult {
  const top = envelope.items[0];
  return {
    shelf,
    status: 'ok',
    searchId: envelope.searchId,
    calibration: envelope.calibration,
    ...(top !== undefined ? { title: top.title, url: top.url, form: top.artifactType } : {}),
    answer: verdict(shelf, envelope),
    ...(extra.authError !== undefined ? { authError: extra.authError } : {}),
  };
}

/** A failed call, as one row per set the call would have carried. */
function failed(shelves: Shelf[], status: LegStatus, extra: { authError?: string }): LegResult[] {
  return shelves.map((shelf) => ({
    shelf,
    status,
    answer: null,
    ...(extra.authError !== undefined ? { authError: extra.authError } : {}),
  }));
}

/** Records what the transport saw without a second round trip. */
function probeFetch(fetchImpl: typeof fetch | undefined, sink: (seen: Seen) => void): typeof fetch {
  const base: typeof fetch = fetchImpl ?? ((input, init) => fetch(input, init));
  return async (input, init) => {
    const res = await base(input, init);
    sink({ status: res.status, json: (res.headers.get('content-type') ?? '').includes('json') });
    return res;
  };
}

/**
 * The search leg: ONE call, one or two sets.
 *
 * - `cfg.shelf !== null` and a signature: POST `/api/shelves/<slug>/search`
 *   with `includePublic` from `team.publicFallback` unless the caller says
 *   otherwise. Two sets, `team` and `public` — or one when `includePublic` is
 *   false, and one when the server answered `public: null` anyway because the
 *   org's policy is off, which the client deliberately cannot tell apart.
 * - no wallet: POST `/api/search`, unsigned. One `public` set, an ordinary
 *   valid configuration.
 * - a shelf is set and nothing local can sign: POST `/api/search`, unsigned,
 *   and the row carries `authError`. THE PUBLIC ANSWER IS STILL DELIVERED.
 *   This is the only case where the configured shelf is not the route that gets
 *   called, and it has to be explicit: unlike the old shape, dropping the
 *   signature no longer leaves a second leg already planned.
 * - `cfg.shelf === null`: POST `/api/search`, unsigned. One `public` set.
 */
export function searchLeg(
  trigger: Trigger,
  cfg: KernelConfig,
  opts: { includePublic?: boolean } = {},
  fetchImpl?: typeof fetch,
): Leg {
  // Decided ONCE, here, because it is what the call will produce: the shelf
  // route returns a public list only when this is true, so a round that says
  // `includePublic: false` (the failure arm's) yields one set and declares one.
  const includePublic = opts.includePublic ?? cfg.team.publicFallback === 'on';
  const sets: Shelf[] =
    cfg.shelf === null ? ['public'] : includePublic ? ['team', 'public'] : ['team'];
  return {
    shelves: sets,
    async request(q, budgetMs, signal, deps): Promise<LegResult[]> {
      const base = trimSlash(cfg.baseUrl);
      const publicBody = () =>
        buildSearchRequest({ question: q.text, limit: SEARCH_LIMIT, trigger, budgetMs });

      let authError: string | undefined;
      if (cfg.shelf !== null) {
        const url = `${base}/api/shelves/${encodeURIComponent(cfg.shelf)}/search`;
        const body = buildSearchRequest({
          question: q.text,
          limit: SEARCH_LIMIT,
          trigger,
          budgetMs,
          includePublic,
        });
        const auth = await deps.auth({ method: 'POST', url, body: JSON.stringify(body) });
        if (auth.kind === 'signed') {
          return await callShelf(sets, url, body, auth.headers, budgetMs, signal, fetchImpl);
        }
        // `no-wallet` is not a failure and writes no error; `unauthenticated`
        // is, and the row says so while the answer still gets delivered.
        if (auth.kind === 'unauthenticated') authError = `unauthenticated: ${auth.detail}`;
      }
      return await callPublic(
        `${base}/api/search`,
        publicBody(),
        budgetMs,
        signal,
        authError === undefined ? {} : { authError },
        fetchImpl,
      );
    },
  };
}

/**
 * `POST /api/shelves/<slug>/keys/resolve`: the failure arm's fingerprints,
 * exact keys and nothing else about the failure. Planned only when a shelf is
 * set (there is no public resolve, decision 13), and it yields one `keys` set.
 * A shelf with keys off answers 404, which is one `refused` row and no
 * machine-wide fact.
 */
export function keysLeg(cfg: KernelConfig, keys: string[], fetchImpl?: typeof fetch): Leg {
  return {
    shelves: ['keys'],
    async request(_q, budgetMs, signal, deps): Promise<LegResult[]> {
      if (cfg.shelf === null) return failed(['keys'], 'error', {});
      const url = `${trimSlash(cfg.baseUrl)}/api/shelves/${encodeURIComponent(cfg.shelf)}/keys/resolve`;
      const body = {
        keys: keys.map((key) => ({ kind: 'fingerprint', key })),
        trigger: 'failure' satisfies Trigger,
        limit: SEARCH_LIMIT,
      };
      const auth = await deps.auth({ method: 'POST', url, body: JSON.stringify(body) });
      if (auth.kind !== 'signed') {
        // There is no unsigned resolve to fall back to, so this is a refused
        // row and the text round is what the failure has left.
        return failed(['keys'], 'refused', {
          ...(auth.kind === 'unauthenticated'
            ? { authError: `unauthenticated: ${auth.detail}` }
            : {}),
        });
      }
      let seen: Seen | null = null;
      try {
        const res = await httpRequest(url, {
          method: 'POST',
          timeoutMs: Math.max(1, budgetMs),
          signal,
          headers: auth.headers,
          fetchImpl: probeFetch(fetchImpl, (s) => (seen = s)),
          jsonBody: body,
        });
        if (!res.ok || res.status !== 200) return failed(['keys'], statusOf(seen, signal), {});
        const parsed = searchResultSchema.safeParse(res.json);
        if (!parsed.success) return failed(['keys'], statusOf(seen, signal), {});
        return [resultOf('keys', parsed.data, firstOf, {})];
      } catch {
        return failed(['keys'], statusOf(seen, signal), {});
      }
    },
  };
}

/** The signed two-list call. */
async function callShelf(
  sets: Shelf[],
  url: string,
  body: unknown,
  headers: Record<string, string>,
  budgetMs: number,
  signal: AbortSignal,
  fetchImpl?: typeof fetch,
): Promise<LegResult[]> {
  let seen: Seen | null = null;
  try {
    const res = await httpRequest(url, {
      method: 'POST',
      // The transport's own timer is not a second deadline: `httpRequest`
      // requires a number and the caller's signal is what actually ends the
      // call, so it gets the same budget and never fires first.
      timeoutMs: Math.max(1, budgetMs),
      signal,
      headers,
      fetchImpl: probeFetch(fetchImpl, (s) => (seen = s)),
      jsonBody: body,
    });
    // THE SETS THE ROUND DECLARED, never a hardcoded pair. A round that sent
    // `includePublic: false` asked the marketplace nothing, so a row saying the
    // marketplace failed is a row about a request that was never made: the
    // failure arm's text round is exactly that round, every time.
    if (!res.ok || res.status !== 200) return failed(sets, statusOf(seen, signal), {});
    const parsed = shelfSearchResponseSchema.safeParse(res.json);
    if (!parsed.success) return failed(sets, statusOf(seen, signal), {});
    const rows = [resultOf('team', parsed.data.shelf, strongestOf, {})];
    // A `public` of null is not a failure and not a row: the marketplace was
    // never run, either because this call said so or because the org's policy
    // does. The CLI cannot tell those apart and does not need to. A list the
    // round did not ask for is dropped for the same reason it is not declared.
    if (parsed.data.public !== null && sets.includes('public')) {
      rows.push(resultOf('public', parsed.data.public, strongestOf, {}));
    }
    return rows;
  } catch {
    return failed(sets, statusOf(seen, signal), {});
  }
}

/** The unsigned public call: one set, however it was reached. */
async function callPublic(
  url: string,
  body: unknown,
  budgetMs: number,
  signal: AbortSignal,
  extra: { authError?: string },
  fetchImpl?: typeof fetch,
): Promise<LegResult[]> {
  let seen: Seen | null = null;
  try {
    const res = await httpRequest(url, {
      method: 'POST',
      timeoutMs: Math.max(1, budgetMs),
      signal,
      fetchImpl: probeFetch(fetchImpl, (s) => (seen = s)),
      jsonBody: body,
    });
    if (!res.ok || res.status !== 200) return failed(['public'], statusOf(seen, signal), extra);
    const parsed = searchResultSchema.safeParse(res.json);
    if (!parsed.success) return failed(['public'], statusOf(seen, signal), extra);
    return [resultOf('public', parsed.data, strongestOf, extra)];
  } catch {
    return failed(['public'], statusOf(seen, signal), extra);
  }
}
