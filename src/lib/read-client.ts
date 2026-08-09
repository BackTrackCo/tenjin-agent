import { z } from 'zod';
import { decodePaymentRequiredHeader, decodePaymentResponseHeader } from '@x402/core/http';
import type { PaymentRequired, SettleResponse } from '@x402/core/types';
import { CliError } from './errors';
import { rateLimitError } from './agent-api';
import { httpRequest } from './http';
import { SIWX_HEADER } from './siwx';

/**
 * The read-route (`GET /api/read/<handle>/<slug>`) client, always JSON/x402, so
 * it is the robust agent target (llms-full). It surfaces the three outcomes the
 * buy flow branches on: `entitled` (200 with the full body, free post, SIWX
 * re-read, or freshly paid), `payment_required` (402 with the decoded
 * PAYMENT-REQUIRED header + the leak-safe preview body), and `already_purchased`
 * (409 owned-re-pay gate, nothing charged). Purchase attribution rides the
 * shared transport's User-Agent always and `X-Tenjin-Search-Id` when a search
 * preceded the buy.
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

/**
 * The public half of the piece's answer card, carried on the 402 body when the
 * piece has one. The key is ABSENT (never null) on an uncarded piece, so callers
 * branch on presence; the projection emits every field whenever it emits the card
 * at all, so a present card is never partial. Nullable fields carry null.
 *
 * This is the depth half of the search/inspect split: the card left the search
 * candidate in search v2 and lives here, one free unpaid GET away.
 */
export const previewCardSchema = z
  .object({
    artifactType: z.string(),
    temporalMode: z.string(),
    asOf: z.string().nullable(),
    validUntil: z.string().nullable(),
    questionsAnswered: z.array(z.string()),
    tasksSupported: z.array(z.string()),
    appliesTo: z.record(z.string(), z.array(z.string())),
    scope: z.string().nullable(),
    exclusions: z.string().nullable(),
    provenanceSummary: z.string().nullable(),
    methodologySummary: z.string().nullable(),
    maintenanceCadence: z.string().nullable(),
  })
  .passthrough();

export type PreviewCard = z.infer<typeof previewCardSchema>;

