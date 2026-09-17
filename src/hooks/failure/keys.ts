import { createHash } from 'node:crypto';

/**
 * The key formats the failure lane and the CLI both have to compute the same
 * way: the test key a failure is looked up and published under, and the
 * composed key it claims the once-per-question gate on, which the arm writes
 * and `capture.ts` reads back.
 *
 * They live here rather than beside either caller because a hook writes the
 * rows and a command reads them back, and a byte of drift between the two
 * sides is a query that silently finds nothing.
 */

/** A string reduced to a stable, non-reversible 16-hex join key. */
export function shortHash(text: string): string {
  return createHash('sha256').update(String(text)).digest('hex').slice(0, 16);
}

/** What a test key starts with: on the wire, in the ledger, and after
 *  `publish --key fingerprint=`. */
export const TEST_KEY_PREFIX = 'test:';
const LINE_PREFIX = 'line:';

/** The server's bound on one key, which `POST_KEY_MAX_CHARS`
 *  (`lib/posts-api.ts`) mirrors for publish. A copy, not an import: this module
 *  ships in the daemon bundle and `posts-api` does not belong there;
 *  `keys.test.ts` pins the two equal. */
export const KEY_MAX_CHARS = 200;
/** One resolve request takes at most this many keys (tenjin `lib/post-keys.ts`),
 *  and one over is a 400 for all of them. */
export const RESOLVE_KEYS_MAX = 10;

/**
 * The key a failing test is looked up and published under:
 * `test:<file> > <suite> > <test>`, the name vitest's own header prints.
 *
 * A NAME, NOT A HASH (tenjin-agent#350). Anyone can derive it without this
 * machine's output, a person can publish under it by hand, and it reads as what
 * it is in the ledger and in the turn-end ask. The hash it replaces was taken
 * over rendered output, so a reporter flag, a colour, a digit or a rebuilt
 * bundle changed it and the shelf never saw the same key twice.
 *
 * PAST THE SERVER'S BOUND a long name keeps its head and trades the tail for a
 * hash of the whole key, the same here and on the ask's side, so the key a
 * teammate publishes under is the one the next run asks.
 */
export function testKey(name: string): string {
  const key = TEST_KEY_PREFIX + name;
  if (key.length <= KEY_MAX_CHARS) return key;
  const hash = shortHash(key);
  let head = key.slice(0, KEY_MAX_CHARS - hash.length - 1);
  // A cut between the halves of a surrogate pair is not text any more.
  if (/[\uD800-\uDBFF]$/.test(head)) head = head.slice(0, -1);
  return head + '#' + hash;
}

/**
 * The failure arm's once-per-question key: every test key this failure has,
 * then the hash of its masked question, as a JSON array.
 *
 * IT IS NOT A `questionKeyOf` VALUE and must never be routed through one. The
 * error line alone is what `questionKeyOf` hashes, and the same assertion in two
 * tests hashes the same, which is the collision the once-per-question gate
 * (`gates.ts`, `Q_PREFIX`) turns into a cached miss the second failure is never
 * looked up past. Composing the test keys in front of the line hash is what
 * keeps them apart; two failures with the same line and no test name are one
 * question, because there is nothing else to ask either of them with.
 *
 * JSON, NOT A JOINED STRING: a test name is free text and carries `|`, `>` and
 * quotes, so any separator would split a name in two on the way back.
 *
 * READABLE ON PURPOSE. `capture.ts` reads the keys back out of
 * `fires.question_key` to name them in the turn-end ask; hashing the whole
 * composition would cost a second store per failure, which is what deleting
 * `pairings` was for. Nothing on the path bounds it: `fires.question_key` is
 * TEXT and so is `marks.key`. It never leaves the machine.
 */
export function failureQuestionKey(parts: { keys: readonly string[]; lineKey?: string }): string {
  const out = [...parts.keys];
  if (parts.lineKey !== undefined && parts.lineKey !== '') out.push(LINE_PREFIX + parts.lineKey);
  return out.length === 0 ? '' : JSON.stringify(out);
}

/**
 * The test keys inside a composed key, in composition order, for the turn-end
 * ask's `--key fingerprint=` suggestions. The `line:` part is dropped: it is a
 * hash of console text, not a key anyone publishes under. A key that is not a
 * JSON array (a row written before tenjin-agent#350) or holds no test key
 * yields an empty list, which is the honest answer: nothing to file under.
 */
export function failureKeyFingerprints(key: string): string[] {
  let parts: unknown;
  try {
    parts = JSON.parse(key);
  } catch {
    return [];
  }
  if (!Array.isArray(parts)) return [];
  return parts.filter((p): p is string => typeof p === 'string' && p.startsWith(TEST_KEY_PREFIX));
}
