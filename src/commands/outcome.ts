import { CliError } from '../lib/errors';
import { resolveContextSettings } from '../lib/settings';
import { buildOutcomeItem, postOutcomes } from '../lib/agent-api';
import { latestLookup } from '../lib/lookup-store';
import type { CommandContext, CommandResult } from '../context';

/**
 * `tenjin outcome --lookup-id <id> --status <s>`, POST to
 * /api/agent/lookups/:id/outcomes, closing the reuse loop (used / partially_used
 * / rejected / regenerated / purchase_declined). The lookupId is the capability,
 * so no wallet is needed; `--last` sugar targets the most recent local lookup.
 */

export interface OutcomeArgs {
  lookupId?: string;
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
  const lookupId = await resolveLookupId(args, ctx);
  const item = buildOutcomeItem({
    status: args.status,
    ...(args.resource !== undefined ? { resourceId: args.resource } : {}),
    ...(args.contentHash !== undefined ? { contentHash: args.contentHash } : {}),
  });

  const settings = await resolveContextSettings(ctx);
  const result = await postOutcomes(lookupId, [item], {
    baseUrl: settings.baseUrl,
    timeoutMs: ctx.flags.timeout,
    ...(deps.fetchImpl !== undefined ? { fetchImpl: deps.fetchImpl } : {}),
  });

  return {
    data: { lookupId, status: item.status, accepted: result.accepted },
    humanLines: [`Reported ${item.status} for lookup ${lookupId} (accepted ${result.accepted}).`],
  };
}

async function resolveLookupId(args: OutcomeArgs, ctx: CommandContext): Promise<string> {
  if (args.lookupId !== undefined && args.last === true) {
    throw new CliError('USAGE', 'Pass either --lookup-id or --last, not both.', {
      fix: 'Use --lookup-id <id> for a specific lookup, or --last for the most recent.',
    });
  }
  if (args.lookupId !== undefined) return args.lookupId;
  if (args.last === true) {
    const latest = await latestLookup(ctx.dataDir);
    if (latest === null) {
      throw new CliError('USAGE', 'No local lookup to target with --last.', {
        fix: 'Run `tenjin lookup` first, or pass --lookup-id <id>.',
      });
    }
    return latest.lookupId;
  }
  throw new CliError('USAGE', 'An outcome needs a lookup to report against.', {
    fix: 'Pass --lookup-id <id> or --last.',
  });
}
