import { CliError } from '../lib/errors';
import { formatUsdDisplay, isPaidPrice, parseUsdToAtomic } from '../lib/money';
import { resolveContextSettings } from '../lib/settings';
import { buildSearchRequest, postSearch, MAX_LIMIT, type SearchInput } from '../lib/agent-api';
import { recordSearch } from '../lib/search-store';
import { listCandidates } from '../lib/candidate-store';
import { assertOnBaseOrigin } from '../lib/resource-ref';
import { sanitizeForTerminal } from '../lib/output';
import type { CommandContext, CommandResult } from '../context';

/**
 * `tenjin search "<question>"`, one POST to /api/agent/search. Prints the compact
 * CANDIDATES/MISS response verbatim (spec 10), and records the searchId +
 * candidates locally so `outcome --last` and `buy <resourceId>` can use them. No
 * wallet, no signing: search is anonymous.
 *
 * Search is the breadth step: a candidate is a lean hit (identity, price,
 * freshness, why it matched), and the full answer card comes from `tenjin inspect`,
 * which is free. So a candidate line stays short on purpose.
 *
 * The response's `searchId` is the outcome-reporting capability for
 * POST /api/agent/searches/<searchId>/outcomes. tenjin#463 renamed both the field
 * (from `lookupId`) and that path, and this client follows the rename end to end,
 * so nothing on the wire or in the local store still speaks `lookupId`.
 */

export interface SearchArgs {
  question: string;
  /** Decimal USD at the edge (O1); converted to atomic for the wire. */
  maxPrice?: string;
  freshWithin?: string;
  limit?: string;
  /** Raw `k=v` / `k=v1,v2` pairs from repeated --applies-to. */
  appliesTo?: string[];
}

export interface SearchDeps {
  fetchImpl?: typeof fetch;
}

