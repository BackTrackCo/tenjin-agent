import { CliError } from '../lib/errors';
import { fetchResponse, fetchFailureToCliError, trimSlash } from '../lib/http';
import type { FetchResponseOptions } from '../lib/http';
import { LookupResponseSchema, apiErrorFrom, baseHeaders, parseBody } from '../lib/api';
import type { LookupCandidate, LookupResponse } from '../lib/api';
import { loadRawConfig, resolveSettings } from '../lib/config';
import { atomicToUsd, parseUsdToAtomic } from '../lib/money';
import { recordLookup } from '../lib/state';
import { sanitizeForTerminal } from '../lib/output';
import type { CommandContext, CommandResult } from '../context';

/**
 * One call to POST /api/agent/lookup, no wallet, no auth. The server decides
 * CANDIDATES or MISS; the CLI never re-ranks and never fabricates confidence.
 * An honest MISS is success (exit 0): "nobody has published this" is exactly
 * the answer the caller paid zero for.
 *
 * Privacy contract (docs + help): the question must be generalized public text.
 * Derive the smallest public phrasing of the task before calling; never include
 * secrets, private code, or personal context. By default the server stores no
 * query text at all; `config set evalCohort true` opts into 90-day storage of
 * the question for retrieval evaluation.
 */
export interface LookupArgs {
  question: string;
  freshWithin?: string;
  maxPrice?: string;
  limit?: string;
  appliesTo?: string[];
}

export interface LookupDeps {
  fetchImpl?: typeof fetch;
}

const FRESH_WITHIN_RE = /^P(\d{1,4})[DWMY]$/;

/** Server-side card bounds, re-applied defensively so a misbehaving server cannot blow up an agent transcript. */
const CAND_BOUNDS = {
  title: 200,
  scope: 240,
  exclusions: 240,
  listItems: 4,
  listItemChars: 160,
  matchReasons: 3,
  matchReasonChars: 80,
  appliesToKeys: 6,
  appliesToValues: 5,
  appliesToValueChars: 80,
} as const;

export async function runLookup(
  args: LookupArgs,
  ctx: CommandContext,
  deps: LookupDeps = {},
): Promise<CommandResult> {
  const question = args.question.trim();
  if (question.length === 0 || question.length > 512) {
    throw new CliError(
      'USAGE',
      'The question must be 1 to 512 characters of generalized public text.',
      {
        fix: 'Shorten the question to the smallest public phrasing of what you need.',
      },
    );
  }
  const body: Record<string, unknown> = { schemaVersion: 1, question };
  if (args.freshWithin !== undefined) {
    // The server rejects ANY zero-valued duration (P0W, P00D, ...), not just P0D.
    const digits = args.freshWithin.match(FRESH_WITHIN_RE)?.[1];
    if (digits === undefined || Number(digits) === 0) {
      throw new CliError(
        'USAGE',
        `Invalid --fresh-within value: ${JSON.stringify(args.freshWithin)}`,
        {
          fix: 'Use a nonzero ISO 8601 duration like P30D, P2W, P6M, or P1Y.',
        },
      );
    }
    body.freshWithin = args.freshWithin;
  }
  if (args.maxPrice !== undefined) body.maxPrice = parseUsdToAtomic(args.maxPrice);
  if (args.limit !== undefined) {
    const limit = Number(args.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 10) {
      throw new CliError('USAGE', `Invalid --limit value: ${JSON.stringify(args.limit)}`, {
        fix: 'Use an integer from 1 to 10.',
      });
    }
    body.limit = limit;
  }
  const appliesTo = parseAppliesTo(args.appliesTo ?? []);
  if (appliesTo !== null) body.appliesTo = appliesTo;

  const settings = resolveSettings({
    config: await loadRawConfig(ctx.dataDir),
    flags: { baseUrl: ctx.flags.baseUrl },
    env: process.env,
  });
  const url = `${trimSlash(settings.baseUrl.value)}/api/agent/lookup`;
  const opts: FetchResponseOptions = {
    timeoutMs: ctx.flags.timeout,
    method: 'POST',
    headers: baseHeaders({
      'content-type': 'application/json',
      ...(settings.evalCohort.value ? { 'x-tenjin-eval-cohort': '1' } : {}),
    }),
    body: JSON.stringify(body),
    ...(deps.fetchImpl !== undefined ? { fetchImpl: deps.fetchImpl } : {}),
  };
  const res = await fetchResponse(url, opts);
  if (!res.ok) throw fetchFailureToCliError(res);
  if (res.status === 400) {
    throw new CliError('USAGE', 'The server rejected the lookup request.', {
      details: res.json,
      fix: 'Check the flag values; run `tenjin lookup --help`.',
    });
  }
  if (res.status !== 200) throw apiErrorFrom(res, 'lookup');

  const parsed = truncateResponse(parseBody(LookupResponseSchema, res, 'lookup'));

  await recordLookup(ctx.dataDir, {
    lookupId: parsed.lookupId,
    decision: parsed.decision,
    at: new Date().toISOString(),
    candidates: (parsed.candidates ?? []).map((c) => ({
      resourceId: c.resourceId,
      url: c.url,
      title: c.title,
      price: c.price,
    })),
  });

  const humanLines =
    parsed.decision === 'MISS'
      ? [`MISS (lookup ${parsed.lookupId}): nothing published answers this. That result is free.`]
      : [
          `${(parsed.candidates ?? []).length} candidate(s) (lookup ${parsed.lookupId}):`,
          ...(parsed.candidates ?? []).map(
            (c, i) =>
              `  ${i + 1}. ${sanitizeForTerminal(c.title)} (${sanitizeForTerminal(c.creator.handle)}) $${atomicToUsd(c.price)}  ${sanitizeForTerminal(c.url)}`,
          ),
        ];
  return { data: parsed, humanLines };
}

