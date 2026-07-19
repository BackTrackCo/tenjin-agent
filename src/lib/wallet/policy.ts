import { readFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { writeFileAtomic } from '../atomic-json';
import { withFileLock } from '../lock';
import { atomicToUsd } from '../money';
import type { Config } from '../config';
import type { SpendDecision, SpendRequest } from './provider';

/**
 * The client-side spend policy engine (D35: enforcement lives in the provider
 * layer, commands only relay the decision). Honest posture: these are
 * guardrails against a runaway agent in THIS process, not a security boundary;
 * any local process can edit the config and ledger files.
 *
 * Semantics:
 * - sessionBudget is a rolling 24h ledger cap and refuses even an explicitly
 *   approved spend: a budget that a flag can bypass is not a budget.
 * - `--yes` (explicitApproval) substitutes for every confirm-class gate
 *   (maxAutoSpend, confirm policy, allowlist), because those exist to decide
 *   when a HUMAN or calling agent must approve, and an explicit approval is
 *   exactly that.
 * - Otherwise a spend is quiet only when it clears maxAutoSpend, the confirm
 *   policy, and the creator allowlist (when one is configured); anything else
 *   escalates to `confirm`, which the command turns into a TTY prompt or, in
 *   machine mode, a policy refusal (exit 3).
 */

export const SESSION_WINDOW_MS = 24 * 60 * 60 * 1000;

const LedgerSchema = z.object({
  entries: z.array(
    z.object({
      atomic: z.string().regex(/^\d+$/),
      at: z.string(),
      resourceId: z.string().optional(),
    }),
  ),
});
type Ledger = z.infer<typeof LedgerSchema>;

export function ledgerPath(dir: string): string {
  return join(dir, 'spend-ledger.json');
}

async function readLedger(dir: string): Promise<Ledger> {
  try {
    const raw = await readFile(ledgerPath(dir), 'utf8');
    return LedgerSchema.parse(JSON.parse(raw));
  } catch {
    // Missing is normal; corrupt degrades to empty. Undercounting on corruption
    // is acceptable for a client-side guardrail, silently blocking spends is not.
    return { entries: [] };
  }
}

export async function spentInWindow(dir: string, now: Date = new Date()): Promise<bigint> {
  const cutoff = now.getTime() - SESSION_WINDOW_MS;
  const ledger = await readLedger(dir);
  let sum = 0n;
  for (const entry of ledger.entries) {
    const at = Date.parse(entry.at);
    if (!Number.isNaN(at) && at >= cutoff) sum += BigInt(entry.atomic);
  }
  return sum;
}

export async function appendSpend(
  dir: string,
  entry: { amountAtomic: string; resourceId?: string },
  now: Date = new Date(),
): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const path = ledgerPath(dir);
  await withFileLock(`${path}.lock`, async () => {
    const ledger = await readLedger(dir);
    const cutoff = now.getTime() - SESSION_WINDOW_MS;
    const entries = ledger.entries.filter((e) => {
      const at = Date.parse(e.at);
      return !Number.isNaN(at) && at >= cutoff;
    });
    entries.push({
      atomic: entry.amountAtomic,
      at: now.toISOString(),
      ...(entry.resourceId !== undefined ? { resourceId: entry.resourceId } : {}),
    });
    await writeFileAtomic(path, `${JSON.stringify({ entries }, null, 2)}\n`, {
      mode: 0o644,
      dirMode: 0o700,
    });
  });
}

/** Pure policy evaluation; the fs-backed window sum arrives as an argument. */
export function evaluateSpend(
  policy: Pick<Config, 'maxAutoSpend' | 'sessionBudget' | 'confirm' | 'allowlistCreators'>,
  req: SpendRequest,
  alreadySpentAtomic: bigint,
): SpendDecision {
  const amount = BigInt(req.amountAtomic);
  const budget = BigInt(policy.sessionBudget);

  if (budget > 0n && alreadySpentAtomic + amount > budget) {
    return {
      decision: 'refuse',
      reasons: [
        `sessionBudget exhausted: ${atomicToUsd(alreadySpentAtomic.toString())} USD spent in the last 24h, budget is ${atomicToUsd(policy.sessionBudget)} USD, this buy is ${atomicToUsd(req.amountAtomic)} USD.`,
      ],
    };
  }

  if (req.explicitApproval) {
    return { decision: 'allow', reasons: ['explicit approval (--yes)'] };
  }

  const reasons: string[] = [];
  if (amount > BigInt(policy.maxAutoSpend)) {
    reasons.push(
      `price ${atomicToUsd(req.amountAtomic)} USD exceeds maxAutoSpend ${atomicToUsd(policy.maxAutoSpend)} USD`,
    );
  }
  if (policy.confirm === 'always') {
    reasons.push('confirm policy is "always"');
  } else if (policy.confirm.startsWith('above:')) {
    const threshold = BigInt(policy.confirm.slice('above:'.length));
    if (amount > threshold) {
      reasons.push(
        `price ${atomicToUsd(req.amountAtomic)} USD is above the confirm threshold ${atomicToUsd(threshold.toString())} USD`,
      );
    }
  }
  if (policy.allowlistCreators.length > 0) {
    const handle = req.creatorHandle?.toLowerCase();
    if (handle === undefined || !policy.allowlistCreators.some((c) => c.toLowerCase() === handle)) {
      reasons.push(`creator ${req.creatorHandle ?? '(unknown)'} is not in allowlistCreators`);
    }
  }

  if (reasons.length > 0) return { decision: 'confirm', reasons };
  return { decision: 'allow', reasons: ['within policy'] };
}
