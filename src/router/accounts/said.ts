/** One line of what an error said, at most `max` characters: for a message a
 *  person reads, or a refusal's detail. */
export function said(err: unknown, max: number): string {
  const text = err instanceof Error ? err.message : String(err);
  return text.replace(/\s+/g, ' ').trim().slice(0, max);
}
