import { CliError } from '../lib/errors';
import { fetchResponse, fetchFailureToCliError } from '../lib/http';
import { OutcomeAcceptedSchema, apiErrorFrom, baseHeaders, parseBody } from '../lib/api';
import { loadRawConfig, resolveSettings } from '../lib/config';
import { findLibraryByResource, lastLookup } from '../lib/state';
import type { CommandContext, CommandResult } from '../context';

/**
 * Report how a lookup ended: POST /api/agent/lookups/:id/outcomes. Anonymous by
 * design (the unguessable lookupId is the capability). The server always
 * answers 202 and never confirms storage (no existence oracle), so a 202 here
 * means "accepted for processing", not "recorded". Closing this loop is what
 * makes the marketplace's hit-rate data mean anything; report honestly,
 * including `regenerated` when a purchase didn't help.
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

export const OUTCOME_STATUSES = [
  'used',
  'partially_used',
  'rejected',
  'regenerated',
  'purchase_declined',
] as const;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CONTENT_HASH_RE = /^sha256:[0-9a-f]{64}$/;

export async function runOutcome(
  args: OutcomeArgs,
  ctx: CommandContext,
  deps: OutcomeDeps = {},
): Promise<CommandResult> {
  if (!(OUTCOME_STATUSES as readonly string[]).includes(args.status)) {
    throw new CliError('USAGE', `Invalid --status value: ${JSON.stringify(args.status)}`, {
      fix: `Use one of: ${OUTCOME_STATUSES.join(', ')}.`,
    });
  }
  if ((args.lookupId === undefined) === (args.last !== true)) {
    throw new CliError('USAGE', 'Pass exactly one of --lookup-id <id> or --last.', {
      fix: 'Use --last to target the most recent local lookup.',
    });
  }

  let lookupId: string;
  if (args.last === true) {
    const last = await lastLookup(ctx.dataDir);
    if (last === null) {
      throw new CliError('USAGE', 'No local lookup history to resolve --last from.', {
        fix: 'Run `tenjin lookup "<question>"` first, or pass --lookup-id explicitly.',
      });
    }
    lookupId = last.lookupId;
  } else {
    lookupId = args.lookupId as string;
    if (!UUID_RE.test(lookupId)) {
      throw new CliError('USAGE', `--lookup-id must be a uuid, got ${JSON.stringify(lookupId)}`);
    }
  }

  if (args.resource !== undefined && !UUID_RE.test(args.resource)) {
    throw new CliError(
      'USAGE',
      `--resource must be a resourceId uuid, got ${JSON.stringify(args.resource)}`,
    );
  }
  if (args.contentHash !== undefined && !CONTENT_HASH_RE.test(args.contentHash)) {
    throw new CliError(
      'USAGE',
      'Invalid --content-hash: expected sha256:<64 lowercase hex chars>.',
    );
  }

  // A report on a bought resource auto-attaches the body hash recorded at save
  // time (any status), so mutable-post outcomes stay identifiable pre-versioning
  // without the caller re-hashing anything.
  let contentHash = args.contentHash;
  if (contentHash === undefined && args.resource !== undefined) {
    const owned = await findLibraryByResource(ctx.dataDir, args.resource);
    if (owned !== null) contentHash = owned.contentHash;
  }

  const outcome = {
    status: args.status,
    ...(args.resource !== undefined ? { resourceId: args.resource } : {}),
    ...(contentHash !== undefined ? { contentHash } : {}),
  };

  const settings = resolveSettings({
    config: await loadRawConfig(ctx.dataDir),
    flags: { baseUrl: ctx.flags.baseUrl },
    env: process.env,
  });
  const url = `${settings.baseUrl.value.replace(/\/+$/, '')}/api/agent/lookups/${lookupId}/outcomes`;
  const res = await fetchResponse(url, {
    timeoutMs: ctx.flags.timeout,
    method: 'POST',
    headers: baseHeaders({ 'content-type': 'application/json' }),
    body: JSON.stringify(outcome),
    ...(deps.fetchImpl !== undefined ? { fetchImpl: deps.fetchImpl } : {}),
  });
  if (!res.ok) throw fetchFailureToCliError(res);
  if (res.status === 400) {
    throw new CliError('USAGE', 'The server rejected the outcome report.', { details: res.json });
  }
  if (res.status !== 202) throw apiErrorFrom(res, 'outcome');
  parseBody(OutcomeAcceptedSchema, res, 'outcome');

  return {
    data: { lookupId, submitted: outcome, accepted: true },
    humanLines: [`Reported ${args.status} for lookup ${lookupId} (202 accepted).`],
  };
}
