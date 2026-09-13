import {
  buildSearchRequest,
  searchResultSchema,
  type SearchCandidate,
  type SearchResult,
} from '../../lib/agent-api';
import { httpRequest, type ShelfBypass } from '../../lib/http';
import { isTeamShelfOrigin } from '../../lib/settings';
import { tryOriginOf } from '../../lib/url';
import type {
  Answer,
  KernelConfig,
  Leg,
  LegResult,
  LegStatus,
  Question,
  Shelf,
  Trigger,
} from '../types';

/**
 * One shelf, one leg, one transport (02-redesign.md §5, 13-pr-d-local-arms.md).
 * `searchLeg` and `keysLeg` are specs over {@link shelfLeg}: the same HTTP
 * transport, the same status map, the same bypass route, with the path, the
 * body and the verdict as data. Both endpoints answer in the search envelope
 * (`searchResultSchema`), so one parser reads both.
 *
 * THIS LEG NEVER THROWS. A bad response is one row in a ledger, and the fire
 * has other legs to hear from. So every failure becomes a {@link LegStatus},
 * which is what tenjin-agent#286 asked for: a timeout, an abort, a refused
 * bypass, a non-JSON body and a JSON body of the wrong shape are five
 * different facts and used to be one silent miss.
 *
 * THE LEG SENDS `Question.text` WHOLE. The cut to the trigger's bound is
 * `question()`'s (`hooks/question.ts`), made once when the plan is built, so
 * what the leg sends, what the ledger stores and what the claim key hashes are
 * one string. `buildSearchRequest` still throws `USAGE` past the bound, as the
 * last guard against a question that skipped that path.
 */

/** Candidates asked for, so a search `verdict` can take a strong rank 2 or 3
 *  over an un-strong rank 1; the keys resolve asks for the same. */
const SEARCH_LIMIT = 3;

/** The team shelf's origin, or null when `baseUrl` is the public marketplace:
 *  keys go to a team shelf only (there is no public resolve), and the primer
 *  and the capture ask pick their wording by the same test. */
export function teamOrigin(cfg: KernelConfig): string | null {
  const origin = tryOriginOf(cfg.baseUrl);
  return origin !== null && isTeamShelfOrigin(origin, cfg.publicShelfUrl) ? origin : null;
}

interface Route {
  baseUrl: string;
  bypass?: ShelfBypass;
}

/**
 * Which origin this shelf is, and what opens it.
 *
 * The same rule `lib/settings.ts` resolves for the CLI, minus the flag and env
 * layers a daemon has none of: the team shelf is `baseUrl` carrying the bypass
 * secret, and the secret rides only when `baseUrl` is a shelf of the team's own
 * — not production, not whatever `publicShelfUrl` points at. A secret with no
 * private shelf behind it is a setup that is not finished, and it fails to
 * public rather than posting the team's door key to the marketplace.
 */
function routeOf(shelf: 'team' | 'public', cfg: KernelConfig): Route {
  if (shelf === 'public') return { baseUrl: cfg.publicShelfUrl };
  const origin = tryOriginOf(cfg.baseUrl);
  const secret = cfg.shelfBypassSecret;
  const carries =
    secret.length > 0 && origin !== null && isTeamShelfOrigin(origin, cfg.publicShelfUrl);
  return {
    baseUrl: cfg.baseUrl,
    ...(carries && origin !== null ? { bypass: { origin, secret } } : {}),
  };
}

/** What the transport saw, for the failure map below. Captured off the
 *  Response because `httpRequest` reports the CLI's failure contract, which
 *  collapses a gate page and a missing field into one code. */
interface Seen {
  status: number;
  json: boolean;
}

/**
 * Why this leg produced no answer.
 *
 * ONE CLOCK. The leg starts no timer of its own: `ask` already hands in
 * `AbortSignal.any([fire.signal, AbortSignal.timeout(budget)])`, and the abort
 * REASON says which of the two ended it — `AbortSignal.timeout` aborts with a
 * `TimeoutError` and `AbortSignal.any` forwards the first reason, so a deadline
 * and a harness that closed its socket stay distinguishable with nothing extra
 * running (00-principles.md, "One clock").
 *
 * The order is the order of certainty: a request that never returned beats one
 * we misread, and a status beats a body. 401 and 403 are `refused` rather than
 * `http_401`: on a team shelf that is Deployment Protection turning the bypass
 * key away, which is a setup problem and not a server outage. A 404 is
 * `http_404` like any other status: on the keys route it is the server saying
 * `not_enabled`, and the ledger row is the whole of what that costs.
 */
function statusOf(seen: Seen | null, signal: AbortSignal): LegStatus {
  if (signal.aborted) {
    const name = (signal.reason as { name?: unknown } | undefined)?.name;
    return name === 'TimeoutError' ? 'timeout' : 'aborted';
  }
  if (seen === null) return 'error';
  if (seen.status === 401 || seen.status === 403) return 'refused';
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
  };
}

