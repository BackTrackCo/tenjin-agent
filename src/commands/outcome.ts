import { CliError } from '../lib/errors';
import { resolveContextSettings } from '../lib/settings';
import { buildOutcomeItem, postOutcomes } from '../lib/agent-api';
import { UUID_RE } from '../lib/ids';
import {
  latestSearch,
  loadSearches,
  markSearchResolved,
  type StoredSearch,
} from '../lib/search-store';
import { isPaidPrice } from '../lib/money';
import { sanitizeForTerminal } from '../lib/output';
import type { CommandContext, CommandResult } from '../context';

/**
 * `tenjin outcome --search-id <id> --status <s>`, POST to
 * /api/searches/:id/outcomes, closing the reuse loop (used / partially_used
 * / rejected / regenerated / purchase_declined). The searchId is the capability,
 * so no wallet is needed; `--last` sugar targets the most recent DELIBERATE
 * search — entries the WebSearch hook rode along with are skipped, or every web
 * search in auto mode would silently re-aim the report (a hook entry is reached
 * by explicit --search-id, which is what the Stop hook's reminder names).
 *
 * `--last` binds to whatever search ran most recently, which in a multi-search
 * session is often not the one the agent means (issue #100). Two guards, both
 * local: the targeted search's question is echoed back in the success line and in
 * the machine data, so a misfire is visible in the same breath as the report; and
 * an outcome that could not describe that search, whether by its status or by
 * naming a resource the search never surfaced, is refused before the request.
 *
 * ONE STATUS, MANY SEARCHES. `--search-id` repeats and `--all-open` sweeps the
 * hook's unanswered loops, because a session that closed seventeen of them one
 * call at a time is a session where the honest close stops happening. Both
 * report per id, both refuse before sending anything if one target's id or
 * status could not be right, and both stop at an unhealthy server and report the
 * rest untouched, because an open loop is the state the Stop hook can recover.
 */

export interface OutcomeArgs {
  /** One search, or several the same status describes. */
  searchId?: string | string[];
  last?: boolean;
  /** Close every open websearch-hook loop; `regenerated` only. */
  allOpen?: boolean;
  status: string;
  resource?: string;
  contentHash?: string;
}

export interface OutcomeDeps {
  fetchImpl?: typeof fetch;
}

/** `error` when the report did not land, `untouched` when the batch stopped
 *  before this id was tried. */
interface OutcomeReport {
  searchId: string;
  accepted: number;
  question?: string;
  error?: { code: string; message: string };
  untouched?: true;
}

/** Failures that say the next id fails the same way, so the batch stops: the
 *  budget signal itself (one sweep can spend 50 of the 60/min window), and the
 *  dead network, where 50 ids at the 10s default stalls a turn end for minutes.
 *  `API_UNREACHABLE` is deliberately absent: `apiFailure` gives it to every
 *  non-2xx, so halting on it would abandon a batch over a 400 about ONE id. */
const HALTING_FAILURES = new Set(['RATE_LIMITED', 'NETWORK_ERROR']);

