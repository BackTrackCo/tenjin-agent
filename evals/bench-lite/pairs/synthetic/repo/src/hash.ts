import { createHash } from 'node:crypto';

/**
 * Content hashing for idempotency keys, dedupe keys and ETags.
 *
 * The hash is sha-256 truncated to 32 hex characters, which is what every
 * stored key column is sized for.
 *
 * ```ts
 * import { fingerprint } from './hash.ts';
 *
 * const key = fingerprint({ accountId, amountCents, kind });
 * ```
 */

const KEY_LENGTH = 32;

/** Hash an ordered list of already-normalised parts. */
export function digest(parts: readonly string[], options: { salt?: string } = {}): string {
  const hash = createHash('sha256');
  if (options.salt) {
    hash.update(options.salt);
    hash.update(' ');
  }
  for (const part of parts) {
    hash.update(part);
    hash.update(' ');
  }
  return hash.digest('hex').slice(0, KEY_LENGTH);
}

/** True if `value` has the shape of a key this module produced. */
export function isKey(value: string): boolean {
  return value.length === KEY_LENGTH && /^[0-9a-f]+$/.test(value);
}

/** A short, human-quotable prefix of a key, for log lines. */
export function shortKey(key: string): string {
  return key.slice(0, 8);
}
