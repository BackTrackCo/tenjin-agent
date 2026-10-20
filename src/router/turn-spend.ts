import { formatUsdDisplay } from '../lib/money';
import { readSpendSummary, spentOf } from '../lib/spend-ledger';

/**
 * WHAT A TURN PAID, IN ONE LINE: `2 paid lookups, $0.09 · today $0.31 of
 * $5.00`. The `Stop` leg's `systemMessage`, which Claude Code shows the user
 * under the turn's answer, never the model. `paid` is each payment `tenjin mcp`
 * made since the last turn ended, one per take or option; today is the spend
 * ledger's rolling day, counted as the budget counts it. Null when the turn
 * paid nothing.
 */
export async function turnSpendLine(
  paid: readonly bigint[],
  dataDir: string,
  budgetAtomic: bigint | null,
  now?: () => number,
): Promise<string | null> {
  if (paid.length === 0) return null;
  const total = paid.reduce((sum, amount) => sum + amount, 0n);
  const head = `${paid.length} paid lookup${paid.length === 1 ? '' : 's'}, $${usd(total)}`;
  const ledger = await readSpendSummary(dataDir, now !== undefined ? { now } : {}).catch(
    () => null,
  );
  if (ledger === null) return head;
  const limit = budgetAtomic === null ? '' : ` of $${usd(budgetAtomic)}`;
  return `${head} · today $${usd(spentOf(ledger))}${limit}`;
}

const usd = (atomic: bigint): string => formatUsdDisplay(atomic.toString());
