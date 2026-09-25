import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { HTTPFacilitatorClient } from '@x402/core/http';
import { withBazaar } from '@x402/extensions/bazaar';
import type { DiscoveryResource } from '@x402/extensions/bazaar';
import type { PaymentRequirements } from '@x402/core/types';
import { getAddress } from 'viem';
import { PaymentRequirementsV2Schema } from '@x402/core/schemas';
import { z } from 'zod';
import { writeFileAtomic } from './atomic-json';

/**
 * Discovery is evidence, never payment authority. Standard registries use the
 * SDK; Ultravioleta has an explicit adapter for its different discovery shape.
 * Every payment candidate is matched locally against the live requirement.
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

const MAX_PAGES = 5;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const ULTRAVIOLETA_ORIGIN = 'https://facilitator.ultravioletadao.xyz';

function isUltravioleta(registry: string): boolean {
  return new URL(registry).origin === ULTRAVIOLETA_ORIGIN;
}

const paymentTerms = z.custom<PaymentRequirements>((value: unknown) => {
  const parsed = PaymentRequirementsV2Schema.safeParse(value);
  return parsed.success && /^\d+$/.test(parsed.data.amount);
});
const ultravioletResource = z.object({
  url: z.string().url(),
  type: z.string(),
  x402Version: z.number().int(),
  description: z.string().optional(),
  accepts: z.array(paymentTerms).max(100),
  lastUpdated: z.number().int().nonnegative().max(8_640_000_000_000),
});
const paginationSchema = z.object({
  limit: z.number().int().positive().max(PAGE_LIMIT),
  offset: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
});
interface Listings {
  items: DiscoveryResource[];
  incomplete?: string;
}

/** A registry controls its response size as well as its latency. */
async function boundedJson(res: Response): Promise<unknown> {
  const reader = res.body?.getReader();
  if (!reader) throw new Error('Registry response has no body');
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) throw new Error('Registry response exceeds size limit');
      chunks.push(next.value);
    }
  } finally {
    await reader.cancel();
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}

