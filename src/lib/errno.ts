/**
 * True when `err` is a Node system error carrying the given `code` (ENOENT,
 * EEXIST, …). One definition so the fs-error checks scattered across the wallet
 * store, config loader, and session cache stay identical.
 */
export function hasCode(err: unknown, code: string): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: unknown }).code === code
  );
}
