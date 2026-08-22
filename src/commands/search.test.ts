import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSearch } from './search';
import { latestSearch } from '../lib/search-store';
import { PRODUCTION_ORIGIN, knownDeploymentOrigins } from '../lib/production-origin';
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

/** The v3 decision-view envelope with one match: `items` + `matched`, and no
 *  `decision` word anywhere on the wire. */
const HIT = {
  schemaVersion: 3,
  searchId: '0197aaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  calibration: 'lexical-v1',
  matched: 1,
  items: [
    {
      resourceId: '0197aaaa-bbbb-cccc-dddd-ffffffffffff',
      url: 'https://preview.example/api/read/iris/slug',
      slug: 'slug',
      title: 'A resource',
      artifactType: 'document',
      price: '100000',
      asOf: null,
      validUntil: null,
      matchReasons: [],
      estimatedTokens: 1,
      creator: { handle: 'iris' },
    },
  ],
};

/** A v3 miss. Not a second envelope shape: the same result with nothing in it,
 *  plus the server's own pointer at where the catalog is browsed. */
const MISS = {
  schemaVersion: 3,
  searchId: '0197aaaa-bbbb-cccc-dddd-000000000009',
  calibration: 'lexical-v1',
  matched: 0,
  items: [],
  hint: 'No matches. Browse the catalog at GET /api/articles.',
};

