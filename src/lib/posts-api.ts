import { z } from 'zod';
import { CliError } from './errors';
import { httpRequest, type HttpResponse, type HttpResult } from './http';
import { CLIENT_HEADER } from './client-meta';
import { rateLimitError } from './agent-api';
import type { ResourceCardInput } from './card';
import type { WriteAuth } from './session-key';

/**
 * The `POST /api/posts` publish contract (A3, tenjin#382). Request building and
 * response validation live here; the wire shape is validated defensively and an
 * unknown shape degrades to a CONTRACT_MISMATCH rather than a guess — the same
 * discipline as agent-api.ts, which this models. Both `POST /api/posts` and
 * `PUT /api/posts/<id>` are `z.strictObject` server-side, so the body carries
 * ONLY the fields below; `cacheEligible`/`schemaVersion` are server-owned and
 * never sent. Every write is signed through the injected WriteAuth (session key
 * by default, plain SIWX as a fallback); a 401 is recovered per the auth's rules.
 */

export type PublishStatus = 'draft' | 'published' | 'unlisted';

export interface PublishInput {
  title?: string;
  bodyMd?: string;
  excerpt?: string;
  tags?: string[];
  /** Atomic USDC digit string (converted from the decimal-USD edge upstream). */
  priceAtomic?: string;
  /** First-post-only word-handle claim (POST only). */
  handle?: string;
  status: PublishStatus;
  resource?: ResourceCardInput;
}

/** The exact strictObject body sent to POST /api/posts (defined keys only). */
export interface PostCreateBody {
  title?: string;
  bodyMd?: string;
  excerpt?: string;
  tags?: string[];
  price?: string;
  handle?: string;
  status?: PublishStatus;
  resource?: ResourceCardInput;
}

const PRICE_RE = /^(0|[1-9]\d{0,12})$/;
const HANDLE_RE = /^[a-z0-9-]{2,32}$/;

/**
 * Assemble + locally validate the create body against the server's bounds so a
 * malformed post fails as USAGE (exit 2) before any network round trip. A
 * non-draft publish requires a title AND body; a draft may omit either.
 */
export function buildPostCreateBody(input: PublishInput): PostCreateBody {
  const isDraft = input.status === 'draft';
  const title = input.title?.trim();
  const bodyMd = input.bodyMd;

  if (!isDraft && (title === undefined || title.length === 0)) {
    throw new CliError('USAGE', 'A published post needs a title.', {
      fix: 'Add a `title:` to the frontmatter or a leading `# Heading`, or pass --draft.',
    });
  }
  if (!isDraft && (bodyMd === undefined || bodyMd.trim().length === 0)) {
    throw new CliError('USAGE', 'A published post needs a body.', {
      fix: 'Add Markdown below the frontmatter, or pass --draft.',
    });
  }
  if (title !== undefined && title.length > 200) {
    throw new CliError('USAGE', 'title must be at most 200 characters.');
  }
  if (bodyMd !== undefined && bodyMd.length > 200_000) {
    throw new CliError('USAGE', 'bodyMd must be at most 200000 characters.');
  }
  if (input.excerpt !== undefined && input.excerpt.length > 500) {
    throw new CliError('USAGE', 'excerpt must be at most 500 characters.');
  }
  if (input.tags !== undefined) {
    if (input.tags.length > 5) throw new CliError('USAGE', 'at most 5 tags.');
    for (const tag of input.tags) {
      if (tag.length === 0 || tag.length > 50) {
        throw new CliError('USAGE', 'each tag is 1 to 50 characters.');
      }
    }
  }
  if (input.priceAtomic !== undefined && !PRICE_RE.test(input.priceAtomic)) {
    throw new CliError('USAGE', `Invalid price: ${JSON.stringify(input.priceAtomic)}`, {
      fix: 'A price is an atomic USDC integer up to 13 digits, e.g. 100000 for $0.10.',
    });
  }
  if (input.handle !== undefined && !HANDLE_RE.test(input.handle)) {
    throw new CliError('USAGE', `Invalid handle: ${JSON.stringify(input.handle)}`, {
      fix: 'A handle is 2 to 32 chars of a-z, 0-9, or hyphen.',
    });
  }

  return {
    ...(title !== undefined && title.length > 0 ? { title } : {}),
    ...(bodyMd !== undefined ? { bodyMd } : {}),
    ...(input.excerpt !== undefined ? { excerpt: input.excerpt } : {}),
    ...(input.tags !== undefined && input.tags.length > 0 ? { tags: input.tags } : {}),
    ...(input.priceAtomic !== undefined ? { price: input.priceAtomic } : {}),
    ...(input.handle !== undefined ? { handle: input.handle } : {}),
    status: input.status,
    ...(input.resource !== undefined ? { resource: input.resource } : {}),
  };
}

// The response echo. `.passthrough()` keeps unknown future fields; the CLI reads
// only what the receipt needs. cacheEligibleMissing is authoritative for "what to
// fix" (the stored cacheEligible boolean can lag a rubric change, per spec 09).
const resourceEchoSchema = z
  .object({
    cacheEligible: z.boolean(),
    cacheEligibleMissing: z.array(z.string()),
  })
  .passthrough();

const ownPostSchema = z
  .object({
    id: z.string(),
    slug: z.string(),
    title: z.string(),
    status: z.string(),
    price: z.string(),
    url: z.string(),
    warnings: z.array(z.string()).optional(),
    resource: resourceEchoSchema.optional(),
  })
  .passthrough();

