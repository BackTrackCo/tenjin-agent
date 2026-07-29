import { z } from 'zod';
import { CliError } from './errors';
import { httpRequest, type HttpResponse, type HttpResult } from './http';
import { CLIENT_HEADER } from './client-meta';
import { rateLimitError } from './agent-api';
import { trimSlash } from './url';
import type { ResourceCardInput } from './card';
import type { WriteAuth } from './session-key';

/**
 * The owned-post contract: `POST /api/posts` (publish, A3 tenjin#382) plus the
 * owner-scoped `GET`/`PUT /api/posts/<id>` that `edit` reads and merges through.
 *
 * Request building and response validation both live here. The wire shape is
 * validated defensively, and an unknown shape degrades to a CONTRACT_MISMATCH
 * rather than a guess — the same discipline as agent-api.ts, which this models.
 * `POST /api/posts` and `PUT /api/posts/<id>` are each `z.strictObject`
 * server-side, so a body carries ONLY the fields declared below;
 * `cacheEligible`/`cacheEligibleMissing`/`schemaVersion` are server-owned and are
 * never sent. Every write is signed through the injected WriteAuth (a session key
 * by default, plain SIWX as the fallback), and a 401 is recovered per the auth's
 * own rules.
 */

/** The status vocabulary; the as-const source the PublishStatus union derives from. */
export const PUBLISH_STATUSES = ['draft', 'published', 'unlisted'] as const;
export type PublishStatus = (typeof PUBLISH_STATUSES)[number];

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
// A handle the server refuses beyond the charset rule: an address-shaped handle
// (0x-prefixed) collides with the address form of a creator, and `latest` is the
// reserved newest-post alias. The full reserved set is server-authoritative — a
// 400/409 still catches any others — but these two are documented and mirrored.
const RESERVED_HANDLES = new Set(['latest']);

/**
 * Assemble + locally validate the create body against the server's bounds so a
 * malformed post fails as USAGE (exit 2) before any network round trip. A
 * non-draft publish requires a title AND body; a draft needs at least one of the
 * two (an all-empty draft is refused, matching the server's superRefine).
 */
