import { resolveResourceRef } from '../lib/resource-ref';
import { resolveContextSettings, shelfRouteFor, type ResolvedSettings } from '../lib/settings';
import { fetchRead, type PreviewCard } from '../lib/read-client';
import { getPostMetadata, type PostMetadata } from '../lib/agent-api';
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

  // Lazy and memoized: a live GET /api/posts/<id>/public call, made only for a
  // ref resolved via a bare id (a URL-only ref has no id to look up) and only
  // when a caller below actually needs it — the common case (an entitled body,
  // or a 402 preview that already names a title) never triggers this. Routed
  // through `shelfRouteFor` the same way every other id-keyed lookup is, so
  // the bypass secret only rides to the shelf it was paired with.
  let metadataPromise: Promise<PostMetadata | null> | undefined;
  const displayMetadata = (): Promise<PostMetadata | null> => {
    const resourceId = ref.resourceId;
    if (metadataPromise === undefined) {
      metadataPromise =
        resourceId === undefined
          ? Promise.resolve(null)
          : fetchDisplayMetadata(resourceId, ref.shelfBaseUrl, ctx, settings, deps);
    }
    return metadataPromise;
  };

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
    // The 402 preview already names a title on every deployment that sends one
    // (zero extra network cost); a title-less preview — an older deployment, or
    // one that omits it for some other reason — falls back to the live
    // GET /api/posts/<id>/public lookup. Never a default: `title` stays
    // undefined, and the line below reads exactly as it always has, when
    // neither source has one. Either source is a PUBLISHER's string on a
    // public marketplace, so it is bounded the same as every other server
    // string this command renders (`boundedTitle`), not trusted at whatever
    // length it arrives.
    const rawTitle = result.preview.title ?? (await displayMetadata())?.title;
    const title = rawTitle !== undefined ? boundedTitle(rawTitle) : undefined;
    return {
      data: {
        url: ref.url,
        ...(ref.resourceId !== undefined ? { resourceId: ref.resourceId } : {}),
        access: 'paid',
        ...(title !== undefined ? { title } : {}),
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
        title !== undefined
          ? `${title}, paid${price !== undefined ? `, ${price.usd} USD (${price.atomic} atomic)` : ''}.`
          : `Paid resource${price !== undefined ? `, ${price.usd} USD (${price.atomic} atomic)` : ''}.`,
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
  // Owned means delivery is free, so this branch points at `read` too. No 402
  // preview exists on this path at all (the result carries only a message), so
  // title/price come only from the live metadata lookup below when the ref
  // resolved via id — absent, never invented, when it doesn't. Bounded the
  // same way the payment_required branch's title is (`boundedTitle`): this is
  // a publisher's string, not this CLI's.
  //
  // `price` here is the piece's LISTED price off `#803`'s metadata, not an
  // amount due — this branch never asks for payment, so there is no amount to
  // report. A consumer reading `data.price` on this `access: 'entitled'` row
  // should read it as "what this piece lists for", same as the free branch's.
  const metadata = await displayMetadata();
  const ownedTitle = metadata !== null ? boundedTitle(metadata.title) : undefined;
  return {
    data: {
      url: ref.url,
      access: 'entitled',
      ...(ownedTitle !== undefined ? { title: ownedTitle } : {}),
      ...(metadata !== null ? { price: toMoney(metadata.price) } : {}),
      message: result.message,
      nextCommand: `tenjin read ${ref.url}`,
    },
    humanLines: [
      ...(ownedTitle !== undefined ? [`${ownedTitle}.`] : []),
      `${sanitizeForTerminal(result.message)} Read it with \`tenjin read ${sanitizeForTerminal(ref.url)}\`.`,
    ],
  };
}

/** A best-effort `GET /api/posts/<id>/public` lookup for a ref resolved via a
 *  bare id, routed the same way every other id-keyed shelf lookup is
 *  (`shelfRouteFor`): the bypass secret only carries to the shelf origin it
 *  was paired with, never to a second one. Callers gate on `ref.resourceId`
 *  before calling this (a URL-only ref has nothing to look up). */
async function fetchDisplayMetadata(
  resourceId: string,
  shelfBaseUrl: string,
  ctx: CommandContext,
  settings: ResolvedSettings,
  deps: InspectDeps,
): Promise<PostMetadata | null> {
  const route = shelfRouteFor({ shelfBaseUrl }, settings);
  return getPostMetadata(resourceId, {
    baseUrl: route.baseUrl,
    timeoutMs: ctx.flags.timeout,
    ...(route.bypass !== undefined ? { bypass: route.bypass } : {}),
    ...(deps.fetchImpl !== undefined ? { fetchImpl: deps.fetchImpl } : {}),
  });
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
  // A piece's title, off either the 402 preview or the live metadata lookup —
  // a PUBLISHER's string, on a public marketplace, read by `inspect` before an
  // agent has decided to trust the piece at all (PR 277 round-4 review).
  title: 200,
} as const;

const CLIP_MARKER = '...';

function cardLine(label: string, value: string | null, max: number): string[] {
  if (value === null) return [];
  const text = sanitizeForTerminal(value).trim();
  if (text.length === 0) return [];
  return [`${label}: ${text.length > max ? `${text.slice(0, max)}${CLIP_MARKER}` : text}`];
}

/** A server-supplied title, bounded like every other free-form field this
 *  command renders (`CARD_BOUNDS`) rather than trusted at whatever length a
 *  publisher sent — unlike the answer card's own JSON copy, which stays
 *  verbatim because an agent judges a purchase on its full text; a title is
 *  display text, not decision content. Empty after sanitizing/trimming reads
 *  as "no title", same as an empty card field. Applied uniformly to both the
 *  `--json` field and the human line: this is identifying text, not the
 *  once-per-purchase judgment call the card's own bound docblock is about. */
function boundedTitle(title: string): string | undefined {
  const text = sanitizeForTerminal(title).trim();
  if (text.length === 0) return undefined;
  return text.length > CARD_BOUNDS.title
    ? `${text.slice(0, CARD_BOUNDS.title)}${CLIP_MARKER}`
    : text;
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
