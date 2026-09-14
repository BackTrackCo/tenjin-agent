/**
 * Timestamps on the wire and in storage.
 *
 * Every persisted row carries a `*Stamp` column and every API payload carries
 * an ISO-8601 string; these four functions are the only place the two forms
 * meet.
 */

/** Storage form of a timestamp. */
export function toStamp(date: Date): number {
  return Math.floor(date.getTime() / 1000);
}

/** Storage form back to a `Date`. */
export function fromStamp(stamp: number): Date {
  return new Date(stamp * 1000);
}

/** Storage form of "right now". */
export function nowStamp(): number {
  return toStamp(new Date());
}

/** Parse an ISO-8601 string into storage form. */
export function parseStamp(iso: string): number {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`not an ISO-8601 timestamp: ${iso}`);
  }
  return toStamp(parsed);
}

/** Storage form as an ISO-8601 string, for API payloads. */
export function formatStamp(stamp: number): string {
  return fromStamp(stamp).toISOString();
}

/** Whole days between two stamps, rounded down. */
export function daysBetween(fromStampValue: number, toStampValue: number): number {
  return Math.floor((toStampValue - fromStampValue) / 86400);
}