export interface PublishResult {
  resourceId: string;
  slug: string;
  title: string;
  status: string;
  priceAtomic: string;
  url: string;
  /** Present only when a card was sent (and echoed). */
  cacheEligible?: boolean;
  cacheEligibleMissing: string[];
  /** Server-dropped external image refs (spec: owned-uploads-only). */
  warnings: string[];
}

export interface PublishClientOptions {
  baseUrl: string;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
}

/** Bounded 401 recovery: the initial attempt plus at most this many re-signs. */
const MAX_RECOVERIES = 3;

function trimSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

/**
 * Create + publish a post. Signs each attempt through `auth`; on a 401 it reads
 * the failure code and asks `auth` whether a retry is worthwhile (a stale
 * per-request signature re-signs; an expired delegation re-establishes with one
 * wallet signature; an unbound key does not retry), bounded so a server that
 * always 401s cannot loop.
 */
export async function publishPost(
  input: PublishInput,
  auth: WriteAuth,
  opts: PublishClientOptions,
): Promise<PublishResult> {
  const body = buildPostCreateBody(input);
  const url = `${trimSlash(opts.baseUrl)}/api/posts`;
  // One serialization used for BOTH the Content-Digest and the wire bytes, so the
  // signed digest covers exactly what is sent.
  const bodyStr = JSON.stringify(body);

  let recoveries = 0;
  for (;;) {
    const authHeaders = await auth.headersFor({ method: 'POST', url, body: bodyStr });
    const res = await httpRequest(url, {
      method: 'POST',
      timeoutMs: opts.timeoutMs,
      headers: { 'x-tenjin-client': CLIENT_HEADER, ...authHeaders },
      jsonBody: body,
      ...(opts.fetchImpl !== undefined ? { fetchImpl: opts.fetchImpl } : {}),
    });
    if (!res.ok) throw writeTransportError(url, res);

    if (res.status === 401 && recoveries < MAX_RECOVERIES) {
      const code = auth401Code(res);
      if (await auth.recover(code)) {
        recoveries++;
        continue;
      }
      throw authError(code, res);
    }
    if (res.status === 401) throw authError(auth401Code(res), res);
    if (res.status === 429) throw rateLimitError(url, (n) => res.header(n));
    if (res.status !== 201 && res.status !== 200) throw publishFailed(res);

    const parsed = ownPostSchema.safeParse(res.json);
    if (!parsed.success) {
      throw new CliError('CONTRACT_MISMATCH', 'The publish response did not match the contract.', {
        fix: 'Update tenjin-cli; the server contract may have changed.',
        details: parsed.error.issues,
      });
    }
    const post = parsed.data;
    return {
      resourceId: post.id,
      slug: post.slug,
      title: post.title,
      status: post.status,
      priceAtomic: post.price,
      url: post.url,
      ...(post.resource !== undefined ? { cacheEligible: post.resource.cacheEligible } : {}),
      cacheEligibleMissing: post.resource?.cacheEligibleMissing ?? [],
      warnings: post.warnings ?? [],
    };
  }
}

/** The 401 failure code, from WWW-Authenticate `error="..."` then the body code. */
function auth401Code(res: HttpResponse): string | undefined {
  const header = res.header('www-authenticate');
  const m = header !== undefined ? /error="([^"]+)"/.exec(header) : null;
  if (m?.[1] !== undefined) return m[1];
  return bodyErrorCode(res.json);
}

function bodyErrorCode(json: unknown): string | undefined {
  if (typeof json === 'object' && json !== null) {
    const err = (json as { error?: unknown }).error;
    if (typeof err === 'object' && err !== null) {
      const code = (err as { code?: unknown }).code;
      if (typeof code === 'string') return code;
    }
  }
  return undefined;
}

function serverMessage(json: unknown): string | undefined {
  if (typeof json === 'object' && json !== null) {
    const err = (json as { error?: unknown }).error;
    if (typeof err === 'object' && err !== null) {
      const m = (err as { message?: unknown }).message;
      if (typeof m === 'string') return m;
    }
  }
  return undefined;
}

function authError(code: string | undefined, res: HttpResponse): CliError {
  return new CliError(
    'PUBLISH_FAILED',
    serverMessage(res.json) ?? `Publish was not authorized (${code ?? '401'}).`,
    {
      fix:
        code === 'session_key_unbound'
          ? 'Delete ~/.tenjin/session.json to re-establish the session key.'
          : 'Check the wallet and retry.',
      details: {
        code: code ?? 'unauthorized',
        ...(res.json !== undefined ? { server: res.json } : {}),
      },
    },
  );
}

/** Any non-recoverable non-2xx after approval is a write failure (exit 4). */
function publishFailed(res: HttpResponse): CliError {
  return new CliError(
    'PUBLISH_FAILED',
    serverMessage(res.json) ?? `Publish failed (${res.status}).`,
    {
      fix: 'Review the server error, then re-run `tenjin publish`.',
      details: { status: res.status, ...(res.json !== undefined ? { server: res.json } : {}) },
    },
  );
}

/** A transport/timeout failure never reached the write; a network-class error. */
function writeTransportError(url: string, result: Exclude<HttpResult, { ok: true }>): CliError {
  const code =
    result.kind === 'network' || result.kind === 'timeout' ? 'NETWORK_ERROR' : 'API_UNREACHABLE';
  return new CliError(code, `${url}: ${result.message}`, {
    fix: 'Check --base-url and your network, then retry.',
  });
}
