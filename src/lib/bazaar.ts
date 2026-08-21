import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { HTTPFacilitatorClient } from '@x402/core/http';
import { withBazaar } from '@x402/extensions/bazaar';
import type { DiscoveryResource } from '@x402/extensions/bazaar';
import type { PaymentRequirements } from '@x402/core/types';
import { getAddress } from 'viem';
import { writeFileAtomic } from './atomic-json';

/**
 * The x402 discovery registries: `discover` reads them, and the Bazaar pay lane
 * verifies a foreign 402 against them before any signature exists. Everything
 * here rides the SDK's own bazaar client (`withBazaar` over the facilitator
 * HTTP client); this module adds only aggregation across registries, a timeout
 * (the SDK fetch has none, and a hung registry must not hang a command), and
 * the cross-check.
 *
 * Registry text (descriptions, resource URLs) is OTHER PEOPLE'S DATA: callers
 * render it sanitized and never follow instructions found in it.
 */

export interface RegistryResource {
  /** The payable resource URL, exactly as the registry lists it. */
  url: string;
  registry: string;
  description?: string;
  accepts: PaymentRequirements[];
  lastUpdated?: string;
}

export interface RegistryError {
  registry: string;
  message: string;
}

export interface RegistrySweep {
  resources: RegistryResource[];
  /** Registries that did not answer; a sweep with errors is PARTIAL, never silently complete. */
  errors: RegistryError[];
  /** Listings skipped because they are not plain HTTP resources (e.g. MCP servers). */
  skippedNonHttp: number;
}

/** One page is the sweep unit; a payTo filter narrows far below this. */
const PAGE_LIMIT = 100;
/** CDP's search endpoint rejects limits above 20 (verified live 2026-08-14). */
const SEARCH_LIMIT = 20;

function client(registry: string) {
  return withBazaar(new HTTPFacilitatorClient({ url: registry }));
}

