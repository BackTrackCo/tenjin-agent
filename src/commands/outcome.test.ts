import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runOutcome, OUTCOME_STATUSES } from './outcome';
import type { OutcomeArgs } from './outcome';
import { CLIENT_LABEL } from '../lib/api';
import { contentHashOf, recordLookup, saveLibraryItem } from '../lib/state';
import { CliError } from '../lib/errors';
import type { CommandContext } from '../context';
import type { Io } from '../lib/output';

const BASE = 'https://tenjin.test';
const LOOKUP_ID = '0b0b0b0b-1111-4222-8333-444455556666';
const OLDER_LOOKUP_ID = '9e9e9e9e-1111-4222-8333-444455556666';
const RESOURCE_ID = 'aaaa1111-2222-4333-8444-555566667777';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tenjin-outcome-'));
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
      status: reply.status ?? 202,
      ...(reply.headers !== undefined ? { headers: reply.headers } : {}),
    });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const ACCEPTED: CannedResponse = { body: { accepted: 1 }, status: 202 };

async function caught(promise: Promise<unknown>): Promise<CliError> {
  const err = await promise.catch((e: unknown) => e);
  expect(err).toBeInstanceOf(CliError);
  return err as CliError;
}

async function seedHistory(lookupId: string, at: string): Promise<void> {
  await recordLookup(dir, {
    lookupId,
    decision: 'CANDIDATES',
    at,
    candidates: [
      { resourceId: RESOURCE_ID, url: `${BASE}/read/alice/foo`, title: 'Foo', price: '250000' },
    ],
  });
}

async function seedLibrary(bodyMd: string): Promise<void> {
  await saveLibraryItem(
    dir,
    {
      resourceId: RESOURCE_ID,
      slug: 'foo',
      title: 'Foo',
      url: `${BASE}/read/alice/foo`,
      priceAtomic: '250000',
      paidAtomic: '250000',
      txHash: null,
      entitlement: 'paid',
      creatorHandle: 'alice',
    },
    bodyMd,
  );
}

describe('runOutcome wire contract', () => {
  it('posts a single {status} object to /api/agent/lookups/<id>/outcomes and treats 202 as success', async () => {
    const { fetchImpl, calls } = captureFetch(ACCEPTED);
    const res = await runOutcome({ lookupId: LOOKUP_ID, status: 'used' }, ctxFor(), { fetchImpl });

    expect(calls).toHaveLength(1);
    const call = calls[0] as CapturedCall;
    expect(call.url).toBe(`${BASE}/api/agent/lookups/${LOOKUP_ID}/outcomes`);
    expect(call.method).toBe('POST');
    expect(call.headers.get('accept')).toBe('application/json');
    expect(call.headers.get('content-type')).toBe('application/json');
    expect(call.headers.get('x-tenjin-client')).toBe(CLIENT_LABEL);
    expect(call.body).toEqual({ status: 'used' });

    expect(res.data).toEqual({
      lookupId: LOOKUP_ID,
      submitted: { status: 'used' },
      accepted: true,
    });
    expect(res.humanLines?.[0]).toContain('202 accepted');
  });

  it('--last resolves the newest history entry', async () => {
    await seedHistory(OLDER_LOOKUP_ID, '2026-07-18T00:00:00.000Z');
    await seedHistory(LOOKUP_ID, '2026-07-19T00:00:00.000Z');
    const { fetchImpl, calls } = captureFetch(ACCEPTED);
    await runOutcome({ last: true, status: 'regenerated' }, ctxFor(), { fetchImpl });
    expect((calls[0] as CapturedCall).url).toBe(`${BASE}/api/agent/lookups/${LOOKUP_ID}/outcomes`);
    expect((calls[0] as CapturedCall).body).toEqual({ status: 'regenerated' });
  });

  it('--last with no local history is USAGE without a fetch', async () => {
    const { fetchImpl, calls } = captureFetch(ACCEPTED);
    const err = await caught(runOutcome({ last: true, status: 'used' }, ctxFor(), { fetchImpl }));
    expect(err.code).toBe('USAGE');
    expect(calls).toHaveLength(0);
  });
});

