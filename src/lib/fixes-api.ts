import { z } from 'zod';
import { CliError } from './errors';
import { httpRequest, type HttpResponse, type HttpResult } from './http';
import { rateLimitError } from './agent-api';
import { UUID_RE } from './ids';
import { trimSlash } from './url';
import { type PublishClientOptions } from './posts-api';
import type { WriteAuth } from './session-key';

/**
 * The FIX STORE contract: `POST /api/fixes` (upsert) and
 * `POST /api/fixes/:id/attest`, the two write routes `tenjin sync` uses.
 *
 * A FIX IS NOT A POST. It has no title, slug, body, card, embedding or
 * search-gate entry, and it never reaches the public marketplace: it is the
 * fact "this exact failure was fixed by changing these files", keyed by the
 * fingerprint the failure arm computed. That is why these live in their own
 * module rather than beside the post routes — the only thing the two share is
 * the signing discipline, which is imported rather than re-implemented.
 *
 * Every write is signed through the injected {@link WriteAuth} (a session key by
 * default, plain SIWX as the fallback), and a 401 is recovered per the auth's
 * own rules, bounded exactly as the post routes bound it.
 */

/** The two lanes a fix can be keyed on, plus the command head that rides along
 *  as metadata and is never itself a lookup key (the server rejects a resolve
 *  request that asks for one). */
export type FixKeyKind = 'test' | 'error' | 'command_head';
export type FixKeyTier = 'fine' | 'coarse';

export interface FixKeyInput {
  kind: FixKeyKind;
  key: string;
  tier: FixKeyTier;
}

export interface FixUpsertInput {
  primary: { kind: 'test' | 'error'; key: string };
  /** Must include `primary` at tier `fine`; at most 8. */
  keys: FixKeyInput[];
  /** The client-computed repo salt. Opaque to the server. */
  repo: string;
  cmdHead: string;
  /** Repo-relative paths, at most 16. */
  fixFiles: string[];
  passedOnHead?: string;
  pkgVersions?: Record<string, string>;
}

const fixSchema = z.object({ id: z.string() });
const upsertSchema = z.object({ fix: fixSchema, created: z.boolean() });
const attestSchema = z.object({ attestations: z.number() });

export interface FixUpsertResult {
  fixId: string;
  /**
   * `false` means the holder row already existed for this
   * (creator, kind, key, repo) — this machine already holds the fix and the
   * server changed nothing. `tenjin sync` stamps the row synced either way;
   * the flag is what tells "published" from "already ours" in the counters.
   */
  created: boolean;
}

/** Bounded 401 recovery: the initial attempt plus at most this many re-signs.
 *  ⚠ The same bound the post routes use, for the same reason: a server that
 *  always 401s must not loop. */
const MAX_RECOVERIES = 3;

/**
 * Upsert this machine's fix record (`POST /api/fixes`).
 *
 * IDEMPOTENT BY THE HOLDER RULE, not by a header: the server's unique
 * (creator, primary_kind, primary_key, repo) tuple is the dedup, so a repeat
 * POST of a row this machine already holds answers 200 `created: false` and
 * changes nothing. That is why sync can re-post a row whose local stamp was
 * lost without risking a duplicate.
 */
export async function upsertFix(
  input: FixUpsertInput,
  auth: WriteAuth,
  opts: PublishClientOptions,
): Promise<FixUpsertResult> {
  const body: Record<string, unknown> = {
    primary: input.primary,
    keys: input.keys,
    repo: input.repo,
    cmdHead: input.cmdHead,
    fixFiles: input.fixFiles,
    ...(input.passedOnHead !== undefined ? { passedOnHead: input.passedOnHead } : {}),
    ...(input.pkgVersions !== undefined && Object.keys(input.pkgVersions).length > 0
      ? { pkgVersions: input.pkgVersions }
      : {}),
  };
  const url = `${trimSlash(opts.baseUrl)}/api/fixes`;
  const res = await signedPost(url, body, auth, opts);
  if (res.status !== 200 && res.status !== 201) throw fixWriteFailed(res, 'record the fix');
  const parsed = upsertSchema.safeParse(res.json);
  if (!parsed.success || !UUID_RE.test(parsed.data.fix.id)) {
    throw new CliError('CONTRACT_MISMATCH', 'The fix response did not match the contract.', {
      fix: 'Update tenjin-cli; the server contract may have changed.',
      ...(parsed.success ? {} : { details: parsed.error.issues }),
    });
  }
  return { fixId: parsed.data.fix.id, created: parsed.data.created };
}

