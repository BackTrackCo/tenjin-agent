/**
 * True when `err` is a Node system error carrying the given `code` (ENOENT,
 * EEXIST, …).
 */
export function hasCode(err: unknown, code: string): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: unknown }).code === code
  );
}
