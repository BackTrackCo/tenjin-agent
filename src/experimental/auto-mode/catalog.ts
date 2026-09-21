import { compileResource } from './contracts';
import type { AutoContract, CompileResult } from './contracts';

export const CDP_BAZAAR = 'https://api.cdp.coinbase.com/platform/v2/x402';
type Fetch = typeof globalThis.fetch;

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

async function readCatalog(
  url: URL,
  fetcher: Fetch,
  timeoutMs: number,
): Promise<Record<string, unknown>> {
  const response = await fetcher(url, {
    signal: AbortSignal.timeout(timeoutMs),
    redirect: 'error',
    headers: { accept: 'application/json' },
  });
  if (!response.ok) throw new Error(`CDP discovery returned HTTP ${response.status}`);
  if (Number(response.headers.get('content-length')) > 8 * 1024 * 1024)
    throw new Error('Discovery response exceeds 8 MiB');
  // Stream bound avoids allocating an unbounded body before checking its size.
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Empty discovery response');
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > 8 * 1024 * 1024) throw new Error('Discovery response exceeds 8 MiB');
      chunks.push(part.value);
    }
  } finally {
    await reader.cancel();
  }
  return object(JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown);
}

export interface CatalogAuditRow {
  index: number;
  url: string | null;
  curated: boolean | null;
  status: 'contract_validated' | 'unsupported';
  method: string | null;
  sourceHash: string | null;
  reasons: string[];
  paymentOptions: { version: unknown; scheme: unknown; network: unknown }[];
  fixtureExecuted: false;
  quoteChecked: false;
  livePaidVerified: false;
}

/** Every source record gets a row, including malformed/duplicate entries. */
export function auditResources(resources: readonly unknown[]): {
  total: number;
  contractValidated: number;
  unsupported: number;
  rows: CatalogAuditRow[];
} {
  const rows = resources.map((resource, index): CatalogAuditRow => {
    const source = object(resource);
    const result = compileResource(resource);
    const supported = result.status === 'supported';
    const input = object(object(object(object(source.extensions).bazaar).info).input);
    return {
      index,
      url:
        typeof source.resource === 'string'
          ? source.resource
          : typeof source.url === 'string'
            ? source.url
            : null,
      curated: typeof source.curated === 'boolean' ? source.curated : null,
      status: supported ? 'contract_validated' : 'unsupported',
      method: supported
        ? result.contract.method
        : typeof input.method === 'string'
          ? input.method
          : typeof source.method === 'string'
            ? source.method
            : null,
      sourceHash: supported ? result.contract.sourceHash : null,
      reasons: supported ? [] : result.reasons,
      paymentOptions: (Array.isArray(source.accepts) ? source.accepts : []).map((accept) => ({
        version: source.x402Version ?? null,
        scheme: object(accept).scheme ?? null,
        network: object(accept).network ?? null,
      })),
      fixtureExecuted: false,
      quoteChecked: false,
      livePaidVerified: false,
    };
  });
  const contractValidated = rows.filter((row) => row.status === 'contract_validated').length;
  return {
    total: rows.length,
    contractValidated,
    unsupported: rows.length - contractValidated,
    rows,
  };
}

export async function discoverCandidates(
  query: string,
  options: { fetch?: Fetch; limit?: number; timeoutMs?: number } = {},
): Promise<{
  resources: unknown[];
  contracts: AutoContract[];
  rejected: Extract<CompileResult, { status: 'unsupported' }>[];
  partial: boolean;
}> {
  if (!query.trim() || query.length > 1000)
    throw new Error('Discovery query must contain 1–1000 characters');
  const limit = options.limit ?? 10;
  if (!Number.isInteger(limit) || limit < 1 || limit > 20)
    throw new Error('Search limit must be 1–20');
  const url = new URL(`${CDP_BAZAAR}/discovery/search`);
  url.searchParams.set('query', query);
  url.searchParams.set('limit', String(limit));
  const result = await readCatalog(
    url,
    options.fetch ?? globalThis.fetch,
    options.timeoutMs ?? 8000,
  );
  if (!Array.isArray(result.resources))
    throw new Error('Malformed CDP search response: resources missing');
  const resources = result.resources.slice(0, limit);
  const compiled = resources.map((resource) => compileResource(resource));
  return {
    resources,
    contracts: compiled
      .filter((entry) => entry.status === 'supported')
      .map((entry) => entry.contract),
    rejected: compiled.filter((entry) => entry.status === 'unsupported'),
    partial: result.partialResults !== false || result.resources.length > limit,
  };
}

