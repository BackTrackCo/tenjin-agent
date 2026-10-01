import { createWriteStream } from 'node:fs';
import { appendFile, mkdir, readFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { writeFileAtomic } from '../lib/atomic-json';
import { assertPublicDestination, type DestinationOptions } from '../lib/destination';
import { withFileLock } from '../lib/lock';
import { downloadsDir, paidLedgerPath } from '../lib/paths';
import { mask } from '../lib/redact';
import { USDC_ADDRESS } from '../lib/usdc-balance';
import { releaseUnchargedExposure } from '../lib/wallet/spend';

/**
 * WHAT A PAID ROUTER CALL BOUGHT, KEPT ON THIS MACHINE. One JSON line per paid
 * call in `~/.tenjin/paid/ledger.jsonl`: who was paid, for what, how much, the
 * settlement it carried and the files it saved. It is the user's own record
 * and the receipt `tenjin payments reconcile` resolves an unknown settlement
 * against. Nothing here can fail a lookup: every write swallows its own error.
 */

export type Settlement = 'settled' | 'unknown' | 'not_charged';

/** The EIP-3009 authorization that was signed, enough to ask the token later
 *  whether it was used. */
export interface SignedAuthorization {
  from: string;
  nonce: string;
  /** Unix seconds; after it the authorization can no longer be used. */
  validBefore: string;
}

export interface PaidRecord {
  version: 1;
  ts: string;
  capabilityId: string;
  provider: string;
  url: string;
  /** The input or query sent, masked and cut to {@link MAX_SENT_CHARS}. */
  sent: string;
  amountAtomic: string;
  txHash?: string;
  settlement: Settlement;
  savedFiles: string[];
  authorization?: SignedAuthorization;
}

export const MAX_SENT_CHARS = 4_096;

/** The input or query as it is recorded: secrets masked, then cut. */
export function recordedSent(sent: string): string {
  return mask(sent).slice(0, MAX_SENT_CHARS);
}

export async function appendPaidRecord(dataDir: string, record: PaidRecord): Promise<void> {
  try {
    const path = paidLedgerPath(dataDir);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    // Under the lock reconcile rewrites with, so an append is never lost to it.
    await withFileLock(`${path}.lock`, () =>
      appendFile(path, `${JSON.stringify(record)}\n`, { mode: 0o600 }),
    );
  } catch {
    // The record is the user's convenience; the lookup already happened.
  }
}

/** `authorizationState(address,bytes32)`: the first four bytes of its keccak-256. */
const AUTHORIZATION_STATE_SELECTOR = '0xe94a0102';
const WORD_RE = /^0x[0-9a-fA-F]{64}$/;
/** How many unknown settlements one pass asks the chain about. */
export const MAX_RECONCILE_CHECKS = 3;
const RECONCILE_TIMEOUT_MS = 1_500;

/**
 * Whether USDC on Base has used this authorization: true once a facilitator
 * settled it, false while it has not. Null when the RPC could not say.
 */
export async function authorizationUsed(
  authorization: SignedAuthorization,
  rpcUrl: string,
  opts: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<boolean | null> {
  try {
    const res = await (opts.fetchImpl ?? fetch)(rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'eth_call',
        params: [
          {
            to: USDC_ADDRESS,
            data: `${AUTHORIZATION_STATE_SELECTOR}${authorization.from.slice(2).toLowerCase().padStart(64, '0')}${authorization.nonce.slice(2).toLowerCase()}`,
          },
          'latest',
        ],
      }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? RECONCILE_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const result = ((await res.json()) as { result?: unknown } | null)?.result;
    if (typeof result !== 'string' || !WORD_RE.test(result)) return null;
    return BigInt(result) !== 0n;
  } catch {
    return null;
  }
}

export interface ReconcileOutcome {
  /** Records asked about in this pass. */
  checked: number;
  /** The authorization was used: the amount was charged. */
  settled: number;
  /** It expired unused: nothing was charged. */
  notCharged: number;
  /** Still unknown: not yet expired, no authorization on record, or the RPC
   *  could not answer. */
  unknown: number;
  /** What the not-charged payments gave back to today's automatic budget. */
  releasedAtomic: string;
}

/**
 * RESOLVE "SETTLEMENT UNKNOWN" FROM THE CHAIN. A paid call whose seller never
 * confirmed settlement leaves a record marked `unknown`. Once its
 * authorization's `validBefore` has passed, the token's own
 * `authorizationState(from, nonce)` is final: used means charged, unused means
 * it can never be charged. At most `max` records are asked about per pass, and
 * a record the RPC cannot answer for stays unknown for the next one.
 *
 * The chain is asked outside the lock; the file is re-read and rewritten under
 * it, so an append made meanwhile is kept.
 */
export async function reconcilePayments(
  dataDir: string,
  opts: {
    rpcUrl: string;
    fetchImpl?: typeof fetch;
    now?: () => number;
    max?: number;
    timeoutMs?: number;
  },
): Promise<ReconcileOutcome> {
  const path = paidLedgerPath(dataDir);
  const now = (opts.now ?? Date.now)();
  const records = parseLedger(await readFile(path, 'utf8').catch(() => ''));
  const open = records.filter(
    (entry): entry is { line: string; record: PaidRecord } =>
      entry.record !== null && entry.record.settlement === 'unknown',
  );
  const due = open.filter(
    ({ record }) =>
      record.authorization !== undefined && Number(record.authorization.validBefore) * 1_000 < now,
  );
  const answers = new Map<string, Settlement>();
  let checked = 0;
  for (const { record } of due.slice(0, opts.max ?? MAX_RECONCILE_CHECKS)) {
    checked += 1;
    const used = await authorizationUsed(record.authorization!, opts.rpcUrl, {
      ...(opts.fetchImpl !== undefined ? { fetchImpl: opts.fetchImpl } : {}),
      ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
    });
    if (used !== null) answers.set(record.authorization!.nonce, used ? 'settled' : 'not_charged');
  }
  if (answers.size > 0) {
    await withFileLock(`${path}.lock`, async () => {
      const current = parseLedger(await readFile(path, 'utf8').catch(() => ''));
      const lines = current.map(({ line, record }) => {
        const answer =
          record?.settlement === 'unknown' && record.authorization !== undefined
            ? answers.get(record.authorization.nonce)
            : undefined;
        return answer === undefined
          ? line
          : JSON.stringify({
              ...record,
              settlement: answer,
              reconciledAt: new Date(now).toISOString(),
            });
      });
      await writeFileAtomic(path, lines.map((line) => `${line}\n`).join(''), { mode: 0o600 });
    });
  }
  // NOT CHARGED GIVES THE DAILY BUDGET BACK: exactly that payment's exposure,
  // by its nonce, while it is still inside the window that counted it. Once
  // per nonce: a second release finds nothing.
  let releasedAtomic = 0n;
  for (const [nonce, answer] of answers) {
    if (answer !== 'not_charged') continue;
    releasedAtomic += await releaseUnchargedExposure(dataDir, nonce, {
      ...(opts.now !== undefined ? { now: opts.now } : {}),
    });
  }
  const settled = [...answers.values()].filter((value) => value === 'settled').length;
  return {
    checked,
    settled,
    notCharged: answers.size - settled,
    unknown: open.length - answers.size,
    releasedAtomic: releasedAtomic.toString(),
  };
}

/** Every line, and the record it holds when it is one; other lines ride along. */
function parseLedger(raw: string): { line: string; record: PaidRecord | null }[] {
  return raw
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      try {
        const value = JSON.parse(line) as PaidRecord;
        return { line, record: value !== null && value.version === 1 ? value : null };
      } catch {
        return { line, record: null };
      }
    });
}

