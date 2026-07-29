import { z } from 'zod';
import { decodePaymentRequiredHeader, decodePaymentResponseHeader } from '@x402/core/http';
import type { PaymentRequired } from '@x402/core/types';
import { CliError } from './errors';
import { rateLimitError } from './agent-api';
import { httpRequest } from './http';
import { CLIENT_HEADER } from './client-meta';
import { SIWX_HEADER } from './siwx';

/**
 * The read-route (`GET /api/read/<handle>/<slug>`) client, always JSON/x402, so
 * it is the robust agent target (llms-full). It surfaces the three outcomes the
 * buy flow branches on: `entitled` (200 with the full body, free post, SIWX
 * re-read, or freshly paid), `payment_required` (402 with the decoded
 * PAYMENT-REQUIRED header + the leak-safe preview body), and `already_purchased`
 * (409 owned-re-pay gate, nothing charged). Purchase attribution rides
 * `X-Tenjin-Client` always and `X-Tenjin-Search-Id` when a search preceded the buy.
 */

const PAYMENT_REQUIRED_HEADER = 'PAYMENT-REQUIRED';
const PAYMENT_RESPONSE_HEADER = 'PAYMENT-RESPONSE';

// id/slug become filesystem path segments (the local library), so they are
// validated as a uuid + the server's slug charset HERE, at the trust boundary, so
// a hostile id='../../evil' or slug fails as CONTRACT_MISMATCH before delivery.
import { SLUG_RE, UUID_RE as RESOURCE_ID_RE } from './ids';

/** The full essay body a 200 returns (loose: require what the CLI reads, keep the rest). */
const readBodySchema = z
  .object({
    id: z.string().regex(RESOURCE_ID_RE, 'resource id must be a uuid'),
    slug: z.string().regex(SLUG_RE, 'unsafe slug').max(80),
    title: z.string(),
    bodyMd: z.string(),
    price: z.string(),
    creator: z
      .object({
        handle: z.string().nullish(),
        walletAddress: z.string().nullish(),
      })
      .passthrough(),
  })
  .passthrough();

export type ReadBody = z.infer<typeof readBodySchema>;

