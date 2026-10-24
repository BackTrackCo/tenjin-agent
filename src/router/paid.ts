import { randomBytes } from 'node:crypto';
import { appendFile, mkdir, open, readFile, rm, type FileHandle } from 'node:fs/promises';
import { request as httpsRequest } from 'node:https';
import type { LookupFunction } from 'node:net';
import { dirname, join } from 'node:path';
import { writeFileAtomic } from '../lib/atomic-json';
import { resolvePublicDestination, type DestinationOptions } from '../lib/destination';
import { hasCode } from '../lib/errno';
import { withFileLock } from '../lib/lock';
import { downloadsDir, paidLedgerPath } from '../lib/paths';
import { mask } from '../lib/redact';
import { USDC_ADDRESS } from '../lib/usdc-balance';
import { releaseUnchargedExposure } from '../lib/wallet/spend';
import type { Identity } from './decision';

/**
 * WHAT A PAID ROUTER CALL BOUGHT, KEPT ON THIS MACHINE. One JSON line per paid
 * call in `~/.tenjin/paid/ledger.jsonl`: who was paid, for what, how much, the
 * settlement it carried and the files it saved. It is the user's own record
 * and the receipt `tenjin payments reconcile` resolves an unknown settlement
 * against. Nothing here can fail a lookup: every write swallows its own error.
 */

/** `account`: run on the user's own connected account, which their plan
 *  pays; nothing left the balance, so there is nothing to settle. */
export type Settlement = 'settled' | 'unknown' | 'not_charged' | 'account';

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
  /** The service's display name, when its decision or spec carried one. */
  label?: string;
  /** Who the call ran through: `tenjin` for Tenjin's own tools, or the id of
   *  the connected account that ran it. Rows from before #37 have none and
   *  read as their identity's source, else `tenjin`. */
  source?: string;
  /** The route the user's settings held it to, when its spec or decision
   *  carried one: which service, source, providers and seller were paid. */
  identity?: Identity;
  /** `swap`: the call answered a native search or fetch in place. */
  via?: 'swap';
  url: string;
  /** The input or query sent, masked and cut to {@link MAX_SENT_CHARS}. */
  sent: string;
  amountAtomic: string;
  txHash?: string;
  settlement: Settlement;
  savedFiles: string[];
  authorization?: SignedAuthorization;
  /** When reconcile last asked the chain about it, so a slow or rate-limited
   *  RPC is not asked about the same record on every lookup. */
  lastCheckedAt?: string;
  /** The offer id of a job on the user's own account (#37): its one row, kept
   *  from when its billing call may have billed and finished in place. */
  job?: string;
  /** `unknown`: a call on the user's own account that may have billed it,
   *  with no result to show it did: still running, failed after the account's
   *  job started, or answered with the account's own error. Usage and
   *  payments say it may have charged, and never count it as billed. Absent:
   *  the account ran it. */
  charge?: 'unknown';
}

export const MAX_SENT_CHARS = 4_096;

/**
 * A JSON value with every object key and string leaf masked on its own. The
 * mask anchors on word boundaries, which a serialized string hides: after an
 * escaped `\n` a key reads as `nsk-ant-…`, one word, and passes.
 */
export function maskDeep(value: unknown): unknown {
  if (typeof value === 'string') return mask(value);
  if (Array.isArray(value)) return value.map(maskDeep);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
        mask(key),
        maskDeep(entry),
      ]),
    );
  }
  return value;
}

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

/**
 * A JOB'S ROW, FINISHED IN PLACE. A paid call whose seller was still working
 * is recorded when it is paid, so a crash mid-poll loses no row; the files the
 * job later saved, and the settlement its last answer named, are written onto
 * that same row, found by its authorization's nonce, under the lock reconcile
 * rewrites with. One payment, one row. Never throws.
 */
export async function updatePaidRecord(
  dataDir: string,
  nonce: string,
  patch: { savedFiles?: string[]; txHash?: string },
): Promise<void> {
  try {
    const path = paidLedgerPath(dataDir);
    const key = nonce.toLowerCase();
    await withFileLock(`${path}.lock`, async () => {
      const current = parseLedger(await readFile(path, 'utf8').catch(() => ''));
      let found = false;
      const lines = current.map(({ line, record }) => {
        if (record?.authorization?.nonce.toLowerCase() !== key) return line;
        found = true;
        return JSON.stringify({
          ...record,
          ...(patch.savedFiles !== undefined ? { savedFiles: patch.savedFiles } : {}),
          ...(patch.txHash !== undefined && record.settlement === 'unknown'
            ? { txHash: patch.txHash, settlement: 'settled' }
            : {}),
        });
      });
      if (found) {
        await writeFileAtomic(path, lines.map((line) => `${line}\n`).join(''), { mode: 0o600 });
      }
    });
  } catch {
    // The record is the user's convenience; the lookup already happened.
  }
}