/** One shelf request as data: where it goes, what it carries, how its
 *  envelope is judged. */
interface ShelfSpec {
  shelf: Shelf;
  route: Route;
  path: string;
  body(q: Question, budgetMs: number): unknown;
  /** null = miss. Decides over the parsed envelope and nothing else. */
  verdict(result: SearchResult): Answer | null;
}

function shelfLeg(spec: ShelfSpec, fetchImpl?: typeof fetch): Leg {
  return {
    shelf: spec.shelf,
    async request(q: Question, budgetMs: number, signal: AbortSignal): Promise<LegResult> {
      let seen: Seen | null = null;
      const base: typeof fetch = fetchImpl ?? ((input, init) => fetch(input, init));
      const probe: typeof fetch = async (input, init) => {
        const res = await base(input, init);
        seen = {
          status: res.status,
          json: (res.headers.get('content-type') ?? '').includes('json'),
        };
        return res;
      };
      try {
        const res = await httpRequest(spec.route.baseUrl.replace(/\/+$/, '') + spec.path, {
          method: 'POST',
          // The transport's own timer is not a second deadline: `httpRequest`
          // requires a number and the caller's signal is what actually ends the
          // leg, so it gets the same budget and never fires first.
          timeoutMs: Math.max(1, budgetMs),
          signal,
          fetchImpl: probe,
          jsonBody: spec.body(q, budgetMs),
          ...(spec.route.bypass !== undefined ? { bypass: spec.route.bypass } : {}),
        });
        if (!res.ok || res.status !== 200) return { status: statusOf(seen, signal) };
        const parsed = searchResultSchema.safeParse(res.json);
        if (!parsed.success) return { status: statusOf(seen, signal) };
        const result = parsed.data;
        const top = result.items[0];
        return {
          status: 'ok',
          searchId: result.searchId,
          calibration: result.calibration,
          ...(top !== undefined ? { title: top.title, url: top.url, form: top.artifactType } : {}),
          payload: result,
        };
      } catch {
        return { status: statusOf(seen, signal) };
      }
    },
    verdict(result: LegResult): Answer | null {
      const payload = result.payload as SearchResult | undefined;
      if (payload === undefined) return null;
      return spec.verdict(payload);
    },
  };
}

/**
 * `POST /api/search`: the question as built, whole.
 *
 * THE VERDICT IS THE ONLY THING THAT DECIDES WHETHER AN AGENT SEES A PIECE,
 * and it is the shelf's decision, not this machine's: the FIRST candidate the
 * server marked `strong` is the answer. Strong means its meaning leg was medium
 * or better and its word leg corroborated it, which is a rule with the
 * embeddings and the full body behind it; the hook has forty words of public
 * text and used to guess with them, wrongly, 12 times out of 12.
 *
 * THIS MACHINE HAS NO QUALITY RULE OF ITS OWN, so there is no fallback to fall
 * back to: a response the shelf vouched for nothing in is a MISS, and the fire
 * records `no-hit` rather than speaking rank 1 on nobody's word. What rank 1
 * was still rides on the leg's `LegResult` — title, url, form, searchId and
 * `calibration` — so the ledger keeps what the shelf offered, and how often a
 * lookup came back with an offer and no vouch, on a row whose `outcome` is
 * `miss`.
 */
export function searchLeg(
  shelf: 'team' | 'public',
  trigger: Trigger,
  cfg: KernelConfig,
  fetchImpl?: typeof fetch,
): Leg {
  return shelfLeg(
    {
      shelf,
      route: routeOf(shelf, cfg),
      path: '/api/search',
      body: (q, budgetMs) =>
        buildSearchRequest({
          question: q.text,
          limit: SEARCH_LIMIT,
          trigger,
          budgetMs,
        }),
      verdict(result) {
        const winner = result.items.find((c) => c.strong === true);
        return winner === undefined ? null : answerOf(shelf, winner, result.searchId);
      },
    },
    fetchImpl,
  );
}

/**
 * `POST /api/keys/resolve` on the team shelf: the failure arm's fingerprints,
 * exact keys and nothing else about the failure (`search.md`: a key hit is
 * exact, nothing to select, so the verdict is the first item). The route is
 * the team shelf's — there is no public resolve — and the arm plans this leg
 * only against a team origin (decision 13). A shelf with keys off answers 404
 * `not_enabled`, which is one `http_404` row and no machine-wide fact.
 */
export function keysLeg(cfg: KernelConfig, keys: string[], fetchImpl?: typeof fetch): Leg {
  return shelfLeg(
    {
      shelf: 'keys',
      route: routeOf('team', cfg),
      path: '/api/keys/resolve',
      body: () => ({
        keys: keys.map((key) => ({ kind: 'fingerprint', key })),
        trigger: 'failure' satisfies Trigger,
        limit: SEARCH_LIMIT,
      }),
      verdict(result) {
        const top = result.items[0];
        return top === undefined ? null : answerOf('keys', top, result.searchId);
      },
    },
    fetchImpl,
  );
}