/** Bounded and resumable inventory; a page cap or changed denominator is explicit. */
export async function snapshotCatalog(
  options: {
    fetch?: Fetch;
    pageSize?: number;
    maxPages?: number;
    startOffset?: number;
    timeoutMs?: number;
    maxDurationMs?: number;
  } = {},
): Promise<{
  fetchedAt: string;
  source: string;
  resources: unknown[];
  pages: number;
  reportedTotal: number;
  nextOffset: number;
  complete: boolean;
  reasons: string[];
}> {
  const pageSize = options.pageSize ?? 100;
  const maxPages = options.maxPages ?? 5;
  let offset = options.startOffset ?? 0;
  if (
    !Number.isInteger(pageSize) ||
    pageSize < 1 ||
    pageSize > 100 ||
    !Number.isInteger(maxPages) ||
    maxPages < 1 ||
    maxPages > 200 ||
    !Number.isInteger(offset) ||
    offset < 0
  )
    throw new Error('Invalid bounded pagination options');
  const resources: unknown[] = [];
  const reasons: string[] = [];
  let pages = 0;
  let reportedTotal = 0;
  let snapshotBytes = 0;
  let firstTotal: number | undefined;
  const startedAt = Date.now();
  const maxDurationMs = options.maxDurationMs ?? 120_000;
  if (!Number.isFinite(maxDurationMs) || maxDurationMs < 100 || maxDurationMs > 240_000)
    throw new Error('Snapshot duration must be 100–240000 ms');
  while (pages < maxPages) {
    if (Date.now() - startedAt >= maxDurationMs) {
      reasons.push('time_limit_reached');
      break;
    }
    const url = new URL(`${CDP_BAZAAR}/discovery/resources`);
    url.searchParams.set('limit', String(pageSize));
    url.searchParams.set('offset', String(offset));
    const page = await readCatalog(
      url,
      options.fetch ?? globalThis.fetch,
      options.timeoutMs ?? 10000,
    );
    const pagination = object(page.pagination);
    if (
      !Array.isArray(page.items) ||
      !Number.isInteger(pagination.total) ||
      !Number.isInteger(pagination.offset) ||
      !Number.isInteger(pagination.limit)
    )
      throw new Error('Malformed CDP pagination');
    const returnedOffset = pagination.offset as number;
    const returnedLimit = pagination.limit as number;
    reportedTotal = pagination.total as number;
    if (
      returnedOffset !== offset ||
      returnedLimit < 1 ||
      page.items.length > returnedLimit ||
      reportedTotal < 0
    )
      throw new Error('CDP pagination contradicts requested offset or returned page');
    snapshotBytes += Buffer.byteLength(JSON.stringify(page.items));
    if (snapshotBytes > 64 * 1024 * 1024) {
      reasons.push('snapshot_size_limit_reached');
      break;
    }
    firstTotal ??= reportedTotal;
    if (reportedTotal !== firstTotal && !reasons.includes('catalog_total_changed'))
      reasons.push('catalog_total_changed');
    resources.push(...page.items);
    pages += 1;
    offset += returnedLimit;
    if (offset >= reportedTotal) break;
    if (page.items.length < returnedLimit) {
      reasons.push('short_page_before_end');
      break;
    }
  }
  if (offset < reportedTotal) reasons.push('page_limit_reached');
  if ((options.startOffset ?? 0) !== 0) reasons.push('resumed_partial_snapshot');
  return {
    fetchedAt: new Date().toISOString(),
    source: CDP_BAZAAR,
    resources,
    pages,
    reportedTotal,
    nextOffset: offset,
    complete: reasons.length === 0 && resources.length === reportedTotal,
    reasons,
  };
}