export async function runOutcome(
  args: OutcomeArgs,
  ctx: CommandContext,
  deps: OutcomeDeps = {},
): Promise<CommandResult> {
  const { targets, deliberateLeftOpen, answeredLeftOpen } = await resolveTargets(args, ctx);
  // The status VOCABULARY; `--all-open`'s narrower rule already ran above, so a
  // bad status under that flag reports the restriction rather than the spelling.
  const item = buildOutcomeItem({
    status: args.status,
    ...(args.resource !== undefined ? { resourceId: args.resource } : {}),
    ...(args.contentHash !== undefined ? { contentHash: args.contentHash } : {}),
  });
  if (item.resourceId !== undefined && (targets.length > 1 || args.allOpen === true)) {
    throw new CliError(
      'USAGE',
      "A --resource names one search's candidate, so it cannot describe a batch.",
      { fix: 'Report the resource against its own search with a single --search-id <id>.' },
    );
  }
  // Every target, id shape included, before any request: a batch that refuses
  // halfway leaves the marketplace holding half a report nobody meant to send.
  for (const target of targets) {
    assertReportableId(target.searchId);
    if (target.stored !== null) assertOutcomeCoherent(item.status, target.stored, item.resourceId);
  }

  const settings = await resolveContextSettings(ctx);
  const reports: OutcomeReport[] = [];
  let halted = false;
  for (const target of targets) {
    const question = target.stored !== null ? echoQuestion(target.stored.question) : undefined;
    if (halted) {
      reports.push({ searchId: target.searchId, accepted: 0, untouched: true });
      continue;
    }
    try {
      const result = await postOutcomes(target.searchId, [item], {
        baseUrl: settings.baseUrl,
        timeoutMs: ctx.flags.timeout,
        ...(deps.fetchImpl !== undefined ? { fetchImpl: deps.fetchImpl } : {}),
      });
      // The loop is closed, so the Stop hook has nothing left to raise about it.
      // AFTER the post, so a refused or failed report leaves the loop open. Local
      // bookkeeping only, and it never throws: see markSearchResolved.
      await markSearchResolved(ctx.dataDir, target.searchId, 'outcome');
      reports.push({
        searchId: target.searchId,
        accepted: result.accepted,
        ...(question !== undefined ? { question } : {}),
      });
    } catch (err) {
      // One id keeps its own error envelope, with the code callers already read.
      if (targets.length === 1) throw err;
      const error = describeFailure(err);
      halted = HALTING_FAILURES.has(error.code);
      reports.push({
        searchId: target.searchId,
        accepted: 0,
        ...(question !== undefined ? { question } : {}),
        error,
      });
    }
  }

  const failed = reports.filter((r) => r.error !== undefined);
  const untouched = reports.filter((r) => r.untouched === true);
  const closed = reports.length - failed.length - untouched.length;
  // The question rides both renderings, so the misfire this guards against is
  // visible whether a human is reading the line or an agent is reading the JSON.
  // Sanitized on the human line only: the envelope is machine data and keeps the
  // bytes it was given (see output.ts).
  const humanLines = reports
    .filter((r) => r.error === undefined && r.untouched !== true)
    .map((r) => reportLine(item.status, r));
  if (targets.length === 0) humanLines.push('No open web-search loops to close.');
  humanLines.push(...leftOpenLines(deliberateLeftOpen, answeredLeftOpen));

  if (failed.length > 0) {
    const remainder = untouched.length > 0 ? `, ${untouched.length} left untouched` : '';
    throw new CliError(
      failureCode(failed),
      `Reported ${item.status} for ${closed} of ${reports.length} searches; ${failed.length} failed${remainder}.`,
      {
        // The ids ride the message, not just `details`: the human rendering
        // prints `fix` and drops every other details shape (see output.ts).
        fix: `Retry with ${retryFlags(failed.concat(untouched))}`,
        details: { status: item.status, closed, results: reports },
      },
    );
  }

  return {
    // The flat fields repeat a lone result, so a caller that has always read
    // data.searchId still reads it.
    data: {
      status: item.status,
      closed,
      results: reports,
      ...(deliberateLeftOpen > 0 ? { deliberateLeftOpen } : {}),
      ...(answeredLeftOpen > 0 ? { answeredLeftOpen } : {}),
      ...(reports.length === 1 ? flatten(reports[0]!) : {}),
    },
    humanLines,
  };
}

/** What the sweep walked past, so a blanket close cannot look complete. */
function leftOpenLines(deliberate: number, answered: number): string[] {
  const lines: string[] = [];
  if (deliberate > 0) {
    lines.push(`${deliberate} deliberate search(es) left open; close each with --search-id <id>.`);
  }
  if (answered > 0) {
    lines.push(
      `${answered} hook search(es) Tenjin answered left open; report each with --search-id <id>.`,
    );
  }
  return lines;
}

/** One shared code when every failure agrees, so an all-USAGE batch keeps its
 *  exit 2 and an all-RATE_LIMITED one stays recoverable; mixed is an outage. */
function failureCode(failed: OutcomeReport[]): 'USAGE' | 'RATE_LIMITED' | 'API_UNREACHABLE' {
  const codes = new Set(failed.map((r) => r.error?.code));
  if (codes.size !== 1) return 'API_UNREACHABLE';
  const [only] = [...codes];
  if (only === 'USAGE') return 'USAGE';
  return only === 'RATE_LIMITED' ? 'RATE_LIMITED' : 'API_UNREACHABLE';
}

/** The copy-pasteable retry, bounded: a fix line naming fifty ids is not a fix. */
function retryFlags(pending: OutcomeReport[]): string {
  const MAX_NAMED = 5;
  const named = pending.slice(0, MAX_NAMED).map((r) => `--search-id ${r.searchId}`);
  const rest = pending.length - named.length;
  return rest > 0 ? `${named.join(' ')} (and ${rest} more, see results)` : named.join(' ');
}

function flatten(report: OutcomeReport): Record<string, unknown> {
  return {
    searchId: report.searchId,
    accepted: report.accepted,
    ...(report.question !== undefined ? { question: report.question } : {}),
  };
}

function reportLine(status: string, report: OutcomeReport): string {
  const question =
    report.question !== undefined ? ` "${sanitizeForTerminal(report.question)}"` : '';
  return `Reported ${status} for search ${report.searchId}${question} (accepted ${report.accepted}).`;
}

function describeFailure(err: unknown): { code: string; message: string } {
  if (err instanceof CliError) return { code: err.code, message: err.message };
  return { code: 'INTERNAL', message: err instanceof Error ? err.message : String(err) };
}

