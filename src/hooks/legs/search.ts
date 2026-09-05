import {
  buildSearchRequest,
  postSearch,
  type SearchCandidate,
  type SearchResult,
} from '../../lib/agent-api';
import type { ShelfBypass } from '../../lib/http';
import { isTeamShelfOrigin } from '../../lib/settings';
import { tryOriginOf } from '../../lib/url';
import { cut } from '../text';
import type { Answer, KernelConfig, Leg, LegResult, LegStatus, Question, Trigger } from '../types';

/**
 * One shelf, one leg (02-redesign.md §5). Every lookup arm uses this factory,
 * and every arm PR D adds will too: the arms differ in what they ask, never in
 * how a shelf is asked.
 *
 * THIS LEG NEVER THROWS. `postSearch` is written for a CLI, where a bad response
 * is an error message and an exit code; here it is one row in a ledger, and the
 * fire has other legs to hear from. So every failure becomes a
 * {@link LegStatus}, which is what tenjin-agent#286 asked for: a timeout, an
 * abort, a refused bypass, a non-JSON body and a JSON body of the wrong shape
 * are five different facts and used to be one silent miss.
 *
 * THE 512-CHARACTER CUT LIVES HERE, cut at a word boundary, because it is the
 * SHELF's bound and not any arm's. No arm has a length rule; `buildSearchRequest`
 * would otherwise throw `USAGE` at a long question, which for a hook is a crash
 * where a shorter query would have done.
 */

/** Candidates asked for, so `verdict` can take a strong rank 2 or 3 over an
 *  un-strong rank 1. Today's `PUSH_SEARCH_LIMIT`. */
const SEARCH_LIMIT = 3;

/** The server's query bound (`lookupRequestSchema`). */
const QUERY_MAX = 512;

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
function routeOf(
  shelf: 'team' | 'public',
  cfg: KernelConfig,
): {
  baseUrl: string;
  bypass?: ShelfBypass;
} {
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

/** What the transport saw, for the failure map below. Captured off the Response
 *  because `postSearch` reports the CLI's error contract, which collapses a 404,
 *  a gate page and a missing field into one code. */
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
 * key away, which is a setup problem and not a server outage.
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

function answerOf(
  shelf: 'team' | 'public',
  candidate: SearchCandidate,
  strong: boolean,
  searchId: string,
): Answer {
  const handle = candidate.creator.handle;
  const excerpt = readString(candidate, 'excerpt');
  return {
    shelf,
    strength: strong ? 'strong' : 'weak',
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

export function searchLeg(
  shelf: 'team' | 'public',
  trigger: Trigger,
  cfg: KernelConfig,
  fetchImpl?: typeof fetch,
): Leg {
  const route = routeOf(shelf, cfg);
  return {
    shelf,
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
        const body = buildSearchRequest({
          question: cut(q.text, QUERY_MAX),
          limit: SEARCH_LIMIT,
          trigger,
          ...(q.identifiers !== undefined ? { identifiers: q.identifiers } : {}),
          budgetMs,
        });
        const result = await postSearch(body, {
          // The transport's own timer is not a second deadline: `httpRequest`
          // requires a number and the caller's signal is what actually ends the
          // leg, so it gets the same budget and never fires first.
          baseUrl: route.baseUrl,
          timeoutMs: Math.max(1, budgetMs),
          signal,
          fetchImpl: probe,
          ...(route.bypass !== undefined ? { bypass: route.bypass } : {}),
        });
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
    /**
     * THE ONLY THING THAT DECIDES WHETHER AN AGENT SEES A PIECE, and it is the
     * shelf's decision, not this machine's: the FIRST candidate the server
     * marked `strong` is the answer. Strong means its meaning leg was medium or
     * better and its word leg corroborated it, which is a rule with the
     * embeddings and the full body behind it; the hook has forty words of
     * public text and used to guess with them, wrongly, 12 times out of 12.
     *
     * Absent is not false. A deployment that sends no `strong` has not called
     * anything strong, so rank 1 rides as `weak` and `calibration` on the leg
     * row says whether the meaning step ran at all. No candidates is a miss.
     */
    verdict(result: LegResult): Answer | null {
      const payload = result.payload as SearchResult | undefined;
      if (payload === undefined || payload.items.length === 0) return null;
      const strong = payload.items.findIndex((c) => c.strong === true);
      const winner = payload.items[strong >= 0 ? strong : 0];
      if (winner === undefined) return null;
      return answerOf(shelf, winner, strong >= 0, payload.searchId);
    },
  };
}
