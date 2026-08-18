/**
 * The curated block `discover` renders ahead of the registry sweep: this
 * deployment's own paid endpoints, plus vetted third-party sellers.
 *
 * DISPLAY ONLY. Nothing here is probed, and nothing here reaches the pay-time
 * evidence store (`bazaar-listings.json`): curation is endorsement, the store is
 * provenance, and a pin no registry lists still fails UNLISTED at pay time. So
 * the worst a wrong entry can do is recommend badly; it cannot move money or
 * loosen a check.
 */

export type PinKind = 'first-party' | 'ecosystem';

export interface PinnedListing {
  url: string;
  kind: PinKind;
  description: string;
  /** Lowercase terms a query is matched against, beside the description's words. */
  keywords: string[];
}

interface FirstPartyPath {
  path: string;
  description: string;
  keywords: string[];
}

/**
 * Paths on the CONFIGURED deployment, so a self-hosted install pins its own
 * endpoints rather than tenjin.sh's. Article reads stay search-driven and
 * `/api/answer` is deliberately absent: a deeper CLI integration for answer may
 * land later, and pinning it now would bake in a shape that work would undo.
 */
const FIRST_PARTY_PATHS: FirstPartyPath[] = [
  {
    path: '/api/phone-lookup',
    description:
      'Phone number intelligence: carrier, line type, and portability for one number, paid per lookup.',
    keywords: ['phone', 'number', 'carrier', 'lookup', 'line', 'telecom', 'msisdn', 'validation'],
  },
];

/**
 * Vetted third-party x402 sellers. EMPTY BY OPERATOR DECISION: an entry ships
 * only once an operator has vetted the seller and confirmed a configured
 * registry currently lists it, re-verified every release. The kind exists so
 * seeding is a data-only change.
 */
const ECOSYSTEM_PINS: PinnedListing[] = [];

/** Every pin, first-party first, resolved against the configured deployment. */
export function pinnedListings(baseUrl: string): PinnedListing[] {
  const origin = trimSlash(baseUrl);
  const firstParty = FIRST_PARTY_PATHS.map((p): PinnedListing => ({
    url: `${origin}${p.path}`,
    kind: 'first-party',
    description: p.description,
    keywords: p.keywords,
  }));
  return [...firstParty, ...ECOSYSTEM_PINS];
}

/**
 * The pins a `discover` run shows: all of them when browsing (no query),
 * otherwise the ones a query token matches. Matching is exact word overlap
 * against keywords and description words, lowercased; no stemming and no fuzzy
 * matching in v1, so a pin either plainly answers the query or stays hidden.
 * Tokens under three characters are dropped, because a pin that surfaces for
 * "a" or "in" is noise, not curation.
 */
export function selectPins(baseUrl: string, query?: string): PinnedListing[] {
  const pins = pinnedListings(baseUrl);
  // Absent (or blank) query is browse-everything; a real query that yields no
  // usable token matches nothing, rather than falling back to showing all.
  if (query === undefined || query.trim().length === 0) return pins;
  const tokens = tokenize(query);
  return pins.filter((pin) => {
    const vocabulary = new Set([
      ...pin.keywords.map((k) => k.toLowerCase()),
      ...tokenize(pin.description),
    ]);
    return tokens.some((t) => vocabulary.has(t));
  });
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3);
}

function trimSlash(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url;
}
