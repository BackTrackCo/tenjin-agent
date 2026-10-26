import type { PaymentRequirements } from '@x402/core/types';
import { saveSweepListings, sweepRegistries } from '../lib/bazaar';
import { formatUsdDisplay } from '../lib/money';
import { sanitizeForTerminal } from '../lib/output';
import { resolveContextSettings } from '../lib/settings';
import { isCanonicalUsdc } from '../lib/x402-pay';
import { CliError } from '../lib/errors';
import { searchOrthogonal } from '../lib/orthogonal-catalog';
import type { CommandContext, CommandResult } from '../context';

/**
 * `tenjin discover [query]`: list or search the configured x402 discovery
 * registries. Free and keyless, with no wallet touched or payment authorized.
 * Complements the router's curated `request({browse})` tool list with the
 * configured registries and Orthogonal. No provider
 * task is called; only this explicit command starts the external searches.
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
  sources?: string[];
}

export async function runDiscover(args: DiscoverArgs, ctx: CommandContext): Promise<CommandResult> {
  const settings = await resolveContextSettings(ctx);
  const sources = [...new Set(args.sources ?? ['registries', 'orthogonal'])];
  if (
    sources.length === 0 ||
    sources.some((source) => !['registries', 'orthogonal'].includes(source))
  )
    throw new CliError('USAGE', 'Use --sources registries,orthogonal or a subset.');
  const query = args.query?.trim() ?? '';
  const [sweep, catalogs] = await Promise.all([
    sources.includes('registries')
      ? sweepRegistries(settings.bazaarRegistries, {
          timeoutMs: ctx.flags.timeout,
          ...(query ? { query } : {}),
        })
      : Promise.resolve({ resources: [], errors: [], skippedNonHttp: 0 }),
    Promise.all([
      ...(sources.includes('orthogonal') ? [searchOrthogonal(query, ctx.flags.timeout)] : []),
    ]),
  ]);

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
    ...(r.serviceName !== undefined ? { serviceName: r.serviceName } : {}),
    ...(r.extensions !== undefined ? { extensions: r.extensions } : {}),
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
    sources,
    registries: sources.includes('registries') ? settings.bazaarRegistries : [],
    ...(args.query !== undefined ? { query: args.query } : {}),
    resources,
    catalogs,
    skippedNonHttp: sweep.skippedNonHttp,
    // A registry that did not answer makes this sweep PARTIAL; saying so is what
    // keeps "not listed here" from reading as "not listed anywhere".
    errors: sweep.errors,
  };

  const humanLines = sweep.resources
    .slice(0, HUMAN_ROWS)
    .map((r) => `${sanitizeForTerminal(r.url)} ${priceTag(r.accepts)}${describe(r.description)}`);
  if (sweep.resources.length > HUMAN_ROWS) {
    humanLines.push(`… ${sweep.resources.length - HUMAN_ROWS} more in --json`);
  }
  if (sources.includes('registries') && sweep.resources.length === 0) {
    humanLines.push(
      sweep.errors.length > 0
        ? 'Discovery is incomplete; no HTTP resources to show.'
        : 'No registry HTTP resources matched.',
    );
  }
  for (const err of sweep.errors) {
    humanLines.push(`(${sanitizeForTerminal(err.registry)}: ${sanitizeForTerminal(err.message)})`);
  }
  for (const catalog of catalogs) {
    humanLines.push(
      `${catalog.source}${catalog.partial ? ' (partial coverage)' : ''}: ${catalog.endpoints.length} matches via ${catalog.via}`,
    );
    for (const endpoint of catalog.endpoints) {
      humanLines.push(
        `${sanitizeForTerminal(endpoint.url)} — ${sanitizeForTerminal(endpoint.name)}${endpoint.advertisedPrice !== undefined ? ` (advertised ${sanitizeForTerminal(String(endpoint.advertisedPrice))})` : ''}`,
      );
    }
    for (const error of catalog.errors)
      humanLines.push(`(${catalog.source}: ${sanitizeForTerminal(error)})`);
  }
  return { data, humanLines };
}

function priceTag(accepts: PaymentRequirements[]): string {
  const first = accepts.find((a) => a.scheme === 'exact' && isCanonicalUsdc(a)) ?? accepts[0];
  if (first === undefined) return '(no price advertised)';
  try {
    if (!isCanonicalUsdc(first)) throw new Error('not a supported dollar asset');
    return `(${formatUsdDisplay(first.amount)} USD on ${first.network})`;
  } catch {
    return `(${sanitizeForTerminal(first.amount)} atomic ${sanitizeForTerminal(first.asset)} on ${sanitizeForTerminal(first.network)})`;
  }
}

function describe(description: string | undefined): string {
  if (description === undefined || description.length === 0) return '';
  const clean = sanitizeForTerminal(description);
  return ` — ${clean.length > 100 ? `${clean.slice(0, 100)}…` : clean}`;
}
