import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runLookup } from './lookup';
import type { LookupArgs } from './lookup';
import { CLIENT_LABEL } from '../lib/api';
import { readLookupHistory } from '../lib/state';
import { CliError } from '../lib/errors';
import type { CommandContext } from '../context';
import type { Io } from '../lib/output';

const BASE = 'https://tenjin.test';
const LOOKUP_ID = '0b0b0b0b-1111-4222-8333-444455556666';
const QUESTION = 'What changed in the Vercel build pipeline this month?';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tenjin-lookup-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function captureIo(): { io: Io } {
  const mk = () =>
    ({
      write: () => true,
    }) as unknown as NodeJS.WritableStream;
  return { io: { stdout: mk(), stderr: mk(), isTTY: false } };
}

function ctxFor(): CommandContext {
  // baseUrl arrives via the flag so a stray TENJIN_BASE_URL in the shell
  // cannot redirect any assertion (flag beats env in resolveSettings).
  return { flags: { json: false, timeout: 5000, baseUrl: BASE }, dataDir: dir, io: captureIo().io };
}

interface CapturedCall {
  url: string;
  method: string;
  headers: Headers;
  body: unknown;
}

interface CannedResponse {
  body: unknown;
  status?: number;
  headers?: Record<string, string>;
}

/** A fetch stub that records every call and answers with one canned Response (or throws an Error). */
function captureFetch(reply: CannedResponse | Error): {
  fetchImpl: typeof fetch;
  calls: CapturedCall[];
} {
  const calls: CapturedCall[] = [];
  const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    calls.push({
      url: String(input),
      method: init?.method ?? 'GET',
      headers: new Headers(init?.headers),
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    });
    if (reply instanceof Error) throw reply;
    return new Response(JSON.stringify(reply.body), {
      status: reply.status ?? 200,
      ...(reply.headers !== undefined ? { headers: reply.headers } : {}),
    });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

async function caught(promise: Promise<unknown>): Promise<CliError> {
  const err = await promise.catch((e: unknown) => e);
  expect(err).toBeInstanceOf(CliError);
  return err as CliError;
}

function candidate(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    resourceId: 'aaaa1111-2222-4333-8444-555566667777',
    url: `${BASE}/read/alice/vercel-weekly`,
    title: 'Vercel build pipeline weekly',
    artifactType: 'article',
    price: '250000',
    asOf: '2026-07-18',
    validUntil: null,
    temporalMode: 'point_in_time',
    appliesTo: { products: ['Vercel'] },
    questionsAnswered: ['What changed in the build pipeline?'],
    tasksSupported: ['upgrade planning'],
    scope: 'Vercel platform changes',
    exclusions: null,
    matchReasons: ['appliesTo product match'],
    estimatedTokens: 900,
    creator: { handle: 'alice' },
    ...over,
  };
}

function candidatesBody(cands: Array<Record<string, unknown>>): Record<string, unknown> {
  return {
    schemaVersion: 1,
    lookupId: LOOKUP_ID,
    decision: 'CANDIDATES',
    calibration: 'of the last 100 CANDIDATES, 62 were used',
    candidates: cands,
  };
}

const MISS_BODY = {
  schemaVersion: 1,
  lookupId: LOOKUP_ID,
  decision: 'MISS',
  calibration: 'of the last 100 CANDIDATES, 62 were used',
};

