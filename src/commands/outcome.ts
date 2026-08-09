import { CliError } from '../lib/errors';
import { resolveContextSettings } from '../lib/settings';
import { buildOutcomeItem, postOutcomes } from '../lib/agent-api';
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
 * /api/agent/searches/:id/outcomes, closing the reuse loop (used / partially_used
 * / rejected / regenerated / purchase_declined). The searchId is the capability,
 * so no wallet is needed; `--last` sugar targets the most recent local search.
 *
 * `--last` binds to whatever search ran most recently, which in a multi-search
 * session is often not the one the agent means (issue #100). Two guards, both
 * local: the targeted search's question is echoed back in the success line and in
 * the machine data, so a misfire is visible in the same breath as the report; and
 * an outcome that could not describe that search, whether by its status or by
 * naming a resource the search never surfaced, is refused before the request.
 */

export interface OutcomeArgs {
  searchId?: string;
  last?: boolean;
  status: string;
  resource?: string;
  contentHash?: string;
}

export interface OutcomeDeps {
  fetchImpl?: typeof fetch;
}

export async function runOutcome(
  args: OutcomeArgs,
  ctx: CommandContext,
  deps: OutcomeDeps = {},
): Promise<CommandResult> {
  const target = await resolveTarget(args, ctx);
  // Status name first, so an unknown status still fails as an unknown status
  // rather than as an incoherent one.
  const item = buildOutcomeItem({
    status: args.status,
    ...(args.resource !== undefined ? { resourceId: args.resource } : {}),
    ...(args.contentHash !== undefined ? { contentHash: args.contentHash } : {}),
  });
  if (target.stored !== null) assertOutcomeCoherent(item.status, target.stored, item.resourceId);
  const { searchId } = target;
  const question = target.stored !== null ? echoQuestion(target.stored.question) : undefined;

  const settings = await resolveContextSettings(ctx);
  const result = await postOutcomes(searchId, [item], {
    baseUrl: settings.baseUrl,
    timeoutMs: ctx.flags.timeout,
    ...(deps.fetchImpl !== undefined ? { fetchImpl: deps.fetchImpl } : {}),
  });

  // The loop is closed, so the Stop hook has nothing left to raise about it.
  // AFTER the post, so a refused or failed report leaves the loop open. Local
  // bookkeeping only, and it never throws: see markSearchResolved.
  await markSearchResolved(ctx.dataDir, searchId, 'outcome');

  // The question rides both renderings, so the misfire this guards against is
  // visible whether a human is reading the line or an agent is reading the JSON.
  // Sanitized on the human line only: the envelope is machine data and keeps the
  // bytes it was given (see output.ts).
  return {
    data: {
      searchId,
      status: item.status,
      accepted: result.accepted,
      ...(question !== undefined ? { question } : {}),
    },
    humanLines: [
      `Reported ${item.status} for search ${searchId}${
        question !== undefined ? ` "${sanitizeForTerminal(question)}"` : ''
      } (accepted ${result.accepted}).`,
    ],
  };
}

/** The search this report will land on, plus the local record of it when there is
 *  one. `stored` is null for a `--search-id` from another machine or an evicted
 *  entry: unknown, so neither echoed nor checked. */
interface OutcomeTarget {
  searchId: string;
  stored: StoredSearch | null;
}

async function resolveTarget(args: OutcomeArgs, ctx: CommandContext): Promise<OutcomeTarget> {
  if (args.searchId !== undefined && args.last === true) {
    throw new CliError('USAGE', 'Pass either --search-id or --last, not both.', {
      fix: 'Use --search-id <id> for a specific search, or --last for the most recent.',
    });
  }
  if (args.searchId !== undefined) {
    const searches = await loadSearches(ctx.dataDir);
    return {
      searchId: args.searchId,
      stored: searches.find((s) => s.searchId === args.searchId) ?? null,
    };
  }
  if (args.last === true) {
    const latest = await latestSearch(ctx.dataDir);
    if (latest === null) {
      throw new CliError('SEARCH_NOT_FOUND', 'No local search to target with --last.', {
        fix: 'Run `tenjin search` first, or pass --search-id <id>.',
      });
    }
    return { searchId: latest.searchId, stored: latest };
  }
  throw new CliError('USAGE', 'An outcome needs a search to report against.', {
    fix: 'Pass --search-id <id> or --last.',
  });
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
