import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { writeFileAtomic } from '../lib/atomic-json';
import type { LiveLine } from '../lib/live-line';
import { formatUsdDisplay } from '../lib/money';
import { PRODUCTION_ORIGIN } from '../lib/production-origin';

/**
 * WATCHING A FUND LINK UNTIL THE MONEY LANDS. Two sources, read side by side:
 *
 * - THE LINK'S PAYMENT STATUS, `GET /api/fund/status` with the link's own
 *   token: what the fund page reported (opened, paying, paid, failed,
 *   cancelled). It is what lets the terminal say "Checkout open" and "Payment
 *   received" while the browser works, and what stops a second checkout while
 *   a payment is still landing. A 404 or 401 (the route is not deployed, or the
 *   token is past its grace) turns it off for the rest of the wait; a 429 or a
 *   network error is one round with no status.
 * - THE BALANCE. Only a rise counts as arrived: the status says what the page
 *   saw, never that the money is spendable.
 *
 * The last link this machine issued is remembered (`fund-link.json`, mode
 * 0600) so `tenjin balance --wait` can follow it from another process and a
 * rerun of `tenjin fund` can tell a payment already on its way from a fresh
 * start. The token in it funds this wallet only and expires with the link.
 */

/** What the fund page last reported for a link. "none" means nothing yet. */
export type LinkState = 'none' | 'opened' | 'paying' | 'paid' | 'failed' | 'cancelled';
const LINK_STATES: readonly LinkState[] = [
  'none',
  'opened',
  'paying',
  'paid',
  'failed',
  'cancelled',
];

export interface LinkStatus {
  state: LinkState;
  updatedAt?: string;
  /** What the person was charged, in USD, on `paid`. */
  amountUsd?: number;
  reason?: string;
}

/** A payment that started, or went through, and may not be in the balance yet. */
export function inFlight(status: LinkStatus | undefined): boolean {
  return status?.state === 'paying' || status?.state === 'paid';
}

/** One status read: the status, or why there is none this round. */
export type StatusRead =
  | { status: LinkStatus }
  /** 404 or 401: stop asking. */
  | { unavailable: 'gone' }
  /** 429, a 5xx, a network error or a body that is not a status: ask again later. */
  | { unavailable: 'busy' | 'error' };

const STATUS_PATH = '/api/fund/status';
const STATUS_TIMEOUT_MS = 5_000;

export async function readLinkStatus(
  token: string,
  opts: { fetchImpl?: typeof fetch; origin?: string; timeoutMs?: number } = {},
): Promise<StatusRead> {
  try {
    const res = await (opts.fetchImpl ?? fetch)(
      `${opts.origin ?? PRODUCTION_ORIGIN}${STATUS_PATH}`,
      {
        method: 'GET',
        headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
        signal: AbortSignal.timeout(opts.timeoutMs ?? STATUS_TIMEOUT_MS),
      },
    );
    if (res.status === 404 || res.status === 401) return { unavailable: 'gone' };
    if (res.status === 429) return { unavailable: 'busy' };
    if (!res.ok) return { unavailable: 'error' };
    const status = parseStatus(await res.json());
    return status === null ? { unavailable: 'error' } : { status };
  } catch {
    return { unavailable: 'error' };
  }
}

/** `{ state }`, with `updatedAt`, `amountUsd` and `reason` only when the server sent them well formed. */
export function parseStatus(json: unknown): LinkStatus | null {
  if (typeof json !== 'object' || json === null) return null;
  const raw = json as Record<string, unknown>;
  const state = raw.state;
  if (typeof state !== 'string' || !LINK_STATES.includes(state as LinkState)) return null;
  const out: LinkStatus = { state: state as LinkState };
  if (typeof raw.updatedAt === 'string' && raw.updatedAt.length <= 40) {
    out.updatedAt = raw.updatedAt;
  }
  if (
    typeof raw.amountUsd === 'number' &&
    Number.isFinite(raw.amountUsd) &&
    raw.amountUsd > 0 &&
    raw.amountUsd <= 100_000
  ) {
    out.amountUsd = raw.amountUsd;
  }
  if (typeof raw.reason === 'string' && raw.reason.length <= 120) out.reason = raw.reason;
  return out;
}

/** The token a Tenjin /fund link carries in its fragment; undefined for any other link. */
export function tokenOf(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    if (parsed.origin !== PRODUCTION_ORIGIN || parsed.pathname !== '/fund') return undefined;
    const token = parsed.hash.replace(/^#/, '');
    return /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token) ? token : undefined;
  } catch {
    return undefined;
  }
}