export function buildPostCreateBody(input: PublishInput): PostCreateBody {
  const isDraft = input.status === 'draft';
  const title = input.title?.trim();
  const bodyMd = input.bodyMd;
  const hasTitle = title !== undefined && title.length > 0;
  const hasBody = bodyMd !== undefined && bodyMd.trim().length > 0;

  if (isDraft && !hasTitle && !hasBody) {
    throw new CliError('USAGE', 'A draft needs a title or a body.', {
      fix: 'Add a `title:` or some Markdown; a completely empty draft is rejected.',
    });
  }
  if (!isDraft && !hasTitle) {
    throw new CliError('USAGE', 'A published post needs a title.', {
      fix: 'Add a `title:` to the frontmatter or a leading `# Heading`, or pass --draft.',
    });
  }
  if (!isDraft && !hasBody) {
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
  // Trimmed to match the server's `z.string().trim()`: sending " x" for a stored
  // "x" would otherwise look like a change on every run and never converge.
  const excerpt = input.excerpt?.trim();
  if (excerpt !== undefined && excerpt.length > 500) {
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
  if (input.handle !== undefined) {
    if (!HANDLE_RE.test(input.handle)) {
      throw new CliError('USAGE', `Invalid handle: ${JSON.stringify(input.handle)}`, {
        fix: 'A handle is 2 to 32 chars of a-z, 0-9, or hyphen.',
      });
    }
    if (input.handle.startsWith('0x') || RESERVED_HANDLES.has(input.handle)) {
      throw new CliError('USAGE', `Reserved handle: ${JSON.stringify(input.handle)}`, {
        fix: 'Pick a handle that is not 0x-prefixed and not a reserved word (e.g. latest).',
      });
    }
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
// The stored card values are typed leniently (nullish) because they are read, not
// sent: a server that starts omitting one must not turn a working read into a
// CONTRACT_MISMATCH. Only the two eligibility fields are demanded.
export const resourceEchoSchema = z
  .object({
    artifactType: z.string().nullish(),
    mediaType: z.string().nullish(),
    temporalMode: z.string().nullish(),
    asOf: z.string().nullish(),
    validUntil: z.string().nullish(),
    supersedesPostId: z.string().nullish(),
    questionsAnswered: z.array(z.string()).nullish(),
    tasksSupported: z.array(z.string()).nullish(),
    scope: z.string().nullish(),
    exclusions: z.string().nullish(),
    appliesTo: z.record(z.string(), z.array(z.string())).nullish(),
    provenanceSummary: z.string().nullish(),
    methodologySummary: z.string().nullish(),
    maintenanceCadence: z.string().nullish(),
    reproductionMinutes: z.number().nullish(),
    estimatedPaidInputCost: z.string().nullish(),
    cacheEligible: z.boolean(),
    cacheEligibleMissing: z.array(z.string()),
  })
  .passthrough();

export const ownPostSchema = z
  .object({
    id: z.string(),
    slug: z.string(),
    title: z.string(),
    status: z.string(),
    price: z.string(),
    url: z.string(),
    excerpt: z.string().nullish(),
    bodyMd: z.string().nullish(),
    tags: z.array(z.string()).nullish(),
    warnings: z.array(z.string()).optional(),
    resource: resourceEchoSchema.optional(),
  })
  .passthrough();

/** An owned post as POST/GET/PUT /api/posts[/id] return it (unknown keys kept). */
export type OwnPost = z.infer<typeof ownPostSchema>;
/** The stored answer card on an owned post. */
export type OwnPostCard = z.infer<typeof resourceEchoSchema>;

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

// ---------------------------------------------------------------------------
// The owner-scoped read + merge-update surface (`GET`/`PUT /api/posts/<id>`).
// ---------------------------------------------------------------------------

/**
 * The card as an update sends it: the create shape plus the explicit-null clears
 * the server's merge accepts on its nullable scalars. Containers clear with an
 * empty `[]`/`{}` rather than null, so their types are unchanged. Field-level
 * merge: an omitted key keeps the stored value, and an array REPLACES wholesale.
 */
export type ResourceCardUpdate = Omit<
  ResourceCardInput,
  | 'asOf'
  | 'validUntil'
  | 'supersedesPostId'
  | 'scope'
  | 'exclusions'
  | 'provenanceSummary'
  | 'methodologySummary'
  | 'maintenanceCadence'
  | 'reproductionMinutes'
  | 'estimatedPaidInputCost'
> & {
  asOf?: string | null;
  validUntil?: string | null;
  supersedesPostId?: string | null;
  scope?: string | null;
  exclusions?: string | null;
  provenanceSummary?: string | null;
  methodologySummary?: string | null;
  maintenanceCadence?: string | null;
  reproductionMinutes?: number | null;
  estimatedPaidInputCost?: string | null;
};

export interface PostUpdateInput {
  title?: string;
  bodyMd?: string;
  excerpt?: string;
  tags?: string[];
  /** Atomic USDC digit string (converted from the decimal-USD edge upstream). */
  priceAtomic?: string;
  status?: PublishStatus;
  resource?: ResourceCardUpdate;
}

/** The exact strictObject body sent to PUT /api/posts/<id> (defined keys only). */
export interface PostUpdateBody {
  title?: string;
  bodyMd?: string;
  excerpt?: string;
  tags?: string[];
  price?: string;
  status?: PublishStatus;
  resource?: ResourceCardUpdate;
}

/**
 * Assemble + locally validate the update body against the server's bounds, the
 * partial-update twin of buildPostCreateBody: every field is optional (an omitted
 * key keeps the stored value), so the create-only "a published post needs a title
 * and a body" rules do not apply — but an EMPTY title or body would blank a live
 * post, which the top-level fields cannot express a clear for, so both are refused
 * as USAGE. `handle` is create-only and has no PostUpdate counterpart.
 */
export function buildPostUpdateBody(input: PostUpdateInput): PostUpdateBody {
  const title = input.title?.trim();
  if (input.title !== undefined && (title === undefined || title.length === 0)) {
    throw new CliError('USAGE', 'title cannot be empty.', {
      fix: 'Pass a title, or omit --title to keep the stored one.',
    });
  }
  if (title !== undefined && title.length > 200) {
    throw new CliError('USAGE', 'title must be at most 200 characters.');
  }
  if (input.bodyMd !== undefined) {
    if (input.bodyMd.trim().length === 0) {
      throw new CliError('USAGE', 'bodyMd cannot be empty.', {
        fix: 'Pass a file with Markdown in it, or omit --body to keep the stored body.',
      });
    }
    if (input.bodyMd.length > 200_000) {
      throw new CliError('USAGE', 'bodyMd must be at most 200000 characters.');
    }
  }
  // Trimmed to match the server's `z.string().trim()`: sending " x" for a stored
  // "x" would otherwise look like a change on every run and never converge.
  const excerpt = input.excerpt?.trim();
  if (excerpt !== undefined && excerpt.length > 500) {
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

  const body: PostUpdateBody = {
    ...(title !== undefined ? { title } : {}),
    ...(input.bodyMd !== undefined ? { bodyMd: input.bodyMd } : {}),
    ...(excerpt !== undefined ? { excerpt } : {}),
    ...(input.tags !== undefined ? { tags: input.tags } : {}),
    ...(input.priceAtomic !== undefined ? { price: input.priceAtomic } : {}),
    ...(input.status !== undefined ? { status: input.status } : {}),
    ...(input.resource !== undefined ? { resource: input.resource } : {}),
  };
  // An empty PUT would burn a nonce to change nothing; the caller is expected to
  // route "no change flags" to the read path instead.
  if (Object.keys(body).length === 0) {
    throw new CliError('USAGE', 'Nothing to update.', {
      fix: 'Pass at least one field flag, or run `tenjin edit <postId>` with no flags to view the post.',
    });
  }
  return body;
}

/**
 * Read one of your own posts (`GET /api/posts/<id>`). Owner-scoped, so it is
 * signed through the same WriteAuth the writes use, but it is a READ: it sends no
 * body, burns no nonce, and its failures are runtime-class (exit 1), never the
 * post-approval write class.
 */
export async function getOwnPost(
  id: string,
  auth: WriteAuth,
  opts: PublishClientOptions,
): Promise<OwnPost> {
  const url = `${trimSlash(opts.baseUrl)}/api/posts/${encodeURIComponent(id)}`;

  let recoveries = 0;
  for (;;) {
    const authHeaders = await auth.headersFor({ method: 'GET', url });
    const res = await httpRequest(url, {
      method: 'GET',
      timeoutMs: opts.timeoutMs,
      headers: { accept: 'application/json', 'x-tenjin-client': CLIENT_HEADER, ...authHeaders },
      ...(opts.fetchImpl !== undefined ? { fetchImpl: opts.fetchImpl } : {}),
    });
    if (!res.ok) throw writeTransportError(url, res);

    if (res.status === 401 && recoveries < MAX_RECOVERIES) {
      const code = auth401Code(res);
      if (await auth.recover(code)) {
        recoveries++;
        continue;
      }
      throw readAuthError(code, res);
    }
    if (res.status === 401) throw readAuthError(auth401Code(res), res);
    if (res.status === 404) throw postNotFound(id);
    if (res.status === 429) throw rateLimitError(url, (n) => res.header(n));
    if (res.status !== 200) {
      throw new CliError(
        'API_UNREACHABLE',
        serverMessage(res.json) ?? `Could not read post ${id} (${res.status}).`,
        {
          fix: 'Review the server error, then retry.',
          details: { status: res.status, ...(res.json !== undefined ? { server: res.json } : {}) },
        },
      );
    }
    return parseOwnPost(res.json, 'read');
  }
}

/**
 * Merge-update one of your own posts (`PUT /api/posts/<id>`). Identical signing
 * and 401-recovery discipline to publishPost: every attempt is signed fresh,
 * because each PUT burns a single-use nonce.
 *
 * Failure posture is publish's with one deliberate exception. A rejected write
 * after the caller approved it is exit 4 (the settlement class), but a 404 is
 * exit 1: the post does not exist or is not ours, so the write definitively did
 * not land, and nothing about it is a half-completed operation.
 */
export async function updatePost(
  id: string,
  input: PostUpdateInput,
  auth: WriteAuth,
  opts: PublishClientOptions,
): Promise<OwnPost> {
  const body = buildPostUpdateBody(input);
  const url = `${trimSlash(opts.baseUrl)}/api/posts/${encodeURIComponent(id)}`;
  // One serialization for BOTH the Content-Digest and the wire bytes.
  const bodyStr = JSON.stringify(body);

  let recoveries = 0;
  for (;;) {
    const authHeaders = await auth.headersFor({ method: 'PUT', url, body: bodyStr });
    const res = await httpRequest(url, {
      method: 'PUT',
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
    if (res.status === 404) throw postNotFound(id);
    if (res.status === 429) throw rateLimitError(url, (n) => res.header(n));
    if (res.status !== 200) throw updateFailed(res);

    return parseOwnPost(res.json, 'update');
  }
}

function parseOwnPost(json: unknown, what: 'read' | 'update'): OwnPost {
  const parsed = ownPostSchema.safeParse(json);
  if (!parsed.success) {
    throw new CliError(
      'CONTRACT_MISMATCH',
      `The post ${what} response did not match the contract.`,
      {
        fix: 'Update tenjin-cli; the server contract may have changed.',
        details: parsed.error.issues,
      },
    );
  }
  return parsed.data;
}

/** 404 is deliberately ambiguous server-side (missing vs not yours); say both. */
function postNotFound(id: string): CliError {
  return new CliError('RESOURCE_NOT_FOUND', `Post ${id} was not found, or is not yours.`, {
    fix: 'Check the post id on your desk; owner-scoped routes do not distinguish the two.',
  });
}

/** A 401 on the READ never wrote anything, so it is runtime-class, not exit 4. */
function readAuthError(code: string | undefined, res: HttpResponse): CliError {
  return new CliError(
    'API_UNREACHABLE',
    serverMessage(res.json) ?? `Reading the post was not authorized (${code ?? '401'}).`,
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

/**
 * A failed update after approval (exit 4). A `validation_failed` carries dotted
 * field keys (`resource.asOf`, `title`); name them in the message, because the
 * server's own message says only "validation failed".
 */
function updateFailed(res: HttpResponse): CliError {
  const fields = fieldErrorKeys(res.json);
  const base = serverMessage(res.json) ?? `Update failed (${res.status}).`;
  return new CliError(
    'PUBLISH_FAILED',
    fields.length > 0 ? `${base} (${fields.join(', ')})` : base,
    {
      fix:
        fields.length > 0
          ? 'Correct the reported fields, then re-run `tenjin edit`.'
          : 'Review the server error, then re-run `tenjin edit`.',
      details: { status: res.status, ...(res.json !== undefined ? { server: res.json } : {}) },
    },
  );
}

/** The dotted keys of `error.details.fieldErrors`, when the server sent any. */
function fieldErrorKeys(json: unknown): string[] {
  if (typeof json !== 'object' || json === null) return [];
  const err = (json as { error?: unknown }).error;
  if (typeof err !== 'object' || err === null) return [];
  const details = (err as { details?: unknown }).details;
  if (typeof details !== 'object' || details === null) return [];
  const fieldErrors = (details as { fieldErrors?: unknown }).fieldErrors;
  if (typeof fieldErrors !== 'object' || fieldErrors === null) return [];
  return Object.keys(fieldErrors);
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
