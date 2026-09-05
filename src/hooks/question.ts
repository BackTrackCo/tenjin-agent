import { createHash } from 'node:crypto';
import { condense, identifiersOf } from '../lib/query-condense';
import { mask } from '../lib/redact';
import type { Question, SkipReason } from './types';

/**
 * What an arm asks, and the key the once-per-question gate is claimed on
 * (02-redesign.md §4).
 *
 * THE SHAPE LIST IS THE BEHAVIOUR. An arm hands `question()` the steps its text
 * goes through — `[mask]` for a search-shaped query, `[mask, condense]` for a
 * prompt — and there is no flag to read. Order is the list's: mask runs first so
 * a token condense would otherwise promote to an identifier is already a stub.
 *
 * `condense` is the one step with more to it than a string in and a string out,
 * because condensing is what produces the identifiers list and what can produce
 * nothing at all. Both are properties of that step, so they live beside it here
 * rather than as options on this function.
 */

/** The query's character bound, cut at a whole token. The shelf's own cap is 512
 *  and the search leg makes that cut; this is the condensed query's bound, and
 *  the figure today's prompt arm calls `PROMPT_QUERY_CHARS`. */
const QUERY_CHARS = 400;

/** A prompt shorter than this is a conversational reply, not a question: 48 of
 *  474 real prompts, every sample a "yes" or a "fix it". */
const PROMPT_MIN_CHARS = 80;
/** And longer than this is a pasted payload: 40 of 474, every one a hook log. */
const PROMPT_MAX_CHARS = 4000;

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;

/** Strip control characters and cap: this text lands in a model's context. */
function clean(value: string, max: number): string {
  return value.replace(CONTROL_CHARS, ' ').trim().slice(0, max);
}

/** Whole words long enough to be a topic word. Not a scorer — the shelf decides
 *  strength — just the floor that keeps an arm from spending a request on
 *  "fix it". */
function wordCount(text: string): number {
  return text.split(/\s+/).filter((w) => w.length >= 3).length;
}

/**
 * The claim key: sha256 over the same normalization `state-store.ts` has always
 * fingerprinted a search question with (lower-cased, whitespace collapsed,
 * trimmed, 512 characters), hex, first 16 bytes. A fan-out re-asks
 * near-identical questions, and case and spacing carry no meaning between them.
 *
 * NEVER A WIRE VALUE. A plain hash of text this machine already holds, with no
 * salt and no rule table, so nothing depends on it staying secret and no stored
 * key has to be migrated when an arm changes what it asks.
 */
export function questionKeyOf(text: string): string {
  const normalized = text.toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 512);
  return createHash('sha256').update(normalized).digest('hex').slice(0, 32);
}

/**
 * Run `shape` over `text` in order and key the result. This never skips: an arm
 * that will not ask says so with a {@link SkipReason} before it gets here.
 */
export function question(text: string, shape: Array<(t: string) => string>): Question {
  let out = text;
  let identifiers: string[] | undefined;
  for (const step of shape) {
    if (step === condense) {
      // Read off the text going IN to condense — the masked prompt — because
      // condensing drops the prose the identifiers were lifted out of.
      const found = identifiersOf(out);
      if (found.length > 0) identifiers = found;
      const condensed = condense(out);
      // WHEN CONDENSING LEAVES NOTHING the head goes instead. Seven three-word
      // questions have no identifier and no clause of four words, and an empty
      // query still spends a request on both shelves to say nothing.
      out = clean(condensed.length > 0 ? condensed : out.slice(0, QUERY_CHARS), QUERY_CHARS);
      continue;
    }
    out = step(out);
  }
  return {
    text: out,
    questionKey: questionKeyOf(out),
    ...(identifiers !== undefined ? { identifiers } : {}),
  };
}

/**
 * The prompt arm's four junk filters, verbatim from the generated arm they
 * replace (`push-scripts.ts:1180-1189`) and PROMPT-ONLY: they are measured
 * against typed prose, and a search query is short and slash-free by nature.
 * Each reason is its own, so the ledger says which one bit.
 *
 * `words` counts the MASKED text, not the raw one: a prompt that is three
 * identifiers and no prose is a question, and a masked credential must not count
 * as one of its words. Length 0 is not a skip — it is having no text at all,
 * which is `no-question`, and the arm returns null for it before asking here.
 */
export function promptSkip(text: string): SkipReason | null {
  if (text.length < PROMPT_MIN_CHARS) return 'short';
  if (text.length > PROMPT_MAX_CHARS) return 'long';
  if (text.startsWith('/')) return 'slash';
  if (wordCount(mask(text)) < 3) return 'words';
  return null;
}
