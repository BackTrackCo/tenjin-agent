import { CliError } from '../lib/errors';
import { ATOMIC_RE } from '../lib/ids';
import { formatUsdDisplay, toMoney } from '../lib/money';
import { sanitizeForTerminal } from '../lib/output';
import { paidLedgerPath } from '../lib/paths';
import type { CommandContext, CommandResult } from '../context';
import { savedAccounts } from './accounts/saved';
import { BUILT_IN_SOURCE } from './decision';
import { readPaidRecords, type PaidRecord } from './paid';

/**
 * `tenjin usage [--since 7d]`: WHAT THIS MACHINE'S LOOKUPS COST, BY DAY AND BY
 * WHO RAN THEM. Tenjin's own tools, paid from the Tenjin balance, and each of
 * the user's connected accounts, billed to that account's own plan, which
 * Tenjin neither sees nor limits. It reads the local ledger and nothing else.
 *
 * The routing fee is not in it: the ledger keeps the calls a lookup made, and
 * the fee's history lives only in today's spend window (`tenjin status`).
 */

export interface UsageOptions {
  /** How far back: `24h`, `7d`, `30d`, or a date (`2026-10-01`). Default 7d. */
  since?: string;
}

const DAY_MS = 24 * 60 * 60_000;
const MAX_DAYS = 366;

/** The start of the window `since` names, in ms. */
export function sinceMs(since: string | undefined, now: number): number {
  const text = (since ?? '7d').trim();
  const span = /^(\d{1,4})([hd])$/.exec(text);
  if (span !== null) {
    const n = Number(span[1]);
    const ms = span[2] === 'h' ? n * 60 * 60_000 : n * DAY_MS;
    if (n > 0 && ms <= MAX_DAYS * DAY_MS) return now - ms;
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    const at = Date.parse(`${text}T00:00:00.000Z`);
    if (Number.isFinite(at) && at <= now && now - at <= MAX_DAYS * DAY_MS) return at;
  }
  throw new CliError(
    'USAGE',
    `--since takes 24h, 7d, 30d or a date such as 2026-10-01; got "${text}".`,
    {
      fix: 'tenjin usage --since 7d',
    },
  );
}

/** Who ran a row: a connected account, by its `source`, or Tenjin's tools,
 *  which every row the balance paid is. */
function sourceOf(record: PaidRecord): string {
  return record.settlement === 'account'
    ? (record.source ?? record.identity?.source ?? BUILT_IN_SOURCE)
    : BUILT_IN_SOURCE;
}

interface Group {
  day: string;
  source: string;
  label: string;
  calls: number;
  /** From the Tenjin balance; null on an account, whose plan paid. */
  spentAtomic: bigint | null;
}

export async function runRouterUsage(
  ctx: CommandContext,
  opts: UsageOptions = {},
  deps: { now?: () => number } = {},
): Promise<CommandResult> {
  const now = (deps.now ?? Date.now)();
  const from = sinceMs(opts.since, now);
  const names = new Map((await savedAccounts(ctx.dataDir)).map(({ id, label }) => [id, label]));
  const records = (await readPaidRecords(ctx.dataDir)).filter((record) => {
    const at = Date.parse(record.ts);
    return Number.isFinite(at) && at >= from && at <= now && ATOMIC_RE.test(record.amountAtomic);
  });
  const groups = new Map<string, Group>();
  for (const record of records) {
    const source = sourceOf(record);
    const account = record.settlement === 'account';
    const day = record.ts.slice(0, 10);
    const key = `${day}\0${source}`;
    const group = groups.get(key) ?? {
      day,
      source,
      label: account ? `your ${names.get(source) ?? record.provider} account` : "Tenjin's tools",
      calls: 0,
      spentAtomic: account ? null : 0n,
    };
    group.calls += 1;
    if (group.spentAtomic !== null) group.spentAtomic += BigInt(record.amountAtomic);
    groups.set(key, group);
  }
  const rows = [...groups.values()].sort(
    (a, b) => b.day.localeCompare(a.day) || a.label.localeCompare(b.label),
  );
  const balanceAtomic = rows.reduce((sum, row) => sum + (row.spentAtomic ?? 0n), 0n);
  const balanceCalls = rows
    .filter((row) => row.spentAtomic !== null)
    .reduce((n, r) => n + r.calls, 0);
  const accountCalls = rows
    .filter((row) => row.spentAtomic === null)
    .reduce((n, r) => n + r.calls, 0);
  const sinceDay = new Date(from).toISOString().slice(0, 10);
  const data = {
    ledger: paidLedgerPath(ctx.dataDir),
    since: new Date(from).toISOString(),
    days: rows.map((row) => ({
      day: row.day,
      source: row.source,
      label: row.label,
      calls: row.calls,
      ...(row.spentAtomic !== null
        ? { spent: toMoney(row.spentAtomic.toString()) }
        : { billedTo: 'account' }),
    })),
    totals: {
      balance: toMoney(balanceAtomic.toString()),
      balanceCalls,
      accountCalls,
    },
  };
  const width = Math.max(0, ...rows.map((row) => row.label.length));
  const calls = (n: number) => `${n} ${n === 1 ? 'call' : 'calls'}`;
  return {
    data,
    humanLines:
      rows.length === 0
        ? [`No lookups on this machine since ${sinceDay}.`]
        : [
            `Since ${sinceDay}:`,
            ...rows.map(
              (row) =>
                `${row.day}  ${sanitizeForTerminal(row.label).padEnd(width)}  ${calls(row.calls).padEnd(9)}  ${
                  row.spentAtomic !== null
                    ? `$${formatUsdDisplay(row.spentAtomic.toString())}`
                    : 'billed to that account'
                }`,
            ),
            `Total: $${formatUsdDisplay(balanceAtomic.toString())} from your Tenjin balance over ${calls(balanceCalls)}` +
              (accountCalls > 0
                ? `; ${calls(accountCalls)} on your own accounts, billed to their plans and not counted in the limit.`
                : '.'),
            "Routing fees aren't in this history; `tenjin status` shows today's spending with them.",
          ],
  };
}
