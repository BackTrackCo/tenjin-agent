import { CliError } from '../lib/errors';
import { formatUsdDisplay, parseUsdToAtomic } from '../lib/money';
import { resolveContextSettings, type ResolvedSettings } from '../lib/settings';
import { buildSearchRequest, postSearch, MAX_LIMIT, type SearchInput } from '../lib/agent-api';
import { recordSearch } from '../lib/search-store';
import { readSessionId } from '../lib/session';
import { assertOnBaseOrigin } from '../lib/resource-ref';
import { sanitizeForTerminal } from '../lib/output';
import type { CommandContext, CommandResult } from '../context';

/**
 * `tenjin search "<question>"`, one POST to /api/search with `view: "decision"`.
 * Prints the compact result (spec 10) and records the searchId + items locally so
 * `outcome --last` and `buy <resourceId>` can use them. No wallet, no signing:
 * search is anonymous.
 *
 * The machine envelope is the server's response verbatim plus exactly one
 * CLI-owned key, `publishBack`, and only on a miss. It carries no server data: it
 * is the local searchId and the two commands that close the loop, which is
 * information the CLI owns and the contract does not describe.
 *
 * Search is the breadth step: an item is a lean hit (identity, price, freshness,
 * why it matched), and the full answer card comes from `tenjin inspect`, which is
 * free. So an item line stays short on purpose.
 *
 * A MISS is no longer a `decision` the server sends, it is simply `matched: 0`
 * with an empty `items` (search v3). The CANDIDATES/MISS wording survives ONLY in
 * the local store, whose entries predate v3 and whose `decision` field `outcome`
 * still reads; it is derived here from whether anything matched, and never parsed
 * off the wire.
 *
 * The response's `searchId` is the outcome-reporting capability for
 * POST /api/searches/<searchId>/outcomes. tenjin#463 renamed the field (from
 * `lookupId`), tenjin#616 dropped the `/agent` prefix from the outcomes path, and
 * tenjin#137 retired the `/api/agent/search` alias; this client follows all three
 * end to end, so nothing on the wire or in the local store still speaks
 * `lookupId` or a prefixed spelling.
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
  /** Environment seam (TENJIN_SESSION_ID); defaults to process.env. */
  env?: NodeJS.ProcessEnv;
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

  const sessionId = readSessionId(deps.env ?? process.env);
  const request = buildSearchRequest(input);

  // SHELF ONE IS ALWAYS `baseUrl`, and the label follows the mode: in team mode
  // that origin IS the team shelf, in public mode it is the marketplace.
  const legs: ShelfLeg[] = [];
  /**
   * A TEAM SHELF THAT ERRORS IS A MISS, NOT A STOP — the rule the push hooks
   * already state in so many words (lib/push-scripts.ts shelfDecide: "silencing
   * the public shelf ... would turn one misconfigured secret into a sidecar that
   * never speaks again"). `postSearch` throws on any non-200, and Deployment
   * Protection answers a rotated or mistyped bypass secret with a 401 HTML page,
   * so an unguarded first leg meant that a typo, a redeploy, or ten minutes of
   * 500s took down every `tenjin search` on the machine while tenjin.blog sat
   * there healthy. The failure is reported, not swallowed; it just does not cost
   * the fallback.
   *
   * Two throws are NOT outages and keep propagating. In public mode there is one
   * shelf and nothing to fall through to. And a CONTRACT_MISMATCH is an ingest
   * trust-boundary refusal, not a shelf that is down — a response whose candidate
   * points off the shelf that served it is exactly what `buy` would later pay, so
   * it fails the command closed rather than degrading into a quiet fallback.
   */
  let teamError: string | undefined;
  try {
    legs.push(
      await queryShelf({
        shelf: settings.teamMode ? 'team' : 'public',
        baseUrl: settings.baseUrl,
        ...(settings.bypass !== undefined ? { bypass: settings.bypass } : {}),
        request,
        ctx,
        settings,
        sessionId,
        ...(deps.fetchImpl !== undefined ? { fetchImpl: deps.fetchImpl } : {}),
      }),
    );
  } catch (err) {
    if (!settings.teamMode) throw err;
    if (err instanceof CliError && err.code === 'CONTRACT_MISMATCH') throw err;
    teamError = sanitizeForTerminal(err instanceof Error ? err.message : String(err));
  }
  // SHELF TWO, TEAM MODE ONLY, AND ONLY WHEN THE FIRST HAD NOTHING TO GIVE —
  // no candidates, or no answer at all. Same order the push hooks use, for the
  // same reason: the team's own shelf covers the working day and the public
  // marketplace is the fallback, so a team hit is never buried under a page of
  // marketplace results. No bypass here — the transport would drop it anyway,
  // since this is a different origin.
  if (settings.teamMode && (legs[0] === undefined || legs[0].response.items.length === 0)) {
    legs.push(
      await queryShelf({
        shelf: 'public',
        baseUrl: settings.publicShelfUrl,
        request,
        ctx,
        settings,
        sessionId,
        ...(deps.fetchImpl !== undefined ? { fetchImpl: deps.fetchImpl } : {}),
      }),
    );
  }

  // The envelope is ONE shelf's response verbatim: the one that answered, or the
  // first (the shelf a publish would go to) when neither did. A merged envelope
  // would be a shape the contract does not describe and `outcome`/`buy` cannot
  // key off, so the second shelf rides in `shelves` instead, and only when there
  // was a second shelf at all.
  const primary = legs.find((leg) => leg.response.items.length > 0) ?? legs[0]!;
  const decision = primary.response.items.length > 0 ? 'CANDIDATES' : 'MISS';

  // Named on its own line, first, whichever way the search then went: a shelf
  // that is broken is something the operator has to hear about, and the search
  // succeeding on the fallback is exactly when nothing else would say so.
  const teamErrorLines =
    teamError === undefined
      ? []
      : [`The team shelf (${settings.baseUrl}) did not answer:`, `  ${teamError}`];

  const humanLines: string[] = [
    ...teamErrorLines,
    ...(decision === 'MISS'
      ? [
          `MISS, no candidates (searchId ${primary.response.searchId})`,
          ...missedShelfLines(legs),
          ...missHint(primary.response),
          ...truncatedHint(primary.response, request.limit),
          publishBackLine(primary.response.searchId),
        ]
      : legs.flatMap((leg) => shelfLines(leg, settings.teamMode, request.limit))),
  ];

  const data =
    decision === 'MISS'
      ? { ...primary.response, publishBack: publishBackHint(primary.response.searchId) }
      : primary.response;

  return {
    data: settings.teamMode
      ? {
          ...(data as object),
          shelves: [
            // The shelf that failed is still a leg that ran, and `shelves` is
            // where a machine reader learns what each one did. It carries
            // `error` instead of a searchId, so "asked and broken" is not read
            // as "asked and empty" — or, worse, as "never asked".
            ...(teamError !== undefined
              ? [{ shelf: 'team' as const, baseUrl: settings.baseUrl, error: teamError }]
              : []),
            ...legs.map((leg) => ({
              shelf: leg.shelf,
              baseUrl: leg.baseUrl,
              searchId: leg.response.searchId,
              matched: leg.response.items.length,
            })),
          ],
        }
      : data,
    humanLines,
  };
}

