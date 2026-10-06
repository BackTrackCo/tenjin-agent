import { createHash } from 'node:crypto';
import { mkdir, open, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { hasCode } from '../lib/errno';
import { formatUsdDisplay } from '../lib/money';
import type { DecisionRoute } from './decision';

/**
 * THE ROUTING FEE, WITHOUT ANYTHING THAT PAYS. Every routing call on the paid
 * path pays $0.003 over x402 `batch-settlement`, and the stock SDK client in
 * `tenjin mcp` does all of it (`routing-payer.ts`). Everything else, `tenjin
 * hook` included, is the free path exactly as before this fee existed.
 *
 * Hook-safe: `tenjin hook` loads this module, and its chunk graph stays free
 * of the wallet and the x402 SDK (`dist-chunks.test.ts`).
 */

export const ROUTE_PAID_PATH = '/api/x402-router/route';

/** The flat fee per routing call, atomic USDC ($0.003). */
export const ROUTING_FEE_ATOMIC = 3_000n;
/** The largest channel deposit, atomic USDC ($0.25), made inline by the SDK
 *  on the first paid call of a channel that cannot cover the next fee. */
export const CHANNEL_DEPOSIT_ATOMIC = 250_000n;

/** The paid path for this call, or null for the free path. `tenjin mcp` passes
 *  its payer's; absent, every call is free. */
export type RouteFor = (baseUrl: string) => Promise<DecisionRoute | null>;

/** The free path's reason code once the server routes only paid calls. */
export const FEE_REQUIRED = 'fee_required';

/** Whether a decision is the free path's `fee_required` answer. */
export function isFeeRequired(response: unknown): boolean {
  const decision = (response as { decision?: { action?: unknown; diagnostics?: unknown } })
    ?.decision;
  const diagnostics = decision?.diagnostics as { reasonCode?: unknown } | undefined;
  return decision?.action === 'native' && diagnostics?.reasonCode === FEE_REQUIRED;
}

const ADDRESS_RE = /^0x[0-9a-f]{40}$/;

/** One wallet's folder: the SDK's file storage for its routing channel
 *  (`client/<channelId>.json`). */
export function payerDir(dataDir: string, payer: string): string {
  const name = payer.toLowerCase();
  if (!ADDRESS_RE.test(name)) throw new Error(`not a wallet address: ${payer}`);
  return join(dataDir, 'router', 'fee', name);
}

/** Atomic USDC as dollars with at least two decimals, never a float. */
export function usd(atomic: bigint): string {
  return formatUsdDisplay(atomic.toString());
}

/** How long a session's notice marker is kept. */
const NOTICE_KEEP_MS = 7 * 86_400_000;

/**
 * TRUE ONCE PER SESSION: the first caller for a session id creates its marker
 * and gets true; every later one gets false. Each marker holds the time it was
 * made, and those older than a week go on the way past, so the directory does
 * not grow with every session ever run.
 */
export async function firstNoticeFor(
  dataDir: string,
  sessionId: string,
  now: number,
): Promise<boolean> {
  const dir = join(dataDir, 'router', 'notices');
  const name = createHash('sha256').update(sessionId).digest('hex').slice(0, 32);
  const created = await createExclusive(join(dir, name), String(now));
  if (created) {
    for (const entry of await readdir(dir).catch(() => [] as string[])) {
      const path = join(dir, entry);
      const at = Number(await readFile(path, 'utf8').catch(() => 'NaN'));
      if (!Number.isFinite(at) || now - at > NOTICE_KEEP_MS) await rm(path, { force: true });
    }
  }
  return created;
}

async function createExclusive(path: string, body: string): Promise<boolean> {
  try {
    await mkdir(join(path, '..'), { recursive: true, mode: 0o700 });
    const handle = await open(path, 'wx', 0o600);
    try {
      await handle.writeFile(body);
    } finally {
      await handle.close();
    }
    return true;
  } catch (err) {
    if (hasCode(err, 'EEXIST')) return false;
    throw err;
  }
}
