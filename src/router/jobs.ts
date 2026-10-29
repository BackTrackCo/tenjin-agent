import { request as httpsRequest } from 'node:https';
import { setTimeout as delay } from 'node:timers/promises';
import { sellerLine } from '../commands/pay';
import { composeUserAgent } from '../lib/client-meta';
import {
  assertPublicHttpsUrl,
  resolvePublicDestination,
  type DestinationOptions,
} from '../lib/destination';
import { CliError } from '../lib/errors';
import { isBinaryContentType } from '../lib/http';
import { POLL_REFERENCE, type Job } from './decision';
import { MAX_MEDIA_BYTES, pinnedLookup, type PinnedTarget } from './paid';

/**
 * A PAID CALL THE SELLER ANSWERED BEFORE ITS RESULT WAS READY, finished by
 * polling. The spec's `job` says where the status is, how a poll is sent, and
 * what says it is still running or failed; this file checks the poll URL
 * against the submit, sends each poll and reads its answer. The caller
 * (`tool.ts`) owns the money, the record and what the agent is told.
 *
 * A POLL NEVER CARRIES A PAYMENT. The take's cost is its one payment, made at
 * the submit; no header from it is kept or re-sent, and nothing is signed for
 * a poll, a status or a complete URL. A seller that asks for a payment there
 * ends the take failed.
 *
 * WHAT A POLL MAY TOUCH. The URL is the submit's own host, over HTTPS; it is
 * checked when the job starts and again before every poll, resolved to a
 * public address and connected to that address, with no redirect followed.
 * A poll carries `accept`, the CLI's user agent and `content-type` on a POST.
 * Its body is the seller's: untrusted, and capped.
 */

/** How long one call waits for a job before it answers `running`. */
export const MAX_CALL_WAIT_MS = 300_000;
/** The interval grows by half each poll, up to this. */
export const MAX_POLL_INTERVAL_MS = 30_000;
const BACKOFF = 1.5;
/** This many transport failures or 5xx answers in a row end the call `running`. */
export const MAX_POLL_ERRORS = 3;
/** One poll, its body included: a finished video is a large download. */
const POLL_REQUEST_TIMEOUT_MS = 120_000;
/** A status answer that is not a file: JSON, inline base64 included. */
const MAX_STATUS_BYTES = 64 * 1024 * 1024;

type Json = Record<string, unknown>;

const record = (value: unknown): Json =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : {};

function fieldIn(json: unknown, field: string, values: readonly string[]): boolean {
  const value = record(json)[field];
  return typeof value === 'string' && values.includes(value);
}

/**
 * WHAT A 2xx SAYS ABOUT THE JOB. `always`: the seller never answers inline,
 * so any 2xx to the submit is a job. A 202 is never a result, to the submit
 * or to a poll. Then the job's own rules: `failed` first, then `running`;
 * anything else is the result itself.
 */
export function answerState(
  job: Job,
  status: number,
  json: unknown,
  opts: { submit: boolean },
): 'running' | 'failed' | 'done' {
  if (job.failed !== undefined && fieldIn(json, job.failed.field, job.failed.values)) {
    return 'failed';
  }
  if (status === 202 || (opts.submit && job.always === true)) return 'running';
  const rule = job.running;
  if (rule.httpStatus !== undefined) return rule.httpStatus.includes(status) ? 'running' : 'done';
  return fieldIn(json, rule.field, rule.values) ? 'running' : 'done';
}

/** One poll as it will be sent. */
export interface PollRequestSpec {
  url: string;
  method: 'GET' | 'POST';
  body?: string;
}

/**
 * WHERE THE JOB IS POLLED, from the submit's answer, or why it cannot be. A
 * URL a field or header names is resolved against the submit's URL, then held
 * to its host over HTTPS. A fixed URL was checked the same way by the server,
 * and is checked again here. `named` is the URL the seller gave, for the agent
 * to see as untrusted, when one was given and refused.
 */
