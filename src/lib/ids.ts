/**
 * The shared identity patterns for server-controlled values that become file
 * paths, URL segments, or terminal output. One definition so a future change
 * (e.g. accepting uppercase ids) cannot be applied in one command and missed in
 * another. SLUG_RE must match the server's slugify charset (lib/posts.ts:
 * lowercase a-z0-9 groups joined by single hyphens, no leading/trailing hyphen).
 */
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** A non-negative atomic USDC integer string (6-decimal base units). */
export const ATOMIC_RE = /^\d{1,39}$/;

/**
 * One handle-shaped segment: an org slug or a shelf slug, the server's
 * `HANDLE_RE` charset.
 */
export const HANDLE_RE = /^[a-z0-9-]{2,32}$/;

/**
 * A QUALIFIED shelf name, `<org-slug>/<shelf-slug>` (e.g. `backtrack/backtrack`,
 * the default shelf being named after its org).
 *
 * The shelf rides in the request BODY now, not in a route segment, so the name
 * on the wire has to say which org it belongs to: two orgs may each own a shelf
 * called `notes`, and a bare `notes` would name whichever one the server looked
 * at first. A bare slug is therefore refused at every edge that accepts one,
 * locally as USAGE and remotely as a 400. The shelf's uuid stays internal to the
 * server; nothing on the wire accepts it in this phase.
 */
export const QUALIFIED_SHELF_RE = /^[a-z0-9-]{2,32}\/[a-z0-9-]{2,32}$/;