/** The leak-safe 402 preview body, never the paid content. */
const previewSchema = z
  .object({
    id: z.string().optional(),
    title: z.string().optional(),
    price: z.string().optional(),
    creator: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();

export type Preview = z.infer<typeof previewSchema>;

// The decoded PAYMENT-REQUIRED is money-path input: validate the fields the pay
// path consumes (amount as an atomic integer, CAIP-2 network, 0x asset/payTo)
// at THIS boundary instead of trusting raw base64 JSON. Loose otherwise so new
// server fields never break an older CLI.
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const paymentRequiredSchema = z
  .object({
    x402Version: z.literal(2),
    accepts: z.array(
      z
        .object({
          scheme: z.string(),
          network: z.string().regex(/^eip155:\d+$/, 'network must be CAIP-2 eip155'),
          asset: z.string().regex(ADDRESS_RE, 'asset must be a 0x address'),
          amount: z.string().regex(/^\d{1,39}$/, 'amount must be an atomic integer string'),
          payTo: z.string().regex(ADDRESS_RE, 'payTo must be a 0x address'),
        })
        .passthrough(),
    ),
  })
  .passthrough();

export type ReadResult =
  | { kind: 'entitled'; body: ReadBody; settlementTxHash?: string }
  | { kind: 'payment_required'; paymentRequired: PaymentRequired; preview: Preview }
  | { kind: 'already_purchased'; message: string };

export interface ReadRequestOptions {
  timeoutMs: number;
  fetchImpl?: typeof fetch;
  /** A `SIGN-IN-WITH-X` header for the entitled free re-read. */
  siwxHeader?: string;
  /** The `PAYMENT-SIGNATURE` header(s) for a paid request. */
  paymentHeaders?: Record<string, string>;
  /** Attribute a following purchase to the search that surfaced it. */
  searchId?: string;
}

export async function fetchRead(url: string, opts: ReadRequestOptions): Promise<ReadResult> {
  const headers: Record<string, string> = {
    accept: 'application/json',
    'x-tenjin-client': CLIENT_HEADER,
  };
  if (opts.searchId !== undefined) headers['x-tenjin-search-id'] = opts.searchId;
  if (opts.siwxHeader !== undefined) headers[SIWX_HEADER] = opts.siwxHeader;
  if (opts.paymentHeaders !== undefined) Object.assign(headers, opts.paymentHeaders);

  const res = await httpRequest(url, {
    method: 'GET',
    timeoutMs: opts.timeoutMs,
    headers,
    fetchImpl: opts.fetchImpl,
    // Pinned even when UNSIGNED (the first probe): a 200 from this route is
    // written to the library by `deliverFresh` as an entitlement record under
    // the server-chosen id/slug, and `findDeliveredByUrl` later matches saved
    // receipts by handle+slug alone — so a followed cross-origin redirect
    // would let another host's bytes short-circuit future buys as owned.
    // `assertOnBaseOrigin` cannot catch this; it checks only the URL asked for.
    //
    // Refused for ANY 3xx, same-origin hops included. The transport failing closed
    // on the whole class is the point: an exemption for "benign" redirects is a
    // second origin check living in the one place that already proved it cannot see
    // enough to make one. Keeping a canonical URL is the CALLER's job instead, and
    // `resolveResourceRef` does it for every verb that gets here.
    blockRedirects: true,
  });
  if (!res.ok) {
    // A redirect refused mid-flight is a URL-shape problem, not a flaky network:
    // retrying a signed request re-sends the same signature into the same
    // redirect, and retrying the unsigned probe re-fetches bytes the library must
    // never record as this origin's. The `fix` names the URL, not the route: the
    // route is allowed to redirect (canonicalizing a path is what a redirect is
    // FOR), and pointing an agent at the base URL for a hop the base URL did not
    // cause spends two useless steps and still does not read the piece.
    // `resolveResourceRef` canonicalizes what it can (the trailing slash); what
    // reaches here is a spelling it could not.
    if (res.kind === 'blocked-redirect') {
      throw new CliError('CONTRACT_MISMATCH', `${url}: ${res.message}`, {
        fix:
          'A redirect is never followed here, so nothing was read and retrying this ' +
          'exact URL will answer the same. The route is not broken: this is what a ' +
          'non-canonical URL looks like. Ask for the URL in the spelling the read ' +
          'route serves (the form a `tenjin search` candidate or `tenjin inspect` ' +
          'reports), and check that --base-url names the origin that answers without ' +
          'a hop of its own (http where the deployment serves https, or an apex host ' +
          'it sends to www).',
      });
    }
    const code =
      res.kind === 'network' || res.kind === 'timeout' ? 'NETWORK_ERROR' : 'API_UNREACHABLE';
    throw new CliError(code, `${url}: ${res.message}`, {
      fix: 'Check the resource URL and your network, then retry.',
    });
  }

  if (res.status === 200) {
    const parsed = readBodySchema.safeParse(res.json);
    if (!parsed.success) {
      throw new CliError(
        'CONTRACT_MISMATCH',
        'The read response did not match the expected contract',
        {
          fix: 'Update tenjin-cli; the read contract may have changed.',
          details: parsed.error.issues,
        },
      );
    }
    const settlement = decodeSettlement(res.header(PAYMENT_RESPONSE_HEADER));
    return {
      kind: 'entitled',
      body: parsed.data,
      ...(settlement !== undefined ? { settlementTxHash: settlement } : {}),
    };
  }

  if (res.status === 402) {
    const encoded = res.header(PAYMENT_REQUIRED_HEADER);
    if (encoded === undefined) {
      throw new CliError('CONTRACT_MISMATCH', 'The 402 carried no PAYMENT-REQUIRED header', {
        fix: 'The server may be misconfigured; try another resource or update tenjin-cli.',
      });
    }
    let decoded: PaymentRequired;
    try {
      decoded = decodePaymentRequiredHeader(encoded);
    } catch (err) {
      throw new CliError('CONTRACT_MISMATCH', 'Could not decode the PAYMENT-REQUIRED header', {
        fix: 'Update tenjin-cli; the x402 header format may have changed.',
        cause: err,
      });
    }
    const validated = paymentRequiredSchema.safeParse(decoded);
    if (!validated.success) {
      throw new CliError(
        'CONTRACT_MISMATCH',
        'The 402 challenge is not a valid x402 v2 payment declaration.',
        {
          fix: 'Update tenjin-cli, or check --base-url points at a Tenjin deployment.',
          details: validated.error.issues,
        },
      );
    }
    const paymentRequired = decoded;
    const preview = previewSchema.safeParse(res.json);
    return {
      kind: 'payment_required',
      paymentRequired,
      preview: preview.success ? preview.data : {},
    };
  }

  if (res.status === 409) {
    // The owned-re-pay gate: a payment for a post this wallet already bought is
    // refused, nothing charged. The caller falls back to a SIWX free re-read.
    return { kind: 'already_purchased', message: readMessage(res.json) ?? 'Already purchased.' };
  }

  if (res.status === 404) {
    throw new CliError('RESOURCE_NOT_FOUND', `No resource at ${url}`, {
      fix: 'Check the handle/slug or resource id.',
    });
  }

  // 429 on the paid-read path is a recoverable pause, not an outage: surface
  // RATE_LIMITED + retryAfterSeconds like postSearch/postOutcomes do, so a looping
  // agent (the caller most likely to hit this) can back off instead of treating it
  // as API_UNREACHABLE.
  if (res.status === 429) throw rateLimitError(url, (n) => res.header(n));

  throw new CliError(
    'API_UNREACHABLE',
    readMessage(res.json) ?? `Unexpected status ${res.status} from ${url}`,
    {
      fix: 'Retry; if it persists the resource may be unavailable.',
      details: res.json,
    },
  );
}

function decodeSettlement(header: string | undefined): string | undefined {
  if (header === undefined) return undefined;
  try {
    const settle = decodePaymentResponseHeader(header);
    const tx = (settle as { transaction?: unknown }).transaction;
    return typeof tx === 'string' ? tx : undefined;
  } catch {
    return undefined;
  }
}

function readMessage(json: unknown): string | undefined {
  if (typeof json === 'object' && json !== null) {
    const rec = json as Record<string, unknown>;
    if (typeof rec.message === 'string') return rec.message;
    if (typeof rec.error === 'string') return rec.error;
    if (typeof rec.code === 'string') return rec.code;
  }
  return undefined;
}