export function pollTarget(
  job: Job,
  submit: { url: string; json: unknown; header?: (name: string) => string | undefined },
  input: Json,
): PollRequestSpec | { problem: string; named?: string } {
  let raw: string | undefined;
  if (job.pollUrl.fixed !== undefined) raw = job.pollUrl.fixed;
  else {
    const { field, header } = job.pollUrl;
    const fromBody = field !== undefined ? record(submit.json)[field] : undefined;
    if (typeof fromBody === 'string' && fromBody.trim().length > 0) raw = fromBody.trim();
    else if (header !== undefined) raw = submit.header?.(header)?.trim() || undefined;
  }
  if (raw === undefined) return { problem: 'the seller named no status URL to poll' };
  if (raw.length > 2_048) return { problem: 'the status URL the seller named is too long' };
  const named = sellerLine(raw);
  let url: URL;
  let base: URL;
  try {
    base = new URL(submit.url);
    url = new URL(raw, base);
  } catch {
    return { problem: 'the status URL the seller named cannot be parsed', named };
  }
  url.hash = '';
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') {
    return { problem: 'the status URL the seller named is not plain HTTPS', named };
  }
  if (url.hostname !== base.hostname) {
    return { problem: `the status URL is on ${url.hostname}, not ${base.hostname}`, named };
  }
  if (job.pollMethod === 'GET') return { url: url.toString(), method: 'GET' };
  if (job.pollBody === undefined) return { url: url.toString(), method: 'POST' };
  const body: Json = {};
  for (const [name, value] of Object.entries(job.pollBody)) {
    const reference = typeof value === 'string' ? POLL_REFERENCE.exec(value) : null;
    if (reference === null) {
      body[name] = value;
      continue;
    }
    const [, from, field] = reference as unknown as [string, 'input' | 'result', string];
    const found = record(from === 'input' ? input : submit.json)[field];
    if (found === undefined || found === null) {
      return {
        problem: `the poll needs ${value}, which the ${from === 'input' ? 'input' : "seller's answer"} does not carry`,
      };
    }
    body[name] = found;
  }
  return { url: url.toString(), method: 'POST', body: JSON.stringify(body) };
}

/** One poll's request, connected to the address that was checked. */
export interface PollRequest {
  method: 'GET' | 'POST';
  headers: Record<string, string>;
  body?: string;
}

export interface PollResponse {
  status: number;
  header: (name: string) => string | undefined;
  body: AsyncIterable<Uint8Array>;
  /** Drop the connection without reading the rest. */
  discard: () => void;
}

export type PollTransport = (
  target: PinnedTarget,
  request: PollRequest,
  signal: AbortSignal,
) => Promise<PollResponse>;

/**
 * THE POLL, CONNECTED TO THE ADDRESS THAT WAS CHECKED, as the media download
 * is (`paid.ts`): `node:https` with a `lookup` that answers the one validated
 * address, so a name that turns private between the check and the connect
 * gets nothing. TLS still verifies the certificate against the URL's host.
 * No redirect is followed: the answer is whatever this URL said.
 */
export const pinnedRequest: PollTransport = (target, request, signal) =>
  new Promise((resolve, reject) => {
    const req = httpsRequest(
      target.url,
      { method: request.method, headers: request.headers, signal, lookup: pinnedLookup(target) },
      (res) => {
        resolve({
          status: res.statusCode ?? 0,
          header: (name) => {
            const value = res.headers[name.toLowerCase()];
            return Array.isArray(value) ? value.join(', ') : value;
          },
          body: res,
          discard: () => res.destroy(),
        });
      },
    );
    req.on('error', reject);
    req.end(request.body);
  });

/** How a job stood when polling stopped. */
export type PollAnswer =
  | {
      state: 'done';
      status: number;
      header: (name: string) => string | undefined;
      text: string;
      json: unknown;
      bytes?: Uint8Array;
      contentType: string;
    }
  | { state: 'running'; status?: number; reason?: string }
  | {
      state: 'failed';
      status?: number;
      reason: string;
      /** The seller's own words for it, one bounded plain line: untrusted. */
      said?: string;
    }
  | { state: 'expired'; status: number };

export interface PollDeps {
  transport?: PollTransport;
  destination?: DestinationOptions;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Told before each poll; a failure here never stops one. */
  onPoll?: () => Promise<void> | void;
}

/** What polling needs of a take. */
export interface PolledTake {
  poll: PollRequestSpec;
  job: Job;
}

