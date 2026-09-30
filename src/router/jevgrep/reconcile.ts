import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { CommandContext } from '../../context';
import { spendLedgerPath } from '../../lib/paths';
import { resolveContextSettings } from '../../lib/settings';
import { readLedger, type DurableSpend } from '../../lib/spend-ledger';
import { createLocalSpendAuthorizer } from '../../lib/wallet/spend';

export interface ReconcileReport {
  /** Durable records still marked signed before this run. */
  unresolved: number;
  /** Of those, records whose evaluation has a validated response in the journal. */
  answered: number;
  /** Records moved to settled by this run (zero on a dry run). */
  settled: number;
  applied: boolean;
  /** Signed exposure that stays unresolved afterwards, in atomic USDC. */
  remainingUnknownAtomic: string;
}

/** The identities of every evaluation whose provider response was saved. */
async function answeredIdentities(dataDir: string): Promise<Set<string>> {
  const root = join(dataDir, 'jevgrep', 'payments');
  const identities = new Set<string>();
  let runs: string[];
  try {
    runs = await readdir(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return identities;
    throw error;
  }
  for (const run of runs) {
    if (!/^[a-f0-9]{64}$/.test(run)) continue;
    let names: string[];
    try {
      names = await readdir(join(root, run));
    } catch {
      continue;
    }
    for (const name of names) {
      const match = /^([a-f0-9]{64})\.response\.json$/.exec(name);
      if (match) identities.add(match[1]!);
    }
  }
  return identities;
}

/**
 * Builds written before settlement tracking left every signed evaluation
 * unresolved, charging the daily budget forever. The journal knows which of
 * them the provider actually answered: those settle into the current window
 * here, exactly as a new evaluation would at response time. Records without a
 * saved response stay unresolved; nothing is deleted.
 */
export async function reconcileJevgrepLedger(
  ctx: CommandContext,
  options: { apply: boolean },
): Promise<ReconcileReport> {
  const { ledger } = await readLedger(spendLedgerPath(ctx.dataDir));
  const signed: DurableSpend[] = (ledger?.durable ?? []).filter(
    (entry) => entry.state === 'signed',
  );
  const answered = await answeredIdentities(ctx.dataDir);
  const matches = signed.filter((entry) => answered.has(entry.requestKey));
  let settled = 0;
  if (options.apply && matches.length > 0) {
    const { policy } = await resolveContextSettings(ctx);
    const authorizer = createLocalSpendAuthorizer({ dir: ctx.dataDir, policy });
    for (const entry of matches) {
      await authorizer.settleDurable!(entry.id);
      settled++;
    }
  }
  const remaining = signed
    .filter((entry) => !(options.apply && answered.has(entry.requestKey)))
    .reduce((sum, entry) => sum + BigInt(entry.amountAtomic), 0n);
  return {
    unresolved: signed.length,
    answered: matches.length,
    settled,
    applied: options.apply,
    remainingUnknownAtomic: remaining.toString(),
  };
}
