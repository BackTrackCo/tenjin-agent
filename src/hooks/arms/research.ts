import { mask } from '../../lib/redact';
import { lookupArm } from './lookup';
import type { Arm } from '../types';

/**
 * The two web arms, over one spec shape (09-pr-c-lookup-arms.md).
 *
 * TWO ARMS, NOT ONE, because the kernel keys its once-per-question claim per
 * arm: an agent that fetches six pages while researching would otherwise share
 * a bucket with the search it is actually running. They differ in three fields
 * and are the same pipeline everywhere else.
 *
 * NEITHER IS CONDENSED and neither has a length rule. A WebSearch query is
 * already a query — `condense` was measured to damage 131 of 184 real ones
 * (`pgvector testcontainer collation` to nothing at all) — and the search leg
 * cuts at 512 on a word boundary, which is the shelf's bound and no arm's.
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
 * Query-string keys whose VALUE is a topic rather than a credential. An
 * allow-list, not a deny-list: `?api_key=`, `?access_token=`, `?sig=` and every
 * vendor spelling nobody has thought of are all handled by not being on it.
 */
const SAFE_PARAM_KEY_RE =
  /^(?:q|query|search|keywords?|topic|tags?|section|category|lang|locale|version|v)$/i;

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;

/** The prompt head a fetch carries. The url's own words come before it. */
const PROMPT_HEAD = 400;

/** The words of an allow-listed param value. A value is a phrase, so it is read
 *  word by word, and a word that reads as an opaque handle rather than as
 *  language is dropped even here. */
function paramWords(url: URL): string {
  const out: string[] = [];
  let budget = 120;
  for (const [key, value] of url.searchParams) {
    if (!SAFE_PARAM_KEY_RE.test(key)) continue;
    for (const word of String(value).split(/[^A-Za-z0-9@._-]+/)) {
      if (word.length === 0 || word.length > 24) continue;
      if (word.length >= 12 && /\d/.test(word) && /[A-Za-z]/.test(word)) continue;
      budget -= word.length + 1;
      if (budget < 0) return out.join(' ');
      out.push(word);
    }
  }
  return out.join(' ');
}

/**
 * The question a WebFetch is really asking: the url's own words (path segments,
 * plus the values of the few query keys that hold a topic) and the prompt the
 * agent attached. Ported from `hook-scripts.ts:1527-1548`, pure.
 *
 * A HOSTNAME NEVER ENTERS THE WORDS at all, only the path and the allow-listed
 * params; and PARAM VALUES ARE NOT SENT WHOLESALE, independent of masking,
 * because a query string is where an api key, an account id and a presigned
 * signature live. The url has already left the machine via the fetch itself, so
 * this is not about hiding the address — the spec's `[mask]` handles the one
 * shape that matters, a credential in a path segment
 * (`acme.com/download/sk-abc.../file.pdf`), which the allow-list never guarded.
 *
 * The port's own 512-character cut is gone: no arm has a length rule now, and
 * masking the whole string before the search leg cuts it is strictly safer than
 * cutting a secret in half first.
 */
function urlWords(raw: string): string | null {
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    const path = decodeURIComponent(url.pathname)
      .replace(/\.(html?|php|aspx?|md|txt)$/i, '')
      .replace(/[/_]+/g, ' ');
    return `${path} ${paramWords(url)}`.replace(/[^A-Za-z0-9@._-]+/g, ' ');
  } catch {
    // A url this build cannot parse is a url this arm has no words for.
    return null;
  }
}

export function fetchQuestion(toolInput: Record<string, unknown>): string {
  const words = urlWords(typeof toolInput.url === 'string' ? toolInput.url : '');
  if (words === null) return '';
  const prompt = typeof toolInput.prompt === 'string' ? toolInput.prompt.slice(0, PROMPT_HEAD) : '';
  return `${words} ${prompt}`.replace(CONTROL_CHARS, ' ').replace(/\s+/g, ' ').trim();
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
  shape: [mask],
  shelves: ['team', 'public'],
  deliver: 'inject',
  after: (ctx) =>
    ctx.deps.config().hooks.webSearch === 'remind' ? { context: REMIND_LINE } : null,
});

/** WebFetch. Its own arm, its own claim, its own once-per-piece marks. */
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
  shape: [mask],
  shelves: ['team', 'public'],
  deliver: 'inject',
});
