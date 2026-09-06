import { lookupArm } from './lookup';
import type { Arm } from '../types';

/**
 * The two web arms, over one spec shape (09-pr-c-lookup-arms.md).
 *
 * TWO ARMS, NOT ONE, because they answer to different switches and read
 * different words: `research` is what `hooks.webSearch` speaks for and asks the
 * query as typed, `fetch` rides the push experiment and asks a url. Two arms
 * also means two `fires.arm` values, so the ledger can tell a page fetch from a
 * real search. They are the same pipeline everywhere else. (The once-per-question
 * claim is keyed on the QUESTION, per actor, not per arm: identical text asked
 * by both is one lookup, which is the point — the loop does not double count.)
 *
 * NEITHER REWRITES ITS WORDS and neither has a length rule. A query is already a
 * query, a url is already an address, and the search leg cuts at 512 on a word
 * boundary, which is the shelf's bound and no arm's.
 */

/**
 * The one-liner `remind` mode says instead of sending the query anywhere,
 * verbatim from the generated arm this replaces (`hook-scripts.ts` REMIND_LINE).
 * Copied rather than imported: that module renders the whole legacy script set
 * and pulls `push-scripts.ts` and `state-store.ts` in with it, and the daemon
 * bundle starts in front of every tool call. It is deleted with them in PR E.
 */
export const REMIND_LINE =
  'Tenjin (a marketplace of tested, paid answers) may already have this: `tenjin search "<question>" --json` is free and anonymous.';

/**
 * The url as typed with its query string cut out of it: a url's query is the
 * run from the first `?` to the `#` that ends it, so that run goes and both
 * sides of it stay. The fragment is one of those sides and is kept — on a docs
 * page it is the topic word (`vitest.dev/config/#restoremocks`), which is
 * exactly what the shelf ranks on.
 */
function withoutQuery(raw: string): string {
  const hash = raw.indexOf('#');
  const end = hash === -1 ? raw.length : hash;
  const start = raw.indexOf('?');
  if (start === -1 || start > end) return raw;
  return raw.slice(0, start) + raw.slice(end);
}

/**
 * The question a WebFetch is really asking: the page's address and the prompt
 * the agent attached to it, both as written.
 *
 * THE QUERY STRING IS THE ONE THING DROPPED. A signed url carries its
 * credential as a parameter value in a shape `mask` has no rule for — a
 * presigned signature, an account id, a vendor's own token spelling — so
 * `?...` never travels while the rest of the address does. Everything else goes
 * as typed; a url this build cannot parse, or one that is not a web address, is
 * a fetch this arm has no words for.
 *
 * THE PARSER IS THE http(s) CHECK, NOT THE ADDRESS. Sending `url.origin +
 * url.pathname` back out was a second rewrite wearing the parser's clothes: it
 * lower-cases and punycodes the host, percent-encodes the path, folds `..`
 * segments away, throws out the fragment, and strips the `user:pass@` that
 * `mask` has its own rule for — five alterations nobody asked for, under a
 * comment claiming one. The string the agent typed is the address; `URL` only
 * says whether it is a web one.
 */
export function fetchQuestion(toolInput: Record<string, unknown>): string {
  const raw = typeof toolInput.url === 'string' ? toolInput.url : '';
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return '';
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return '';
  const prompt = typeof toolInput.prompt === 'string' ? toolInput.prompt : '';
  // The trim is the join's own: with no prompt attached there is nothing on the
  // far side of the space to keep it for.
  return `${withoutQuery(raw)} ${prompt}`.trim();
}

/** WebSearch. The one arm `hooks.webSearch` speaks for. */
export const researchArm: Arm = lookupArm({
  id: 'research',
  wait: 'tool',
  on: [{ event: 'tool.before', kind: 'web' }],
  trigger: 'research',
  // `off` is the kill switch and silences `after` too. `remind` leaves the arm
  // ON — it has a line to say — and declines to ask, below.
  enabled: (cfg) => cfg.hooks.webSearch !== 'off',
  text: (input, ctx) => {
    // `remind` is the standing nudge for an agent that has to ask for itself:
    // nothing is sent anywhere, so there is no question and `after` speaks.
    if (ctx.deps.config().hooks.webSearch === 'remind') return null;
    const query = input.tool?.input.query;
    return typeof query === 'string' ? query.trim() : null;
  },
  shelves: ['team', 'public'],
  deliver: 'inject',
  after: (ctx) =>
    ctx.deps.config().hooks.webSearch === 'remind' ? { context: REMIND_LINE } : null,
});

/** WebFetch. Its own arm, its own switch, its own row in the ledger. */
export const fetchArm: Arm = lookupArm({
  id: 'fetch',
  wait: 'tool',
  on: [{ event: 'tool.before', kind: 'fetch' }],
  // The wire trigger is `research` for both: the server's telemetry asks which
  // KIND of moment produced the question, and both of these are a web lookup.
  trigger: 'research',
  // A page fetch is the push experiment's, not `hooks.webSearch`'s: today's
  // matcher widening, now a condition.
  enabled: (cfg) => cfg.hooks.push === 'on',
  text: (input) => fetchQuestion(input.tool?.input ?? {}),
  shelves: ['team', 'public'],
  deliver: 'inject',
});