/**
 * POLL ONE TAKE UNTIL IT ENDS OR THE DEADLINE PASSES. The first poll waits
 * `firstWaitMs` (the job's interval after a submit, none on a resume), each
 * later one half as long again as the last, up to {@link MAX_POLL_INTERVAL_MS}.
 * A 402 is a seller asking to be paid again for a result already paid for:
 * nothing is signed, and the take fails. A 404 or 410 is a job the seller no
 * longer has. Any other 4xx ends the job failed, in the seller's words: AiSpace
 * answers a refused prompt's retrieve with a 422, and every later one the
 * same. {@link MAX_POLL_ERRORS} 5xx, 429 or transport failures in a row stop
 * the call `running`, and the job stays resumable.
 */
export async function pollUntil(
  take: PolledTake,
  opts: { deadline: number; firstWaitMs: number },
  deps: PollDeps = {},
): Promise<PollAnswer> {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => delay(ms).then(() => undefined));
  let interval = take.job.everyS * 1000;
  let wait = opts.firstWaitMs;
  let errors = 0;
  let last: number | undefined;
  for (;;) {
    if (wait > 0) {
      const left = opts.deadline - now();
      if (left <= 0) return { state: 'running', ...(last !== undefined ? { status: last } : {}) };
      await sleep(Math.min(wait, left));
    }
    await Promise.resolve()
      .then(() => deps.onPoll?.())
      .catch(() => undefined);
    const answer = await pollOnce(take, deps);
    wait = interval;
    interval = Math.min(Math.round(interval * BACKOFF), MAX_POLL_INTERVAL_MS);
    if (answer.kind === 'refused') return { state: 'failed', reason: answer.reason };
    const status = answer.kind === 'answer' ? answer.status : undefined;
    if (status !== undefined) last = status;
    const transient =
      answer.kind === 'error' || status === 429 || (status !== undefined && status >= 500);
    if (transient) {
      errors += 1;
      if (errors >= MAX_POLL_ERRORS) {
        return {
          state: 'running',
          ...(status !== undefined ? { status } : {}),
          reason:
            answer.kind === 'error'
              ? answer.reason
              : `the status URL answered ${status} ${MAX_POLL_ERRORS} times in a row`,
        };
      }
      if (now() >= opts.deadline)
        return { state: 'running', ...(status !== undefined ? { status } : {}) };
      continue;
    }
    if (answer.kind !== 'answer') continue;
    errors = 0;
    if (answer.status === 402) {
      return {
        state: 'failed',
        status: 402,
        reason: 'the seller asked for another payment to return the result; none was sent',
      };
    }
    if (answer.status === 404 || answer.status === 410) {
      return { state: 'expired', status: answer.status };
    }
    if (answer.status >= 300 && answer.status < 400) {
      return {
        state: 'failed',
        status: answer.status,
        reason: 'the status URL answered a redirect, which a poll does not follow',
      };
    }
    if (answer.status < 200 || answer.status >= 300) {
      const said = sellerSaid(answer.json, answer.text);
      return {
        state: 'failed',
        status: answer.status,
        reason: `the seller ended the job with HTTP ${answer.status}`,
        ...(said.length > 0 ? { said } : {}),
      };
    }
    if (answer.tooLarge) {
      return {
        state: 'failed',
        status: answer.status,
        reason: 'the finished file is over the size this call keeps',
      };
    }
    const state = answerState(take.job, answer.status, answer.json, { submit: false });
    if (state === 'failed') {
      const said = sellerSaid(answer.json, answer.text);
      return {
        state: 'failed',
        status: answer.status,
        reason: 'the seller says the job failed',
        ...(said.length > 0 ? { said } : {}),
      };
    }
    if (state === 'done') {
      return {
        state: 'done',
        status: answer.status,
        header: answer.header,
        text: answer.text,
        json: answer.json,
        ...(answer.bytes !== undefined ? { bytes: answer.bytes } : {}),
        contentType: answer.header('content-type') ?? '',
      };
    }
    if (now() >= opts.deadline) return { state: 'running', status: answer.status };
  }
}

/**
 * FREE THE SELLER'S COPY once ours is saved: the job's `completeUrl`, held to
 * the submit's host over HTTPS as a poll is, sent once with the poll's method
 * and body. Its answer, and any failure, is ignored: the result is already on
 * disk. The caller sends it only after the save succeeded.
 */