/** The search this report will land on, plus the local record of it when there is
 *  one. `stored` is null for a `--search-id` from another machine or an evicted
 *  entry: unknown, so neither echoed nor checked. */
interface OutcomeTarget {
  searchId: string;
  stored: StoredSearch | null;
}

/** The searches to report against, plus what `--all-open` walked past. */
interface ResolvedTargets {
  targets: OutcomeTarget[];
  deliberateLeftOpen: number;
  answeredLeftOpen: number;
}

/** The shape `postOutcomes` enforces, hoisted in front of the send loop: there it
 *  runs per id mid-batch, so a typo in the third of five ids lands after two
 *  reports already left. UUID_RE and not `SEARCH_ID_WIRE_RE` — this path
 *  parameter is declared `format: uuid` with no pattern (openapi.fixture.json),
 *  so the stricter POST /api/posts regex would refuse ids this route accepts. */
function assertReportableId(searchId: string): void {
  if (UUID_RE.test(searchId)) return;
  throw new CliError('USAGE', `Invalid search id: ${JSON.stringify(searchId)}`, {
    fix: 'Pass a searchId from a prior search (or use --last).',
  });
}

async function resolveTargets(args: OutcomeArgs, ctx: CommandContext): Promise<ResolvedTargets> {
  const ids = idsOf(args.searchId);
  const selectors = [ids.length > 0, args.last === true, args.allOpen === true].filter(
    Boolean,
  ).length;
  if (selectors > 1) {
    throw new CliError('USAGE', 'Pass one of --search-id, --last or --all-open, not several.', {
      fix: "Use --search-id <id> (repeatable) for specific searches, --last for the most recent, or --all-open to close the web-search hook's open loops.",
    });
  }
  if (args.allOpen === true) return resolveAllOpen(args, ctx);
  if (ids.length > 0) {
    const searches = await loadSearches(ctx.dataDir);
    return {
      targets: ids.map((searchId) => ({
        searchId,
        stored: searches.find((s) => s.searchId === searchId) ?? null,
      })),
      deliberateLeftOpen: 0,
      answeredLeftOpen: 0,
    };
  }
  if (args.last === true) {
    const latest = await latestSearch(ctx.dataDir);
    if (latest === null) {
      throw new CliError('SEARCH_NOT_FOUND', 'No local search to target with --last.', {
        fix: 'Run `tenjin search` first, or pass --search-id <id>.',
      });
    }
    return {
      targets: [{ searchId: latest.searchId, stored: latest }],
      deliberateLeftOpen: 0,
      answeredLeftOpen: 0,
    };
  }
  throw new CliError('USAGE', 'An outcome needs a search to report against.', {
    fix: 'Pass --search-id <id>, --last, or --all-open --status regenerated.',
  });
}

/**
 * Every open loop the WebSearch hook recorded and Tenjin could not answer.
 *
 * `regenerated` ONLY: the other statuses claim what a specific search did for
 * the agent, and a blanket `used` over queries nobody read piece by piece is
 * attribution the marketplace would be right to trust and wrong to believe.
 *
 * MISS ONLY, the same reason one step further in: the hook records CANDIDATES
 * under this same source, and those are the searches where a priced answer was
 * shown and may have been bought, so `regenerated` would overwrite the one
 * positive attribution this loop collects. It also matches the Stop hook's weak
 * batch, so the nag cannot name a command reaching past what it describes.
 * Neither a deliberate search nor an answered one is swept; both are counted.
 */
async function resolveAllOpen(args: OutcomeArgs, ctx: CommandContext): Promise<ResolvedTargets> {
  if (args.status !== 'regenerated') {
    throw new CliError(
      'USAGE',
      `--all-open closes searches nobody examined one by one, so it reports regenerated and nothing else (got ${JSON.stringify(args.status)}).`,
      {
        fix: 'Use --all-open --status regenerated, or report other statuses per search with --search-id <id>.',
      },
    );
  }
  const open = (await loadSearches(ctx.dataDir)).filter(
    (s) => s.resolved === undefined || s.resolved === null,
  );
  // Absent source predates sources, and those entries were all deliberate.
  const hook = open.filter((s) => s.source === 'websearch-hook');
  return {
    targets: hook
      .filter((s) => s.decision === 'MISS')
      .map((stored) => ({ searchId: stored.searchId, stored })),
    deliberateLeftOpen: open.length - hook.length,
    answeredLeftOpen: hook.filter((s) => s.decision !== 'MISS').length,
  };
}

function idsOf(searchId: string | string[] | undefined): string[] {
  if (searchId === undefined) return [];
  const ids = typeof searchId === 'string' ? [searchId] : searchId;
  return [...new Set(ids)];
}