/** Ultravioleta's documented resources API uses q, url and Unix seconds. */
async function ultravioletListings(
  registry: string,
  timeoutMs: number,
  query?: string,
): Promise<Listings> {
  const deadline = Date.now() + timeoutMs;
  const items: DiscoveryResource[] = [];
  let offset = 0;
  for (let page = 0; page < MAX_PAGES; page++) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error('Registry lookup deadline exceeded');
    const params = new URLSearchParams({
      limit: String(PAGE_LIMIT),
      offset: String(offset),
      ...(query !== undefined ? { q: query } : {}),
    });
    const res = await fetch(`${new URL(registry).origin}/discovery/resources?${params}`, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(remaining),
      redirect: 'error',
    });
    if (!res.ok) throw new Error(`listing ${registry} answered ${res.status}`);
    const response = z
      .object({ items: z.array(ultravioletResource).max(PAGE_LIMIT), pagination: paginationSchema })
      .parse(await boundedJson(res));
    const pagination = response.pagination;
    if (pagination.offset !== offset || response.items.length > pagination.limit)
      throw new Error('Invalid registry pagination');
    for (const item of response.items) {
      items.push({
        resource: item.url,
        type: item.type,
        x402Version: item.x402Version,
        accepts: item.accepts as PaymentRequirements[],
        lastUpdated: new Date(item.lastUpdated * 1000).toISOString(),
        ...(item.description !== undefined ? { description: item.description } : {}),
      });
    }
    const next = pagination.offset + response.items.length;
    if (next >= pagination.total) return { items };
    if (response.items.length === 0) break;
    offset = next;
  }
  return { items, incomplete: 'Registry search truncated at the pagination limit' };
}

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
  const deadline = Date.now() + opts.timeoutMs;
  for (const registry of registries) {
    try {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error('Registry lookup deadline exceeded');
      const bazaar = client(registry).extensions.bazaar;
      const ultraviolet = isUltravioleta(registry)
        ? await withTimeout(
            ultravioletListings(registry, remaining, opts.query),
            remaining,
            registry,
          )
        : undefined;
      if (ultraviolet?.incomplete) errors.push({ registry, message: ultraviolet.incomplete });
      const items =
        ultraviolet?.items ??
        (opts.query !== undefined
          ? (
              await withTimeout(
                bazaar.search({ query: opts.query, limit: SEARCH_LIMIT }),
                remaining,
                `search on ${registry}`,
              )
            ).resources
          : (
              await withTimeout(
                bazaar.listResources({ type: 'http', limit: PAGE_LIMIT }),
                remaining,
                `listing ${registry}`,
              )
            ).items);
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
// The local listing store: what a `discover` sweep returned, kept as pay-time
// evidence (bounded, TTL'd). The pay lane checks a fresh stored listing first,
// then asks each registry live (`listingsFor`), so the store is a shortcut and
// never the only way a listed resource can be paid.
// ---------------------------------------------------------------------------

const LISTING_STORE_FILE = 'bazaar-listings.json';
/** A listing older than this is not pay-time evidence; the live lookup decides. */
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
 * worst a live lookup.
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
  /** Some required evidence could not be checked; absence is not established. */
  | { outcome: 'unavailable'; errors: RegistryError[] };

/**
 * Resource identity is origin + path (trailing slash normalized): a registry
 * lists the ENDPOINT, and the query string is the per-call request riding it
 * (verified live: the Bazaar lists `/search`, callers pay `/search?query=...`).
 * An unparseable listing matches nothing.
 */
function sameResourceUrl(listed: string, requested: string): boolean {
  const a = resourceIdentity(listed);
  return a !== null && a === resourceIdentity(requested);
}

function resourceIdentity(u: string): string | null {
  try {
    const parsed = new URL(u);
    const path = parsed.pathname.endsWith('/') ? parsed.pathname.slice(0, -1) : parsed.pathname;
    return `${parsed.origin}${path}`;
  } catch {
    return null;
  }
}

/** Search by endpoint identity so differing recipients remain visible. Registries
 * without search retain the SDK's recipient-filtered listing fallback. */
async function listingsFor(
  registry: string,
  url: string,
  payTo: string,
  timeoutMs: number,
): Promise<Listings> {
  if (isUltravioleta(registry))
    return ultravioletListings(registry, timeoutMs, resourceIdentity(url) ?? url);
  const deadline = Date.now() + timeoutMs;
  const params = new URLSearchParams({
    urlSubstring: resourceIdentity(url) ?? url,
    limit: String(SEARCH_LIMIT),
  });
  const res = await fetch(`${registry.replace(/\/+$/, '')}/discovery/search?${params.toString()}`, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(timeoutMs),
    redirect: 'error',
  });
  if (res.ok) {
    const answer = (await boundedJson(res)) as {
      resources?: unknown;
      partialResults?: boolean;
      pagination?: { cursor?: unknown };
    } | null;
    if (Array.isArray(answer?.resources)) {
      return {
        items: answer.resources.slice(0, PAGE_LIMIT) as DiscoveryResource[],
        ...(answer.resources.length > PAGE_LIMIT ||
        answer.partialResults === true ||
        answer.pagination?.cursor != null
          ? { incomplete: 'Registry search results are truncated' }
          : {}),
      };
    }
  } else if (res.status !== 400 && res.status !== 404) {
    throw new Error(`search on ${registry} answered ${res.status}`);
  }
  const bazaar = client(registry).extensions.bazaar;
  const items: DiscoveryResource[] = [];
  let offset = 0;
  for (let page = 0; page < MAX_PAGES; page++) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error('Registry lookup deadline exceeded');
    const response = await withTimeout(
      bazaar.listResources({ type: 'http', payTo, limit: PAGE_LIMIT, offset }),
      remaining,
      registry,
    );
    const pagination = paginationSchema.parse(response.pagination);
    if (
      !Array.isArray(response.items) ||
      response.items.length > PAGE_LIMIT ||
      pagination.offset !== offset
    )
      throw new Error('Invalid registry page');
    items.push(...response.items);
    offset = pagination.offset + response.items.length;
    if (offset >= pagination.total) return { items };
    if (response.items.length === 0) break;
  }
  return { items, incomplete: 'Registry listing truncated at the pagination limit' };
}

/** An exact resource match must cover the live scheme, network, asset, recipient
 * and price. Missing or incomplete evidence is never a verified listing. */
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
  // resource, and it answers without a round trip.
  if (opts.dataDir !== undefined) {
    for (const listing of await storedListingsFor(opts.dataDir, url, opts.now ?? Date.now)) {
      if (!registries.includes(listing.registry)) continue; // no longer configured
      const detail = acceptsMismatch(listing.accepts, live);
      if (detail === null) return { outcome: 'verified', registry: listing.registry };
      mismatch ??= { registry: listing.registry, detail };
    }
  }

  const deadline = Date.now() + timeoutMs;
  for (const registry of registries) {
    try {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error('Registry lookup deadline exceeded');
      const listed = await withTimeout(
        listingsFor(registry, url, live.payTo, remaining),
        remaining,
        `looking up this resource on ${registry}`,
      );
      if (listed.incomplete) errors.push({ registry, message: listed.incomplete });
      const matches = listed.items.filter(
        (item) =>
          item != null &&
          item.type === 'http' &&
          typeof item.resource === 'string' &&
          Array.isArray(item.accepts) &&
          sameResourceUrl(item.resource, url),
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
  if (errors.length > 0) {
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
  for (const raw of advertised) {
    const parsed = paymentTerms.safeParse(raw);
    if (!parsed.success) {
      closest = 'malformed advertised payment terms';
      continue;
    }
    const adv = parsed.data;
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