/** Mirror the server's strictObject bounds so a bad filter fails as a local USAGE error, not a remote 400. */
function parseAppliesTo(pairs: string[]): Record<string, string[]> | null {
  if (pairs.length === 0) return null;
  const out: Record<string, string[]> = {};
  for (const pair of pairs) {
    const eq = pair.indexOf('=');
    if (eq <= 0) {
      throw new CliError('USAGE', `Invalid --applies-to entry: ${JSON.stringify(pair)}`, {
        fix: 'Use key=value, e.g. --applies-to products=Vercel. Repeat the flag for more.',
      });
    }
    const key = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (!/^[a-z][a-z0-9_]{0,31}$/.test(key)) {
      throw new CliError('USAGE', `Invalid --applies-to key: ${JSON.stringify(key)}`, {
        fix: 'Keys are lowercase snake_case, e.g. products, versions, platforms, networks.',
      });
    }
    if (value.length === 0 || value.length > 120) {
      throw new CliError(
        'USAGE',
        `Invalid --applies-to value for ${key}: must be 1 to 120 characters.`,
        {
          fix: 'Use key=value with a nonempty value, e.g. --applies-to products=Vercel.',
        },
      );
    }
    const values = (out[key] ??= []);
    values.push(value);
    if (values.length > 20) {
      throw new CliError('USAGE', `Too many --applies-to values for ${key} (max 20).`);
    }
  }
  if (Object.keys(out).length > 8) {
    throw new CliError('USAGE', 'Too many --applies-to keys (max 8).');
  }
  return out;
}

/** Re-apply the server's own card bounds so output stays ~1k tokens even off a misbehaving server. */
function truncateResponse(res: LookupResponse): LookupResponse {
  if (res.candidates === undefined) return res;
  return { ...res, candidates: res.candidates.map(truncateCandidate) };
}

function truncateCandidate(c: LookupCandidate): LookupCandidate {
  const cap = (s: string, n: number): string => (s.length > n ? s.slice(0, n) : s);
  const capList = (list: string[], items: number, chars: number): string[] =>
    list.slice(0, items).map((s) => cap(s, chars));
  const appliesTo: Record<string, string[]> = {};
  for (const key of Object.keys(c.appliesTo).slice(0, CAND_BOUNDS.appliesToKeys)) {
    appliesTo[cap(key, CAND_BOUNDS.appliesToValueChars)] = capList(
      c.appliesTo[key] ?? [],
      CAND_BOUNDS.appliesToValues,
      CAND_BOUNDS.appliesToValueChars,
    );
  }
  return {
    ...c,
    title: cap(c.title, CAND_BOUNDS.title),
    scope: c.scope === null ? null : cap(c.scope, CAND_BOUNDS.scope),
    exclusions: c.exclusions === null ? null : cap(c.exclusions, CAND_BOUNDS.exclusions),
    questionsAnswered: capList(
      c.questionsAnswered,
      CAND_BOUNDS.listItems,
      CAND_BOUNDS.listItemChars,
    ),
    tasksSupported: capList(c.tasksSupported, CAND_BOUNDS.listItems, CAND_BOUNDS.listItemChars),
    matchReasons: capList(c.matchReasons, CAND_BOUNDS.matchReasons, CAND_BOUNDS.matchReasonChars),
    appliesTo,
  };
}
