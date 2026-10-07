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
/**
 * The smallest deposit worth signing: ten fees ($0.03). A per-call limit under
 * $0.25 sizes the deposit down to the limit while it still covers this many.
 */
export const MIN_DEPOSIT_ATOMIC = 10n * ROUTING_FEE_ATOMIC;

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

/**
 * WHY A CALL WAS NOT PAID, for the user: the reason and the fix, keyed by the
 * payer's skip reason (or `fee_required`, when the free path answered it and
 * nothing else explains why). Null for a reason that is no fault and needs no
 * fix: another session's call on the channel, a server with no paid path, or
 * a call queued past its own budget.
 */
const UNPAID: Record<string, { reason: string; fix: string }> = {
  wallet_low: {
    reason: `the wallet holds less than the $${usd(CHANNEL_DEPOSIT_ATOMIC)} routing deposit`,
    fix: `Fund it with \`tenjin wallet fund ${usd(CHANNEL_DEPOSIT_ATOMIC)}\`.`,
  },
  wallet_locked: {
    reason: '`tenjin mcp` cannot unlock the wallet without a prompt',
    fix: 'Set TENJIN_WALLET_PASSPHRASE in the environment Claude Code starts from, then restart Claude Code.',
  },
  no_wallet: {
    reason: 'this machine has no wallet',
    fix: 'Run `tenjin doctor`.',
  },
  limit_below_deposit: {
    reason: `the per-call spend limit is below the smallest routing deposit ($${usd(MIN_DEPOSIT_ATOMIC)})`,
    fix: 'Run `tenjin doctor`.',
  },
  budget_reached: {
    reason: 'the daily spend limit has no room left for a routing deposit',
    fix: 'Run `tenjin doctor`.',
  },
  not_allowlisted: {
    reason: 'allowlistCreators does not include the router',
    fix: 'Run `tenjin doctor`.',
  },
  payment_failed: {
    reason: 'the routing payment failed',
    fix: 'Run `tenjin doctor`.',
  },
  [FEE_REQUIRED]: {
    reason: 'the router now charges it, and this session cannot pay it',
    fix: 'Run `tenjin doctor`.',
  },
};
const NO_FAULT = new Set(['channel_busy', 'paid_path_absent', 'busy', 'no_call']);

/** The reason and fix for an unpaid call, or null when it needs no word. */
export function unpaid(why: string): { reason: string; fix: string } | null {
  if (NO_FAULT.has(why)) return null;
  return UNPAID[why] ?? UNPAID['payment_failed']!;
}

/** The one line the user sees, once per session, when a call was not paid. */
export function unpaidSentence(why: string): string | null {
  const u = unpaid(why);
  if (u === null) return null;
  return `Tenjin routing could not pay its $${usd(ROUTING_FEE_ATOMIC)} fee (${u.reason}), so calls take the free path until that is fixed. ${u.fix}`;
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