/** Long enough to tell two searches apart on one line, short enough not to bury
 *  the searchId next to it. The ellipsis is part of the echo: a question cut with
 *  no marker reads as a shorter question that was never asked. */
const QUESTION_ECHO_MAX = 80;

function echoQuestion(question: string): string {
  return question.length > QUESTION_ECHO_MAX
    ? `${question.slice(0, QUESTION_ECHO_MAX - 1)}…`
    : question;
}

/**
 * Refuse an outcome that could not describe the search it is aimed at. Two
 * independent checks, because they answer to different rules.
 *
 * MEMBERSHIP, for any status that names a `--resource`: the id has to be one this
 * search surfaced. On a CANDIDATES decision that is provable, since browse
 * pointers are MISS-only by contract AND truncateResponse deletes the array
 * outright on CANDIDATES rather than trust the server, so `candidates` is the
 * entire payable set the agent was shown and `search` records all of it. A uuid
 * outside it is a typo or another search's, and the server drops the item behind
 * its 202 (tenjin#641) whatever the status says, leaving the CLI to report
 * success for an outcome nobody stored. A MISS keeps the fail-open: its browse
 * tail is payable and deliberately unrecorded, so an absent id there is
 * unknowable rather than wrong. So does any other decision value.
 *
 * PAYABILITY, for `purchase_declined` alone. The status matrix is deliberately
 * one-sided: four of the five describe ANY search, so only this one has a
 * precondition.
 *
 *   used, partially_used  always. A MISS's browse tail is readable, and a free
 *                         piece is used without any purchase, so "used" on a
 *                         MISS, or on a free candidate, is a real report and not
 *                         a mistake (issue #100).
 *   rejected, regenerated always. "Nothing here helped, I wrote it myself" is
 *                         exactly what a MISS deserves to record.
 *   purchase_declined     needs the search to have offered something to buy, or,
 *                         when `--resource` names a candidate the store knows,
 *                         needs THAT candidate to have cost money. Declining a
 *                         purchase nobody offered cannot have happened, and that
 *                         is the shape the dogfooding misfire took: a
 *                         purchase_declined aimed at a bare MISS.
 *
 * Local knowledge only, and fail-open by construction: an unknown is never a
 * refusal. The server owns the checks this cannot make.
 */
function assertOutcomeCoherent(status: string, stored: StoredSearch, resourceId?: string): void {
  const named =
    resourceId !== undefined
      ? stored.candidates.find((c) => c.resourceId === resourceId)
      : undefined;

  if (resourceId !== undefined && named === undefined && stored.decision === 'CANDIDATES') {
    throw new CliError(
      'USAGE',
      `Search ${stored.searchId} "${echoQuestion(stored.question)}" surfaced no candidate ${resourceId}, so an outcome naming it would not be recorded.`,
      {
        fix: 'Pass a resourceId from this search, or drop --resource to report on the search as a whole.',
      },
    );
  }

  if (status !== 'purchase_declined') return;

  // A named candidate the store knows answers for itself. A piece that was free
  // is not made purchasable by a paid sibling in the same result, so the specific
  // claim is checked against the specific price rather than the search's total.
  if (named !== undefined) {
    if (isPaidPrice(named.price) !== false) return;
    throw new CliError(
      'USAGE',
      `Search ${stored.searchId} "${echoQuestion(stored.question)}" listed ${resourceId} at no cost, so purchase_declined cannot describe it.`,
      {
        fix: 'A free piece is reported as used, partially_used, rejected or regenerated; pass the --resource you actually declined to buy.',
      },
    );
  }

  if (offeredSomethingToBuy(stored) !== false) return;
  throw new CliError(
    'USAGE',
    `Search ${stored.searchId} "${echoQuestion(stored.question)}" was a ${stored.decision} that offered nothing to buy, so purchase_declined cannot describe it.`,
    {
      fix: 'Report used, partially_used, rejected or regenerated for this search, or pass --search-id <id> for the search you meant to report against.',
    },
  );
}

/**
 * Whether the search put anything payable in front of the agent. Priced at zero
 * does not count: `read` delivers a free piece with no payment, so a result that
 * was free end to end offered no purchase to decline, however many rows it had.
 * Null when the stored entry cannot say: it predates `paidBrowseCount`, so an
 * all-free candidate list might still have sat above a payable browse tail.
 */
function offeredSomethingToBuy(stored: StoredSearch): boolean | null {
  if (stored.candidates.some((c) => isPaidPrice(c.price) === true)) return true;
  // A price the store cannot parse is not evidence that the result was free.
  if (stored.candidates.some((c) => isPaidPrice(c.price) === null)) return null;
  if (stored.paidBrowseCount === undefined) return null;
  return stored.paidBrowseCount > 0;
}
