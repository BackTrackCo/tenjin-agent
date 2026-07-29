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
 * The card is the depth half of the search/inspect split: search v2 candidates are
 * lean, so this free call is where an agent gets what it answers, what it applies
 * to, what it excludes, and how it is dated, before spending anything.
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
  const ref = await resolveResourceRef(args.ref, ctx.dataDir, settings.baseUrl);

  const result = await fetchRead(ref.url, {
    timeoutMs: ctx.flags.timeout,
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
      },
      humanLines: [
        `${sanitizeForTerminal(body.title)}, free (${body.price} atomic). Read it with \`tenjin buy\`.`,
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
        preview: result.preview,
        // Hoisted out of `preview` so the card is a first-class part of the
        // envelope, which is what an agent decides to buy on. Absent, never null,
        // when the piece carries no card, matching the wire.
        ...(card !== undefined ? { card } : {}),
      },
      humanLines: [
        `Paid resource${price !== undefined ? `, ${price.usd} USD (${price.atomic} atomic)` : ''}.`,
        ...cardLines(card),
        'This is the pre-purchase card; run `tenjin buy` to pay and read.',
      ],
    };
  }

  // already_purchased without a payment header is unexpected; report it plainly.
  return {
    data: { url: ref.url, access: 'entitled', message: result.message },
    humanLines: [sanitizeForTerminal(result.message)],
  };
}

/** Per-line cap for the rendered card. Every card field is already bounded at
 *  write time (lists 10x200 chars, prose 500, cadence 120), so this only bites a
 *  misbehaving server, and it bites only the terminal: the `--json` payload keeps
 *  the card exactly as the server sent it, because that copy is what an agent
 *  decides a non-refundable purchase on. */
const CARD_LINE_CHARS = 300;

function cardLine(label: string, value: string | null): string[] {
  if (value === null) return [];
  const text = sanitizeForTerminal(value).trim();
  if (text.length === 0) return [];
  return [`${label}: ${text.length > CARD_LINE_CHARS ? text.slice(0, CARD_LINE_CHARS) : text}`];
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
    ...cardLine('Answers', list(card.questionsAnswered)),
    ...cardLine('Tasks', list(card.tasksSupported)),
    ...cardLine('Applies to', list(appliesTo)),
    ...cardLine('Scope', card.scope),
    ...cardLine('Excludes', card.exclusions),
    ...cardLine('Freshness', freshness(card)),
    ...cardLine('Provenance', card.provenanceSummary),
    ...cardLine('Method', card.methodologySummary),
    ...cardLine('Maintenance', card.maintenanceCadence),
  ];
}

/** Type, temporal mode and the two dates on one line: they answer the single
 *  question a buyer asks of freshness, which is whether this is still true here. */
function freshness(card: PreviewCard): string {
  const parts = [card.artifactType, card.temporalMode];
  if (card.asOf !== null) parts.push(`as of ${card.asOf}`);
  if (card.validUntil !== null) parts.push(`valid until ${card.validUntil}`);
  return parts.join(', ');
}
