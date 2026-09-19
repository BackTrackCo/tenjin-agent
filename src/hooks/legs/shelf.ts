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
 * shelf is now a row on the one deployment and a FIELD IN THE BODY, so the
 * request goes to `/api/search` — the one endpoint, the same one an anonymous
 * caller uses — carrying `shelf`, signed, and comes back with TWO candidate
 * sets: the shelf's and the marketplace's. `searchLeg` therefore returns a
 * {@link LegResult} PER SET, not per request, and `ask.ts` writes one `legs`
 * row per set from them. `legs.shelf` keeps its name and its three values.
 *
 * THIS LEG NEVER THROWS. A bad response is one row in a ledger. So every
 * failure becomes a {@link LegStatus}: a timeout, an abort, a rejected
 * signature, a non-JSON body and a JSON body of the wrong shape are five
 * different facts and used to be one silent miss.
 *
 * THE LEG SENDS `Question.text` WHOLE. The cut to the shelf's bound is
 * `question()`'s (`hooks/question.ts`), made once when the plan is built, so
 * what the leg sends, what the ledger stores and what the claim key hashes are
 * one string. `buildSearchRequest` still throws `USAGE` past the bound, as the
 * last guard against a question that skipped that path.
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
 * ONE thing: the signature was rejected. A 404 is `refused` too, and on a call
 * that named a shelf it means this wallet is not a member of it, or the org or
 * shelf names nothing — the server answers the same either way on purpose, and
 * `tenjin doctor` is where a user learns which it was.
 *
 * NEITHER IS EVER SILENT. `refusedReason` below turns both into the sentence
 * the row carries, so a fire that asked a shelf and was turned away says why in
 * `fires.error` instead of reading as an ordinary miss. The keys endpoint gets
 * its own sentence from `keysRefusedReason`, because a 404 there is EITHER
 * membership or knowledge keys being off, and the two remedies are different
 * people's.
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

/**
 * The sentence a refused SEARCH call writes to the ledger, or undefined when the
 * status was not a refusal. Only a call that NAMED a shelf can be refused for
 * membership, so the shelf is named in the text: it is the one fact that tells
 * an operator which of the two remedies is theirs.
 *
 * SEARCH ONLY. On `/api/search` a 404 has the one cause; on `/api/keys/resolve`
 * it has two, and {@link keysRefusedReason} is the sentence for that endpoint.
 */
function refusedReason(seen: Seen | null, shelf: string | null): string | undefined {
  if (seen === null || shelf === null) return undefined;
  if (seen.status === 401 || seen.status === 403) {
    return `unauthenticated: the signed call for shelf "${shelf}" answered ${seen.status}`;
  }
  if (seen.status === 404) {
    return `not-a-member: shelf "${shelf}" answered 404, so this creator is not in that org or no such shelf exists`;
  }
  return undefined;
}

/** The server's `error.code`, when the refusal body carried one. */
function errorCodeOf(body: unknown): string | undefined {
  const error = (body as { error?: unknown } | undefined)?.error;
  const code = (error as { code?: unknown } | undefined)?.code;
  return typeof code === 'string' ? code : undefined;
}

/**
 * The sentence a refused KEYS call writes to the ledger.
 *
 * A 404 HERE HAS TWO CAUSES, NOT ONE, and they have different remedies: this
 * wallet is not a member of the shelf (an org admin's to fix), or knowledge keys
 * are off on that shelf (a redeploy with KNOWLEDGE_KEYS on). Telling a member
 * they are not one sends them to the wrong person, so the code the server sends
 * decides the sentence, and a 404 with no code names both causes rather than
 * picking one. 401 and 403 mean the same here as on search.
 */
