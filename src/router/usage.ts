import { CliError } from '../lib/errors';
import { ATOMIC_RE } from '../lib/ids';
import { toMoney } from '../lib/money';
import { paint, sanitizeForTerminal } from '../lib/output';
import { paidLedgerPath } from '../lib/paths';
import type { CommandContext, CommandResult } from '../context';
import { savedAccounts } from './accounts/saved';
import { BUILT_IN_SOURCE } from './settings-wire';
import { readPaidRecords, type PaidRecord } from './paid';

/**
 * `tenjin usage [--since 7d]`: WHAT THIS MACHINE'S LOOKUPS COST, BY DAY AND BY
 * WHO RAN THEM. Tenjin's own tools, paid from the Tenjin balance, and each of
 * the user's connected accounts, billed to that account's own plan, which
 * Tenjin neither sees nor limits. A call on an account whose charge is unknown
 * (still running, failed after the account's job started, or answered with
 * the account's own error) has its own row that says it may have charged, and
 * is never counted with the calls that billed. It reads the local ledger and
 * nothing else.
 *
 * The routing fee is not in it: the ledger keeps the calls a lookup made, and
 * the fee's history lives only in today's spend window (`tenjin status`), so
 * the table says so in one dim line.
 */

export interface UsageOptions {
  /** How far back: `24h`, `7d`, `30d`, or a date (`2026-10-01`). Default 7d. */
  since?: string;
}

const DAY_MS = 24 * 60 * 60_000;
const MAX_DAYS = 366;

/** The start of the window `since` names, in ms, and its name: "Last 7 days". */
export function sinceWindow(
  since: string | undefined,
  now: number,
): { from: number; title: string } {
  const text = (since ?? '7d').trim();
  const span = /^(\d{1,4})([hd])$/.exec(text);
  if (span !== null) {
    const n = Number(span[1]);
    const hours = span[2] === 'h';
    const ms = hours ? n * 60 * 60_000 : n * DAY_MS;
    const unit = hours ? 'hour' : 'day';
    if (n > 0 && ms <= MAX_DAYS * DAY_MS)
      return { from: now - ms, title: n === 1 ? `Last ${unit}` : `Last ${n} ${unit}s` };
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    const at = Date.parse(`${text}T00:00:00.000Z`);
    if (Number.isFinite(at) && at <= now && now - at <= MAX_DAYS * DAY_MS)
      return { from: at, title: `Since ${text}` };
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
  return record.settlement === 'account' ? (record.source ?? BUILT_IN_SOURCE) : BUILT_IN_SOURCE;
}

interface Group {
  day: string;
  source: string;
  label: string;
  /** Who ran it, as the human table names it: "Tenjin's tools", "fal". */
  name: string;
  calls: number;
  /** From the Tenjin balance; null on an account, whose plan paid. */
  spentAtomic: bigint | null;
  /** Calls on an account whose charge is unknown: they may have charged it. */
  mayHaveCharged: boolean;
}

export async function runRouterUsage(
  ctx: CommandContext,
  opts: UsageOptions = {},
  deps: { now?: () => number } = {},
): Promise<CommandResult> {
  const now = (deps.now ?? Date.now)();
  const { from, title } = sinceWindow(opts.since, now);
  const names = new Map((await savedAccounts(ctx.dataDir)).map(({ id, label }) => [id, label]));
  // A PAYMENT THE CHAIN SAYS WAS NEVER USED (`not_charged`, from reconcile)
  // never left the balance: it is no spending, and no call that cost anything.
  const records = (await readPaidRecords(ctx.dataDir)).filter((record) => {
    const at = Date.parse(record.ts);
    return (
      record.settlement !== 'not_charged' &&
      Number.isFinite(at) &&
      at >= from &&
      at <= now &&
      ATOMIC_RE.test(record.amountAtomic)
    );
  });
  const groups = new Map<string, Group>();
  for (const record of records) {
    const source = sourceOf(record);
    const account = record.settlement === 'account';
    const mayHaveCharged = account && record.charge === 'unknown';
    const day = record.ts.slice(0, 10);
    const key = `${day}\0${source}\0${mayHaveCharged ? 'maybe' : ''}`;
    const group = groups.get(key) ?? {
      day,
      source,
      label: account ? `your ${names.get(source) ?? record.provider} account` : "Tenjin's tools",
      name: account ? (names.get(source) ?? record.provider) : "Tenjin's tools",
      calls: 0,
      spentAtomic: account ? null : 0n,
      mayHaveCharged,
    };
    group.calls += 1;
    if (group.spentAtomic !== null) group.spentAtomic += BigInt(record.amountAtomic);
    groups.set(key, group);
  }
  const rows = [...groups.values()].sort(
    (a, b) =>
      b.day.localeCompare(a.day) ||
      a.label.localeCompare(b.label) ||
      Number(a.mayHaveCharged) - Number(b.mayHaveCharged),
  );
  const balanceAtomic = rows.reduce((sum, row) => sum + (row.spentAtomic ?? 0n), 0n);
  const callsWhere = (keep: (row: Group) => boolean) =>
    rows.filter(keep).reduce((n, r) => n + r.calls, 0);
  const balanceCalls = callsWhere((row) => row.spentAtomic !== null);
  const accountCalls = callsWhere((row) => row.spentAtomic === null && !row.mayHaveCharged);
  const mayHaveChargedCalls = callsWhere((row) => row.mayHaveCharged);
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
        : row.mayHaveCharged
          ? { mayHaveCharged: 'account' }
          : { billedTo: 'account' }),
    })),
    totals: {
      balance: toMoney(balanceAtomic.toString()),
      balanceCalls,
      accountCalls,
      mayHaveChargedCalls,
    },
  };
  return { data, humanLines: usageTable(ctx, title, rows, balanceAtomic, { from, now }) };
}

