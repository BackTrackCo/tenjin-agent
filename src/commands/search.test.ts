import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSearch } from './search';
import { latestSearch } from '../lib/search-store';
import { createCandidate } from '../lib/candidate-store';
import type { CommandContext, GlobalFlags } from '../context';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tenjin-search-cmd-'));
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
  searchId: '0197aaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
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

describe('runSearch', () => {
  it('converts a decimal-USD --max-price to atomic and passes the appliesTo map', async () => {
    const { fetch, bodies } = stub(CANDIDATES);
    await runSearch(
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

  it('records the search so outcome --last and buy <id> can use it', async () => {
    const { fetch } = stub(CANDIDATES);
    await runSearch({ question: 'q' }, makeCtx(), { fetchImpl: fetch });
    const latest = await latestSearch(dir);
    expect(latest?.searchId).toBe('0197aaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
    expect(latest?.candidates[0]?.url).toBe('https://preview.example/api/read/iris/slug');
  });

  it('returns the MISS verbatim and records it', async () => {
    const miss = {
      schemaVersion: 1,
      searchId: '0197aaaa-bbbb-cccc-dddd-000000000009',
      decision: 'MISS',
      calibration: 'lexical-v1',
    };
    const { fetch } = stub(miss);
    const res = await runSearch({ question: 'q' }, makeCtx(), { fetchImpl: fetch });
    expect((res.data as { decision: string }).decision).toBe('MISS');
  });

  // The browse tail (tenjin#460) is MISS-only and must stay a hint: one human
  // line, never merged into candidates, never recorded as a buyable candidate.
  const BROWSE_MISS = {
    schemaVersion: 1,
    searchId: '0197aaaa-bbbb-cccc-dddd-00000000000b',
    decision: 'MISS',
    calibration: 'lexical-v1',
    browse: [
      {
        resourceId: '0197aaaa-bbbb-cccc-dddd-00000000000c',
        url: 'https://preview.example/api/read/iris/one',
        title: 'Browse one',
        price: '100000',
        creator: { handle: 'iris' },
      },
      {
        resourceId: '0197aaaa-bbbb-cccc-dddd-00000000000d',
        url: 'https://preview.example/api/read/iris/two',
        title: 'Browse two',
        price: '200000',
        creator: { handle: 'iris' },
      },
    ],
  };

  it('renders a MISS browse tail as exactly one extra hint line', async () => {
    const { fetch } = stub(BROWSE_MISS);
    const res = await runSearch({ question: 'q' }, makeCtx(), { fetchImpl: fetch });
    expect(res.humanLines).toHaveLength(2);
    expect(res.humanLines?.[0]).toContain('MISS, no candidates');
    // The price is on the line because `buy <browse url>` really does pay: the
    // URL arm of resolveResourceRef never consults the store, so this is the
    // only human-visible surface that can warn before the spend. It reads in
    // dollars, the same unit every spend gate is entered in, and at the canonical
    // two-decimal precision, so a dime is "0.10" and never "0.1" or "100000".
    expect(res.humanLines?.[1]).toBe(
      'no match, 2 piece(s) you could browse: Browse one (0.10 USD); Browse two (0.20 USD)',
    );
    expect(res.humanLines?.[1]).not.toContain('atomic');
    expect(res.humanLines?.[1]).not.toContain('—');
    // The machine envelope is unaffected: --json still carries exact atomic.
    expect((res.data as { browse?: { price: string }[] }).browse?.[0]?.price).toBe('100000');
  });

  it('keeps browse pointers out of candidates and out of the local store', async () => {
    const { fetch } = stub(BROWSE_MISS);
    const res = await runSearch({ question: 'q' }, makeCtx(), { fetchImpl: fetch });
    expect((res.data as { candidates?: unknown[] }).candidates).toBeUndefined();
    const latest = await latestSearch(dir);
    expect(latest?.candidates).toEqual([]);
  });

  // A plainly different host is the easy case. The two shapes this check exists
  // to stop are the ones that survive a naive `startsWith`/`includes` rewrite:
  // userinfo, where the real host is what follows the `@`, and a subdomain
  // suffix, where the base URL is a prefix of an attacker-owned name. Pin all
  // three so "simplifying" the origin comparison to a substring test fails here.
  it.each([
    ['a plainly different host', 'https://evil.example/api/read/iris/one'],
    ['userinfo masquerading as the host', 'https://preview.example@evil.example/api/read/iris/one'],
    [
      'a subdomain suffix of the base host',
      'https://preview.example.evil.example/api/read/iris/one',
    ],
  ])('refuses a browse pointer url off the configured base URL: %s', async (_label, url) => {
    const evil = { ...BROWSE_MISS, browse: [{ ...BROWSE_MISS.browse[0], url }] };
    const { fetch } = stub(evil);
    await expect(
      runSearch({ question: 'q' }, makeCtx(), { fetchImpl: fetch }),
    ).rejects.toMatchObject({ code: 'CONTRACT_MISMATCH' });
  });

  it('rejects a malformed --applies-to', async () => {
    const { fetch } = stub(CANDIDATES);
    await expect(
      runSearch({ question: 'q', appliesTo: ['noequals'] }, makeCtx(), { fetchImpl: fetch }),
    ).rejects.toMatchObject({ code: 'USAGE' });
  });
});

describe('runSearch — parked-candidate nudge', () => {
  const miss = {
    schemaVersion: 1,
    searchId: '0197aaaa-bbbb-cccc-dddd-000000000009',
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
      searchId: '0197aaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
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
    await runSearch({ question: 'q' }, ctx, { fetchImpl: fetch });
    expect(stderr()).toContain('2 candidate(s) parked (0 stale >7d) - tenjin candidate list');
  });

  it('counts the stale (>7d) candidates', async () => {
    await park(daysAgo(1));
    await park(daysAgo(8));
    await park(daysAgo(30));
    const { fetch } = stub(miss);
    const { ctx, stderr } = ctxCapturingStderr();
    await runSearch({ question: 'q' }, ctx, { fetchImpl: fetch });
    expect(stderr()).toContain('3 candidate(s) parked (2 stale >7d)');
  });

  it('is silent when nothing is parked', async () => {
    const { fetch } = stub(miss);
    const { ctx, stderr } = ctxCapturingStderr();
    await runSearch({ question: 'q' }, ctx, { fetchImpl: fetch });
    expect(stderr()).not.toContain('parked');
  });

  it('does NOT nudge on a HIT, even with candidates parked (MISS-only)', async () => {
    await park(daysAgo(1));
    const { fetch } = stub(CANDIDATES);
    const { ctx, stderr } = ctxCapturingStderr();
    await runSearch({ question: 'q' }, ctx, { fetchImpl: fetch });
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
          searchId: '0197aaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
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
    await runSearch({ question: 'q' }, makeCtx(), { fetchImpl: fetch });
    expect(headers[0]?.['x-tenjin-eval-cohort']).toBeUndefined();
  });

  it('sends X-Tenjin-Eval-Cohort: 1 when config.json opts in', async () => {
    await writeFile(join(dir, 'config.json'), JSON.stringify({ evalCohort: true }));
    const { fetch, headers } = headerStub();
    await runSearch({ question: 'q' }, makeCtx(), { fetchImpl: fetch });
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
      runSearch({ question: 'q' }, makeCtx(), { fetchImpl: fetch }),
    ).rejects.toMatchObject({ code: 'CONTRACT_MISMATCH', exitCode: 1 });
  });
});