describe('runOutcome contentHash resolution', () => {
  it('--resource auto-attaches the library contentHash when --content-hash is omitted', async () => {
    const bodyMd = '# Foo\n\nThe purchased body.\n';
    await seedLibrary(bodyMd);
    const { fetchImpl, calls } = captureFetch(ACCEPTED);
    await runOutcome({ lookupId: LOOKUP_ID, status: 'used', resource: RESOURCE_ID }, ctxFor(), {
      fetchImpl,
    });
    expect((calls[0] as CapturedCall).body).toEqual({
      status: 'used',
      resourceId: RESOURCE_ID,
      contentHash: contentHashOf(bodyMd),
    });
  });

  it('an explicit --content-hash wins over the seeded library hash', async () => {
    await seedLibrary('# Foo\n\nThe purchased body.\n');
    const explicit = `sha256:${'ab'.repeat(32)}`;
    const { fetchImpl, calls } = captureFetch(ACCEPTED);
    await runOutcome(
      {
        lookupId: LOOKUP_ID,
        status: 'partially_used',
        resource: RESOURCE_ID,
        contentHash: explicit,
      },
      ctxFor(),
      { fetchImpl },
    );
    expect((calls[0] as CapturedCall).body).toEqual({
      status: 'partially_used',
      resourceId: RESOURCE_ID,
      contentHash: explicit,
    });
  });

  it('--resource with no library entry sends no contentHash', async () => {
    const { fetchImpl, calls } = captureFetch(ACCEPTED);
    await runOutcome({ lookupId: LOOKUP_ID, status: 'rejected', resource: RESOURCE_ID }, ctxFor(), {
      fetchImpl,
    });
    expect((calls[0] as CapturedCall).body).toEqual({
      status: 'rejected',
      resourceId: RESOURCE_ID,
    });
  });
});

describe('runOutcome argument validation (USAGE before any fetch)', () => {
  const cases: Array<{ name: string; args: OutcomeArgs }> = [
    {
      name: 'both --lookup-id and --last',
      args: { lookupId: LOOKUP_ID, last: true, status: 'used' },
    },
    { name: 'neither --lookup-id nor --last', args: { status: 'used' } },
    { name: 'a non-uuid --lookup-id', args: { lookupId: 'not-a-uuid', status: 'used' } },
    {
      name: 'a non-uuid --resource',
      args: { lookupId: LOOKUP_ID, status: 'used', resource: 'nope' },
    },
    {
      name: 'a malformed --content-hash (not sha256:hex)',
      args: { lookupId: LOOKUP_ID, status: 'used', contentHash: 'sha256:xyz' },
    },
    {
      name: 'an uppercase --content-hash',
      args: { lookupId: LOOKUP_ID, status: 'used', contentHash: `sha256:${'AB'.repeat(32)}` },
    },
  ];

  it.each(cases)('$name is USAGE and never touches the network', async ({ args }) => {
    const { fetchImpl, calls } = captureFetch(ACCEPTED);
    const err = await caught(runOutcome(args, ctxFor(), { fetchImpl }));
    expect(err.code).toBe('USAGE');
    expect(err.exitCode).toBe(2);
    expect(calls).toHaveLength(0);
  });

  it('an invalid --status is USAGE listing all five statuses', async () => {
    const { fetchImpl, calls } = captureFetch(ACCEPTED);
    const err = await caught(
      runOutcome({ lookupId: LOOKUP_ID, status: 'loved-it' }, ctxFor(), { fetchImpl }),
    );
    expect(err.code).toBe('USAGE');
    expect(calls).toHaveLength(0);
    expect(OUTCOME_STATUSES).toHaveLength(5);
    for (const status of OUTCOME_STATUSES) {
      expect(err.fix).toContain(status);
    }
  });
});

describe('runOutcome failure mapping', () => {
  it('400 is USAGE carrying the server details', async () => {
    const serverBody = { error: { code: 'invalid_request', message: 'unknown status' } };
    const { fetchImpl } = captureFetch({ body: serverBody, status: 400 });
    const err = await caught(
      runOutcome({ lookupId: LOOKUP_ID, status: 'used' }, ctxFor(), { fetchImpl }),
    );
    expect(err.code).toBe('USAGE');
    expect(err.exitCode).toBe(2);
    expect(err.details).toEqual(serverBody);
  });

  it('429 is RATE_LIMITED with retryAfterSeconds', async () => {
    const { fetchImpl } = captureFetch({
      body: { error: { code: 'rate_limited', message: 'slow down' } },
      status: 429,
      headers: { 'retry-after': '7' },
    });
    const err = await caught(
      runOutcome({ lookupId: LOOKUP_ID, status: 'used' }, ctxFor(), { fetchImpl }),
    );
    expect(err.code).toBe('RATE_LIMITED');
    expect(err.exitCode).toBe(1);
    expect((err.details as { retryAfterSeconds: number }).retryAfterSeconds).toBe(7);
  });

  it('an unexpected 200 is API_ERROR (the contract says 202)', async () => {
    const { fetchImpl } = captureFetch({ body: { accepted: 1 }, status: 200 });
    const err = await caught(
      runOutcome({ lookupId: LOOKUP_ID, status: 'used' }, ctxFor(), { fetchImpl }),
    );
    expect(err.code).toBe('API_ERROR');
    expect(err.exitCode).toBe(1);
  });

  it('a transport failure is NETWORK_ERROR', async () => {
    const { fetchImpl } = captureFetch(new TypeError('fetch failed'));
    const err = await caught(
      runOutcome({ lookupId: LOOKUP_ID, status: 'used' }, ctxFor(), { fetchImpl }),
    );
    expect(err.code).toBe('NETWORK_ERROR');
    expect(err.exitCode).toBe(1);
  });
});
