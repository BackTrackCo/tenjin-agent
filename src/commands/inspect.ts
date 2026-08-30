import { resolveResourceRef } from '../lib/resource-ref';
import { resolveContextSettings } from '../lib/settings';
import { fetchRead, type PreviewCard } from '../lib/read-client';
import { toMoney } from '../lib/money';
import { headingOutline } from '../lib/markdown';
import { sanitizeForTerminal } from '../lib/output';
import type { CommandContext, CommandResult } from '../context';

/**
 * `tenjin inspect <resource-url-or-id>`, fetch the pre-purchase answer card /
 * preview from the read route's 402 body WITHOUT paying (spec 10). A free
 * resource returns 200 with the whole body; a paid one returns the leak-safe
 * preview plus the advertised price/network, and the answer card when the piece
 * carries one. Never signs, never pays, never saves.
 *
 * The card is the depth half of the search/inspect split: search v3 candidates
 * stay lean and inline only a bounded rank-1 subset, so this free call is where
 * an agent gets the full public card for any candidate before spending anything.
 */

export interface InspectArgs {
  ref: string;
}

export interface InspectDeps {
  fetchImpl?: typeof fetch;
}

export async function runInspect(
  args: InspectArgs,
  ctx: CommandContext,
  deps: InspectDeps = {},
): Promise<CommandResult> {
  const settings = await resolveContextSettings(ctx);
  const ref = await resolveResourceRef(
    args.ref,
    ctx.dataDir,
    settings.baseUrl,
    // The second origin only exists in TEAM mode. In public mode `publicShelfUrl`
    // is a shelf nothing falls through to, so widening on it would accept a URL
    // from an origin no search on this machine can even surface.
    settings.teamMode ? settings.publicShelfUrl : undefined,
  );

  const result = await fetchRead(ref.url, {
    timeoutMs: ctx.flags.timeout,
    ...(settings.bypass !== undefined ? { bypass: settings.bypass } : {}),
    ...(deps.fetchImpl !== undefined ? { fetchImpl: deps.fetchImpl } : {}),
  });

  if (result.kind === 'entitled') {
    // Free (or already-entitled) resource: the body is readable now, no payment.
    const body = result.body;
    return {
      data: {
        url: ref.url,
        resourceId: body.id,
        access: 'free',
        title: body.title,
        price: toMoney(body.price),
        headings: headingOutline(body.bodyMd),
        // The free/owned half of the verb split (#42): delivery here costs nothing,
        // so point at the free-only verb, not at the paying one. Machine consumers
        // read this; the human line below says the same thing.
        nextCommand: `tenjin read ${ref.url}`,
      },
      humanLines: [
        `${sanitizeForTerminal(body.title)}, free (${body.price} atomic). Read it with \`tenjin read ${sanitizeForTerminal(ref.url)}\`.`,
      ],
    };
  }

  if (result.kind === 'payment_required') {
    const requirement = result.paymentRequired.accepts[0];
    const price = requirement !== undefined ? toMoney(requirement.amount) : undefined;
    const card = result.preview.card;
    return {
      data: {
        url: ref.url,
        ...(ref.resourceId !== undefined ? { resourceId: ref.resourceId } : {}),
        access: 'paid',
        ...(price !== undefined ? { price } : {}),
        payment:
          requirement !== undefined
            ? {
                scheme: requirement.scheme,
                network: requirement.network,
                asset: requirement.asset,
                payTo: requirement.payTo,
                amount: requirement.amount,
              }
            : undefined,
        // The card stays where the wire puts it, inside `preview`, and is emitted
        // exactly once: it is the largest object in this envelope, and a second
        // hoisted copy would double every inspect payload to save one key of
        // depth.
        preview: result.preview,
        ...(result.cardError === true ? { cardError: true } : {}),
        // Paid and unowned: this one really does cost money, so it keeps pointing at
        // `buy`. `tenjin read` would refuse it with exit 3.
        nextCommand: `tenjin buy ${ref.url}`,
      },
      humanLines: [
        `Paid resource${price !== undefined ? `, ${price.usd} USD (${price.atomic} atomic)` : ''}.`,
        ...cardLines(card),
        // Three distinct states behind an absent card, and they call for three
        // different actions: the piece attests nothing (a signal, judge on that),
        // the server could not load a card it has (transient, retry), or this CLI
        // could not parse what arrived (a client-side bug or server drift). Only
        // the last is ours. `cardUnavailable` is server-sent and never rides
        // alongside a card, so it is only worth saying when there is no card.
        ...(card === undefined && result.preview.cardUnavailable === true
          ? ['The piece has a card the server could not load; retry later.']
          : []),
        ...(result.cardError === true
          ? [
              'The server sent an answer card this CLI could not parse; judging on price and preview only.',
            ]
          : []),
        'This is the pre-purchase card; run `tenjin buy` to pay and read (`tenjin read` refuses paid pieces).',
      ],
    };
  }

  // already_purchased without a payment header is unexpected; report it plainly.
  // Owned means delivery is free, so this branch points at `read` too.
  return {
    data: {
      url: ref.url,
      access: 'entitled',
      message: result.message,
      nextCommand: `tenjin read ${ref.url}`,
    },
    humanLines: [
      `${sanitizeForTerminal(result.message)} Read it with \`tenjin read ${sanitizeForTerminal(ref.url)}\`.`,
    ],
  };
}