/** Which shelf answered, and what it said. */
interface ShelfLeg {
  shelf: 'team' | 'public';
  baseUrl: string;
  response: Awaited<ReturnType<typeof postSearch>>;
}

interface ShelfQuery {
  shelf: 'team' | 'public';
  baseUrl: string;
  bypass?: ResolvedSettings['bypass'];
  request: ReturnType<typeof buildSearchRequest>;
  ctx: CommandContext;
  settings: ResolvedSettings;
  sessionId: string | undefined;
  fetchImpl?: typeof fetch;
}

/**
 * One shelf's POST, origin-checked and recorded. Everything here was already
 * true of the single-shelf version; the only new thing is that the origin check
 * and the stored candidates are scoped to THIS shelf's base URL, not to the
 * configured one — a public-shelf candidate is on the public shelf's origin, and
 * checking it against the team's would refuse every result the fallback found.
 */
async function queryShelf(q: ShelfQuery): Promise<ShelfLeg> {
  const response = await postSearch(q.request, {
    baseUrl: q.baseUrl,
    timeoutMs: q.ctx.flags.timeout,
    evalCohort: q.settings.evalCohort,
    ...(q.bypass !== undefined ? { bypass: q.bypass } : {}),
    ...(q.fetchImpl !== undefined ? { fetchImpl: q.fetchImpl } : {}),
  });

  // Ingest trust boundary: a candidate url that points off the shelf that served
  // it would later route a wallet-signed SIWX header and payment to that host via
  // `buy <resourceId>`. Refuse the whole response as a contract violation.
  // This deliberately diverges from the hook path (lib/hook-scripts.ts
  // askTenjin), which DROPS the one off-origin candidate and keeps the rest: a
  // hook hint is advisory and never pays, so one bad row should not blank the
  // hint, whereas a `search` result feeds `buy` and must fail closed as a whole.
  for (const c of response.items) {
    try {
      assertOnBaseOrigin(c.url, q.baseUrl, 'search candidate URL');
    } catch (err) {
      throw new CliError(
        'CONTRACT_MISMATCH',
        `Search candidate ${c.resourceId} points off the ${q.shelf} shelf's base URL.`,
        { cause: err },
      );
    }
  }
  // Derived, never read off the wire: v3 has no `decision` field. The store keeps
  // the two words because entries written by older CLIs and by the WebSearch hook
  // carry them and `outcome` branches on them, so a rename here would split the
  // ledger rather than clean it up.
  const decision = response.items.length > 0 ? 'CANDIDATES' : 'MISS';
  await recordSearch(q.ctx.dataDir, {
    searchId: response.searchId,
    at: new Date().toISOString(),
    question: q.request.query,
    decision,
    // A deliberate search, as opposed to one the WebSearch hook rode along with.
    // The Stop hook nags on the two differently, so the tag has to be written
    // here rather than inferred later from anything.
    source: 'cli',
    // Usually absent; see readSessionId. An unstamped entry is raised in every
    // session, which is the safe direction for a reminder.
    ...(q.sessionId !== undefined ? { sessionId: q.sessionId } : {}),
    candidates: response.items.map((c) => ({
      resourceId: c.resourceId,
      url: c.url,
      title: c.title,
      price: c.price,
    })),
    // Always zero under search v3, and that is a fact about the result rather
    // than a placeholder: the decision view draws no browse tail at all, so no
    // pointer was offered and none of them cost money. `outcome` reads this to
    // tell a search that offered nothing to buy from one that put a payable
    // pointer in front of the agent, and under v3 the answer is always the
    // former. The field stays on the store because entries written by older CLIs
    // still carry a real count, and `undefined` there must keep reading as
    // "unknown" rather than as zero.
    paidBrowseCount: 0,
  });
  return { shelf: q.shelf, baseUrl: q.baseUrl, response };
}

