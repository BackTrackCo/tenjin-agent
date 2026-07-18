import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { writeFileAtomic } from '../atomic-json';
import { withFileLock } from '../lock';
import {
  evaluateSpendPolicy,
  type PolicyReason,
  type SpendDecision,
  type SpendPolicy,
} from '../policy';
import type { PolicyEnforcement } from './provider';

/**
 * The spend-policy enforcement seam — deliberately in the WALLET PROVIDER layer,
 * BEFORE any signing/payment path, so a future hosted provider (Privy, B5)
 * inherits it: policy moves provider-side by swapping this local authorizer for
 * one the hosted signer enforces. The local authorizer is `client-only` (any
 * process that runs the CLI can edit config or the ledger), and it says so.
 *
 * The session ledger is a rolling window persisted on disk so `sessionBudget`
 * survives across the per-command CLI processes an agent spawns. Only SETTLED
 * on-chain spends are committed; a free/SIWX/already-delivered read never touches it.
 */

const DEFAULT_WINDOW_MS = 86_400_000; // 24h rolling day

export interface SpendRequest {
  amountAtomic: bigint;
  creator: string;
  /** The caller's `--max-price` cap, if any. */
  maxPriceAtomic?: bigint;
}

export interface SpendAuthorization {
  decision: SpendDecision;
  reason: PolicyReason;
  message: string;
  amountAtomic: bigint;
  sessionSpentAtomic: bigint;
  sessionBudgetAtomic: bigint;
  policyEnforcement: PolicyEnforcement;
}

export interface SpendAuthorizer {
  policyEnforcement: PolicyEnforcement;
  /** Evaluate a spend against policy + the rolling session ledger. Read-only. */
  authorize(req: SpendRequest): Promise<SpendAuthorization>;
  /** Record a SETTLED spend into the rolling session window. */
  commit(amountAtomic: bigint): Promise<void>;
}

const LedgerSchema = z.object({
  schemaVersion: z.literal(1),
  windowStartMs: z.number(),
  spentAtomic: z.string().regex(/^\d+$/),
});
type Ledger = z.infer<typeof LedgerSchema>;

export interface LocalSpendAuthorizerDeps {
  dir: string;
  policy: SpendPolicy;
  /** Rolling window length (ms); default 24h. Injectable for tests. */
  windowMs?: number;
  /** Clock seam for deterministic window tests. */
  now?: () => number;
}

export function createLocalSpendAuthorizer(deps: LocalSpendAuthorizerDeps): SpendAuthorizer {
  const windowMs = deps.windowMs ?? DEFAULT_WINDOW_MS;
  const now = deps.now ?? Date.now;
  const path = join(deps.dir, 'session.json');

  const currentSpent = async (): Promise<bigint> => {
    const ledger = await readLedger(path);
    if (ledger === null) return 0n;
    // A window older than windowMs has rolled over; its spend no longer counts.
    if (now() - ledger.windowStartMs >= windowMs) return 0n;
    return BigInt(ledger.spentAtomic);
  };

  return {
    policyEnforcement: 'client-only',
    async authorize(req: SpendRequest): Promise<SpendAuthorization> {
      const sessionSpentAtomic = await currentSpent();
      const evaluation = evaluateSpendPolicy(deps.policy, {
        amountAtomic: req.amountAtomic,
        creator: req.creator,
        ...(req.maxPriceAtomic !== undefined ? { maxPriceAtomic: req.maxPriceAtomic } : {}),
        sessionSpentAtomic,
      });
      return {
        ...evaluation,
        amountAtomic: req.amountAtomic,
        sessionSpentAtomic,
        sessionBudgetAtomic: deps.policy.sessionBudgetAtomic,
        policyEnforcement: 'client-only',
      };
    },
    async commit(amountAtomic: bigint): Promise<void> {
      await mkdir(deps.dir, { recursive: true, mode: 0o700 });
      await withFileLock(`${path}.lock`, async () => {
        const ledger = await readLedger(path);
        const rolled = ledger === null || now() - ledger.windowStartMs >= windowMs;
        const base = rolled ? 0n : BigInt(ledger.spentAtomic);
        const next: Ledger = {
          schemaVersion: 1,
          windowStartMs: rolled ? now() : ledger.windowStartMs,
          spentAtomic: (base + amountAtomic).toString(),
        };
        await writeFileAtomic(path, `${JSON.stringify(next, null, 2)}\n`, {
          mode: 0o600,
          dirMode: 0o700,
        });
      });
    },
  };
}

async function readLedger(path: string): Promise<Ledger | null> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    return null;
  }
  try {
    const parsed = LedgerSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