/**
 * A JOB ON THE USER'S OWN ACCOUNT, ONE ROW (#37). It is written once its
 * billing call may have billed (still running, failed, or answered with the
 * account's own error), its charge `unknown`, so usage and payments show it
 * as may have charged; a later write for the same job that delivered (the
 * resumed job) finishes that row in place, with the files it saved and its
 * charge no longer unknown, under the lock reconcile rewrites with. Never
 * throws.
 */
export async function recordAccountRow(
  dataDir: string,
  record: PaidRecord & { job: string },
): Promise<void> {
  try {
    const path = paidLedgerPath(dataDir);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await withFileLock(`${path}.lock`, async () => {
      const current = parseLedger(await readFile(path, 'utf8').catch(() => ''));
      const kept = current.find(({ record: row }) => row?.job === record.job)?.record;
      if (kept === undefined || kept === null) {
        await appendFile(path, `${JSON.stringify(record)}\n`, { mode: 0o600 });
        return;
      }
      // Still unknown, or already finished with nothing to add: unchanged.
      if (record.charge !== undefined) return;
      if (kept.charge === undefined && record.savedFiles.length === 0) return;
      const lines = current.map(({ line, record: row }) => {
        if (row?.job !== record.job) return line;
        const finished: PaidRecord = {
          ...row,
          ...(record.savedFiles.length > 0 ? { savedFiles: record.savedFiles } : {}),
        };
        delete finished.charge;
        return JSON.stringify(finished);
      });
      await writeFileAtomic(path, lines.map((line) => `${line}\n`).join(''), { mode: 0o600 });
    });
  } catch {
    // The record is the user's convenience; the lookup already happened.
  }
}

/** `authorizationState(address,bytes32)`: the first four bytes of its keccak-256. */
const AUTHORIZATION_STATE_SELECTOR = '0xe94a0102';
const WORD_RE = /^0x[0-9a-fA-F]{64}$/;
/** How many unknown settlements one pass asks the chain about. */
export const MAX_RECONCILE_CHECKS = 3;
/** How long a record the chain could not answer for waits before it is asked
 *  about again by the lookup-time pass. */
export const RECHECK_MS = 10 * 60_000;
const RECONCILE_TIMEOUT_MS = 1_500;

/**
 * Whether USDC on Base has used this authorization: true once a facilitator
 * settled it, false while it has not. Null when the RPC could not say.
 */
export async function authorizationUsed(
  authorization: SignedAuthorization,
  rpcUrl: string,
  opts: { fetchImpl?: typeof fetch; timeoutMs?: number; blockTag?: string } = {},
): Promise<boolean | null> {
  const result = await rpcCall(
    rpcUrl,
    'eth_call',
    [
      {
        to: USDC_ADDRESS,
        data: `${AUTHORIZATION_STATE_SELECTOR}${authorization.from.slice(2).toLowerCase().padStart(64, '0')}${authorization.nonce.slice(2).toLowerCase()}`,
      },
      opts.blockTag ?? 'latest',
    ],
    opts,
  );
  if (typeof result !== 'string' || !WORD_RE.test(result)) return null;
  return BigInt(result) !== 0n;
}

/**
 * The chain's own clock: the latest block's number and timestamp (seconds).
 * Expiry is decided against it, not this machine's clock, and the state is
 * read at that same block: a node that lags, or a clock running ahead, then
 * agrees with itself. Null when the RPC could not say.
 */
