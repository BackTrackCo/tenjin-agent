import pkg from '../../package.json';

/**
 * The RFC 9110 product token naming this CLI. It leads every User-Agent the
 * shared transport sends, because the server's `parseUserAgentProduct()` (tenjin
 * PR #544) attributes on the FIRST product only and the CLI is the user agent
 * that constructed and sent the request.
 */
export const TENJIN_PRODUCT = `tenjin-cli/${pkg.version}`;

/** The product NAME alone, which is what identifies a copy of us in a handoff. */
export const TENJIN_PRODUCT_NAME = 'tenjin-cli';

/**
 * The product the WebSearch hook leads with, so a ridealong query is separable
 * from a deliberate `tenjin search`. Leading is the mechanism: the server
 * attributes on the FIRST User-Agent product, landing here in `client_name`.
 *
 * The separation is the deliverable, not any one consumer: whatever judges hook
 * demand needs these populations distinguishable at ingest (tenjin#704,
 * tenjin-agent#179). A rename breaks no filter today, it merges them again. */
export const WEBSEARCH_HOOK_PRODUCT_NAME = 'tenjin-websearch-hook';
export const WEBSEARCH_HOOK_PRODUCT = `${WEBSEARCH_HOOK_PRODUCT_NAME}/${pkg.version}`;

/** Every identity of ours a handoff may carry, which composition drops rather
 *  than duplicate, whichever product is leading. */
export const OWN_PRODUCT_NAMES = [TENJIN_PRODUCT_NAME, WEBSEARCH_HOOK_PRODUCT_NAME];

/**
 * The identifying comment. It rides LAST so a caller's products keep the order
 * they were handed off in, and so stripping it is enough to recover the caller's
 * sequence from an already-composed field (see `composeUserAgent`).
 */
export const TENJIN_COMMENT = '(+https://tenjin.blog)';

/**
 * The CLI's identity on every HTTP request, sent as the standard `User-Agent`
 * header from the shared transport (`http.ts`). `X-Tenjin-Client` is retired and
 * this CLI sends it nowhere.
 */
export const TENJIN_USER_AGENT = `${TENJIN_PRODUCT} ${TENJIN_COMMENT}`;

/** The same field for the WebSearch hook, which identifies as its own product. */
export const WEBSEARCH_HOOK_USER_AGENT = `${WEBSEARCH_HOOK_PRODUCT} ${TENJIN_COMMENT}`;

/** The handoff seam for an agent that launches the CLI as a subprocess. */
export const CALLER_USER_AGENT_ENV = 'TENJIN_CALLER_USER_AGENT';

/** The server's bound: a longer field is discarded whole, never truncated. */
export const USER_AGENT_MAX_LENGTH = 512;

/**
 * One RFC 9110 product: a token, optionally `/token`. The handoff accepts a
 * sequence of these and nothing else (no comments, no free text), which is what
 * structurally keeps a user, wallet, session, hostname, or machine identifier
 * out of the field rather than a blocklist that has to guess at one.
 */
export const PRODUCT_RE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+(?:\/[!#$%&'*+.^_`|~0-9A-Za-z-]+)?$/;

/** Printable ASCII, the only range the server parses; also excludes CR/LF/tab. */
export const PRINTABLE_ASCII_RE = /^[\x20-\x7e]*$/;

export interface ComposeUserAgentInput {
  /** A caller's product sequence, passed programmatically; wins over the env. */
  caller?: string | undefined;
  /** Environment seam; defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** The product to lead with; the WebSearch hook passes its own. */
  product?: string;
}

/**
 * Compose the field the transport sends: the Tenjin product, then the caller's
 * products in their original order, then the Tenjin comment. The handoff is
 * SELF-REPORTED TELEMETRY and never trusted policy input; nothing here or on the
 * server may read it to decide entitlement, spend, or trust.
 *
 * Idempotent by construction: the caller value is decomposed into tokens, our own
 * product and comment are dropped from it, and the field is rebuilt from
 * `TENJIN_PRODUCT`, so re-composing an already-composed field (a retry, a nested
 * helper, an agent re-exporting the env it received) yields the same string
 * rather than a second `tenjin-cli` token. Caller products survive byte for byte.
 *
 * Rejection is total, never partial: a non-printable, non-product, or overlong
 * handoff is OMITTED and the Tenjin identity travels alone, because truncating a
 * product token would mint a different, false identity.
 */
export function composeUserAgent(input: ComposeUserAgentInput = {}): string {
  const product = input.product ?? TENJIN_PRODUCT;
  const alone = `${product} ${TENJIN_COMMENT}`;
  const raw = input.caller ?? (input.env ?? process.env)[CALLER_USER_AGENT_ENV];
  const products = callerProducts(raw);
  if (products.length === 0) return alone;
  const composed = `${product} ${products.join(' ')} ${TENJIN_COMMENT}`;
  return composed.length <= USER_AGENT_MAX_LENGTH ? composed : alone;
}

/** The caller's products, or none at all when any part of the handoff is unusable. */
function callerProducts(raw: string | undefined): string[] {
  if (raw === undefined || !PRINTABLE_ASCII_RE.test(raw)) return [];
  // Printable ASCII leaves the space as the only whitespace, so it is the only
  // separator a product sequence can have.
  const tokens = raw.split(' ').filter((token) => token.length > 0 && !isOwnIdentity(token));
  return tokens.every((token) => PRODUCT_RE.test(token)) ? tokens : [];
}

/**
 * Our own identity inside a caller value, matched case-insensitively: a product
 * token is case-sensitive to the server, but a copy of ours in any casing is
 * still a duplicate identity, and dropping it is what makes composition total.
 */
function isOwnIdentity(token: string): boolean {
  const lower = token.toLowerCase();
  // Both sides are lowered: comparing a lowered token against a constant that is
  // merely all-lowercase TODAY would break silently the day either gains a
  // capital, and it fails safe (the stale copy stops matching, then fails
  // PRODUCT_RE, and the whole handoff drops), so nothing would notice.
  if (lower === TENJIN_COMMENT.toLowerCase()) return true;
  return OWN_PRODUCT_NAMES.some((name) => {
    const own = name.toLowerCase();
    return lower === own || lower.startsWith(`${own}/`);
  });
}
