import pkg from '../../package.json';
import { PRODUCTION_ORIGIN } from './production-origin';

/**
 * The RFC 9110 product token naming this CLI. It leads every User-Agent
 * because the server's `parseUserAgentProduct()` attributes on the first
 * product only, and the CLI is what sent the request.
 */
export const TENJIN_PRODUCT = `tenjin-cli/${pkg.version}`;

/** The product name alone, which identifies a copy of us in a handoff. */
export const TENJIN_PRODUCT_NAME = 'tenjin-cli';

/** The product an earlier build's WebSearch hook led with; a handoff may still carry it. */
export const WEBSEARCH_HOOK_PRODUCT_NAME = 'tenjin-websearch-hook';

/** Every identity of ours a handoff may carry, which composition drops rather
 *  than duplicate. */
export const OWN_PRODUCT_NAMES = [TENJIN_PRODUCT_NAME, WEBSEARCH_HOOK_PRODUCT_NAME];

/**
 * The identifying comment. It rides last so a caller's products keep their
 * order, and stripping it recovers the caller's sequence from a composed field.
 */
export const TENJIN_COMMENT = `(+${PRODUCTION_ORIGIN})`;

/**
 * The CLI's identity on every HTTP request, sent as `User-Agent` from the
 * shared transport (`http.ts`).
 */
export const TENJIN_USER_AGENT = `${TENJIN_PRODUCT} ${TENJIN_COMMENT}`;

/** The handoff seam for an agent that launches the CLI as a subprocess. */
export const CALLER_USER_AGENT_ENV = 'TENJIN_CALLER_USER_AGENT';

/** The server's bound: a longer field is discarded whole, never truncated. */
export const USER_AGENT_MAX_LENGTH = 512;

/**
 * One RFC 9110 product: a token, optionally `/token`. The handoff accepts only
 * a sequence of these, no comments or free text, which keeps user, wallet,
 * session and machine identifiers out structurally rather than by blocklist.
 */
export const PRODUCT_RE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+(?:\/[!#$%&'*+.^_`|~0-9A-Za-z-]+)?$/;

/** Printable ASCII, the only range the server parses; also excludes CR/LF/tab. */
export const PRINTABLE_ASCII_RE = /^[\x20-\x7e]*$/;

export interface ComposeUserAgentInput {
  /** A caller's product sequence, passed programmatically; wins over the env. */
  caller?: string | undefined;
  /** Environment seam; defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
}

/**
 * Compose the field the transport sends: the Tenjin product, the caller's
 * products in order, then the Tenjin comment. The handoff is self-reported
 * telemetry; nothing here or on the server may use it for entitlement, spend
 * or trust.
 *
 * Idempotent: our own product and comment are dropped from the caller value
 * before the rebuild, so re-composing a composed field (a retry, an agent
 * re-exporting its env) never adds a second `tenjin-cli` token.
 *
 * Rejection is total: a non-printable, non-product or overlong handoff is
 * omitted whole, because truncating a product token would mint a false one.
 */
export function composeUserAgent(input: ComposeUserAgentInput = {}): string {
  const raw = input.caller ?? (input.env ?? process.env)[CALLER_USER_AGENT_ENV];
  const products = callerProducts(raw);
  if (products.length === 0) return TENJIN_USER_AGENT;
  const composed = `${TENJIN_PRODUCT} ${products.join(' ')} ${TENJIN_COMMENT}`;
  return composed.length <= USER_AGENT_MAX_LENGTH ? composed : TENJIN_USER_AGENT;
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
 * Our own identity inside a caller value, matched case-insensitively: a copy
 * of ours in any casing is still a duplicate identity.
 */
function isOwnIdentity(token: string): boolean {
  const lower = token.toLowerCase();
  // Lower both sides, so a constant that gains a capital still matches.
  if (lower === TENJIN_COMMENT.toLowerCase()) return true;
  return OWN_PRODUCT_NAMES.some((name) => {
    const own = name.toLowerCase();
    return lower === own || lower.startsWith(`${own}/`);
  });
}
