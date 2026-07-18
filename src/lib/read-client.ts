import { z } from 'zod';
import { decodePaymentRequiredHeader, decodePaymentResponseHeader } from '@x402/core/http';
import type { PaymentRequired } from '@x402/core/types';
import { CliError } from './errors';
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
 * `X-Tenjin-Client` always and `X-Tenjin-Lookup-Id` when a lookup preceded the buy.
 */

const PAYMENT_REQUIRED_HEADER = 'PAYMENT-REQUIRED';
const PAYMENT_RESPONSE_HEADER = 'PAYMENT-RESPONSE';

// id/slug become filesystem path segments (the local library), so they are
// validated as a uuid + the server's slug charset HERE, at the trust boundary, so
// a hostile id='../../evil' or slug fails as CONTRACT_MISMATCH before delivery.
const RESOURCE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

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
  /** Attribute a following purchase to the lookup that surfaced it. */
  lookupId?: string;
}

export async function fetchRead(url: string, opts: ReadRequestOptions): Promise<ReadResult> {
  const headers: Record<string, string> = {
    accept: 'application/json',
    'x-tenjin-client': CLIENT_HEADER,
  };
  if (opts.lookupId !== undefined) headers['x-tenjin-lookup-id'] = opts.lookupId;
  if (opts.siwxHeader !== undefined) headers[SIWX_HEADER] = opts.siwxHeader;
  if (opts.paymentHeaders !== undefined) Object.assign(headers, opts.paymentHeaders);

  const res = await httpRequest(url, {
    method: 'GET',
    timeoutMs: opts.timeoutMs,
    headers,
    fetchImpl: opts.fetchImpl,
  });
  if (!res.ok) {
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
    let paymentRequired: PaymentRequired;
    try {
      paymentRequired = decodePaymentRequiredHeader(encoded);
    } catch (err) {
      throw new CliError('CONTRACT_MISMATCH', 'Could not decode the PAYMENT-REQUIRED header', {
        fix: 'Update tenjin-cli; the x402 header format may have changed.',
        cause: err,
      });
    }
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
