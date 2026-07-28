import { CliError } from '../lib/errors';
import { resolveContextSettings } from '../lib/settings';
import { buildOutcomeItem, postOutcomes } from '../lib/agent-api';
import { latestSearch } from '../lib/search-store';
import type { CommandContext, CommandResult } from '../context';

/**
 * `tenjin outcome --search-id <id> --status <s>`, POST to
 * /api/agent/searches/:id/outcomes, closing the reuse loop (used / partially_used
 * / rejected / regenerated / purchase_declined). The searchId is the capability,
 * so no wallet is needed; `--last` sugar targets the most recent local search.
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
  const searchId = await resolveSearchId(args, ctx);
  const item = buildOutcomeItem({
    status: args.status,
    ...(args.resource !== undefined ? { resourceId: args.resource } : {}),
    ...(args.contentHash !== undefined ? { contentHash: args.contentHash } : {}),
  });

  const settings = await resolveContextSettings(ctx);
  const result = await postOutcomes(searchId, [item], {
    baseUrl: settings.baseUrl,
    timeoutMs: ctx.flags.timeout,
    ...(deps.fetchImpl !== undefined ? { fetchImpl: deps.fetchImpl } : {}),
  });

  return {
    data: { searchId, status: item.status, accepted: result.accepted },
    humanLines: [`Reported ${item.status} for search ${searchId} (accepted ${result.accepted}).`],
  };
}

async function resolveSearchId(args: OutcomeArgs, ctx: CommandContext): Promise<string> {
  if (args.searchId !== undefined && args.last === true) {
    throw new CliError('USAGE', 'Pass either --search-id or --last, not both.', {
      fix: 'Use --search-id <id> for a specific search, or --last for the most recent.',
    });
  }
  if (args.searchId !== undefined) return args.searchId;
  if (args.last === true) {
    const latest = await latestSearch(ctx.dataDir);
    if (latest === null) {
      throw new CliError('SEARCH_NOT_FOUND', 'No local search to target with --last.', {
        fix: 'Run `tenjin search` first, or pass --search-id <id>.',
      });
    }
    return latest.searchId;
  }
  throw new CliError('USAGE', 'An outcome needs a search to report against.', {
    fix: 'Pass --search-id <id> or --last.',
  });
}