/** The media a paid result links to, by the extension its path ends in. */
const MEDIA_EXTENSIONS = new Set([
  'png',
  'jpg',
  'jpeg',
  'webp',
  'gif',
  'svg',
  'mp3',
  'wav',
  'm4a',
  'ogg',
  'mp4',
  'webm',
  'mov',
]);
export const MAX_MEDIA_FILES = 5;
export const MAX_MEDIA_BYTES = 200 * 1024 * 1024;
export const MEDIA_TIMEOUT_MS = 60_000;
const MAX_REDIRECTS = 3;
const URL_RE = /https:\/\/[^\s"'<>\\]+/g;

/** Every https URL in the result whose path ends in a media extension, in
 *  order and without repeats, at most {@link MAX_MEDIA_FILES}. */
export function mediaUrlsIn(result: string, limit = MAX_MEDIA_FILES): string[] {
  const found: string[] = [];
  for (const match of result.matchAll(URL_RE)) {
    if (found.length >= limit) break;
    let url: URL;
    try {
      url = new URL(match[0]);
    } catch {
      continue;
    }
    const ext = url.pathname.split('.').pop()?.toLowerCase() ?? '';
    if (!url.pathname.includes('.') || !MEDIA_EXTENSIONS.has(ext)) continue;
    if (!found.includes(url.toString())) found.push(url.toString());
  }
  return found;
}

export interface MediaDeps {
  fetchImpl?: typeof fetch;
  destination?: DestinationOptions;
  now?: () => number;
  timeoutMs?: number;
  maxBytes?: number;
}

/**
 * Download each URL into the downloads dir, one at a time, each under its own
 * size cap and deadline, and every hop of a redirect checked as a public
 * destination first. Returns the paths that were written; a URL that fails is
 * skipped and never fails the call.
 */
export async function saveMedia(
  dataDir: string,
  stem: string,
  urls: string[],
  deps: MediaDeps = {},
): Promise<string[]> {
  const saved: string[] = [];
  for (const [index, url] of urls.entries()) {
    const path = await saveOne(dataDir, `${stem}-${index + 1}`, url, deps);
    if (path !== null) saved.push(path);
  }
  return saved;
}

async function saveOne(
  dataDir: string,
  stem: string,
  raw: string,
  deps: MediaDeps,
): Promise<string | null> {
  const doFetch = deps.fetchImpl ?? fetch;
  const maxBytes = deps.maxBytes ?? MAX_MEDIA_BYTES;
  const signal = AbortSignal.timeout(deps.timeoutMs ?? MEDIA_TIMEOUT_MS);
  let target = raw;
  let path: string | null = null;
  try {
    let res: Response | null = null;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      await assertPublicDestination(target, deps.destination ?? {});
      res = await doFetch(target, { redirect: 'manual', signal });
      const location = res.headers.get('location');
      if (res.status < 300 || res.status >= 400 || location === null) break;
      target = new URL(location, target).toString();
      res = null;
    }
    if (res === null || res.status < 200 || res.status >= 300 || res.body === null) return null;
    const declared = Number(res.headers.get('content-length') ?? '0');
    if (declared > maxBytes) return null;
    const ext = new URL(target).pathname.split('.').pop()?.toLowerCase() ?? 'bin';
    const name = `${stem.replace(/[^A-Za-z0-9_-]+/g, '-').slice(0, 80)}-${(deps.now ?? Date.now)()}.${MEDIA_EXTENSIONS.has(ext) ? ext : 'bin'}`;
    const directory = downloadsDir(dataDir);
    await mkdir(directory, { recursive: true });
    path = join(directory, name);
    const out = createWriteStream(path, { mode: 0o600 });
    let size = 0;
    try {
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        size += chunk.byteLength;
        if (size > maxBytes) throw new Error('media over the size cap');
        if (!out.write(chunk)) await new Promise((resolve) => out.once('drain', resolve));
      }
    } finally {
      await new Promise<void>((resolve) => out.end(resolve));
    }
    return path;
  } catch {
    if (path !== null) await rm(path, { force: true }).catch(() => undefined);
    return null;
  }
}
