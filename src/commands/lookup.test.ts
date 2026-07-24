import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runLookup } from './lookup';
import { latestLookup } from '../lib/lookup-store';
import { createCandidate } from '../lib/candidate-store';
import type { CommandContext, GlobalFlags } from '../context';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tenjin-lookup-cmd-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function makeCtx(flags: Partial<GlobalFlags> = {}): CommandContext {
  const sink = () => ({ write: () => true }) as unknown as NodeJS.WritableStream;
  return {
    flags: { json: false, timeout: 5000, baseUrl: 'https://preview.example', ...flags },
    dataDir: dir,
    io: { stdout: sink(), stderr: sink(), isTTY: false },
  };
}

function stub(body: unknown, status = 200): { fetch: typeof fetch; bodies: unknown[] } {
  const bodies: unknown[] = [];
  const fetchFn = (async (_url: string, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return { fetch: fetchFn, bodies };
}

const CANDIDATES = {
  schemaVersion: 1,
  lookupId: '0197aaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  decision: 'CANDIDATES',
  calibration: 'lexical-v1',
  candidates: [
    {
      resourceId: '0197aaaa-bbbb-cccc-dddd-ffffffffffff',
      url: 'https://preview.example/api/read/iris/slug',
      title: 'A resource',
      artifactType: 'document',
      price: '100000',
      asOf: null,
      validUntil: null,
      temporalMode: 'evergreen',
      appliesTo: {},
      questionsAnswered: [],
      tasksSupported: [],
      scope: null,
      exclusions: null,
      matchReasons: [],
      estimatedTokens: 1,
      creator: { handle: 'iris' },
    },
  ],
};

describe('runLookup', () => {
  it('converts a decimal-USD --max-price to atomic and passes the appliesTo map', async () => {
    const { fetch, bodies } = stub(CANDIDATES);
    await runLookup(
      { question: 'q', maxPrice: '0.10', freshWithin: 'P30D', appliesTo: ['products=Vercel,Next'] },
      makeCtx(),
      { fetchImpl: fetch },
    );
    expect(bodies[0]).toEqual({
      schemaVersion: 1,
      question: 'q',
      maxPrice: '100000',
      freshWithin: 'P30D',
      appliesTo: { products: ['Vercel', 'Next'] },
      limit: 5,
    });
  });

  it('records the lookup so outcome --last and buy <id> can use it', async () => {
    const { fetch } = stub(CANDIDATES);
    await runLookup({ question: 'q' }, makeCtx(), { fetchImpl: fetch });
    const latest = await latestLookup(dir);
    expect(latest?.lookupId).toBe('0197aaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
    expect(latest?.candidates[0]?.url).toBe('https://preview.example/api/read/iris/slug');
  });

  it('returns the MISS verbatim and records it', async () => {
    const miss = {
      schemaVersion: 1,
      lookupId: '0197aaaa-bbbb-cccc-dddd-000000000009',
      decision: 'MISS',
      calibration: 'lexical-v1',
    };
    const { fetch } = stub(miss);
    const res = await runLookup({ question: 'q' }, makeCtx(), { fetchImpl: fetch });
    expect((res.data as { decision: string }).decision).toBe('MISS');
  });

  it('rejects a malformed --applies-to', async () => {
    const { fetch } = stub(CANDIDATES);
    await expect(
      runLookup({ question: 'q', appliesTo: ['noequals'] }, makeCtx(), { fetchImpl: fetch }),
    ).rejects.toMatchObject({ code: 'USAGE' });
  });
});

describe('runLookup — parked-candidate nudge', () => {
  const miss = {
    schemaVersion: 1,
    lookupId: '0197aaaa-bbbb-cccc-dddd-000000000009',
    decision: 'MISS',
    calibration: 'lexical-v1',
  };

  function ctxCapturingStderr(): { ctx: CommandContext; stderr: () => string } {
    const chunks: string[] = [];
    const sink = () => ({ write: () => true }) as unknown as NodeJS.WritableStream;
    const err = {
      write: (s: string) => (chunks.push(s), true),
    } as unknown as NodeJS.WritableStream;
    return {
      stderr: () => chunks.join(''),
      ctx: {
        flags: { json: false, timeout: 5000, baseUrl: 'https://preview.example' },
        dataDir: dir,
        io: { stdout: sink(), stderr: err, isTTY: false },
      },
    };
  }

  async function park(created: string): Promise<void> {
    await createCandidate(dir, {
      draft: '# d\n',
      lookupId: '0197aaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      created,
      sourceProject: dir,
    });
  }

  const daysAgo = (n: number) => new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();

  it('emits one stderr line when candidates are parked (none stale)', async () => {
    await park(daysAgo(1));
    await park(daysAgo(2));
    const { fetch } = stub(miss);
    const { ctx, stderr } = ctxCapturingStderr();
    await runLookup({ question: 'q' }, ctx, { fetchImpl: fetch });
    expect(stderr()).toContain('2 candidate(s) parked (0 stale >7d) - tenjin candidate list');
  });

  it('counts the stale (>7d) candidates', async () => {
    await park(daysAgo(1));
    await park(daysAgo(8));
    await park(daysAgo(30));
    const { fetch } = stub(miss);
    const { ctx, stderr } = ctxCapturingStderr();
    await runLookup({ question: 'q' }, ctx, { fetchImpl: fetch });
    expect(stderr()).toContain('3 candidate(s) parked (2 stale >7d)');
  });

  it('is silent when nothing is parked', async () => {
    const { fetch } = stub(miss);
    const { ctx, stderr } = ctxCapturingStderr();
    await runLookup({ question: 'q' }, ctx, { fetchImpl: fetch });
    expect(stderr()).not.toContain('parked');
  });

  it('does NOT nudge on a HIT, even with candidates parked (MISS-only)', async () => {
    await park(daysAgo(1));
    const { fetch } = stub(CANDIDATES);
    const { ctx, stderr } = ctxCapturingStderr();
    await runLookup({ question: 'q' }, ctx, { fetchImpl: fetch });
    expect(stderr()).not.toContain('parked');
  });
});

describe('evalCohort threading', () => {
  function headerStub(): { fetch: typeof fetch; headers: Array<Record<string, string>> } {
    const headers: Array<Record<string, string>> = [];
    const fetchFn = (async (_url: string, init?: RequestInit) => {
      headers.push((init?.headers ?? {}) as Record<string, string>);
      return new Response(
        JSON.stringify({
          schemaVersion: 1,
          lookupId: '0197aaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
          decision: 'MISS',
          calibration: 'lexical-v1',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as unknown as typeof fetch;
    return { fetch: fetchFn, headers };
  }

  it('sends no eval-cohort header by default', async () => {
    const { fetch, headers } = headerStub();
    await runLookup({ question: 'q' }, makeCtx(), { fetchImpl: fetch });
    expect(headers[0]?.['x-tenjin-eval-cohort']).toBeUndefined();
  });

  it('sends X-Tenjin-Eval-Cohort: 1 when config.json opts in', async () => {
    await writeFile(join(dir, 'config.json'), JSON.stringify({ evalCohort: true }));
    const { fetch, headers } = headerStub();
    await runLookup({ question: 'q' }, makeCtx(), { fetchImpl: fetch });
    expect(headers[0]?.['x-tenjin-eval-cohort']).toBe('1');
  });
});

describe('candidate URL origin ingest boundary', () => {
  it('refuses a response whose candidate URL points off the configured base URL', async () => {
    const offOrigin = {
      ...CANDIDATES,
      candidates: [
        {
          ...(CANDIDATES.candidates[0] as object),
          url: 'https://evil.example/api/read/iris/slug',
        },
      ],
    };
    const { fetch } = stub(offOrigin);
    await expect(
      runLookup({ question: 'q' }, makeCtx(), { fetchImpl: fetch }),
    ).rejects.toMatchObject({ code: 'CONTRACT_MISMATCH', exitCode: 1 });
  });
});
