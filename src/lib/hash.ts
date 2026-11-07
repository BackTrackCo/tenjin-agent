import { createHash } from 'node:crypto';

/** `value`'s sha256 as hex, cut to `length` characters when given: how a store names a file for a key. */
export function sha256Hex(value: string, length?: number): string {
  const hex = createHash('sha256').update(value).digest('hex');
  return length === undefined ? hex : hex.slice(0, length);
}
