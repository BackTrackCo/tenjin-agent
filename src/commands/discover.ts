import type { PaymentRequirements } from '@x402/core/types';
import { sameResourceUrl, saveSweepListings, sweepRegistries } from '../lib/bazaar';
import type { RegistryResource } from '../lib/bazaar';
import { formatUsdDisplay } from '../lib/money';
import { sanitizeForTerminal } from '../lib/output';
import { resolveContextSettings } from '../lib/settings';
import { selectPins } from '../lib/vip-listings';
import type { PinnedListing } from '../lib/vip-listings';
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
 *
 * Ahead of that sweep sits the pinned block (lib/vip-listings): this
 * deployment's own paid endpoints and any curated sellers. Pins are labeled for
 * what they are, are never probed, and NEVER reach the pay-time evidence store.
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
  //
  // ONLY `sweep.resources` is ever passed here. Pins are computed below, after
  // this call, so no amount of curation can become the evidence a payment is
  // checked against.
  try {
    await saveSweepListings(ctx.dataDir, sweep.resources);
  } catch {
    // nothing: the sweep result still stands on its own
  }

  const pins = selectPins(settings.baseUrl, args.query);
  // A pin the sweep also lists is rendered once, in the pinned block, carrying
  // the registry's live terms. Identity is the pay lane's own rule, so the two
  // can never disagree about what "the same endpoint" means.
  const pinned = pins.map((pin) => ({
    pin,
    listed: sweep.resources.find((r) => sameResourceUrl(r.url, pin.url)),
  }));
  const unpinnedResources = sweep.resources.filter(
    (r) => !pins.some((pin) => sameResourceUrl(r.url, pin.url)),
  );

  const resources = unpinnedResources.map((r) => ({
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
    pinned: pinned.map(({ pin, listed }) => ({
      url: pin.url,
      kind: pin.kind,
      description: pin.description,
      keywords: pin.keywords,
      // Terms appear only when a registry listed this endpoint. A pin is not
      // itself a price quote: discover probes nothing.
      ...(listed !== undefined
        ? {
            registry: listed.registry,
            accepts: listed.accepts.map((a) => ({
              scheme: a.scheme,
              network: a.network,
              asset: a.asset,
              amount: a.amount,
              payTo: a.payTo,
            })),
          }
        : {}),
    })),
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

  const humanLines = pinned.map(({ pin, listed }) => pinnedLine(pin, listed));
  if (humanLines.length > 0) humanLines.push('');
  humanLines.push(
    ...unpinnedResources
      .slice(0, HUMAN_ROWS)
      .map((r) => `${sanitizeForTerminal(r.url)} ${priceTag(r.accepts)}${describe(r.description)}`),
  );
  if (unpinnedResources.length > HUMAN_ROWS) {
    humanLines.push(`… ${unpinnedResources.length - HUMAN_ROWS} more in --json`);
  }
  if (unpinnedResources.length === 0) {
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

/**
 * One pinned row. The label is the whole honesty of this block: `first-party`
 * says whose endpoint it is, and the VIP label says curated is not vouched-for.
 * A price appears only when the sweep supplied one, because nothing here probes.
 */
function pinnedLine(pin: PinnedListing, listed: RegistryResource | undefined): string {
  const label =
    pin.kind === 'first-party' ? 'first-party' : 'VIP (curated, quality not guaranteed)';
  const price = listed !== undefined ? ` ${priceTag(listed.accepts)}` : '';
  return `${label}  ${sanitizeForTerminal(pin.url)}${price}${describe(pin.description)}`;
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
