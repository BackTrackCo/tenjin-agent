import { describe, it, expect } from 'vitest';
import pkg from '../../package.json';
import {
  baseHeaders,
  CLIENT_LABEL,
  LookupResponseSchema,
  parseBody,
  serverError,
  apiErrorFrom,
} from './api';
import { CliError } from './errors';
import type { FetchResponseSuccess } from './http';

/** Build a FetchResponseSuccess without going through fetchResponse/fetch. */
function fakeSuccess(
  json: unknown,
  opts: { status?: number; headers?: Record<string, string>; requestId?: string } = {},
): FetchResponseSuccess {
  const headers = opts.headers ?? {};
  return {
    ok: true,
    status: opts.status ?? 200,
    json,
    header: (name) => headers[name.toLowerCase()] ?? null,
    ...(opts.requestId !== undefined ? { requestId: opts.requestId } : {}),
  };
}

async function catchCliError<T>(fn: () => T): Promise<CliError> {
  try {
    fn();
  } catch (e) {
    return e as CliError;
  }
  throw new Error('expected the call to throw');
}

describe('CLIENT_LABEL / baseHeaders', () => {
  it('CLIENT_LABEL carries the package version', () => {
    expect(CLIENT_LABEL).toBe(`tenjin-cli/${pkg.version}`);
  });

  it('sends accept and x-tenjin-client, mergeable with extra headers', () => {
    expect(baseHeaders()).toEqual({
      accept: 'application/json',
      'x-tenjin-client': `tenjin-cli/${pkg.version}`,
    });
    expect(baseHeaders({ 'sign-in-with-x': 'sig' })).toEqual({
      accept: 'application/json',
      'x-tenjin-client': `tenjin-cli/${pkg.version}`,
      'sign-in-with-x': 'sig',
    });
  });
});

const CANDIDATE = {
  resourceId: 'res_123',
  url: 'https://tenjin.blog/a/example-post',
  title: 'Example post title',
  artifactType: 'article',
  price: '250000',
  asOf: '2026-07-01T00:00:00.000Z',
  validUntil: null,
  temporalMode: 'point-in-time',
  appliesTo: { region: ['US', 'EU'] },
  questionsAnswered: ['What changed in the release?'],
  tasksSupported: ['summarize'],
  scope: 'US market',
  exclusions: null,
  matchReasons: ['keyword overlap'],
  estimatedTokens: 512,
  creator: { handle: 'athoughts' },
  // Field the schema doesn't pin: must survive parsing via looseObject.
  freshnessScore: 0.92,
};

const CANDIDATES_RESPONSE = {
  schemaVersion: 1,
  lookupId: 'lu_abc123',
  decision: 'CANDIDATES',
  calibration: 'high',
  candidates: [CANDIDATE],
  // Top-level field the schema doesn't pin either.
  debug: { tookMs: 42 },
};

const MISS_RESPONSE = {
  schemaVersion: 1,
  lookupId: 'lu_miss1',
  decision: 'MISS',
  calibration: 'low',
  // no candidates key at all
};

describe('LookupResponseSchema', () => {
  it('accepts a full CANDIDATES response and preserves unknown extra fields', () => {
    const parsed = LookupResponseSchema.safeParse(CANDIDATES_RESPONSE);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.decision).toBe('CANDIDATES');
    expect(parsed.data.candidates).toHaveLength(1);
    const candidate = parsed.data.candidates?.[0] as unknown as Record<string, unknown>;
    expect(candidate.freshnessScore).toBe(0.92);
    expect((parsed.data as unknown as Record<string, unknown>).debug).toEqual({ tookMs: 42 });
  });

  it('accepts a MISS response with no candidates key', () => {
    const parsed = LookupResponseSchema.safeParse(MISS_RESPONSE);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.decision).toBe('MISS');
    expect(parsed.data.candidates).toBeUndefined();
  });
});

describe('parseBody', () => {
  it('returns the parsed value on a schema match', () => {
    const res = fakeSuccess(MISS_RESPONSE);
    const data = parseBody(LookupResponseSchema, res, 'lookup');
    expect(data.decision).toBe('MISS');
  });

  it('throws CONTRACT_MISMATCH with issues in details on a schema mismatch', async () => {
    const res = fakeSuccess(
      { schemaVersion: 1, decision: 'NOT_A_DECISION' },
      { requestId: 'req-1' },
    );
    const err = await catchCliError(() => parseBody(LookupResponseSchema, res, 'lookup'));
    expect(err).toBeInstanceOf(CliError);
    expect(err.code).toBe('CONTRACT_MISMATCH');
    expect(err.message).toContain('lookup');
    const details = err.details as { issues: unknown[]; requestId: string };
    expect(Array.isArray(details.issues)).toBe(true);
    expect(details.issues.length).toBeGreaterThan(0);
    expect(details.requestId).toBe('req-1');
  });
});

describe('serverError', () => {
  it('returns the error envelope code/message when present', () => {
    const res = fakeSuccess({ error: { code: 'NOT_FOUND', message: 'no such thing' } });
    expect(serverError(res)).toEqual({ code: 'NOT_FOUND', message: 'no such thing' });
  });

  it('returns null on a non-envelope body', () => {
    expect(serverError(fakeSuccess({ items: [] }))).toBeNull();
    expect(serverError(fakeSuccess([1, 2, 3]))).toBeNull();
    expect(serverError(fakeSuccess('plain string'))).toBeNull();
  });
});

describe('apiErrorFrom', () => {
  it('maps 429 to RATE_LIMITED with retryAfterSeconds from the Retry-After header', () => {
    const res = fakeSuccess(
      {},
      { status: 429, headers: { 'retry-after': '30' }, requestId: 'req-2' },
    );
    const err = apiErrorFrom(res, 'lookup');
    expect(err.code).toBe('RATE_LIMITED');
    expect(err.exitCode).toBe(1);
    expect(err.fix).toBe('Retry after 30s.');
    const details = err.details as { retryAfterSeconds: number; requestId: string };
    expect(details.retryAfterSeconds).toBe(30);
    expect(details.requestId).toBe('req-2');
  });

  it('maps 429 without a Retry-After header to RATE_LIMITED with no retryAfterSeconds', () => {
    const res = fakeSuccess({}, { status: 429 });
    const err = apiErrorFrom(res, 'lookup');
    expect(err.code).toBe('RATE_LIMITED');
    expect(err.fix).toBe('Retry shortly.');
    const details = err.details as Record<string, unknown>;
    expect('retryAfterSeconds' in details).toBe(false);
  });

  it('maps other statuses to API_ERROR carrying the server envelope code', () => {
    const res = fakeSuccess(
      { error: { code: 'INTERNAL_SERVER_ERROR', message: 'boom' } },
      { status: 500, requestId: 'req-3' },
    );
    const err = apiErrorFrom(res, 'lookup');
    expect(err.code).toBe('API_ERROR');
    expect(err.exitCode).toBe(1);
    expect(err.message).toContain('boom');
    const details = err.details as { status: number; serverCode: string; requestId: string };
    expect(details.status).toBe(500);
    expect(details.serverCode).toBe('INTERNAL_SERVER_ERROR');
    expect(details.requestId).toBe('req-3');
  });

  it('maps a non-envelope error body to API_ERROR without a serverCode', () => {
    const res = fakeSuccess({ foo: 'bar' }, { status: 400 });
    const err = apiErrorFrom(res, 'lookup');
    expect(err.code).toBe('API_ERROR');
    expect(err.message).toContain('status 400');
    const details = err.details as Record<string, unknown>;
    expect('serverCode' in details).toBe(false);
  });
});