function keysRefusedReason(
  seen: Seen | null,
  shelf: string | null,
  body: unknown,
): string | undefined {
  if (seen === null || shelf === null) return undefined;
  if (seen.status !== 404) return refusedReason(seen, shelf);
  if (errorCodeOf(body) === 'not_enabled') {
    return `keys-off: shelf "${shelf}" answered 404 not_enabled, so knowledge keys are off on that shelf; turn KNOWLEDGE_KEYS on for it and redeploy`;
  }
  return `refused: shelf "${shelf}" answered 404, so either knowledge keys are off on that shelf or this creator is not in that org`;
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
 * ONE ENDPOINT IN EVERY ARM, `/api/search`. What changes is the body.
 *
 * - `cfg.shelf !== null` and a signature: POST `/api/search` with `shelf` and
 *   with `includePublic` from `team.publicFallback` unless the caller says
 *   otherwise. Two sets, `team` and `public` — or one when `includePublic` is
 *   false, and one when the server answered `public: null` anyway because the
 *   org's policy is off, which the client deliberately cannot tell apart.
 * - no wallet: POST `/api/search` with NO `shelf`, unsigned. One `public` set,
 *   an ordinary valid configuration.
 * - a shelf is set and nothing local can sign: POST `/api/search` with no
 *   `shelf`, unsigned, and the row carries `authError`. THE PUBLIC ANSWER IS
 *   STILL DELIVERED.
 *   This is the only case where the configured shelf is not the shelf that gets
 *   asked, and it has to be explicit: unlike the old shape, dropping the
 *   signature no longer leaves a second leg already planned. It happens only
 *   where the round asked for a public list at all: a shelf-only round (the
 *   failure text, or `publicFallback: off`) records `refused` rather than send
 *   its question somewhere it was never meant to go.
 * - `cfg.shelf === null`: POST `/api/search` with no `shelf`, unsigned. One
 *   `public` set.
 */
export function searchLeg(
  trigger: Trigger,
  cfg: KernelConfig,
  opts: { includePublic?: boolean } = {},
  fetchImpl?: typeof fetch,
): Leg {
  // Decided ONCE, here, because it is what the call will produce: a shelf call
  // returns a public list only when this is true, so a round that says
  // `includePublic: false` (the failure arm's) yields one set and declares one.
  const includePublic = opts.includePublic ?? cfg.team.publicFallback === 'on';
  const sets: Shelf[] =
    cfg.shelf === null ? ['public'] : includePublic ? ['team', 'public'] : ['team'];
  return {
    shelves: sets,
    async request(q, budgetMs, signal, deps): Promise<LegResult[]> {
      // THE ONE URL. A shelf is a body field, so there is nothing to build per
      // shelf and no second path a question can be sent down by mistake.
      const url = `${trimSlash(cfg.baseUrl)}/api/search`;
      const publicBody = () =>
        buildSearchRequest({ question: q.text, limit: SEARCH_LIMIT, trigger, budgetMs });

      let authError: string | undefined;
      if (cfg.shelf !== null) {
        const body = buildSearchRequest({
          question: q.text,
          limit: SEARCH_LIMIT,
          trigger,
          budgetMs,
          shelf: cfg.shelf,
          includePublic,
        });
        const auth = await deps.auth({ method: 'POST', url, body: JSON.stringify(body) });
        if (auth.kind === 'signed') {
          return await callShelf(
            sets,
            url,
            body,
            auth.headers,
            budgetMs,
            signal,
            cfg.shelf,
            fetchImpl,
          );
        }
        // `no-wallet` is not a failure and writes no error; `unauthenticated`
        // is, and the row says so while the answer still gets delivered.
        if (auth.kind === 'unauthenticated') authError = `unauthenticated: ${auth.detail}`;
        // THE FALLBACK IS TO THE PUBLIC LIST, AND ONLY WHERE THIS ROUND ASKED
        // FOR ONE. A round that sent `includePublic: false` said the
        // marketplace is not part of this question: the failure arm's text
        // round (decision 13) and a machine on `publicFallback: off` both mean
        // it, and posting the masked failure text to tenjin.blog because a
        // session expired is not a fallback, it is a different question being
        // asked of a different audience. The round records the credential
        // failure instead, which is what doctor reads.
        if (!includePublic) {
          return failed(sets, 'refused', authError === undefined ? {} : { authError });
        }
      }
      return await callPublic(
        url,
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
 * `POST /api/keys/resolve` WITH A SHELF NAMED: the failure arm's fingerprints,
 * exact keys and nothing else about the failure. The one endpoint again, with
 * `shelf` in the body; planned only when a shelf is set (there is no public
 * resolve, decision 13), and it yields one `keys` set. A shelf with keys off
 * answers 404, which is one `refused` row carrying the reason and no
 * machine-wide fact.
 */
export function keysLeg(cfg: KernelConfig, keys: string[], fetchImpl?: typeof fetch): Leg {
  return {
    shelves: ['keys'],
    async request(_q, budgetMs, signal, deps): Promise<LegResult[]> {
      if (cfg.shelf === null) return failed(['keys'], 'error', {});
      const url = `${trimSlash(cfg.baseUrl)}/api/keys/resolve`;
      const body = {
        keys: keys.map((key) => ({ kind: 'fingerprint', key })),
        trigger: 'failure' satisfies Trigger,
        limit: SEARCH_LIMIT,
        // SHELF-ONLY BY CONSTRUCTION. There is no `includePublic` here: the
        // failure arm never sends a masked error to the marketplace, so the
        // only thing this body says about scope is which shelf to resolve in.
        shelf: cfg.shelf,
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
        // The BODY decides which of the two 404s this was, so the code is read
        // before the status is turned into a row. It is only there on the ok
        // branch; a transport failure carries no parsed body and falls through
        // to the sentence that names both causes.
        const refused = keysRefusedReason(seen, cfg.shelf, res.ok ? res.json : undefined);
        const reason = refused === undefined ? {} : { authError: refused };
        if (!res.ok || res.status !== 200) return failed(['keys'], statusOf(seen, signal), reason);
        const parsed = searchResultSchema.safeParse(res.json);
        if (!parsed.success) return failed(['keys'], statusOf(seen, signal), {});
        return [resultOf('keys', parsed.data, firstOf, {})];
      } catch {
        return failed(['keys'], statusOf(seen, signal), {});
      }
    },
  };
}

/** The signed two-list call: one POST to `/api/search` whose body names a shelf. */
async function callShelf(
  sets: Shelf[],
  url: string,
  body: unknown,
  headers: Record<string, string>,
  budgetMs: number,
  signal: AbortSignal,
  shelf: string,
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
    // A 401 or a 404 is a REASON, not just a status: the round asked a shelf and
    // was turned away, which is an operator's problem and rides to `fires.error`
    // rather than reading in the ledger as an ordinary empty answer.
    const refused = refusedReason(seen, shelf);
    if (!res.ok || res.status !== 200) {
      return failed(
        sets,
        statusOf(seen, signal),
        refused === undefined
          ? {}
          : {
              authError: refused,
            },
      );
    }
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
