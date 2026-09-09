import { createHash } from 'node:crypto';

/**
 * The key formats the failure lane and the CLI both have to compute the same
 * way: a signature key, the `project` a row is scoped by — the finding queue's
 * column (`capture.ts`) and the checkout the publish gate compares against
 * (`publish.ts`) — and the composed key a failure claims the once-per-question
 * gate on, which the arm writes and `capture.ts` reads back.
 *
 * They live here rather than beside either caller because a hook writes the
 * rows and a command reads them back, and a byte of drift between the two
 * sides is a query that silently finds nothing.
 */

/** A cwd or machine string reduced to a stable, non-reversible 16-hex join key. */
export function shortHash(text: string): string {
  return createHash('sha256').update(String(text)).digest('hex').slice(0, 16);
}

/**
 * The `project` a finding row is stamped with, from the cwd it happened in;
 * null for a
 * payload that carries none, which matches the rows written without one and
 * nothing else.
 *
 * IT IS A CWD HASH, NOT A REPO ROOT, so a subdirectory of a checkout reads as a
 * different project. That errs toward asking, which is the direction every
 * comparison over it is for.
 */
export function projectId(cwd: string | null | undefined): string | null {
  return typeof cwd === 'string' && cwd.length > 0 ? shortHash(cwd) : null;
}

/** The label the keys leg already sends a fingerprint under (`arms/failure.ts`
 *  builds exactly these strings into `fine`), and the label the composed
 *  failure key carries them under, so one format serves the wire, the ledger
 *  and `publish --key fingerprint=`. */
export const SIG_LABEL = 'sig_v1';
export const TEST_SIG_LABEL = 'sig_v1_test';
const LINE_LABEL = 'line';

/**
 * The failure arm's once-per-question key: every fingerprint this failure has,
 * then the hash of its masked error line, joined by `|` in a fixed order.
 *
 * IT IS NOT A `questionKeyOf` VALUE and must never be routed through one. The
 * error line alone is what `questionKeyOf` hashes, and two failures with the
 * same line in different files hash the same — which is the collision the
 * once-per-question gate (`gates.ts`, `Q_PREFIX`) turns into a cached miss the
 * second failure never gets looked up past. Composing the fingerprints in front
 * of the line hash is what keeps them apart.
 *
 * A KEY IS NOT STABLE ACROSS THE SAME FAILURE TWICE, and that is the price.
 * `sig_v1_test` comes from a test report read off disk (`test-identity.ts`), so
 * the same failure keys differently depending on whether the artifact was there
 * and fresh — one failure can claim the gate twice and be looked up twice. A
 * wasted lookup, where the collision above loses one entirely.
 *
 * READABLE ON PURPOSE. `capture.ts` reads the fingerprints back out of
 * `fires.question_key` to name them in the turn-end ask; hashing the
 * composition to keep the 32-hex shape buys nothing but the shape and costs a
 * second store per failure, which is what deleting `pairings` was for. At most
 * 90 characters (7+16, 12+16, 5+32, two separators), and nothing on the path
 * bounds it: `fires.question_key` is TEXT and `marks.key` is TEXT inside a
 * primary key.
 *
 * LOCAL ONLY, like every key here: each part is a non-reversible hash, and the
 * two fingerprint substrings are byte-identical to what the keys leg already
 * puts on the wire.
 */
export function failureQuestionKey(parts: {
  sig?: string;
  testSig?: string;
  lineKey?: string;
}): string {
  const out: string[] = [];
  if (parts.sig !== undefined && parts.sig !== '') out.push(SIG_LABEL + ':' + parts.sig);
  if (parts.testSig !== undefined && parts.testSig !== '')
    out.push(TEST_SIG_LABEL + ':' + parts.testSig);
  if (parts.lineKey !== undefined && parts.lineKey !== '')
    out.push(LINE_LABEL + ':' + parts.lineKey);
  return out.join('|');
}

/**
 * The `<kind>:<hash>` fingerprints inside a composed key, in composition order,
 * for the turn-end ask's `--key fingerprint=` suggestions. The `line:` part is
 * dropped: it is a hash of console text, not a key anyone publishes under. A
 * key that is nothing but `line:` yields an empty list, which is the honest
 * answer — that failure has no fingerprint to file a piece against.
 *
 * TOLERANT BY DESIGN. `fires` outlives a build, so a row written by an older
 * shape — a bare 16-hex `sig_v1_test` key, which is what the arm stored before
 * the composition — parses to nothing rather than to garbage.
 */
export function failureKeyFingerprints(key: string): string[] {
  return key
    .split('|')
    .filter((p) => p.startsWith(SIG_LABEL + ':') || p.startsWith(TEST_SIG_LABEL + ':'));
}
