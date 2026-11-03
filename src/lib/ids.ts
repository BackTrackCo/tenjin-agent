/**
 * The shared identity patterns for server-controlled values that become file
 * paths, URL segments, or terminal output. One definition so a future change
 * (e.g. accepting uppercase ids) cannot be applied in one command and missed in
 * another.
 */
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A non-negative atomic USDC integer string (6-decimal base units). */
export const ATOMIC_RE = /^\d{1,39}$/;
