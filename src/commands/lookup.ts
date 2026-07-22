import { CliError } from '../lib/errors';
import { parseUsdToAtomic } from '../lib/money';
import { resolveContextSettings } from '../lib/settings';
import { buildLookupRequest, postLookup, type LookupInput } from '../lib/agent-api';
import { recordLookup } from '../lib/lookup-store';
import { listCandidates } from '../lib/candidate-store';
import { assertOnBaseOrigin } from '../lib/resource-ref';
import { sanitizeForTerminal } from '../lib/output';
import type { CommandContext, CommandResult } from '../context';

/**
 * `tenjin lookup "<question>"`, one POST to /api/agent/lookup. Prints the compact
 * CANDIDATES/MISS response verbatim (spec 10), and records the lookupId +
 * candidates locally so `outcome --last` and `buy <resourceId>` can use them. No
 * wallet, no signing: lookup is anonymous.
 */

export interface LookupArgs {
  question: string;
  /** Decimal USD at the edge (O1); converted to atomic for the wire. */
  maxPrice?: string;
  freshWithin?: string;
  limit?: string;
  /** Raw `k=v` / `k=v1,v2` pairs from repeated --applies-to. */
  appliesTo?: string[];
}

export interface LookupDeps {
  fetchImpl?: typeof fetch;
}

export async function runLookup(
  args: LookupArgs,
  ctx: CommandContext,
  deps: LookupDeps = {},
): Promise<CommandResult> {
  const settings = await resolveContextSettings(ctx);
  const input: LookupInput = { question: args.question };
  if (args.maxPrice !== undefined) input.maxPrice = parseUsdToAtomic(args.maxPrice);
  if (args.freshWithin !== undefined) input.freshWithin = args.freshWithin;
  if (args.limit !== undefined) input.limit = parseLimit(args.limit);
  if (args.appliesTo !== undefined && args.appliesTo.length > 0) {
    input.appliesTo = parseAppliesTo(args.appliesTo);
  }

  const request = buildLookupRequest(input);
  const response = await postLookup(request, {
    baseUrl: settings.baseUrl,
    timeoutMs: ctx.flags.timeout,
    evalCohort: settings.evalCohort,
    ...(deps.fetchImpl !== undefined ? { fetchImpl: deps.fetchImpl } : {}),
  });

  const candidates = response.candidates ?? [];
  // Ingest trust boundary: a candidate url that points off the configured origin
  // would later route a wallet-signed SIWX header and payment to that host via
  // `buy <resourceId>`. Refuse the whole response as a contract violation.
  for (const c of candidates) {
    try {
      assertOnBaseOrigin(c.url, settings.baseUrl, 'lookup candidate URL');
    } catch (err) {
      throw new CliError(
        'CONTRACT_MISMATCH',
        `Lookup candidate ${c.resourceId} points off the configured base URL.`,
        { cause: err },
      );
    }
  }
  await recordLookup(ctx.dataDir, {
    lookupId: response.lookupId,
    at: new Date().toISOString(),
    question: request.question,
    decision: response.decision,
    candidates: candidates.map((c) => ({
      resourceId: c.resourceId,
      url: c.url,
      title: c.title,
      price: c.price,
    })),
  });

  // A parked-candidate nudge on stderr (not in the machine JSON): a MISS is the
  // moment to publish the answer you are about to derive, and stale drafts should
  // not rot unseen. One line, any lookup outcome, only when something is parked.
  await emitCandidateNudge(ctx);

  const humanLines =
    response.decision === 'MISS'
      ? [`MISS, no candidates (lookupId ${response.lookupId})`]
      : [
          `${candidates.length} candidate(s) (lookupId ${response.lookupId}):`,
          ...candidates.map(
            (c, i) =>
              `  ${i + 1}. ${sanitizeForTerminal(c.title)}, ${c.price} atomic, ${sanitizeForTerminal(c.url)}`,
          ),
        ];

  return { data: response, humanLines };
}

const STALE_MS = 7 * 24 * 60 * 60 * 1000;

/** One stderr line naming parked candidates (and how many are stale >7d), so a
 *  lookup is a reminder to publish/tidy the local pen. Silent when none parked. */
async function emitCandidateNudge(ctx: CommandContext): Promise<void> {
  const records = await listCandidates(ctx.dataDir);
  if (records.length === 0) return;
  const now = Date.now();
  const stale = records.filter((r) => now - Date.parse(r.meta.created) > STALE_MS).length;
  ctx.io.stderr.write(
    `${records.length} candidate(s) parked (${stale} stale >7d) - tenjin candidate list\n`,
  );
}

function parseLimit(raw: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n)) {
    throw new CliError('USAGE', `Invalid --limit: ${JSON.stringify(raw)}`, {
      fix: 'Pass an integer between 1 and 10.',
    });
  }
  return n;
}

/** `products=Vercel` or `products=Vercel,Next` → { products: ["Vercel","Next"] }. Repeated
 *  keys merge their values. */
function parseAppliesTo(pairs: string[]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const pair of pairs) {
    const eq = pair.indexOf('=');
    if (eq <= 0) {
      throw new CliError('USAGE', `Invalid --applies-to: ${JSON.stringify(pair)}`, {
        fix: 'Use key=value, e.g. --applies-to products=Vercel.',
      });
    }
    const key = pair.slice(0, eq).trim();
    const values = pair
      .slice(eq + 1)
      .split(',')
      .map((v) => v.trim())
      .filter((v) => v.length > 0);
    if (values.length === 0) {
      throw new CliError('USAGE', `--applies-to ${JSON.stringify(key)} has no values`, {
        fix: 'Give each key at least one value, e.g. products=Vercel.',
      });
    }
    out[key] = [...(out[key] ?? []), ...values];
  }
  return out;
}