/**
 * Attest to a teammate's fix (`POST /api/fixes/:id/attest`) with what THIS
 * machine changed.
 *
 * THIS IS THE SECOND, INDEPENDENT CONFIRMATION, and the only route there is to
 * one: the shelf has no close endpoint, so a failure a teammate published and
 * this machine then closed locally can be recorded nowhere else. Their fix is
 * theirs — every write route is owner-scoped — so this machine adds to it
 * rather than publishing a near-duplicate under its own name.
 *
 * A 400 `self_attest` means the local link is stale and the fix is in fact
 * ours; the caller treats that as "nothing to do" rather than as an error.
 */
export async function attestFix(
  fixId: string,
  fixFiles: string[],
  auth: WriteAuth,
  opts: PublishClientOptions,
): Promise<number> {
  const url = `${trimSlash(opts.baseUrl)}/api/fixes/${encodeURIComponent(fixId)}/attest`;
  const res = await signedPost(url, { fixFiles }, auth, opts);
  if (res.status === 404) {
    throw new CliError('RESOURCE_NOT_FOUND', `No fix ${fixId} on this shelf.`, {
      details: { status: 404 },
    });
  }
  if (res.status !== 200 && res.status !== 201) throw fixWriteFailed(res, 'attest to the fix');
  const parsed = attestSchema.safeParse(res.json);
  return parsed.success ? parsed.data.attestations : 0;
}

/** Whether `err` is the server's own "you own this fix" refusal (400
 *  `self_attest`), which means the local link is stale rather than that
 *  anything went wrong. */
export function isSelfAttest(err: unknown): boolean {
  return err instanceof CliError && err.code === 'REFUSED' && /self_attest/.test(err.message);
}

/** One signed POST with the shared bounded-401 recovery. Both routes take a
 *  JSON body and neither has an ingest gate to parse, so this is the whole of
 *  what they share. */
async function signedPost(
  url: string,
  body: Record<string, unknown>,
  auth: WriteAuth,
  opts: PublishClientOptions,
): Promise<HttpResponse> {
  const failed = (res: Exclude<HttpResult, { ok: true }>): CliError => {
    const code =
      res.kind === 'network' || res.kind === 'timeout' ? 'NETWORK_ERROR' : 'API_UNREACHABLE';
    return new CliError(code, `${url}: ${res.message}`, {
      fix: 'Check your network and the configured base URL (`tenjin config get baseUrl`), then retry.',
    });
  };
  // One serialization for BOTH the Content-Digest and the wire bytes, so the
  // signed digest covers exactly what is sent.
  const bodyStr = JSON.stringify(body);
  let recoveries = 0;
  for (;;) {
    const authHeaders = await auth.headersFor({ method: 'POST', url, body: bodyStr });
    const res = await httpRequest(url, {
      method: 'POST',
      timeoutMs: opts.timeoutMs,
      headers: { ...authHeaders },
      jsonBody: body,
      ...(opts.bypass !== undefined ? { bypass: opts.bypass } : {}),
      ...(opts.fetchImpl !== undefined ? { fetchImpl: opts.fetchImpl } : {}),
    });
    if (!res.ok) throw failed(res);
    if (res.status === 401 && recoveries < MAX_RECOVERIES) {
      if (await auth.recover(codeOf(res))) {
        recoveries++;
        continue;
      }
    }
    // ⚠ NO `details.status` HERE, DELIBERATELY. `tenjin sync` treats a 4xx
    // carrying one as terminal FOR THAT ROW and stamps it synced; a 401 is not
    // about the row at all, it is the wallet or the session, and every row
    // behind it would be silently marked synced without ever reaching the
    // shelf. Left statusless so it aborts the run instead, and the next run
    // retries the lot.
    if (res.status === 401) {
      throw new CliError(
        'PUBLISH_FAILED',
        `The shelf refused this write (${codeOf(res) ?? '401'}).`,
        {
          fix: 'Delete ~/.tenjin/session.json to re-establish the session key, or check the wallet.',
        },
      );
    }
    if (res.status === 429) throw rateLimitError(url, (n) => res.header(n));
    if (res.status === 400 && codeOf(res) === 'self_attest') {
      throw new CliError(
        'REFUSED',
        'self_attest: this fix is already yours, so there is nothing to attest.',
      );
    }
    return res;
  }
}

/** The server's own error code, when its body carries one. */
function codeOf(res: HttpResponse): string | undefined {
  const json = res.json;
  if (typeof json !== 'object' || json === null) return undefined;
  const error = (json as { error?: unknown }).error;
  if (typeof error === 'string') return error;
  if (typeof error !== 'object' || error === null) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

function fixWriteFailed(res: HttpResponse, what: string): CliError {
  const code = codeOf(res);
  return new CliError(
    'PUBLISH_FAILED',
    `Could not ${what} (${res.status}${code ? `, ${code}` : ''}).`,
    {
      fix: 'Re-run `tenjin sync`; a fix that could not be recorded is retried on the next run.',
      details: { status: res.status, ...(res.json !== undefined ? { server: res.json } : {}) },
    },
  );
}
