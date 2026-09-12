import { createHash } from 'node:crypto';
import { queryMax } from '../lib/agent-api';
import { mask } from '../lib/redact';
import { clean, cut } from './text';
import type { Question, SkipReason, Trigger } from './types';

/**
 * What an arm asks, and the key the once-per-question gate is claimed on
 * (02-redesign.md §4).
 *
 * A QUESTION IS WHAT THE AGENT TYPED, WITH ITS SECRETS STUBBED AND CUT TO WHAT
 * THE SHELF WILL READ. `mask` and then `cut` at the trigger's bound
 * (`queryMax`: 8,000 for a dispatch work order, 512 for everything else) are the
 * only two things that happen to an arm's text before it leaves the machine
 * (owner decisions 2026-09-06 and 2026-09-11). No condensing, no identifier
 * lifting, no per-arm shaping: an arm that rewrites its own words is guessing at
 * a question nobody asked, and the shelf ranks better on the sentence than on
 * this machine's summary of it.
 *
 * THE CUT LIVES HERE AND NOWHERE ELSE, so `Question.text` IS the wire text: the
 * leg sends it whole, the ledger stores it whole, and the once-per-question key
 * is a hash of exactly what was sent.
 *
 * LEADING AND TRAILING WHITESPACE COMES OFF, and is named here so the list is
 * the real one rather than the tidy one. An arm trims the text it built
 * (`research.ts`) and `buildSearchRequest` trims what it sends, which is also
 * how a query of nothing but spaces becomes no question instead of a request
 * the shelf refuses. It moves no word and reorders none, so it is not one of
 * the rewrites above.
 */

/** What a SKIPPED text is stored as. Not a query bound — nothing is asked — but
 *  the row still lands in `loop.db`, and a refused prompt is exactly where a
 *  pasted transcript and a credential live. Masked first, then cut, so a token
 *  is a stub before anything is thrown away. */
const SKIP_TEXT_CHARS = 512;

/** The text a {@link Skip} carries into `fires.question`. */
export function skipText(text: string): string {
  return clean(mask(text), SKIP_TEXT_CHARS);
}

/** Whole words long enough to be a topic word. Not a scorer — the shelf decides
 *  strength — just the floor that keeps an arm from spending a request on
 *  "fix it". */
function wordCount(text: string): number {
  return text.split(/\s+/).filter((w) => w.length >= 3).length;
}

/**
 * The claim key: sha256 over the WHOLE sent text, lower-cased, whitespace
 * collapsed and trimmed; hex, first 16 bytes. A fan-out re-asks near-identical
 * questions, and case and spacing carry no meaning between them.
 *
 * The whole text, not a head of it: two work orders that open with the same
 * rules and differ in their task are two questions, and a key over the first
 * 512 characters would have answered the second child from the first one's
 * cache without asking.
 *
 * NEVER A WIRE VALUE. A plain hash of text this machine already holds, with no
 * salt and no rule table, so nothing depends on it staying secret and no stored
 * key has to be migrated when an arm changes what it asks.
 */
export function questionKeyOf(text: string): string {
  const normalized = text.toLowerCase().replace(/\s+/g, ' ').trim();
  return createHash('sha256').update(normalized).digest('hex').slice(0, 32);
}

/**
 * Mask the text, cut it to what the trigger's shelf request will read, and key
 * the result. This never skips: an arm that will not ask says so with a
 * {@link SkipReason} before it gets here.
 */
export function question(text: string, trigger: Trigger): Question {
  const out = cut(mask(text), queryMax(trigger));
  return { text: out, questionKey: questionKeyOf(out) };
}

/**
 * Text that was typed into the prompt channel and addressed to the harness
 * rather than to anyone. `<task-notification>` and `<agent-message` are a
 * subagent's own plumbing arriving as a prompt, and `[SYSTEM NOTIFICATION` is
 * the harness talking to itself; a shelf has nothing to say about any of them.
 */
const HARNESS_PREFIXES = ['<task-notification>', '<agent-message', '[SYSTEM NOTIFICATION'];

/**
 * The prompt arm's junk rules, and no one else's. All three say the same thing:
 * this text is addressed to the harness, or it is not words at all.
 *
 * THERE IS NO LENGTH RULE. A short question is a question and a long paste is
 * still what the person is asking about; both go as typed, and `question()`'s
 * cut at the trigger's bound is the only one either meets. Each reason is its
 * own, so the ledger says which one bit.
 *
 * `words` counts the MASKED text, not the raw one: a prompt that is three
 * identifiers and no prose is a question, and a masked credential must not count
 * as one of its words. Length 0 is not a skip — it is having no text at all,
 * which is `no-question`, and the arm returns null for it before asking here.
 */
export function promptSkip(text: string): SkipReason | null {
  if (text.startsWith('/')) return 'slash';
  if (HARNESS_PREFIXES.some((prefix) => text.startsWith(prefix))) return 'harness';
  if (wordCount(mask(text)) < 3) return 'words';
  return null;
}