describe('runSearch', () => {
  it('converts a decimal-USD --max-price to atomic and passes the appliesTo map', async () => {
    const { fetch, bodies } = stub(HIT);
    await runSearch(
      { question: 'q', maxPrice: '0.10', freshWithin: 'P30D', appliesTo: ['products=Vercel,Next'] },
      makeCtx(),
      { fetchImpl: fetch },
    );
    // Nested under `filters`, which is where v3 puts every narrowing. A stray
    // top-level `maxPrice` is not a 400: the server strips it into `warnings` and
    // runs the search UNFILTERED, so this shape is the price cap actually
    // applying rather than a cosmetic detail.
    expect(bodies[0]).toEqual({
      schemaVersion: 3,
      view: 'decision',
      query: 'q',
      filters: {
        maxPrice: '100000',
        freshWithin: 'P30D',
        appliesTo: { products: ['Vercel', 'Next'] },
      },
      limit: 5,
    });
  });

  it('records the search so outcome --last and buy <id> can use it', async () => {
    const { fetch } = stub(HIT);
    await runSearch({ question: 'q' }, makeCtx(), { fetchImpl: fetch });
    const latest = await latestSearch(dir);
    expect(latest?.searchId).toBe('0197aaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
    expect(latest?.candidates[0]?.url).toBe('https://preview.example/api/read/iris/slug');
  });

  // The Stop hook scopes its nag on this, so a session that set the variable
  // stops hearing about a sibling session's open loops.
  it('stamps the session from TENJIN_SESSION_ID when it is set', async () => {
    const { fetch } = stub(HIT);
    await runSearch({ question: 'q' }, makeCtx(), {
      fetchImpl: fetch,
      env: { TENJIN_SESSION_ID: 'session-a' },
    });
    expect((await latestSearch(dir))?.sessionId).toBe('session-a');
  });

  // A harness that exports neither variable. Unstamped means the reminder is
  // raised in every session rather than in none.
  it('records no session when the environment names none', async () => {
    const { fetch } = stub(HIT);
    await runSearch({ question: 'q' }, makeCtx(), { fetchImpl: fetch, env: {} });
    expect((await latestSearch(dir))?.sessionId).toBeUndefined();
  });

  it('ignores a blank TENJIN_SESSION_ID rather than stamping an empty session', async () => {
    const { fetch } = stub(HIT);
    await runSearch({ question: 'q' }, makeCtx(), {
      fetchImpl: fetch,
      env: { TENJIN_SESSION_ID: '   ' },
    });
    expect((await latestSearch(dir))?.sessionId).toBeUndefined();
  });

  // The ambient harness variable: the same value the hook scripts are handed on
  // stdin, so a CLI search and a hook search in one session stamp identically.
  it('stamps the session from CLAUDE_CODE_SESSION_ID when it is set', async () => {
    const { fetch } = stub(HIT);
    await runSearch({ question: 'q' }, makeCtx(), {
      fetchImpl: fetch,
      env: { CLAUDE_CODE_SESSION_ID: 'harness-session' },
    });
    expect((await latestSearch(dir))?.sessionId).toBe('harness-session');
  });

  // Explicit operator override beats the ambient one.
  it('prefers TENJIN_SESSION_ID over CLAUDE_CODE_SESSION_ID', async () => {
    const { fetch } = stub(HIT);
    await runSearch({ question: 'q' }, makeCtx(), {
      fetchImpl: fetch,
      env: { TENJIN_SESSION_ID: 'operator', CLAUDE_CODE_SESSION_ID: 'harness-session' },
    });
    expect((await latestSearch(dir))?.sessionId).toBe('operator');
  });

  // A blank override falls THROUGH to the harness value rather than blanking it.
  it('falls back to CLAUDE_CODE_SESSION_ID when TENJIN_SESSION_ID is blank', async () => {
    const { fetch } = stub(HIT);
    await runSearch({ question: 'q' }, makeCtx(), {
      fetchImpl: fetch,
      env: { TENJIN_SESSION_ID: '  ', CLAUDE_CODE_SESSION_ID: 'harness-session' },
    });
    expect((await latestSearch(dir))?.sessionId).toBe('harness-session');
  });

  // The candidate line prices in dollars, like the browse hint below it: a human
  // reading a price has to be able to compare it to `--max-price 0.10` without
  // dividing by a million. Two decimals, so a dime is "0.10" and not "0.1".
  it('renders the candidate line in USD, not atomic units', async () => {
    const { fetch } = stub(HIT);
    const res = await runSearch({ question: 'q' }, makeCtx(), { fetchImpl: fetch });
    expect(res.humanLines?.[1]).toBe(
      '  1. A resource, 0.10 USD, https://preview.example/api/read/iris/slug',
    );
    expect(res.humanLines?.[1]).not.toContain('atomic');
    // The machine envelope is unaffected: --json still carries exact atomic.
    expect((res.data as { items?: { price: string }[] }).items?.[0]?.price).toBe('100000');
  });

  it('returns the miss verbatim and records it', async () => {
    const { fetch } = stub(MISS);
    const res = await runSearch({ question: 'q' }, makeCtx(), { fetchImpl: fetch });
    // No `decision` on the wire under v3: the miss IS `matched: 0` with an empty
    // `items`, and the envelope carries the server's fields untouched.
    const data = res.data as { matched: number; items: unknown[]; decision?: string };
    expect(data.matched).toBe(0);
    expect(data.items).toEqual([]);
    expect(data).not.toHaveProperty('decision');
    // A miss offered nothing to buy, and the store has to say so rather than
    // leave it unknown: that is what lets `outcome` refuse purchase_declined here.
    expect(await latestSearch(dir)).toMatchObject({ candidates: [], paidBrowseCount: 0 });
  });

  // The store's CANDIDATES/MISS vocabulary predates v3 and `outcome` still
  // branches on it, so it is DERIVED from whether anything matched and never read
  // off a response field that no longer exists.
  it('derives the stored decision from whether anything matched', async () => {
    const { fetch } = stub(MISS);
    await runSearch({ question: 'q' }, makeCtx(), { fetchImpl: fetch });
    expect((await latestSearch(dir))?.decision).toBe('MISS');

    const hit = stub(HIT);
    await runSearch({ question: 'q' }, makeCtx(), { fetchImpl: hit.fetch });
    expect((await latestSearch(dir))?.decision).toBe('CANDIDATES');
  });

  // The v2 MISS browse tail is gone: the decision view draws no fallback shelf,
  // so there is never a payable pointer this search put in front of the agent.
  // The field stays on the store because entries written by older CLIs carry a
  // real count and `undefined` there must keep reading as "unknown", not zero.
  it('records a zero paid-browse count, because v3 draws no browse tail', async () => {
    const { fetch } = stub(MISS);
    await runSearch({ question: 'q' }, makeCtx(), { fetchImpl: fetch });
    expect((await latestSearch(dir))?.paidBrowseCount).toBe(0);
  });

  // One line, and it is the SERVER's sentence rather than a local paraphrase, so
  // the two cannot drift when that pointer moves.
  it('renders the miss hint as exactly one extra line, in the server wording', async () => {
    const { fetch } = stub(MISS);
    const res = await runSearch({ question: 'q' }, makeCtx(), { fetchImpl: fetch });
    // MISS line, hint, publish-back line.
    expect(res.humanLines).toHaveLength(3);
    expect(res.humanLines?.[0]).toContain('MISS, no candidates');
    expect(res.humanLines?.[1]).toBe('No matches. Browse the catalog at GET /api/articles.');
    expect(res.humanLines?.[2]).toContain('publish it back');
  });

  it('costs the reader a line rather than an empty bullet when the hint is absent', async () => {
    const noHint: Record<string, unknown> = { ...MISS };
    delete noHint.hint;
    const { fetch } = stub(noHint);
    const res = await runSearch({ question: 'q' }, makeCtx(), { fetchImpl: fetch });
    expect(res.humanLines).toHaveLength(2);
    expect(res.humanLines?.[1]).toContain('publish it back');
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
  ])('refuses an item url off the configured base URL: %s', async (_label, url) => {
    const evil = { ...HIT, items: [{ ...(HIT.items[0] as object), url }] };
    const { fetch } = stub(evil);
    await expect(
      runSearch({ question: 'q' }, makeCtx(), { fetchImpl: fetch }),
    ).rejects.toMatchObject({ code: 'CONTRACT_MISMATCH' });
  });

  // `truncated` fires when the server dropped candidates the limit had room for,
  // and there is no cursor: the hint has to point at narrowing the question, since
  // a smaller --limit would only shorten the list further.
  // The remedy is counter-intuitive after tenjin#501: the ceiling grows with the
  // candidates returned, so a truncated page is recovered by asking for MORE. The
  // CLI knows the limit it sent, so it names the step that applies rather than
  // making the reader work out which half of the rule they are in.
  it('tells a below-maximum search to retry with a larger limit', async () => {
    const { fetch } = stub({ ...HIT, truncated: true });
    const res = await runSearch({ question: 'q', limit: '3' }, makeCtx(), { fetchImpl: fetch });
    expect(res.humanLines?.at(-1)).toBe(
      'some candidates were dropped for size; retry with --limit 10 (the size ceiling grows with the number of candidates returned)',
    );
    expect((res.data as { truncated?: true }).truncated).toBe(true);
  });

  it('tells a search already at the maximum to narrow the question instead', async () => {
    const { fetch } = stub({ ...HIT, truncated: true });
    const res = await runSearch({ question: 'q', limit: '10' }, makeCtx(), { fetchImpl: fetch });
    expect(res.humanLines?.at(-1)).toBe(
      'some candidates were dropped for size; at --limit 10 the dropped tail cannot be recovered, so narrow the question',
    );
  });

  it('says nothing about truncation when the flag did not fire', async () => {
    const { fetch } = stub(HIT);
    const res = await runSearch({ question: 'q' }, makeCtx(), { fetchImpl: fetch });
    expect(res.humanLines?.some((l) => l.includes('dropped for size'))).toBe(false);
    expect((res.data as { truncated?: true }).truncated).toBeUndefined();
  });

  // The default limit is 5, so an unflagged search must still get the larger-limit
  // advice rather than the terminal one.
  it('uses the sent limit, not the maximum, to pick the advice', async () => {
    const { fetch } = stub({ ...HIT, truncated: true });
    const res = await runSearch({ question: 'q' }, makeCtx(), { fetchImpl: fetch });
    expect(res.humanLines?.at(-1)).toContain('retry with --limit 10');
  });

  it('rejects a malformed --applies-to', async () => {
    const { fetch } = stub(HIT);
    await expect(
      runSearch({ question: 'q', appliesTo: ['noequals'] }, makeCtx(), { fetchImpl: fetch }),
    ).rejects.toMatchObject({ code: 'USAGE' });
  });
});

describe('runSearch — the miss stderr surface', () => {
  const miss = MISS;

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

  // An older version's pen is still on disk, because uninstall and upgrade both
  // leave operator data alone. Nothing reads it: a search neither counts it nor
  // mentions it, which is the whole of the "leave it, stop reading it" decision.
  it('ignores residual ~/.tenjin/candidates data left by an older version', async () => {
    const pen = join(dir, 'candidates', '0197aaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
    await mkdir(pen, { recursive: true });
    await writeFile(join(pen, 'draft.md'), '# an old parked draft\n');
    await writeFile(
      join(pen, 'meta.json'),
      JSON.stringify({ searchId: '0197aaaa-bbbb-cccc-dddd-eeeeeeeeeeee' }),
    );

    const { fetch } = stub(miss);
    const { ctx, stderr } = ctxCapturingStderr();
    await runSearch({ question: 'q' }, ctx, { fetchImpl: fetch });
    expect(stderr()).not.toContain('parked');
    expect(stderr()).not.toContain('candidate');
    // And it is still there afterwards: nothing cleans it up either.
    expect(existsSync(join(pen, 'draft.md'))).toBe(true);
  });

  describe('publish-back on a fresh miss', () => {
    const humanText = (res: { humanLines?: string[] }): string => (res.humanLines ?? []).join('\n');

    it('names the searchId, the publish arm, and the decline arm', async () => {
      const { fetch } = stub(miss);
      const res = await runSearch({ question: 'q' }, makeCtx(), { fetchImpl: fetch });
      const text = humanText(res);
      expect(text).toContain('if you solve it, publish it back');
      // The second arm CLOSES the loop; it does not save anything for later.
      expect(text).toContain(`tenjin outcome --search-id ${miss.searchId} --status regenerated`);
      expect(text).not.toContain('candidate add');
    });

    /**
     * `--json` says it suppresses human stderr rendering, and this line was the
     * one thing that ignored it: written straight to `ctx.io.stderr`, which no
     * output mode gates, so an agent asking for a machine envelope got ~260 bytes
     * of prose alongside it. It rides humanLines now, which `emitSuccess` drops
     * whenever the envelope is what was asked for.
     */
    it('writes nothing at all to stderr, so --json can suppress it', async () => {
      const { fetch } = stub(miss);
      const { ctx, stderr } = ctxCapturingStderr();
      await runSearch({ question: 'q' }, ctx, { fetchImpl: fetch });
      expect(stderr()).toBe('');
    });

    it('carries a publishBack hint in the machine envelope', async () => {
      const { fetch } = stub(miss);
      const res = await runSearch({ question: 'q' }, makeCtx(), { fetchImpl: fetch });
      const data = res.data as { matched: number; publishBack?: Record<string, string> };
      expect(data.publishBack).toEqual({
        searchId: miss.searchId,
        reason: 'Nothing on the marketplace answered this. If you solve it, publish it back.',
        publish: `tenjin publish <file.md> --json --search-id ${miss.searchId}`,
        decline: `tenjin outcome --search-id ${miss.searchId} --status regenerated --json`,
      });
    });

    // Both arms are commands to run verbatim; a publish arm without the id closes
    // nothing, which is the loop this hint exists to close.
    it('names the searchId in BOTH arms of the hint, and on the rendered line', async () => {
      const { fetch } = stub(miss);
      const res = await runSearch({ question: 'q' }, makeCtx(), { fetchImpl: fetch });
      const hint = (res.data as { publishBack: { publish: string; decline: string } }).publishBack;
      expect(hint.publish).toContain(`--search-id ${miss.searchId}`);
      expect(hint.decline).toContain(`--search-id ${miss.searchId}`);
      expect(humanText(res)).toContain(`tenjin publish <file.md> --search-id ${miss.searchId}`);
    });

    // The envelope is the server's response verbatim everywhere else, so the one
    // CLI-owned key must not leak onto the path the contract describes.
    it('adds nothing at all to an envelope that carried matches', async () => {
      const { fetch } = stub(HIT);
      const res = await runSearch({ question: 'q' }, makeCtx(), { fetchImpl: fetch });
      expect(res.data).not.toHaveProperty('publishBack');
      expect(res.data).toEqual(HIT);
    });

    it('says nothing on a HIT, in the rendering either', async () => {
      const { fetch } = stub(HIT);
      const { ctx, stderr } = ctxCapturingStderr();
      const res = await runSearch({ question: 'q' }, ctx, { fetchImpl: fetch });
      expect(humanText(res)).not.toContain('publish it back');
      expect(stderr()).not.toContain('publish it back');
    });
  });
});

describe('evalCohort threading', () => {
  function headerStub(): { fetch: typeof fetch; headers: Array<Record<string, string>> } {
    const headers: Array<Record<string, string>> = [];
    const fetchFn = (async (_url: string, init?: RequestInit) => {
      headers.push((init?.headers ?? {}) as Record<string, string>);
      return new Response(JSON.stringify(MISS), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
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

describe('item URL origin ingest boundary', () => {
  it('refuses a response whose item URL points off the configured base URL', async () => {
    const offOrigin = {
      ...HIT,
      items: [
        {
          ...(HIT.items[0] as object),
          url: 'https://evil.example/api/read/iris/slug',
        },
      ],
    };
    const { fetch } = stub(offOrigin);
    await expect(
      runSearch({ question: 'q' }, makeCtx(), { fetchImpl: fetch }),
    ).rejects.toMatchObject({ code: 'CONTRACT_MISMATCH', exitCode: 1 });
  });

  /**
   * tenjin#738 in one test. The server builds candidate urls from its own global,
   * so at the cutover every candidate lands on the other origin at once while an
   * installed CLI still names the old one. Before the alias set that was a
   * CONTRACT_MISMATCH on the whole response, which is the published CLI going
   * dark, not degrading.
   */
  it('accepts a candidate on the deployment other origin when the base is one of them', async () => {
    // Named, not indexed: reordering the set must not silently change which
    // origin this configures and which one it flips the candidate onto.
    const base = PRODUCTION_ORIGIN;
    const sibling = knownDeploymentOrigins().find((o) => o !== base);
    expect(sibling).toBeDefined();
    const flipped = {
      ...HIT,
      items: [{ ...(HIT.items[0] as object), url: `${sibling}/api/read/iris/slug` }],
    };
    const { fetch } = stub(flipped);
    await runSearch({ question: 'q' }, makeCtx({ baseUrl: base }), { fetchImpl: fetch });
    const stored = await latestSearch(dir);
    expect(stored?.candidates[0]?.url).toBe(`${sibling}/api/read/iris/slug`);
  });

  it('still refuses a deployment origin when the configured base is self-hosted', async () => {
    // makeCtx pins a preview base, which the alias set knows nothing about.
    const known = PRODUCTION_ORIGIN;
    const foreign = {
      ...HIT,
      items: [{ ...(HIT.items[0] as object), url: `${known}/api/read/iris/slug` }],
    };
    const { fetch } = stub(foreign);
    await expect(
      runSearch({ question: 'q' }, makeCtx(), { fetchImpl: fetch }),
    ).rejects.toMatchObject({ code: 'CONTRACT_MISMATCH', exitCode: 1 });
  });
});
