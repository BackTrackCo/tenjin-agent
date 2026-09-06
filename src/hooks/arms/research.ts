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
 * The url up to its first `?` or `#`, whichever comes first; the rest is cut.
 * ONE RULE, because both runs carry the same risk: a credential in a shape
 * `mask` has no rule for — a presigned signature or an account id in the query,
 * a hash router's own `#/invite?code=…`, the `#access_token=…` an OAuth
 * redirect hands back. A fragment that is none of those is a doc anchor, and an
 * anchor is worth nothing to a shelf that ranks on the page.
 */
function addressOnly(raw: string): string {
  const end = raw.search(/[?#]/);
  return end === -1 ? raw : raw.slice(0, end);
}

/**
 * The question a WebFetch is really asking: the page's address and the prompt
 * the agent attached to it, both as written.
 *
 * THE ADDRESS STOPS AT THE FIRST `?` OR `#`. Everything before it goes as
 * typed and nothing after it travels, because either run can hold a credential
 * `mask` cannot see (see `addressOnly`). A url this build cannot parse, or one
 * that is not a web address, is a fetch this arm has no words for.
 *
 * THE PARSER IS THE http(s) CHECK, NOT THE ADDRESS. Sending `url.origin +
 * url.pathname` back out was a second rewrite wearing the parser's clothes: it
 * lower-cases and punycodes the host, percent-encodes the path, folds `..`
 * segments away, and strips the `user:pass@` that `mask` has its own rule for —
 * four alterations nobody asked for, under a comment claiming one. The string
 * the agent typed is the address; `URL` only says whether it is a web one.
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
  return `${addressOnly(raw)} ${prompt}`.trim();
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
