import { createWriteStream } from 'node:fs';
import { appendFile, mkdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { assertPublicDestination, type DestinationOptions } from '../lib/destination';
import { downloadsDir, paidLedgerPath } from '../lib/paths';
import { mask } from '../lib/redact';

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
    await appendFile(path, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  } catch {
    // The record is the user's convenience; the lookup already happened.
  }
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