/** `$1.14`, rounded to the cent; a charge under half a cent is `<$0.01`. */
function cents(atomic: bigint): string {
  if (atomic > 0n && atomic < 5_000n) return '<$0.01';
  const total = (atomic + 5_000n) / 10_000n;
  return `$${total / 100n}.${(total % 100n).toString().padStart(2, '0')}`;
}

/** `Nov 13`, and the year too when it is not this one. */
function shortDay(day: string, now: number): string {
  const at = new Date(`${day}T00:00:00.000Z`);
  const sameYear = at.getUTCFullYear() === new Date(now).getUTCFullYear();
  return at.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' }),
    timeZone: 'UTC',
  });
}

/** The days as a table: a header, one row a day and who ran it, the total. */
function usageTable(
  ctx: CommandContext,
  title: string,
  rows: readonly Group[],
  balanceAtomic: bigint,
  { from, now }: { from: number; now: number },
): string[] {
  if (rows.length === 0)
    return [
      title.startsWith('Since')
        ? `No lookups ${title.toLowerCase()}.`
        : `No lookups in the ${title.toLowerCase()}.`,
    ];
  const shown = rows.map((row) => ({
    day: shortDay(row.day, now),
    name: sanitizeForTerminal(row.name),
    calls: String(row.calls),
    cost:
      row.spentAtomic !== null
        ? cents(row.spentAtomic)
        : row.mayHaveCharged
          ? 'may have charged'
          : 'your plan',
  }));
  const dayWidth = Math.max(...shown.map(({ day }) => day.length));
  const nameWidth = Math.max(...shown.map(({ name }) => name.length));
  const callsWidth = Math.max('calls'.length, ...shown.map(({ calls }) => calls.length));
  const left = Math.max(2 + dayWidth + 3 + nameWidth, title.length);
  const line = (start: string, calls: string, cost: string) =>
    `${start.padEnd(left)}  ${calls.padStart(callsWidth)}    ${cost}`;
  const total = cents(balanceAtomic);
  const width = Math.max(...shown.map(({ cost }) => cost.length), total.length, 'cost'.length);
  return [
    line(title, 'calls', 'cost'),
    ...shown.map(({ day, name, calls, cost }) =>
      line(`  ${day.padEnd(dayWidth)}   ${name.padEnd(nameWidth)}`, calls, cost),
    ),
    `  ${'─'.repeat(left - 2 + 2 + callsWidth + 4 + width)}`,
    `${line('  Total', '', total)}  from your Tenjin balance`,
    paint(
      ctx.io,
      'dim',
      `Routing fees aren't in this history.${now - from < 30 * DAY_MS ? ' For longer: tenjin usage --since 30d' : ''}`,
    ),
  ];
}