/** When the token says the link expires (ms epoch), read from its unsigned payload; display only. */
export function tokenExpiry(token: string): number | undefined {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[0]!, 'base64url').toString('utf8')) as {
      exp?: unknown;
    };
    return typeof payload.exp === 'number' && Number.isFinite(payload.exp)
      ? payload.exp
      : undefined;
  } catch {
    return undefined;
  }
}

/** The link's own lifetime, when its token does not say. */
export const LINK_LIFETIME_MS = 10 * 60_000;
/** How long past its expiry the status route still answers for a link. */
export const STATUS_GRACE_MS = 60 * 60_000;

export interface RememberedLink {
  version: 1;
  /** Lowercase wallet address the link funds. */
  address: string;
  url: string;
  /**
   * The Tenjin /fund link's token, for its payment status. A Coinbase-hosted
   * link has none: it is remembered for its starting balance alone, so a
   * payment that lands before `tenjin balance --wait` starts still counts.
   */
  token?: string;
  issuedAt: number;
  expiresAt: number;
  /** The balance just before the link was issued, atomic, when it could be read. */
  startBalanceAtomic?: string;
}

const LINK_FILE = 'fund-link.json';

export function linkPath(dataDir: string): string {
  return join(dataDir, LINK_FILE);
}

/** Best effort: a link that cannot be remembered still works, it is just not followed. */
export async function rememberLink(dataDir: string, link: RememberedLink): Promise<void> {
  try {
    await writeFileAtomic(linkPath(dataDir), JSON.stringify(link), {
      mode: 0o600,
      dirMode: 0o700,
    });
  } catch {
    // Nothing follows this link from another process.
  }
}

/**
 * The last link this machine issued for `address`, while its status can still
 * be read (`expiresAt` plus {@link STATUS_GRACE_MS}), else null.
 */
export async function recallLink(
  dataDir: string,
  address: string,
  now: number,
): Promise<RememberedLink | null> {
  try {
    const row = JSON.parse(await readFile(linkPath(dataDir), 'utf8')) as Partial<RememberedLink>;
    if (
      row.version !== 1 ||
      typeof row.address !== 'string' ||
      row.address !== address.toLowerCase() ||
      typeof row.url !== 'string' ||
      (row.token !== undefined && typeof row.token !== 'string') ||
      typeof row.issuedAt !== 'number' ||
      typeof row.expiresAt !== 'number' ||
      now < row.issuedAt ||
      now > row.expiresAt + STATUS_GRACE_MS ||
      (row.startBalanceAtomic !== undefined && !/^\d{1,40}$/.test(row.startBalanceAtomic))
    ) {
      return null;
    }
    return row as RememberedLink;
  } catch {
    return null;
  }
}

/** The link's money landed and was said: nothing more to follow. */
export async function forgetLink(dataDir: string): Promise<void> {
  await rm(linkPath(dataDir), { force: true }).catch(() => undefined);
}

/** `$5.00`, `$0.006`: whole cents keep two decimals. */
export function dollars(atomic: bigint): string {
  return `$${formatUsdDisplay(atomic.toString())}`;
}

/** `$5.20` from the page's charged amount. */
function chargedUsd(amount: number): string {
  return `$${amount.toFixed(2)}`;
}

/** `9:12 left on this link`. */
function timeLeft(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')} left on this link`;
}

export type WatchEnd =
  | { kind: 'arrived'; balance: bigint; added: bigint; status?: LinkStatus }
  /**
   * The link expired with no payment on it (or with no status to say).
   * `statusKnown` only when the status read in the expiring round answered:
   * the one case where "nothing was charged" is said.
   */
  | { kind: 'expired'; status?: LinkStatus; statusKnown: boolean }
  | { kind: 'timed-out'; status?: LinkStatus };

export interface WatchOptions {
  startBalance: bigint;
  /** A read that failed is undefined; the watch just reads again. */
  readBalance: () => Promise<bigint | undefined>;
  /** The link's token, for its payment status. Absent: the balance alone. */
  token?: string;
  /** End with `expired` once this passes with no payment on the link. */
  expiresAt?: number;
  /** End with `timed-out` once this passes. */
  deadline: number;
  /** What the lines say: a checkout in the browser, or a crypto send. */
  view: 'checkout' | 'crypto' | 'funds';
  live?: LiveLine;
  fetchImpl?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  intervalMs?: number;
}

