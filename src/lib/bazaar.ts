import { HTTPFacilitatorClient } from '@x402/core/http';
import { withBazaar } from '@x402/extensions/bazaar';
import type { DiscoveryResource } from '@x402/extensions/bazaar';
import type { PaymentRequirements } from '@x402/core/types';
import { getAddress } from 'viem';

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
                bazaar.search({ query: opts.query, limit: PAGE_LIMIT }),
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

export type RegistryVerification =
  | { outcome: 'verified'; registry: string }
  /** Listed somewhere, but no listing matches the live 402's terms. */
  | { outcome: 'mismatch'; registry: string; detail: string }
  | { outcome: 'unlisted' }
  /** Every registry errored: the check could not run, which is never a pass. */
  | { outcome: 'unavailable'; errors: RegistryError[] };

/** Trailing-slash tolerance only; anything else must match exactly. */
function sameResourceUrl(a: string, b: string): boolean {
  const trim = (u: string) => (u.endsWith('/') ? u.slice(0, -1) : u);
  return trim(a) === trim(b);
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
): Promise<RegistryVerification> {
  const errors: RegistryError[] = [];
  let mismatch: { registry: string; detail: string } | undefined;
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