describe('runLookup wire contract', () => {
  it('posts the exact JSON body and headers to /api/agent/lookup, no eval-cohort header by default', async () => {
    const { fetchImpl, calls } = captureFetch({ body: candidatesBody([candidate()]) });
    const res = await runLookup(
      {
        question: QUESTION,
        freshWithin: 'P30D',
        maxPrice: '0.25',
        limit: '3',
        appliesTo: ['products=Vercel', 'products=Next.js', 'versions=16'],
      },
      ctxFor(),
      { fetchImpl },
    );

    expect(calls).toHaveLength(1);
    const call = calls[0] as CapturedCall;
    expect(call.url).toBe(`${BASE}/api/agent/lookup`);
    expect(call.method).toBe('POST');
    expect(call.headers.get('accept')).toBe('application/json');
    expect(call.headers.get('content-type')).toBe('application/json');
    expect(call.headers.get('x-tenjin-client')).toBe(CLIENT_LABEL);
    expect(CLIENT_LABEL).toMatch(/^tenjin-cli\//);
    expect(call.headers.get('x-tenjin-eval-cohort')).toBeNull();
    expect(call.body).toEqual({
      schemaVersion: 1,
      question: QUESTION,
      freshWithin: 'P30D',
      maxPrice: '250000',
      limit: 3,
      appliesTo: { products: ['Vercel', 'Next.js'], versions: ['16'] },
    });

    const data = res.data as { decision: string; lookupId: string };
    expect(data.decision).toBe('CANDIDATES');
    expect(data.lookupId).toBe(LOOKUP_ID);
    expect(res.humanLines?.[0]).toContain('1 candidate(s)');
    expect(res.humanLines?.[1]).toContain('$0.25');
  });

  it('omits every optional field from the body when no flags are given', async () => {
    const { fetchImpl, calls } = captureFetch({ body: MISS_BODY });
    await runLookup({ question: QUESTION }, ctxFor(), { fetchImpl });
    expect((calls[0] as CapturedCall).body).toEqual({ schemaVersion: 1, question: QUESTION });
  });

  it('sends x-tenjin-eval-cohort: 1 when evalCohort is true in config.json', async () => {
    await writeFile(join(dir, 'config.json'), JSON.stringify({ evalCohort: true }));
    const { fetchImpl, calls } = captureFetch({ body: MISS_BODY });
    await runLookup({ question: QUESTION }, ctxFor(), { fetchImpl });
    expect((calls[0] as CapturedCall).headers.get('x-tenjin-eval-cohort')).toBe('1');
  });
});

describe('runLookup decisions and history', () => {
  it('MISS returns normally (exit 0) and records the MISS with empty candidates', async () => {
    const { fetchImpl } = captureFetch({ body: MISS_BODY });
    const res = await runLookup({ question: QUESTION }, ctxFor(), { fetchImpl });
    const data = res.data as { decision: string };
    expect(data.decision).toBe('MISS');
    expect(res.humanLines?.[0]).toContain('MISS');
    expect(res.humanLines?.[0]).toContain(LOOKUP_ID);

    const history = await readLookupHistory(dir);
    expect(history).toHaveLength(1);
    expect(history[0]?.lookupId).toBe(LOOKUP_ID);
    expect(history[0]?.decision).toBe('MISS');
    expect(history[0]?.candidates).toEqual([]);
  });

  it('records CANDIDATES to history without the question text', async () => {
    const { fetchImpl } = captureFetch({ body: candidatesBody([candidate()]) });
    await runLookup({ question: QUESTION }, ctxFor(), { fetchImpl });

    const raw = await readFile(join(dir, 'lookups.json'), 'utf8');
    expect(raw).not.toContain(QUESTION);

    const history = await readLookupHistory(dir);
    expect(history[0]?.candidates).toEqual([
      {
        resourceId: 'aaaa1111-2222-4333-8444-555566667777',
        url: `${BASE}/read/alice/vercel-weekly`,
        title: 'Vercel build pipeline weekly',
        price: '250000',
      },
    ]);
  });

  it('truncates oversized server strings to the documented card bounds', async () => {
    const oversized = candidate({
      title: 'T'.repeat(500),
      scope: 'S'.repeat(500),
      exclusions: 'E'.repeat(500),
      questionsAnswered: Array.from({ length: 100 }, () => 'q'.repeat(1000)),
      tasksSupported: Array.from({ length: 100 }, () => 't'.repeat(1000)),
      matchReasons: Array.from({ length: 10 }, () => 'm'.repeat(200)),
      appliesTo: Object.fromEntries(
        Array.from({ length: 10 }, (_, i) => [
          `key_${i}`,
          Array.from({ length: 10 }, () => 'v'.repeat(200)),
        ]),
      ),
    });
    const { fetchImpl } = captureFetch({ body: candidatesBody([oversized]) });
    const res = await runLookup({ question: QUESTION }, ctxFor(), { fetchImpl });

    const data = res.data as {
      candidates: Array<{
        title: string;
        scope: string;
        exclusions: string;
        questionsAnswered: string[];
        tasksSupported: string[];
        matchReasons: string[];
        appliesTo: Record<string, string[]>;
      }>;
    };
    const c = data.candidates[0];
    expect(c?.title).toHaveLength(200);
    expect(c?.scope).toHaveLength(240);
    expect(c?.exclusions).toHaveLength(240);
    expect(c?.questionsAnswered).toHaveLength(4);
    expect(c?.questionsAnswered[0]).toHaveLength(160);
    expect(c?.tasksSupported).toHaveLength(4);
    expect(c?.tasksSupported[0]).toHaveLength(160);
    expect(c?.matchReasons).toHaveLength(3);
    expect(c?.matchReasons[0]).toHaveLength(80);
    expect(Object.keys(c?.appliesTo ?? {})).toHaveLength(6);
    expect(c?.appliesTo['key_0']).toHaveLength(5);
    expect(c?.appliesTo['key_0']?.[0]).toHaveLength(80);
  });
});

describe('runLookup failure mapping', () => {
  it('429 is RATE_LIMITED (exit 1) carrying retryAfterSeconds', async () => {
    const { fetchImpl } = captureFetch({
      body: { error: { code: 'rate_limited', message: 'slow down' } },
      status: 429,
      headers: { 'retry-after': '30' },
    });
    const err = await caught(runLookup({ question: QUESTION }, ctxFor(), { fetchImpl }));
    expect(err.code).toBe('RATE_LIMITED');
    expect(err.exitCode).toBe(1);
    expect((err.details as { retryAfterSeconds: number }).retryAfterSeconds).toBe(30);
  });

  it('400 is USAGE with the server body as details', async () => {
    const serverBody = { error: { code: 'invalid_request', message: 'bad freshWithin' } };
    const { fetchImpl } = captureFetch({ body: serverBody, status: 400 });
    const err = await caught(runLookup({ question: QUESTION }, ctxFor(), { fetchImpl }));
    expect(err.code).toBe('USAGE');
    expect(err.exitCode).toBe(2);
    expect(err.details).toEqual(serverBody);
  });

  it('500 is API_ERROR carrying the server code', async () => {
    const { fetchImpl } = captureFetch({
      body: { error: { code: 'internal_error', message: 'boom' } },
      status: 500,
    });
    const err = await caught(runLookup({ question: QUESTION }, ctxFor(), { fetchImpl }));
    expect(err.code).toBe('API_ERROR');
    expect(err.exitCode).toBe(1);
    expect((err.details as { serverCode: string }).serverCode).toBe('internal_error');
  });

  it('a transport failure is NETWORK_ERROR', async () => {
    const { fetchImpl } = captureFetch(new TypeError('fetch failed'));
    const err = await caught(runLookup({ question: QUESTION }, ctxFor(), { fetchImpl }));
    expect(err.code).toBe('NETWORK_ERROR');
    expect(err.exitCode).toBe(1);
  });
});

describe('runLookup flag validation (USAGE before any fetch)', () => {
  const cases: Array<{ name: string; args: LookupArgs }> = [
    { name: 'empty question', args: { question: '' } },
    { name: 'whitespace-only question', args: { question: '   ' } },
    { name: 'question over 512 chars', args: { question: 'q'.repeat(513) } },
    { name: 'fresh-within P0D', args: { question: QUESTION, freshWithin: 'P0D' } },
    { name: 'fresh-within Q30D', args: { question: QUESTION, freshWithin: 'Q30D' } },
    { name: 'limit 0', args: { question: QUESTION, limit: '0' } },
    { name: 'limit 11', args: { question: QUESTION, limit: '11' } },
    { name: 'limit x', args: { question: QUESTION, limit: 'x' } },
    { name: 'applies-to missing =', args: { question: QUESTION, appliesTo: ['products'] } },
    {
      name: 'applies-to bad key casing',
      args: { question: QUESTION, appliesTo: ['Products=Vercel'] },
    },
  ];

  it.each(cases)('$name is USAGE and never touches the network', async ({ args }) => {
    const { fetchImpl, calls } = captureFetch({ body: MISS_BODY });
    const err = await caught(runLookup(args, ctxFor(), { fetchImpl }));
    expect(err.code).toBe('USAGE');
    expect(err.exitCode).toBe(2);
    expect(calls).toHaveLength(0);
  });
});
