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
 * The question a WebFetch is really asking: the page's address and the prompt
 * the agent attached to it, both as written.
 *
 * THE QUERY STRING IS THE ONE THING DROPPED. A signed url carries its
 * credential as a parameter value in a shape `mask` has no rule for — a
 * presigned signature, an account id, a vendor's own token spelling — so
 * `?...` never travels while the origin and the path do. Everything else goes
 * as typed; a url this build cannot parse, or one that is not a web address, is
 * a fetch this arm has no words for.
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
  return `${url.origin}${url.pathname} ${prompt}`.trim();
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
