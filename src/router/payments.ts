import { toMoney } from '../lib/money';
import { paidLedgerPath } from '../lib/paths';
import { resolveContextSettings } from '../lib/settings';
import type { CommandContext, CommandResult } from '../context';
import { reconcilePayments } from './paid';

/**
 * `tenjin payments reconcile`: settle every "settlement unknown" record in the
 * paid ledger that the chain can now answer for. The `request` tool runs the
 * same pass, three records at a time, before each lookup; this one asks about
 * up to {@link MAX_COMMAND_CHECKS}.
 *
 * A record found not charged also gives its amount back to the daily budget,
 * when the spend ledger still holds that payment's exposure in this window.
 */

const MAX_COMMAND_CHECKS = 50;

export interface PaymentsDeps {
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export async function runPaymentsReconcile(
  ctx: CommandContext,
  deps: PaymentsDeps = {},
): Promise<CommandResult> {
  const settings = await resolveContextSettings(ctx);
  const outcome = await reconcilePayments(ctx.dataDir, {
    rpcUrl: settings.rpcUrl,
    max: MAX_COMMAND_CHECKS,
    ...(deps.fetchImpl !== undefined ? { fetchImpl: deps.fetchImpl } : {}),
    ...(deps.now !== undefined ? { now: deps.now } : {}),
  });
  return {
    data: { ledger: paidLedgerPath(ctx.dataDir), ...outcome },
    humanLines: [
      outcome.checked === 0
        ? 'No paid lookup is waiting on its settlement.'
        : `Checked ${outcome.checked}: ${outcome.settled} charged, ${outcome.notCharged} not charged.` +
          (outcome.releasedAtomic !== '0'
            ? ` ${toMoney(outcome.releasedAtomic).usd} USD went back to today's limit.`
            : ''),
      ...(outcome.unknown > 0
        ? [`${outcome.unknown} still unknown: not expired yet, or the chain could not say.`]
        : []),
    ],
  };
}