export async function runSearch(
  args: SearchArgs,
  ctx: CommandContext,
  deps: SearchDeps = {},
): Promise<CommandResult> {
  const settings = await resolveContextSettings(ctx);
  const input: SearchInput = { question: args.question };
  if (args.maxPrice !== undefined) input.maxPrice = parseUsdToAtomic(args.maxPrice);
  if (args.freshWithin !== undefined) input.freshWithin = args.freshWithin;
  if (args.limit !== undefined) input.limit = parseLimit(args.limit);
  if (args.appliesTo !== undefined && args.appliesTo.length > 0) {
    input.appliesTo = parseAppliesTo(args.appliesTo);
  }

  const request = buildSearchRequest(input);
  const response = await postSearch(request, {
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
      assertOnBaseOrigin(c.url, settings.baseUrl, 'search candidate URL');
    } catch (err) {
      throw new CliError(
        'CONTRACT_MISMATCH',
        `Search candidate ${c.resourceId} points off the configured base URL.`,
        { cause: err },
      );
    }
  }
  // Browse pointers are never buyable through `buy <resourceId>` (they are not
  // recorded), but their urls are still emitted into the agent's transcript, so
  // they get the same origin check rather than a weaker one.
  for (const b of response.browse ?? []) {
    try {
      assertOnBaseOrigin(b.url, settings.baseUrl, 'browse pointer URL');
    } catch (err) {
      throw new CliError(
        'CONTRACT_MISMATCH',
        `Browse pointer ${b.resourceId} points off the configured base URL.`,
        { cause: err },
      );
    }
  }
  await recordSearch(ctx.dataDir, {
    searchId: response.searchId,
    at: new Date().toISOString(),
    question: request.question,
    decision: response.decision,
    candidates: candidates.map((c) => ({
      resourceId: c.resourceId,
      url: c.url,
      title: c.title,
      price: c.price,
    })),
    // The pointers stay unrecorded on purpose (see below); only how many of them
    // cost money, so `outcome` can tell a MISS that offered a payable browse tail
    // from one that offered nothing to buy. A zero-priced pointer does not count:
    // `read` delivers it for nothing, so there was no purchase to decline. Zero on
    // a CANDIDATES decision, where the contract carries no browse array and the
    // parser drops any that appears.
    paidBrowseCount: (response.browse ?? []).filter((b) => isPaidPrice(b.price) === true).length,
  });

  // A parked-candidate nudge on stderr (not in the machine JSON), MISS only: a
  // MISS is the moment to publish the answer you are about to derive, and stale
  // drafts should not rot unseen. A HIT is not a publish moment, and hot search
  // paths should not get advisory noise every call. One line, only when parked.
  if (response.decision === 'MISS') await emitCandidateNudge(ctx);

  // A MISS may carry up to 3 browse pointers from the broad corpus. They are
  // pointers, NOT candidates: rendered as ONE hint line with no scores and no
  // per-item detail, so a MISS still reads as a MISS and an agent is never
  // nudged to treat a browse pointer as an answer. The machine JSON keeps the
  // full `browse` array; this line is only the human tail.
  //
  // The price rides this line because a browse url IS payable: it is the read
  // endpoint that answers a 402, and `buy <url>` resolves the URL arm by origin
  // without consulting the search store, so a browse pointer can be bought even
  // though `buy <resourceId>` can never reach one. All spend gates (price cap,
  // session budget, allowlist, confirm) still run; showing the price keeps the
  // only human-visible surface from being a blind spend.
  //
  // It renders in DOLLARS, not atomic units, because the whole point of the line
  // is that a human can size the spend against the gates they set, and every gate
  // is entered in decimal USD (`--max-price 0.10`, the `maxAutoSpend` config).
  // `formatUsdDisplay` is the canonical human-copy form (always two decimals, so
  // a dime reads "0.10" and not "0.1"); the machine `browse` array in --json still
  // carries the exact atomic string, per the money-units contract in the README.
  const browse = response.browse ?? [];
  const browseHint =
    browse.length > 0
      ? [
          `no match, ${browse.length} piece(s) you could browse: ${browse
            .map((b) => `${sanitizeForTerminal(b.title)} (${formatUsdDisplay(b.price)} USD)`)
            .join('; ')}`,
        ]
      : [];

  // `truncated` means the server's size backstop dropped candidates, either a
  // trailing few the limit had room for or a single oversized one. The response
  // ceiling GROWS with the number of candidates returned (tenjin#501), so the
  // remedy is counter-intuitive and worth stating outright: a larger --limit
  // recovers the tail, a smaller one returns strictly fewer. Only at the maximum
  // is the tail unrecoverable and narrowing the question the answer.
  //
  // The CLI knows the limit it sent, so it names the next step instead of
  // restating the rule and leaving the reader to work out which half applies.
  // The flag stays in the machine envelope (--json) untouched, where it is
  // omitted rather than false when it did not fire.
  //
  // Rendering it on a MISS too is DEFENSIVE, not wire behavior: the server only
  // ever sets the flag alongside candidates it dropped. Handling both keeps the
  // flag from going unrendered if that ever changes.
  const truncatedHint =
    response.truncated === true
      ? [
          request.limit < MAX_LIMIT
            ? `some candidates were dropped for size; retry with --limit ${MAX_LIMIT} (the size ceiling grows with the number of candidates returned)`
            : `some candidates were dropped for size; at --limit ${MAX_LIMIT} the dropped tail cannot be recovered, so narrow the question`,
        ]
      : [];

  const humanLines =
    response.decision === 'MISS'
      ? [`MISS, no candidates (searchId ${response.searchId})`, ...browseHint, ...truncatedHint]
      : [
          `${candidates.length} candidate(s) (searchId ${response.searchId}):`,
          // Dollars for the same reason the browse hint uses them: this is the
          // human's cue to size the spend against gates they entered in decimal
          // USD. The machine `candidates` array in --json keeps atomic.
          ...candidates.map(
            (c, i) =>
              `  ${i + 1}. ${sanitizeForTerminal(c.title)}, ${formatUsdDisplay(c.price)} USD, ${sanitizeForTerminal(c.url)}`,
          ),
          ...truncatedHint,
        ];

  return { data: response, humanLines };
}

const STALE_MS = 7 * 24 * 60 * 60 * 1000;

/** One stderr line naming parked candidates (and how many are stale >7d), so a
 *  search is a reminder to publish/tidy the local pen. Silent when none parked. */
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