/** The leak-safe 402 preview body, never the paid content. */
const previewSchema = z
  .object({
    id: z.string().optional(),
    title: z.string().optional(),
    price: z.string().optional(),
    creator: z.record(z.string(), z.unknown()).optional(),
    // `.catch` keeps a botched card from taking the rest of the preview with it:
    // every other preview field is optional, so before the card existed a parse
    // failure here was near-impossible, and a server that half-fills the card
    // should still not cost the caller the title and the price it came for.
    // The drop is NOT silent: see `cardError` on the result below.
    card: previewCardSchema.optional().catch(undefined),
    // Set by the SERVER when the piece has a card it could not load, so an absent
    // card is never ambiguous: no flag means uncarded, this flag means temporarily
    // unreadable. Never false and never sent beside `card` (tenjin#500), and the
    // same fail-soft as above so a bogus `false` drops the flag rather than the
    // whole preview.
    cardUnavailable: z.literal(true).optional().catch(undefined),
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
  | {
      kind: 'entitled';
      body: ReadBody;
      settlementTxHash?: string;
      /** Full canonical x402 receipt, retained for the MCP transport metadata. */
      settlementResponse?: SettleResponse;
    }
  | {
      kind: 'payment_required';
      paymentRequired: PaymentRequired;
      preview: Preview;
      /** The 402 carried a `card` this CLI could not parse, so `preview.card` is
       *  absent for a reason that is NOT "the piece is uncarded". The two must
       *  stay distinguishable: an uncarded piece is a real signal a buyer acts
       *  on, and this 402 is the only pre-purchase depth there is. */
      cardError?: true;
    }
  | { kind: 'already_purchased'; message: string };

/**
 * The extra outcome a SESSION-SIGNED read can have: a 401 saying the delegation is
 * expired, revoked, or bound to a key this server will not accept.
 *
 * It is a value rather than a thrown API_UNREACHABLE because the caller has a
 * defined answer for it — `read` falls to its ordinary exit-3 refusal, never a
 * retry loop, because re-establishing needs a wallet it cannot reach. And it is
 * kept OUT of `ReadResult` because an unsigned or SIWX 401 has no such contract:
 * widening the shared union would make `buy` and `inspect` branch on a state they
 * can never produce, and a "cannot happen" branch is where wrong handling hides.
 */
export type SessionReadResult = ReadResult | { kind: 'session_rejected'; code?: string };

export interface ReadRequestOptions {
  timeoutMs: number;
  fetchImpl?: typeof fetch;
  /** A `SIGN-IN-WITH-X` header for the entitled free re-read. */
  siwxHeader?: string;
  /** The `PAYMENT-SIGNATURE` header(s) for a paid request. */
  paymentHeaders?: Record<string, string>;
  /**
   * RFC 9421 session-key headers (`Tenjin-Session-Delegation`, `Signature-Input`,
   * `Signature`) proving an entitlement without a wallet and without paying. A
   * bodyless GET carries no `Content-Digest`, so the covered set is method+URI.
   */
  sessionHeaders?: Record<string, string>;
  /** Attribute a following purchase to the search that surfaced it. */
  searchId?: string;
}

/**
 * One transport, two result types, selected by whether the caller actually
 * presented a session key. The `session_rejected` arm is reachable only when
 * `sessionHeaders` were sent, so the overloads say exactly that instead of
 * leaving every caller to prove it by inspection.
 */
export async function fetchRead(
  url: string,
  opts: ReadRequestOptions & { sessionHeaders: Record<string, string> },
): Promise<SessionReadResult>;
export async function fetchRead(url: string, opts: ReadRequestOptions): Promise<ReadResult>;
export async function fetchRead(url: string, opts: ReadRequestOptions): Promise<SessionReadResult> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (opts.searchId !== undefined) headers['x-tenjin-search-id'] = opts.searchId;
  if (opts.siwxHeader !== undefined) headers[SIWX_HEADER] = opts.siwxHeader;
  if (opts.sessionHeaders !== undefined) Object.assign(headers, opts.sessionHeaders);
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
        // The origin half of this hint deliberately does NOT name the base-URL
        // flag. `read` is meant to be allowlistable, the skill tells the agent
        // never to pass that flag on an allowlisted verb, and a `fix:` naming it
        // would coach exactly the move the skill forbids. `doctor` is the
        // allowlisted verb that owns the question — its `checkReadPath` probes
        // this route and its own copy names the config command when it should.
        fix:
          'Ask for the URL in the spelling `tenjin search` or `tenjin inspect` ' +
          'reports. If every read hops, `tenjin doctor` checks the configured origin.',
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
      ...(settlement !== undefined
        ? {
            settlementResponse: settlement,
            ...(typeof settlement.transaction === 'string'
              ? { settlementTxHash: settlement.transaction }
              : {}),
          }
        : {}),
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
          fix: 'Update tenjin-cli, or check the configured base URL (`tenjin config get baseUrl`) points at a Tenjin deployment.',
          details: validated.error.issues,
        },
      );
    }
    const paymentRequired = decoded;
    const parsed = previewSchema.safeParse(res.json);
    const preview = parsed.success ? parsed.data : {};
    return {
      kind: 'payment_required',
      paymentRequired,
      preview,
      ...(sentUnparsableCard(res.json, preview) ? { cardError: true as const } : {}),
    };
  }

  // Narrow on purpose: only a request that actually presented a session key gets
  // the soft outcome. Widening this to every 401 would quietly turn buy's SIWX
  // re-check failure into a value the caller has to remember to branch on.
  if (res.status === 401 && opts.sessionHeaders !== undefined) {
    const code = readCode(res.json);
    return { kind: 'session_rejected', ...(code !== undefined ? { code } : {}) };
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

/** The server sent a `card` key but nothing survived the parse. Distinguishes a
 *  DROPPED card from an absent one, which the `.catch` above otherwise makes
 *  look identical. */
function sentUnparsableCard(json: unknown, preview: Preview): boolean {
  if (typeof json !== 'object' || json === null) return false;
  return 'card' in json && preview.card === undefined;
}

function decodeSettlement(header: string | undefined): SettleResponse | undefined {
  if (header === undefined) return undefined;
  try {
    return decodePaymentResponseHeader(header);
  } catch {
    return undefined;
  }
}

/** The server's machine `code` on an auth failure (`session_expired`, …), if any. */
function readCode(json: unknown): string | undefined {
  if (typeof json !== 'object' || json === null) return undefined;
  const code = (json as Record<string, unknown>).code;
  return typeof code === 'string' ? code : undefined;
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