/**
 * Per-line caps for the rendered card, each derived from the server's write-time
 * bound for that field, so a VALID card is never clipped: the two lists are 10
 * items x 200 chars joined with '; '; appliesTo is 8 keys (<=32 chars) x 20
 * values x 120 chars; the prose fields have a 500-char column bound and cadence
 * 120. Exceeding one means a server that broke its own bounds.
 *
 * When that happens the clip is MARKED. A silently shortened claim reads as a
 * whole one, and "applies to Postgres 14, 15" is a different promise from
 * "applies to Postgres 14, 15, 16". The `--json` payload stays verbatim either
 * way, because that copy is what an agent decides a non-refundable purchase on.
 */
const CARD_BOUNDS = {
  list: 10 * 200 + 9 * 2,
  appliesTo: 8 * (32 + 1 + 20 * 120 + 19 * 2) + 7 * 2,
  prose: 500,
  cadence: 120,
  // artifactType and temporalMode are open strings on the wire, so the composed
  // freshness line gets a bound of its own rather than trusting them.
  freshness: 200,
} as const;

const CLIP_MARKER = '...';

function cardLine(label: string, value: string | null, max: number): string[] {
  if (value === null) return [];
  const text = sanitizeForTerminal(value).trim();
  if (text.length === 0) return [];
  return [`${label}: ${text.length > max ? `${text.slice(0, max)}${CLIP_MARKER}` : text}`];
}

/**
 * The answer card off the 402 body, as human lines. This is the depth half of the
 * search/inspect split: search v2 returns lean hits, and the card an agent judges
 * fit on arrives here, for free. Empty when the piece carries no card, so an
 * uncarded inspect renders exactly as it did before.
 */
function cardLines(card: PreviewCard | undefined): string[] {
  if (card === undefined) return [];
  const list = (items: string[]): string | null => (items.length > 0 ? items.join('; ') : null);
  const appliesTo = Object.entries(card.appliesTo).map(
    ([key, values]) => `${key}=${values.join(', ')}`,
  );
  return [
    ...cardLine('Answers', list(card.questionsAnswered), CARD_BOUNDS.list),
    ...cardLine('Tasks', list(card.tasksSupported), CARD_BOUNDS.list),
    ...cardLine('Applies to', list(appliesTo), CARD_BOUNDS.appliesTo),
    ...cardLine('Scope', card.scope, CARD_BOUNDS.prose),
    ...cardLine('Excludes', card.exclusions, CARD_BOUNDS.prose),
    ...cardLine('Freshness', freshness(card), CARD_BOUNDS.freshness),
    ...cardLine('Provenance', card.provenanceSummary, CARD_BOUNDS.prose),
    ...cardLine('Method', card.methodologySummary, CARD_BOUNDS.prose),
    ...cardLine('Maintenance', card.maintenanceCadence, CARD_BOUNDS.cadence),
  ];
}

/** Type, temporal mode and the two dates on one line: they answer the single
 *  question a buyer asks of freshness, which is whether this is still true here.
 *
 *  Both labels are open strings on the wire, so an empty one is dropped rather
 *  than joined: otherwise the line leads with a comma and reads as a rendering
 *  bug. All four empty yields '', and cardLine then omits the line entirely. */
function freshness(card: PreviewCard): string {
  const parts = [card.artifactType, card.temporalMode].filter((s) => s.trim().length > 0);
  if (card.asOf !== null) parts.push(`as of ${card.asOf}`);
  if (card.validUntil !== null) parts.push(`valid until ${card.validUntil}`);
  return parts.join(', ');
}
