import type { PaymentRequirements } from '@x402/core/types';
import { saveSweepListings, sweepRegistries } from '../lib/bazaar';
import { formatUsdDisplay } from '../lib/money';
import { sanitizeForTerminal } from '../lib/output';
import { resolveContextSettings } from '../lib/settings';
import type { CommandContext, CommandResult } from '../context';

/**
 * `tenjin discover [query]`: list or search the configured x402 discovery
 * registries. Free and keyless, no wallet touched, and available with the
 * `bazaarPay` toggle off (it shows what the toggle unlocks; a stderr hint says
 * so). The foreign-endpoint counterpart of `tenjin search`: `search` finds
 * marketplace answers, `discover` finds payable endpoints anywhere.
 *
 * Registry listings are settlement-derived and unvetted, and every string in
 * them is other people's content: rendered sanitized, never followed. MCP-type
 * listings are counted but not shown, because `tenjin pay` cannot speak to
 * them; nothing here implies this CLI can pay everything a registry lists.
 */

/** Terminal rows; the machine envelope carries every swept resource. */
const HUMAN_ROWS = 20;

export interface DiscoverArgs {
  query?: string;
}

export async function runDiscover(args: DiscoverArgs, ctx: CommandContext): Promise<CommandResult> {
  const settings = await resolveContextSettings(ctx);
  const sweep = await sweepRegistries(settings.bazaarRegistries, {
    timeoutMs: ctx.flags.timeout,
    ...(args.query !== undefined && args.query.trim().length > 0
      ? { query: args.query.trim() }
      : {}),
  });

  // The sweep doubles as pay-time evidence: `tenjin pay` verifies a foreign 402
  // against these stored listings, because a live per-URL registry lookup is not
  // reliable (see lib/bazaar). Best-effort: a store write failure loses cache,
  // never the sweep output.
  try {
    await saveSweepListings(ctx.dataDir, sweep.resources);
  } catch {
    // nothing: the sweep result still stands on its own
  }

  const resources = sweep.resources.map((r) => ({
    url: r.url,
    registry: r.registry,
    ...(r.description !== undefined ? { description: r.description } : {}),
    ...(r.lastUpdated !== undefined ? { lastUpdated: r.lastUpdated } : {}),
    accepts: r.accepts.map((a) => ({
      scheme: a.scheme,
      network: a.network,
      asset: a.asset,
      amount: a.amount,
      payTo: a.payTo,
    })),
  }));

  const data = {
    registries: settings.bazaarRegistries,
    ...(args.query !== undefined ? { query: args.query } : {}),
    resources,
    skippedNonHttp: sweep.skippedNonHttp,
    // A registry that did not answer makes this sweep PARTIAL; saying so is what
    // keeps "not listed here" from reading as "not listed anywhere".
    errors: sweep.errors,
    bazaarPay: settings.bazaarPay,
  };

  if (!settings.bazaarPay) {
    ctx.io.stderr.write(
      'bazaarPay is off: these endpoints are visible but not payable. An operator enables the lane with `tenjin config set bazaarPay on`.\n',
    );
  }

  const humanLines = sweep.resources
    .slice(0, HUMAN_ROWS)
    .map((r) => `${sanitizeForTerminal(r.url)} ${priceTag(r.accepts)}${describe(r.description)}`);
  if (sweep.resources.length > HUMAN_ROWS) {
    humanLines.push(`… ${sweep.resources.length - HUMAN_ROWS} more in --json`);
  }
  if (sweep.resources.length === 0) {
    humanLines.push(
      sweep.errors.length > 0
        ? 'No registry answered; nothing to show.'
        : 'No HTTP resources matched.',
    );
  }
  for (const err of sweep.errors) {
    humanLines.push(`(${sanitizeForTerminal(err.registry)} did not answer)`);
  }
  return { data, humanLines };
}

function priceTag(accepts: PaymentRequirements[]): string {
  const first = accepts[0];
  if (first === undefined) return '(no price advertised)';
  try {
    return `(${formatUsdDisplay(first.amount)} USD on ${first.network})`;
  } catch {
    return `(${first.amount} atomic on ${first.network})`;
  }
}

function describe(description: string | undefined): string {
  if (description === undefined || description.length === 0) return '';
  const clean = sanitizeForTerminal(description);
  return ` — ${clean.length > 100 ? `${clean.slice(0, 100)}…` : clean}`;
}