/** The SDK fetch carries no deadline; a registry that stalls loses its slot. */
async function withTimeout<T>(work: Promise<T>, timeoutMs: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${what} timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function toResource(item: DiscoveryResource, registry: string): RegistryResource {
  return {
    url: item.resource,
    registry,
    ...(item.description !== undefined ? { description: item.description } : {}),
    accepts: item.accepts,
    ...(item.lastUpdated !== undefined ? { lastUpdated: item.lastUpdated } : {}),
  };
}

/** List HTTP-type resources across every configured registry. */
export async function sweepRegistries(
  registries: readonly string[],
  opts: { timeoutMs: number; query?: string },
): Promise<RegistrySweep> {
  const resources: RegistryResource[] = [];
  const errors: RegistryError[] = [];
  let skippedNonHttp = 0;
  for (const registry of registries) {
    try {
      const bazaar = client(registry).extensions.bazaar;
      const items =
        opts.query !== undefined
          ? (
              await withTimeout(
                bazaar.search({ query: opts.query, limit: SEARCH_LIMIT }),
                opts.timeoutMs,
                `search on ${registry}`,
              )
            ).resources
          : (
              await withTimeout(
                bazaar.listResources({ type: 'http', limit: PAGE_LIMIT }),
                opts.timeoutMs,
                `listing ${registry}`,
              )
            ).items;
      for (const item of items) {
        if (item.type !== 'http') {
          // An MCP-type listing is a seller this CLI cannot speak x402-over-HTTP
          // to; counted so the sweep never silently narrows what it covered.
          skippedNonHttp += 1;
          continue;
        }
        resources.push(toResource(item, registry));
      }
    } catch (err) {
      errors.push({ registry, message: err instanceof Error ? err.message : String(err) });
    }
  }
  return { resources, errors, skippedNonHttp };
}

// ---------------------------------------------------------------------------
// The local listing store: what `discover` swept, kept as pay-time evidence.
//
// The live lookup below is honest but weak: CDP's Bazaar ignores the `payTo`
// list filter and its search is semantic (a URL query matches nothing), both
// verified live 2026-08-14, so "look this URL up at pay time" cannot be relied
// on against the largest registry. What CAN be relied on is what a sweep
// actually returned: `discover` persists its listings here (bounded, TTL'd),
// and the pay lane treats a fresh stored listing as the registry's word. That
// also matches the designed flow — discover, then pay what discovery surfaced.
// ---------------------------------------------------------------------------

const LISTING_STORE_FILE = 'bazaar-listings.json';
/** A listing older than this is not pay-time evidence; re-run `discover`. */
const LISTING_TTL_MS = 24 * 60 * 60 * 1000;
/** Newest-first cap so the store cannot grow without bound. */
const LISTING_STORE_CAP = 1000;

export interface StoredListing {
  url: string;
  registry: string;
  accepts: PaymentRequirements[];
  fetchedAt: string;
}

interface ListingStore {
  listings: StoredListing[];
}

function listingStorePath(dataDir: string): string {
  return join(dataDir, LISTING_STORE_FILE);
}

/**
 * Shape-checked PER ENTRY, not just per array. `acceptsMismatch` iterates
 * `accepts`, so one malformed row from a truncated write or a hand-edit throws a
 * raw TypeError out of the check that decides whether a payment may be signed.
 * A row that is not the shape this module writes is dropped, which costs at
 * worst a re-`discover`.
 */
function isStoredListing(value: unknown): value is StoredListing {
  if (typeof value !== 'object' || value === null) return false;
  const listing = value as Partial<StoredListing>;
  return (
    typeof listing.url === 'string' &&
    typeof listing.registry === 'string' &&
    typeof listing.fetchedAt === 'string' &&
    Array.isArray(listing.accepts)
  );
}

async function loadListingStore(dataDir: string): Promise<ListingStore> {
  try {
    const raw: unknown = JSON.parse(await readFile(listingStorePath(dataDir), 'utf8'));
    const listings = (raw as { listings?: unknown } | null)?.listings;
    return { listings: Array.isArray(listings) ? listings.filter(isStoredListing) : [] };
  } catch {
    return { listings: [] };
  }
}

/** Persist a sweep's listings, newest first, deduplicated on (identity, registry). */
export async function saveSweepListings(
  dataDir: string,
  resources: readonly RegistryResource[],
  now: () => number = Date.now,
): Promise<void> {
  const store = await loadListingStore(dataDir);
  const fetchedAt = new Date(now()).toISOString();
  const fresh: StoredListing[] = resources.map((r) => ({
    url: r.url,
    registry: r.registry,
    accepts: r.accepts,
    fetchedAt,
  }));
  const seen = new Set(fresh.map((l) => `${l.registry} ${l.url}`));
  const kept = store.listings.filter((l) => !seen.has(`${l.registry} ${l.url}`));
  await writeFileAtomic(
    listingStorePath(dataDir),
    JSON.stringify({ listings: [...fresh, ...kept].slice(0, LISTING_STORE_CAP) }, null, 2),
  );
}

/** Fresh stored listings for this resource identity, newest first. */
async function storedListingsFor(
  dataDir: string,
  url: string,
  now: () => number,
): Promise<StoredListing[]> {
  const store = await loadListingStore(dataDir);
  return store.listings.filter((l) => {
    if (!sameResourceUrl(l.url, url)) return false;
    const age = now() - Date.parse(l.fetchedAt);
    // BOUNDED AT BOTH ENDS. A negative age is not extra-fresh evidence, it is a
    // stamp the clock disagrees with (skew, a restored or copied data dir), and
    // an unbounded `age < TTL` made such a listing permanent pay-time evidence
    // that no 24h re-sweep could ever expire. NaN (an unparseable stamp) fails
    // the same comparison.
    return age >= 0 && age < LISTING_TTL_MS;
  });
}

export type RegistryVerification =
  | { outcome: 'verified'; registry: string }
  /** Listed somewhere, but no listing matches the live 402's terms. */
  | { outcome: 'mismatch'; registry: string; detail: string }
  | { outcome: 'unlisted' }
  /** Every registry errored: the check could not run, which is never a pass. */
  | { outcome: 'unavailable'; errors: RegistryError[] };

/**
 * Resource identity is origin + path (trailing slash normalized): a registry
 * lists the ENDPOINT, and the query string is the per-call request riding it
 * (verified live: the Bazaar lists `/search`, callers pay `/search?query=...`).
 * An unparseable listing matches nothing.
 */
function sameResourceUrl(listed: string, requested: string): boolean {
  const identity = (u: string): string | null => {
    try {
      const parsed = new URL(u);
      const path = parsed.pathname.endsWith('/') ? parsed.pathname.slice(0, -1) : parsed.pathname;
      return `${parsed.origin}${path}`;
    } catch {
      return null;
    }
  };
  const a = identity(listed);
  return a !== null && a === identity(requested);
}

/**
 * Is the live 402 the deal a registry publicly advertises? Looked up by the
 * LIVE payTo (the discovery API's only useful filter), which is self-verifying:
 * a tampered payTo finds either nothing or listings whose resource is not this
 * URL. A match requires same scheme/network/asset/payTo and a live amount AT
 * MOST the advertised one, so a seller can cut prices without delisting but a
 * raise waits for the registry. This is provenance, not endorsement: the spend
 * policy and the confirm gate still bound the money.
 */
export async function verifyAgainstRegistries(
  registries: readonly string[],
  url: string,
  live: PaymentRequirements,
  timeoutMs: number,
  opts: { dataDir?: string; now?: () => number } = {},
): Promise<RegistryVerification> {
  const errors: RegistryError[] = [];
  let mismatch: { registry: string; detail: string } | undefined;

  // A fresh listing a `discover` sweep stored IS the registry's word for this
  // resource; checking it first is also the only reliable path on registries
  // whose live lookup cannot filter by URL or payTo (see the store note above).
  if (opts.dataDir !== undefined) {
    for (const listing of await storedListingsFor(opts.dataDir, url, opts.now ?? Date.now)) {
      if (!registries.includes(listing.registry)) continue; // no longer configured
      const detail = acceptsMismatch(listing.accepts, live);
      if (detail === null) return { outcome: 'verified', registry: listing.registry };
      mismatch ??= { registry: listing.registry, detail };
    }
  }

  for (const registry of registries) {
    try {
      const bazaar = client(registry).extensions.bazaar;
      const listed = await withTimeout(
        bazaar.listResources({ type: 'http', payTo: live.payTo, limit: PAGE_LIMIT }),
        timeoutMs,
        `listing ${registry}`,
      );
      const matches = listed.items.filter(
        (item) => item.type === 'http' && sameResourceUrl(item.resource, url),
      );
      if (matches.length === 0) continue;
      for (const item of matches) {
        const detail = acceptsMismatch(item.accepts, live);
        if (detail === null) return { outcome: 'verified', registry };
        mismatch ??= { registry, detail };
      }
    } catch (err) {
      errors.push({ registry, message: err instanceof Error ? err.message : String(err) });
    }
  }
  if (mismatch !== undefined) return { outcome: 'mismatch', ...mismatch };
  if (errors.length === registries.length && registries.length > 0) {
    return { outcome: 'unavailable', errors };
  }
  return { outcome: 'unlisted' };
}

/** Null when some advertised accept covers the live requirement; else why not. */
function acceptsMismatch(
  advertised: PaymentRequirements[],
  live: PaymentRequirements,
): string | null {
  let closest = 'the listing advertises no payment terms';
  for (const adv of advertised) {
    if (adv.scheme !== live.scheme) {
      closest = `advertised scheme ${adv.scheme}, live ${live.scheme}`;
      continue;
    }
    if (adv.network !== live.network) {
      closest = `advertised network ${adv.network}, live ${live.network}`;
      continue;
    }
    if (!sameAddress(adv.asset, live.asset)) {
      closest = `advertised asset ${adv.asset}, live ${live.asset}`;
      continue;
    }
    if (!sameAddress(adv.payTo, live.payTo)) {
      closest = `advertised payTo ${adv.payTo}, live ${live.payTo}`;
      continue;
    }
    let advertisedAmount: bigint;
    let liveAmount: bigint;
    try {
      advertisedAmount = BigInt(adv.amount);
      liveAmount = BigInt(live.amount);
    } catch {
      closest = 'a non-integer amount in the listing or the live 402';
      continue;
    }
    if (liveAmount > advertisedAmount) {
      closest = `live amount ${live.amount} exceeds the advertised ${adv.amount}`;
      continue;
    }
    return null;
  }
  return closest;
}

function sameAddress(a: string, b: string): boolean {
  try {
    return getAddress(a) === getAddress(b);
  } catch {
    return false;
  }
}