/**
 * One shelf's candidates. `labelled` follows TEAM MODE, not the number of legs
 * that ran: a team-mode reader needs to know which shelf answered even when only
 * one was asked, and a public-mode reader must see exactly the header this
 * command has always printed — a machine parsing these lines should not learn a
 * new shape because a second shelf exists on somebody else's machine.
 */
function shelfLines(leg: ShelfLeg, labelled: boolean, limit: number): string[] {
  const { response } = leg;
  if (response.items.length === 0) return [];
  const head = labelled
    ? `${response.items.length} candidate(s) on the ${leg.shelf} shelf (searchId ${response.searchId}):`
    : `${response.items.length} candidate(s) (searchId ${response.searchId}):`;
  return [
    head,
    // Dollars, not atomic units: this is the human's cue to size the spend
    // against gates they entered in decimal USD (`--max-price 0.10`, the
    // `maxAutoSpend` config). `formatUsdDisplay` is the canonical human-copy
    // form (always two decimals, so a dime reads "0.10" and not "0.1"); the
    // machine `items` array in --json keeps the exact atomic string, per the
    // money-units contract in the README.
    ...response.items.map(
      (c, i) =>
        `  ${i + 1}. ${sanitizeForTerminal(c.title)}, ${formatUsdDisplay(c.price)} USD, ${sanitizeForTerminal(c.url)}`,
    ),
    ...truncatedHint(response, limit),
  ];
}