/** The status route's rate limit allows one read a second; two leaves room. */
export const STATUS_INTERVAL_MS = 2_000;

/**
 * Poll until the balance rises above `startBalance`, the link expires with
 * nothing on it, or the deadline passes. The balance is read every other
 * round (the public RPC rate-limits), every round once the page says paid.
 */
export async function watchFunding(o: WatchOptions): Promise<WatchEnd> {
  const now = o.now ?? Date.now;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const interval = o.intervalMs ?? STATUS_INTERVAL_MS;
  const live = o.live;
  let status: LinkStatus | undefined;
  let statusOn = o.token !== undefined && o.view !== 'crypto';
  let statusKnown = false;
  let backoff = 0;
  let saidOpen = false;
  let saidPaid = false;
  let lastSaid: LinkState | undefined;

  const render = (t: number) => {
    if (live === undefined) return;
    if (o.view === 'crypto') return live.spin('Watching for it to arrive…');
    const left =
      o.expiresAt !== undefined && t < o.expiresAt ? timeLeft(o.expiresAt - t) : undefined;
    if (!statusKnown) {
      return o.view === 'funds' && o.token === undefined
        ? live.spin('Waiting for funds to arrive…')
        : live.spin('Waiting for your payment…', left);
    }
    const state = status!.state;
    if (state !== 'none' && !saidOpen) {
      saidOpen = true;
      live.ok('Checkout open');
    }
    if (state === 'paid' && !saidPaid) {
      saidPaid = true;
      live.ok(
        'Payment received',
        status!.amountUsd !== undefined ? `${chargedUsd(status!.amountUsd)} charged` : undefined,
      );
    }
    if (state !== lastSaid) {
      if (state === 'failed') live.warn("That payment didn't go through. Nothing was charged.");
      if (state === 'cancelled') live.line('  No payment was made.');
      lastSaid = state;
    }
    if (state === 'none') return live.spin('Waiting for the page to open…');
    if (state === 'paid') return live.spin('Adding to your balance…');
    if (state === 'paying') return live.spin('Waiting for your payment…');
    return live.spin('Waiting for your payment…', left);
  };

  for (let round = 0; ; round++) {
    // Did THIS round's status read answer? An earlier answer still draws the
    // line, but only a fresh one is evidence that nothing was charged: a read
    // that failed or was skipped for a 429 may have missed a payment starting.
    let fresh = false;
    if (statusOn && backoff === 0) {
      const read = await readLinkStatus(o.token!, {
        ...(o.fetchImpl !== undefined ? { fetchImpl: o.fetchImpl } : {}),
      });
      if ('status' in read) {
        status = read.status;
        statusKnown = true;
        fresh = true;
      } else if (read.unavailable === 'gone') {
        statusOn = false;
        statusKnown = false;
      } else if (read.unavailable === 'busy') {
        // Skip the next few rounds; the limit is per wallet, shared with the page.
        backoff = 3;
      }
    } else if (backoff > 0) {
      backoff--;
    }
    if (round % 2 === 0 || status?.state === 'paid') {
      const balance = await o.readBalance();
      if (balance !== undefined && balance > o.startBalance) {
        const added = balance - o.startBalance;
        if (live !== undefined) {
          live.stop();
          if (o.view === 'crypto') {
            live.ok('Received from a crypto wallet', `+${dollars(added)}`);
          } else {
            if (statusKnown && status?.state === 'paid' && !saidPaid) {
              saidPaid = true;
              live.ok(
                'Payment received',
                status.amountUsd !== undefined
                  ? `${chargedUsd(status.amountUsd)} charged`
                  : undefined,
              );
            }
            live.ok('Added to your balance', `+${dollars(added)}`);
          }
        }
        return { kind: 'arrived', balance, added, ...(status !== undefined ? { status } : {}) };
      }
    }
    const t = now();
    render(t);
    // A payment the page last reported keeps the wait going, however old the
    // report; "nothing was charged" needs this round's answer.
    if (
      o.expiresAt !== undefined &&
      t >= o.expiresAt &&
      !inFlight(statusKnown ? status : undefined)
    ) {
      live?.stop();
      return {
        kind: 'expired',
        statusKnown: statusKnown && fresh,
        ...(status !== undefined ? { status } : {}),
      };
    }
    if (t >= o.deadline) {
      live?.stop();
      return { kind: 'timed-out', ...(status !== undefined ? { status } : {}) };
    }
    await sleep(interval);
  }
}
