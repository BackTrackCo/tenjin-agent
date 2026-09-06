import { createHash } from 'node:crypto';
import { mask } from '../lib/redact';
import { clean } from './text';
import type { Question, SkipReason } from './types';

/**
 * What an arm asks, and the key the once-per-question gate is claimed on
 * (02-redesign.md §4).
 *
 * A QUESTION IS WHAT THE AGENT TYPED, WITH ITS SECRETS STUBBED. `mask` is the
 * only thing that happens to an arm's text here, and the search leg's cut at the
 * shelf's 512 characters is the only other thing that happens to it before it
 * leaves the machine (owner decision 2026-09-06). No condensing, no identifier
 * lifting, no per-arm shaping: an arm that rewrites its own words is guessing at
 * a question nobody asked, and the shelf ranks better on the sentence than on
 * this machine's summary of it.
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
 * Mask the text and key the result. This never skips: an arm that will not ask
 * says so with a {@link SkipReason} before it gets here.
 */
export function question(text: string): Question {
  const out = mask(text);
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
 * still what the person is asking about; both go as typed, and the search leg's
 * 512-character cut is the only bound either meets. Each reason is its own, so
 * the ledger says which one bit.
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