/** On a total miss with two shelves, name both, so the reader knows the fallback
 *  ran rather than assuming the team shelf was the only thing asked. */
function missedShelfLines(legs: ShelfLeg[]): string[] {
  if (legs.length < 2) return [];
  return [`Asked both shelves: ${legs.map((leg) => leg.shelf).join(', then ')}.`];
}

/**
 * A miss under search v3 carries no browse tail at all: the decision view
 * returns matches or nothing, and the catalog is browsed at GET /api/articles.
 * The server says exactly that in `hint`, and rendering the server's own
 * sentence rather than a local paraphrase is what keeps the two from drifting
 * when that pointer moves. It is server-authored text on its way to a terminal,
 * so it is sanitized like every other rendered string, and the parser has
 * already bounded its length.
 *
 * Absent-but-empty is treated as absent: `hint` is contractually present only
 * when nothing matched, so a server that omits it costs the reader one line
 * rather than an empty bullet.
 */
function missHint(response: Awaited<ReturnType<typeof postSearch>>): string[] {
  return response.hint !== undefined && response.hint.length > 0
    ? [sanitizeForTerminal(response.hint)]
    : [];
}

/**
 * `truncated` means the server's size backstop dropped candidates, either a
 * trailing few the limit had room for or a single oversized one. The response
 * ceiling GROWS with the number of candidates returned (tenjin#501), so the
 * remedy is counter-intuitive and worth stating outright: a larger --limit
 * recovers the tail, a smaller one returns strictly fewer. Only at the maximum
 * is the tail unrecoverable and narrowing the question the answer.
 *
 * The CLI knows the limit it sent, so it names the next step instead of
 * restating the rule and leaving the reader to work out which half applies.
 * The flag stays in the machine envelope (--json) untouched, where it is
 * omitted rather than false when it did not fire.
 *
 * Rendering it on a MISS too is DEFENSIVE, not wire behavior: the server only
 * ever sets the flag alongside candidates it dropped. Handling both keeps the
 * flag from going unrendered if that ever changes.
 */
function truncatedHint(response: Awaited<ReturnType<typeof postSearch>>, limit: number): string[] {
  if (response.truncated !== true) return [];
  return [
    limit < MAX_LIMIT
      ? `some candidates were dropped for size; retry with --limit ${MAX_LIMIT} (the size ceiling grows with the number of candidates returned)`
      : `some candidates were dropped for size; at --limit ${MAX_LIMIT} the dropped tail cannot be recovered, so narrow the question`,
  ];
}

/** The publish-back hint, as machine fields rather than prose to re-parse. */
function publishBackHint(searchId: string): {
  searchId: string;
  reason: string;
  publish: string;
  decline: string;
} {
  return {
    searchId,
    reason: 'Nothing on the marketplace answered this. If you solve it, publish it back.',
    // Both arms carry the searchId, because both are commands to run verbatim and
    // a publish without it leaves this very loop open (see publish's --search-id).
    // The second arm is DECLINE, not park: nothing is saved to come back to, and
    // reporting the outcome is what closes the loop so it never raises again.
    publish: `tenjin publish <file.md> --json --search-id ${searchId}`,
    decline: `tenjin outcome --search-id ${searchId} --status regenerated --json`,
  };
}

/** The same hint as one rendered line for a human. */
function publishBackLine(searchId: string): string {
  return `Nobody has published this yet - if you solve it, publish it back (tenjin publish <file.md> --search-id ${searchId}); if you will not, close the loop: tenjin outcome --search-id ${searchId} --status regenerated`;
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
