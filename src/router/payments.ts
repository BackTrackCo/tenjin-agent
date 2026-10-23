import { ATOMIC_RE } from '../lib/ids';
import { formatUsdDisplay, toMoney } from '../lib/money';
import { sanitizeForTerminal } from '../lib/output';
import { paidLedgerPath } from '../lib/paths';
import { resolveContextSettings } from '../lib/settings';
import type { CommandContext, CommandResult } from '../context';
import { readPaidRecords, reconcilePayments, type Settlement } from './paid';

/** How many of the newest records a bare `tenjin payments` prints. */
const LIST_LIMIT = 20;

const SETTLEMENT_WORDS: Record<Settlement, string> = {
  settled: 'settled',
  unknown: 'unknown',
  not_charged: 'not charged',
  account: 'your account',
};

/**
 * `tenjin payments`: the newest paid lookups in the ledger, newest first, at
 * most {@link LIST_LIMIT}. It reads the local file and nothing else; a record
 * whose settlement is unknown stays unknown here until `reconcile` asks.
 */
export async function runPaymentsList(ctx: CommandContext): Promise<CommandResult> {
  const ledger = paidLedgerPath(ctx.dataDir);
  const records = (await readPaidRecords(ctx.dataDir)).filter((record) =>
    ATOMIC_RE.test(record.amountAtomic),
  );
  const payments = records
    .slice(-LIST_LIMIT)
    .reverse()
    .map((record) => ({
      at: record.ts,
      provider: record.provider,
      service: record.capabilityId,
      amount: toMoney(record.amountAtomic),
      settlement: record.settlement,
      ...(record.txHash !== undefined ? { txHash: record.txHash } : {}),
      // Run in a native search's or fetch's place, which nobody was asked about.
      ...(record.via !== undefined ? { via: record.via } : {}),
    }));
  const unknown = records.filter((record) => record.settlement === 'unknown').length;
  if (payments.length === 0) {
    return {
      data: { ledger, total: 0, payments },
      humanLines: ['No paid lookups on this machine yet.'],
    };
  }
  const header = ['TIME (UTC)', 'PROVIDER', 'SERVICE', 'AMOUNT', 'STATUS', 'TX'];
  const cells = [
    header,
    ...payments.map((p) => [
      p.at.slice(0, 16).replace('T', ' '),
      sanitizeForTerminal(p.provider),
      `${sanitizeForTerminal(p.service)}${p.via === 'swap' ? ' (in place)' : ''}`,
      // A call on the user's own account: their plan paid, the balance nothing.
      p.settlement === 'account' ? '-' : `$${formatUsdDisplay(p.amount.atomic)}`,
      SETTLEMENT_WORDS[p.settlement] ?? p.settlement,
      p.txHash ?? '',
    ]),
  ];
  const width = header.map((_, i) => Math.max(...cells.map((row) => (row[i] ?? '').length)));
  return {
    data: { ledger, total: records.length, payments },
    humanLines: [
      ...cells.map((row) =>
        row
          .map((cell, i) => cell.padEnd(width[i] ?? 0))
          .join('  ')
          .trimEnd(),
      ),
      records.length > payments.length
        ? `The newest ${payments.length} of ${records.length}; every one is in ${ledger}.`
        : `From ${ledger}.`,
      ...(unknown > 0
        ? [
            `${unknown} with settlement unknown: \`tenjin payments reconcile\` asks the chain once they expire.`,
          ]
        : []),
    ],
  };
}

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