export async function latestBlock(
  rpcUrl: string,
  opts: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<{ tag: string; timestamp: number } | null> {
  const result = await rpcCall(rpcUrl, 'eth_getBlockByNumber', ['latest', false], opts);
  if (result === null || typeof result !== 'object') return null;
  const { number, timestamp } = result as { number?: unknown; timestamp?: unknown };
  if (typeof number !== 'string' || !/^0x[0-9a-fA-F]+$/.test(number)) return null;
  if (typeof timestamp !== 'string' || !/^0x[0-9a-fA-F]+$/.test(timestamp)) return null;
  return { tag: number, timestamp: Number(BigInt(timestamp)) };
}

async function rpcCall(
  rpcUrl: string,
  method: string,
  params: unknown[],
  opts: { fetchImpl?: typeof fetch; timeoutMs?: number },
): Promise<unknown> {
  try {
    const res = await (opts.fetchImpl ?? fetch)(rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? RECONCILE_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    return ((await res.json()) as { result?: unknown } | null)?.result ?? null;
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
 * confirmed settlement leaves a record marked `unknown`. Once the chain's
 * latest block is past its authorization's `validBefore`, the token's own
 * `authorizationState(from, nonce)` read AT THAT BLOCK is final: used means
 * charged, unused means it can never be charged, since no later block can
 * carry it. This machine's clock only decides whether the chain is worth
 * asking. At most `max` records are asked about per pass, and
 * a record the RPC cannot answer for stays unknown, stamped `lastCheckedAt`,
 * and is not asked about again for `recheckMs`.
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
    /** Defaults to {@link RECHECK_MS}; the command passes 0. */
    recheckMs?: number;
  },
): Promise<ReconcileOutcome> {
  const path = paidLedgerPath(dataDir);
  const now = (opts.now ?? Date.now)();
  const records = parseLedger(await readFile(path, 'utf8').catch(() => ''));
  const open = records.filter(
    (entry): entry is { line: string; record: PaidRecord } =>
      entry.record !== null && entry.record.settlement === 'unknown',
  );
  const recheckMs = opts.recheckMs ?? RECHECK_MS;
  const due = open.filter(
    ({ record }) =>
      record.authorization !== undefined &&
      Number(record.authorization.validBefore) * 1_000 < now &&
      (record.lastCheckedAt === undefined || now - Date.parse(record.lastCheckedAt) >= recheckMs),
  );
  const answers = new Map<string, Settlement>();
  const asked = new Set<string>();
  let checked = 0;
  const rpc = {
    ...(opts.fetchImpl !== undefined ? { fetchImpl: opts.fetchImpl } : {}),
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
  };
  const block = due.length > 0 ? await latestBlock(opts.rpcUrl, rpc) : null;
  for (const { record } of due.slice(0, opts.max ?? MAX_RECONCILE_CHECKS)) {
    // Not past validBefore on the chain yet: not asked, and not stamped.
    if (block !== null && Number(record.authorization!.validBefore) >= block.timestamp) continue;
    checked += 1;
    asked.add(record.authorization!.nonce);
    if (block === null) continue;
    const used = await authorizationUsed(record.authorization!, opts.rpcUrl, {
      ...rpc,
      blockTag: block.tag,
    });
    if (used !== null) answers.set(record.authorization!.nonce, used ? 'settled' : 'not_charged');
  }
  // NOT CHARGED GIVES THE DAILY BUDGET BACK FIRST: exactly that payment's
  // exposure, by its nonce, while it is still inside the window that counted
  // it. Only then is the record marked; a release that could not be written
  // leaves it unknown, and the next pass asks again. A second release of the
  // same nonce finds nothing, so a retry never gives back twice.
  let releasedAtomic = 0n;
  for (const [nonce, answer] of [...answers]) {
    if (answer !== 'not_charged') continue;
    const released = await releaseUnchargedExposure(dataDir, nonce, {
      ...(opts.now !== undefined ? { now: opts.now } : {}),
    });
    if (released === null) answers.delete(nonce);
    else releasedAtomic += released;
  }
  if (asked.size > 0) {
    await withFileLock(`${path}.lock`, async () => {
      const current = parseLedger(await readFile(path, 'utf8').catch(() => ''));
      const lines = current.map(({ line, record }) => {
        const nonce =
          record?.settlement === 'unknown' && record.authorization !== undefined
            ? record.authorization.nonce
            : undefined;
        if (nonce === undefined || !asked.has(nonce)) return line;
        const answer = answers.get(nonce);
        const stamp = new Date(now).toISOString();
        return JSON.stringify(
          answer === undefined
            ? { ...record, lastCheckedAt: stamp }
            : { ...record, settlement: answer, lastCheckedAt: stamp, reconciledAt: stamp },
        );
      });
      await writeFileAtomic(path, lines.map((line) => `${line}\n`).join(''), { mode: 0o600 });
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

/** Every paid record in the ledger, oldest first; a line that is not one is skipped. */
export async function readPaidRecords(dataDir: string): Promise<PaidRecord[]> {
  const raw = await readFile(paidLedgerPath(dataDir), 'utf8').catch(() => '');
  return parseLedger(raw).flatMap(({ record }) => (record === null ? [] : [record]));
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

/** One GET the media download makes, connected to the address it validated. */
export interface PinnedTarget {
  url: URL;
  /** The address `resolvePublicDestination` checked; the socket goes here. */
  address: string;
  family: 4 | 6;
}

export interface MediaResponse {
  status: number;
  location?: string;
  contentLength?: number;
  body: AsyncIterable<Uint8Array>;
  /** Drop the connection without reading the rest. */
  discard: () => void;
}

export type MediaTransport = (target: PinnedTarget, signal: AbortSignal) => Promise<MediaResponse>;

export interface MediaDeps {
  /** Test seam; production connects with {@link pinnedGet}. */
  transport?: MediaTransport;
  destination?: DestinationOptions;
  now?: () => number;
  timeoutMs?: number;
  maxBytes?: number;
  /** What the call may still write, shared by every file it saves, side by
   *  side or not: charged as each chunk is written, so a download still in
   *  flight holds only what it wrote. A chunk that would take it below zero
   *  stops that file, and a file that is not kept gives its bytes back. */
  budget?: { leftBytes: number };
}

/**
 * CONNECT TO THE ADDRESS THAT WAS CHECKED. `fetch` resolves the name again on
 * its own, so a host answering publicly to the check and privately a moment
 * later (DNS rebinding) would get the request. `node:https` with a `lookup`
 * that hands back the one validated address closes that: the socket goes to
 * it, and TLS still verifies the certificate against the URL's own host name.
 */
export const pinnedGet: MediaTransport = (target, signal) =>
  new Promise((resolve, reject) => {
    const req = httpsRequest(
      target.url,
      {
        method: 'GET',
        signal,
        lookup: pinnedLookup(target),
      },
      (res) => {
        const length = Number(res.headers['content-length']);
        const location = res.headers.location;
        resolve({
          status: res.statusCode ?? 0,
          ...(typeof location === 'string' ? { location } : {}),
          ...(Number.isFinite(length) ? { contentLength: length } : {}),
          body: res,
          discard: () => res.destroy(),
        });
      },
    );
    req.on('error', reject);
    req.end();
  });

/** A `lookup` that answers every name with the one validated address. */
export function pinnedLookup(target: Pick<PinnedTarget, 'address' | 'family'>): LookupFunction {
  return ((_host: string, options: { all?: boolean }, callback: LookupCallback) => {
    if (options.all === true) {
      callback(null, [{ address: target.address, family: target.family }]);
    } else {
      callback(null, target.address, target.family);
    }
  }) as unknown as LookupFunction;
}

type LookupCallback = (
  err: Error | null,
  address: string | { address: string; family: number }[],
  family?: number,
) => void;

/** A file the budget left too little room for. */
const CAPPED = Symbol('capped');
/** A file a later try could save: the network, the file's server or this
 *  disk failed, not a rule of ours. */
const FAILED = Symbol('failed');

/**
 * Download each URL into the downloads dir, one at a time, each under its own
 * size cap and deadline, every hop of a redirect validated and connected to
 * the address it validated. Returns the paths that were written, whether the
 * budget left a file too little room (`capped`), and whether a download
 * failed in a way a later try could get past (`failed`); a later call could
 * save either. A URL that fails is skipped and never fails the call.
 */
export async function saveMedia(
  dataDir: string,
  stem: string,
  urls: string[],
  deps: MediaDeps = {},
): Promise<{ saved: string[]; capped: boolean; failed: boolean }> {
  const saved: string[] = [];
  let capped = false;
  let failed = false;
  for (const [index, url] of urls.entries()) {
    const path = await saveOne(dataDir, `${stem}-${index + 1}`, url, deps);
    if (path === CAPPED) capped = true;
    else if (path === FAILED) failed = true;
    else if (path !== null) saved.push(path);
  }
  return { saved, capped, failed };
}

/** Statuses a later try could get past: the server, not the link, failed. */
const RETRYABLE_STATUS = new Set([408, 429]);

async function saveOne(
  dataDir: string,
  stem: string,
  raw: string,
  deps: MediaDeps,
): Promise<string | typeof CAPPED | typeof FAILED | null> {
  const transport = deps.transport ?? pinnedGet;
  const cap = deps.maxBytes ?? MAX_MEDIA_BYTES;
  const { budget } = deps;
  if (budget !== undefined && budget.leftBytes <= 0) return CAPPED;
  // What this file has taken from the call's budget, given back unless kept.
  let charged = 0;
  let kept = false;
  // Stopped by the call's budget, not by the file's own cap.
  let capped = false;
  // Stopped by a rule of ours (an address, the file's cap), which no later
  // try gets past.
  let refused = false;
  const signal = AbortSignal.timeout(deps.timeoutMs ?? MEDIA_TIMEOUT_MS);
  let target = raw;
  let path: string | null = null;
  try {
    let res: MediaResponse | null = null;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      const pinned = await resolvePublicDestination(target, deps.destination ?? {}).catch(
        (err: unknown) => {
          refused = true;
          throw err;
        },
      );
      res = await transport(pinned, signal);
      if (res.status < 300 || res.status >= 400 || res.location === undefined) break;
      res.discard();
      target = new URL(res.location, target).toString();
      res = null;
    }
    if (res === null || res.status < 200 || res.status >= 300) {
      res?.discard();
      const status = res?.status ?? 0;
      return status >= 500 || RETRYABLE_STATUS.has(status) ? FAILED : null;
    }
    const declared = res.contentLength ?? 0;
    if (declared > cap) {
      res.discard();
      return null;
    }
    if (budget !== undefined && declared > budget.leftBytes) {
      res.discard();
      return CAPPED;
    }
    const ext = new URL(target).pathname.split('.').pop()?.toLowerCase() ?? 'bin';
    const file = await createUniqueFile(
      downloadsDir(dataDir),
      `${stem}-${(deps.now ?? Date.now)()}`,
      MEDIA_EXTENSIONS.has(ext) ? ext : 'bin',
    );
    path = file.path;
    let size = 0;
    try {
      for await (const chunk of res.body) {
        size += chunk.byteLength;
        if (size > cap) {
          res.discard();
          refused = true;
          throw new Error('media over the size cap');
        }
        // Charged before the write, in the same turn as the check, so files
        // saving side by side can never write past the call's cap between
        // them.
        if (budget !== undefined) {
          if (chunk.byteLength > budget.leftBytes) {
            res.discard();
            capped = true;
            throw new Error("media over the call's download cap");
          }
          budget.leftBytes -= chunk.byteLength;
          charged += chunk.byteLength;
        }
        await writeAll(file.handle, chunk);
      }
    } finally {
      await file.handle.close();
    }
    kept = true;
    return path;
  } catch {
    if (path !== null) await rm(path, { force: true }).catch(() => undefined);
    return capped ? CAPPED : refused ? null : FAILED;
  } finally {
    if (budget !== undefined && !kept) budget.leftBytes += charged;
  }
}

/**
 * EVERY BYTE, OR A THROW. `FileHandle.write` may write fewer bytes than it was
 * handed and says so only in `bytesWritten`; a caller that ignores it saves a
 * file with a hole in it. A write that makes no progress is an error.
 */
export async function writeAll(
  handle: Pick<FileHandle, 'write'>,
  bytes: Uint8Array,
): Promise<void> {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const { bytesWritten } = await handle.write(bytes, offset, bytes.byteLength - offset);
    if (bytesWritten <= 0) throw new Error('the file write made no progress');
    offset += bytesWritten;
  }
}

/**
 * A NEW FILE, NEVER ANOTHER CALL'S. The name is the stem plus a random suffix,
 * created with an exclusive flag, so two lookups finishing in the same
 * millisecond each get their own file; a clash is retried with a new suffix.
 */
export async function createUniqueFile(
  directory: string,
  stem: string,
  ext: string,
): Promise<{ path: string; handle: FileHandle }> {
  await mkdir(directory, { recursive: true });
  const safe = stem.replace(/[^A-Za-z0-9_-]+/g, '-').slice(0, 100) || 'lookup';
  for (let attempt = 0; ; attempt += 1) {
    const path = join(directory, `${safe}-${randomBytes(4).toString('hex')}.${ext}`);
    try {
      return { path, handle: await open(path, 'wx', 0o600) };
    } catch (err) {
      if (attempt >= 4 || !hasCode(err, 'EEXIST')) throw err;
    }
  }
}
