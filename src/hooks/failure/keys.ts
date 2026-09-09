import { createHash } from 'node:crypto';

/**
 * The two hashes the failure lane and the CLI both have to compute the same
 * way: a signature key, and the `project` a row is scoped by — the finding
 * queue's column (`capture.ts`) and the checkout the publish gate compares
 * against (`publish.ts`).
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
