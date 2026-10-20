import { join } from 'node:path';
import { writeFileAtomic } from '../lib/atomic-json';

/**
 * WHAT THE CLAUDE CODE MOD READS, AND NOTHING IT WRITES. The mod
 * (`hosts/claude/tenjin/hooks/register.tsx`) draws from files the CLI already
 * keeps under its data dir, through `$.fs.read`, and writes nothing there.
 * Each file is a contract between the two, versioned by one field, and the mod
 * reads a file whose version it does not know as absent: a surface then says
 * less, never something it did not read.
 *
 * | File | Writer | Version field | What the mod reads |
 * | --- | --- | --- | --- |
 * | `progress/specs/<sha256(id)>.json` | `specs.ts` `storeSpecs` | the spec's own schema | `label`, `priceAtomic`, `maxAmountAtomic`, `priceVaries`, `capabilityId` |
 * | `progress/specs/<sha256(id)>.paid.json` | `specs.ts` `settleSpecPayment` | `state` | `state`, `at`, `amountAtomic`, `txHash` |
 * | `paid/ledger.jsonl` | `paid.ts` `appendPaidRecord` | `version: 1` | `ts`, `capabilityId`, `amountAtomic`, `txHash`, `settlement` |
 * | `spend.json` | `lib/wallet/spend.ts` | `schemaVersion: 2` | `windowStartMs`, `automaticCommittedAtomic`, `reservations` |
 * | `balance.json` | `lib/usdc-balance.ts` | `version: 1` | `address`, `atomic` |
 * | `wallet.json` | `lib/wallet/store.ts` | the keystore's own | `address` only |
 * | `config.json` | `lib/config.ts` | none (keys) | `maxAutoSpend`, `sessionBudget` |
 * | `wallet-created.json` | {@link writeWalletCreated} | `version: 1` | `address`, `at` |
 * | `progress/held/<sha256(tool_use_id)>.json` | `held.ts` `markHeld`, `markRouted`, `markNative` | `version: 1` | `outcome` (`held`, `routed` or `native`), `label`, `priceAtomic`, `offerId`, `routedToolUseId` |
 *
 * `mod-state.test.ts` writes each through its CLI writer and pins the fields.
 */

/** The marker the first-run wallet toast reads. */
export const WALLET_CREATED_FILE = 'wallet-created.json';

export interface WalletCreated {
  version: 1;
  /** The wallet `tenjin install` created in this run. */
  address: string;
  at: string;
}

/**
 * THE INSTALL CREATED THE WALLET IN THIS RUN. The mod's `session.start` reads
 * it to show the first-run toast once, and on a surface with no prompt hint
 * once per session while the wallet is unfunded. Best effort: a marker that
 * cannot be written costs only the toast.
 */
export async function writeWalletCreated(
  dataDir: string,
  address: string,
  now: number = Date.now(),
): Promise<void> {
  const record: WalletCreated = { version: 1, address, at: new Date(now).toISOString() };
  await writeFileAtomic(join(dataDir, WALLET_CREATED_FILE), `${JSON.stringify(record)}\n`, {
    mode: 0o600,
    dirMode: 0o700,
  }).catch(() => undefined);
}
