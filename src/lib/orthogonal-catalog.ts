import { z } from 'zod';
import { boundedJson } from './bazaar';

export const ORTHOGONAL_CATALOG_URL = 'https://api.orthogonal.com/discover';
const RESULT_LIMIT = 20;

const endpointSchema = z.object({
  name: z.string().nullish(),
  path: z.string().optional(),
  description: z.string().optional(),
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']),
  price: z.union([z.string(), z.number().finite().nonnegative()]).nullish(),
  queryParams: z.array(z.unknown()).optional(),
  bodyParams: z.array(z.unknown()).optional(),
  bodyType: z.string().nullish(),
  payment: z
    .object({
      x402: z
        .object({ url: z.url(), chain: z.string().optional(), token: z.string().optional() })
        .nullish(),
    })
    .nullish(),
});
const apiSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  endpoints: z.array(z.unknown()),
});
const catalogSchema = z.object({
  success: z.literal(true),
  apis: z.array(z.unknown()),
  pagination: z.object({ hasMore: z.boolean() }).optional(),
});

export interface CatalogEndpoint {
  url: string;
  name: string;
  description?: string;
  method?: string;
  advertisedPrice?: string | number;
  payment?: unknown;
  input?: unknown;
}

export interface OrthogonalCatalog {
  source: 'orthogonal';
  via: string;
  endpoints: CatalogEndpoint[];
  partial: boolean;
  errors: string[];
}

function orthogonalUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    return (
      url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      ['x402.orthogonal.com', 'x402.orth.sh'].includes(url.hostname)
    );
  } catch {
    return false;
  }
}

/** Local keyword ranking over metadata, never a provider execution request. */
function shortlist(rows: CatalogEndpoint[], query: string): CatalogEndpoint[] {
  const words = [...new Set(query.toLowerCase().match(/[a-z0-9]{2,}/g) ?? [])];
  const seen = new Set<string>();
  return rows
    .map((row) => ({
      row,
      score: words.reduce(
        (score, word) =>
          score +
          (row.name.toLowerCase().includes(word) ? 3 : 0) +
          (`${row.description ?? ''} ${row.url}`.toLowerCase().includes(word) ? 1 : 0),
        0,
      ),
    }))
    .filter(({ row, score }) => {
      const key = `${row.method ?? ''} ${row.url}`;
      if (seen.has(key) || (words.length > 0 && score === 0)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => b.score - a.score)
    .map(({ row }) => row);
}

/** Only the manual discover command calls these catalogs; no hook imports it. */
export async function searchOrthogonal(
  query: string,
  timeoutMs: number,
): Promise<OrthogonalCatalog> {
  const out: OrthogonalCatalog = {
    source: 'orthogonal',
    via: ORTHOGONAL_CATALOG_URL,
    endpoints: [],
    partial: false,
    errors: [],
  };
  try {
    const response = await fetch(ORTHOGONAL_CATALOG_URL, {
      headers: { accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`Catalog answered ${response.status}`);
    }
    const catalog = catalogSchema.parse(await boundedJson(response));
    const rows: CatalogEndpoint[] = [];
    let malformed = false;
    for (const raw of catalog.apis) {
      const api = apiSchema.safeParse(raw);
      if (!api.success) {
        malformed = true;
        continue;
      }
      for (const rawEndpoint of api.data.endpoints) {
        const parsed = endpointSchema.safeParse(rawEndpoint);
        if (!parsed.success) {
          malformed = true;
          continue;
        }
        const endpoint = parsed.data;
        const payment = endpoint.payment?.x402;
        if (!payment) continue;
        if (!orthogonalUrl(payment.url)) {
          malformed = true;
          continue;
        }
        rows.push({
          url: payment.url,
          method: endpoint.method,
          name: `${api.data.name}: ${endpoint.name ?? endpoint.path ?? new URL(payment.url).pathname}`,
          description: [api.data.description, endpoint.description].filter(Boolean).join(' '),
          ...(endpoint.price != null ? { advertisedPrice: endpoint.price } : {}),
          payment,
          input: {
            queryParams: endpoint.queryParams,
            bodyParams: endpoint.bodyParams,
            bodyType: endpoint.bodyType,
          },
        });
      }
    }
    const matches = shortlist(rows, query);
    out.endpoints = matches.slice(0, RESULT_LIMIT);
    out.partial =
      catalog.pagination?.hasMore === true || matches.length > RESULT_LIMIT || malformed;
    if (catalog.pagination?.hasMore)
      out.errors.push('Catalog has additional pages; coverage is partial');
    if (malformed) out.errors.push('Catalog skipped malformed records');
  } catch (err) {
    out.partial = true;
    out.errors.push(err instanceof Error ? err.message : String(err));
  }
  return out;
}
