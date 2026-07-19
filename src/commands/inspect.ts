import { resolveResourceRef } from '../lib/resource-ref';
import { resolveContextSettings } from '../lib/settings';
import { fetchRead } from '../lib/read-client';
import { toMoney } from '../lib/money';
import { headingOutline } from '../lib/markdown';
import { sanitizeForTerminal } from '../lib/output';
import type { CommandContext, CommandResult } from '../context';

/**
 * `tenjin inspect <resource-url-or-id>`, fetch the pre-purchase answer card /
 * preview from the read route's 402 body WITHOUT paying (spec 10). A free
 * resource returns 200 with the whole body; a paid one returns the leak-safe
 * preview plus the advertised price/network. Never signs, never pays, never saves.
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
      },
      humanLines: [
        `Paid resource${price !== undefined ? `, ${price.usd} USD (${price.atomic} atomic)` : ''}.`,
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
