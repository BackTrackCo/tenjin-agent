import { loadRawConfig } from '../lib/config';
import { toMoney } from '../lib/money';
import { paidLedgerPath } from '../lib/paths';
import { resolveContextSettings } from '../lib/settings';
import type { CommandContext, CommandResult } from '../context';
import { routingAllowanceAtomic, routingFeeApproved } from './fee';
import { feeSummary } from './fee-readouts';
import { ROUTING_FEE_ATOMIC } from './fee-state';
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
    // Asked for by hand: every due record, however recently it was asked about.
    recheckMs: 0,
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

/**
 * `tenjin payments fees`: the routing fee beside the provider payments. Read
 * from the SDK's channel files and the fee lines alone: what the server has
 * charged per channel, what the channels still hold, and what the rolling 24 h
 * window has used of the allowance.
 */
export async function runPaymentsFees(
  ctx: CommandContext,
  deps: Pick<PaymentsDeps, 'now'> = {},
): Promise<CommandResult> {
  const config = await loadRawConfig(ctx.dataDir).catch(() => ({}));
  const summary = await feeSummary(ctx.dataDir, (deps.now ?? Date.now)());
  const allowance = routingAllowanceAtomic(config).toString();
  return {
    data: {
      approved: routingFeeApproved(config),
      perCall: toMoney(ROUTING_FEE_ATOMIC.toString()),
      last24h: toMoney(summary.windowAtomic),
      allowance: toMoney(allowance),
      charged: toMoney(summary.chargedAtomic),
      channelCredit: toMoney(summary.creditAtomic),
      channels: summary.channels.map((channel) => ({
        channelId: channel.channelId,
        deposited: toMoney(channel.depositedAtomic),
        charged: toMoney(channel.chargedAtomic),
      })),
    },
    humanLines:
      summary.channels.length === 0
        ? ['No routing fee paid: this machine has no routing channel.']
        : [
            `Routing fees: ${toMoney(summary.chargedAtomic).usd} USD charged in all, ${toMoney(summary.windowAtomic).usd} USD of ${toMoney(allowance).usd} USD in the rolling 24h window.`,
            ...summary.channels.map(
              (channel) =>
                `channel ${channel.channelId.slice(0, 10)}: ${toMoney(channel.depositedAtomic).usd} USD deposited, ${toMoney(channel.chargedAtomic).usd} USD charged`,
            ),
            `${toMoney(summary.creditAtomic).usd} USD left in the channels for later fees.`,
          ],
  };
}