export async function completeJob(
  take: PolledTake & { submitUrl: string },
  deps: PollDeps = {},
): Promise<void> {
  const fixed = take.job.completeUrl?.fixed;
  if (fixed === undefined) return;
  let url: URL;
  let base: URL;
  try {
    base = new URL(take.submitUrl);
    url = new URL(fixed);
  } catch {
    return;
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') return;
  if (url.hostname !== base.hostname) return;
  await pollOnce({ ...take, poll: { ...take.poll, url: url.toString() } }, deps).catch(
    () => undefined,
  );
}

/**
 * THE SELLER'S OWN WORDS for a job that failed: its `error` (a string, or one
 * with a `message`), `message`, `reason` or `detail`, else the body, as one
 * bounded, redacted plain line; empty when it said nothing. Untrusted text.
 */
export function sellerSaid(json: unknown, text: string): string {
  const body = record(json);
  const error = body.error;
  const said = [
    typeof error === 'string' ? error : record(error).message,
    body.message,
    body.reason,
    body.detail,
  ].find((value): value is string => typeof value === 'string' && value.trim().length > 0);
  return sellerLine(said ?? text);
}

type Attempt =
  | {
      kind: 'answer';
      status: number;
      header: (name: string) => string | undefined;
      text: string;
      json: unknown;
      bytes?: Uint8Array;
      tooLarge?: true;
    }
  | { kind: 'error'; reason: string }
  | { kind: 'refused'; reason: string };

async function pollOnce(take: PolledTake, deps: PollDeps): Promise<Attempt> {
  try {
    assertPublicHttpsUrl(take.poll.url);
  } catch {
    return { kind: 'refused', reason: 'the status URL is not a public HTTPS endpoint' };
  }
  let pinned: PinnedTarget;
  try {
    pinned = await resolvePublicDestination(take.poll.url, deps.destination ?? {});
  } catch (err) {
    // A name that did not resolve is the network's failure, and the next poll
    // may get past it; one that resolved onto a private address is a refusal.
    const unresolved =
      err instanceof CliError &&
      (err.details as { cause?: unknown } | undefined)?.cause !== undefined;
    return unresolved
      ? { kind: 'error', reason: 'the status URL host could not be resolved' }
      : { kind: 'refused', reason: 'the status URL resolves to a private address' };
  }
  const headers: Record<string, string> = {
    accept: 'application/json, */*;q=0.8',
    'user-agent': composeUserAgent(),
    ...(take.poll.body !== undefined ? { 'content-type': 'application/json' } : {}),
  };
  const signal = AbortSignal.timeout(POLL_REQUEST_TIMEOUT_MS);
  let res: PollResponse;
  try {
    res = await (deps.transport ?? pinnedRequest)(
      pinned,
      {
        method: take.poll.method,
        headers,
        ...(take.poll.body !== undefined ? { body: take.poll.body } : {}),
      },
      signal,
    );
  } catch (err) {
    return { kind: 'error', reason: `the status URL could not be reached (${errorText(err)})` };
  }
  if (res.status >= 300 && res.status < 400) {
    res.discard();
    return { kind: 'answer', status: res.status, header: res.header, text: '', json: undefined };
  }
  const binary = isBinaryContentType(res.header('content-type'));
  // A file is read whole under the media cap; what the call may write of it
  // is the save's to check, so a file this call has no room for stays
  // resumable rather than failing here.
  const cap = binary ? MAX_MEDIA_BYTES : MAX_STATUS_BYTES;
  const declared = Number(res.header('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > cap) {
    res.discard();
    return {
      kind: 'answer',
      status: res.status,
      header: res.header,
      text: '',
      json: undefined,
      tooLarge: true,
    };
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for await (const chunk of res.body) {
      size += chunk.byteLength;
      if (size > cap) {
        res.discard();
        return {
          kind: 'answer',
          status: res.status,
          header: res.header,
          text: '',
          json: undefined,
          tooLarge: true,
        };
      }
      chunks.push(chunk);
    }
  } catch (err) {
    return { kind: 'error', reason: `the status answer could not be read (${errorText(err)})` };
  }
  const all = Buffer.concat(chunks);
  if (binary) {
    return {
      kind: 'answer',
      status: res.status,
      header: res.header,
      text: '',
      json: undefined,
      bytes: new Uint8Array(all),
    };
  }
  const text = all.toString('utf8');
  let json: unknown;
  try {
    json = text.length > 0 ? JSON.parse(text) : undefined;
  } catch {
    json = undefined;
  }
  return { kind: 'answer', status: res.status, header: res.header, text, json };
}

function errorText(err: unknown): string {
  return sellerLine(err instanceof Error ? err.message : String(err)) || 'no reason given';
}
