import { afterEach, describe, expect, it, vi } from 'vitest';
import type { KernelConfig, Plan } from '../types';
import { fetchArm, fetchQuestion, researchArm } from './research';
import { cleanup, fireContext, freshDb, hookInput, kernelConfig, toolInput } from './test-support';

/**
 * The two web arms. What matters here is that they are TWO — separate ids,
 * separate events, separate questions and so separate claims — that a query and
 * a url travel as written, and that nothing an agent typed into either reaches
 * a shelf unmasked.
 */

afterEach(() => {
  vi.unstubAllGlobals();
  cleanup();
});

const ON = kernelConfig();

function searchInput(query: string) {
  return hookInput({
    event: 'tool.before',
    native: { event: 'PreToolUse' },
    tool: toolInput('web', { query }),
  });
}

function fetchInput(input: { url?: string; prompt?: string }) {
  return hookInput({
    event: 'tool.before',
    native: { event: 'PreToolUse' },
    tool: toolInput('fetch', { url: input.url ?? '', prompt: input.prompt ?? '' }),
  });
}

function planOf(
  arm: typeof researchArm,
  input: ReturnType<typeof hookInput>,
  config: KernelConfig = ON,
) {
  const db = freshDb();
  const ctx = fireContext({ db, arm, input, config });
  return { plan: arm.plan?.(ctx) ?? null, ctx };
}

/** The bodies a stubbed global `fetch` was handed. */
function captureFetch(): { bodies: Promise<unknown>[] } {
  const bodies: Promise<unknown>[] = [];
  vi.stubGlobal('fetch', async (input: unknown, init?: RequestInit) => {
    bodies.push(new Request(String(input), init).json());
    return new Response(
      JSON.stringify({
        schemaVersion: 3,
        searchId: '11111111-1111-4111-8111-111111111111',
        calibration: 'hybrid-v1',
        items: [],
        matched: 0,
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  });
  return { bodies };
}

describe('research and fetch are two arms', () => {
  it('with their own ids, their own tool kinds and their own budgets', () => {
    expect(researchArm.id).toBe('research');
    expect(fetchArm.id).toBe('fetch');
    expect(researchArm.on).toEqual([{ event: 'tool.before', kind: 'web' }]);
    expect(fetchArm.on).toEqual([{ event: 'tool.before', kind: 'fetch' }]);
    expect(researchArm.wait).toBe('tool');
    expect(fetchArm.wait).toBe('tool');
  });

  it('ask different questions of the same moment, so their claims never collide', () => {
    const search = planOf(researchArm, searchInput('pgvector collation flip')).plan as Plan;
    const page = planOf(
      fetchArm,
      fetchInput({ url: 'https://example.com/docs/pgvector', prompt: 'what changed' }),
    ).plan as Plan;
    expect(search.question.questionKey).not.toBe(page.question.questionKey);
  });
});

describe('the research arm', () => {
  it('asks both shelves the query the agent typed', () => {
    const planned = planOf(researchArm, searchInput('pgvector testcontainer collation')).plan;
    const plan = planned as Plan;
    expect(plan.stages[0]?.map((l) => l.shelf)).toEqual(['team', 'public']);
    expect(plan.question.text).toBe('pgvector testcontainer collation');
  });

  it('`hooks.web-search` off is the kill switch: no question, and no line ever', () => {
    const { plan } = planOf(
      researchArm,
      searchInput('anything at all'),
      kernelConfig({ 'web-search': false }),
    );
    expect(plan).toBeNull();
    // The arm has no words of its own left to say, on or off: what it delivers
    // is a shelf answer or nothing.
    expect(researchArm.after).toBeUndefined();
  });

  it('an empty or absent query is no-question', () => {
    expect(planOf(researchArm, searchInput('   ')).plan).toBeNull();
    expect(planOf(researchArm, fetchInput({})).plan).toBeNull();
  });

  it('a ghp_ token in a WebSearch query never reaches the wire', async () => {
    const token = 'ghp_0123456789abcdefghijklmnopqrstuvwxyz';
    const { bodies } = captureFetch();
    const plan = planOf(researchArm, searchInput(`why does ${token} 401 on push`)).plan as Plan;
    const leg = plan.stages[0]?.[0];
    expect(leg).toBeDefined();
    const result = await leg?.request(plan.question, 1000, new AbortController().signal);
    expect(result?.status).toBe('ok');
    const body = JSON.stringify(await bodies[0]);
    expect(body).not.toContain(token);
    expect(body).toContain('"trigger":"research"');
  });
});

describe('the fetch arm', () => {
  it('is gated on `hooks.web-fetch`, not on `hooks.web-search`', () => {
    const url = { url: 'https://example.com/docs/collation', prompt: 'what changed' };
    expect(planOf(fetchArm, fetchInput(url), kernelConfig({ 'web-fetch': false })).plan).toBeNull();
    expect(
      planOf(fetchArm, fetchInput(url), kernelConfig({ 'web-search': false })).plan,
    ).not.toBeNull();
  });

  it('rides the wire as `research` too: the moment is what the server labels', async () => {
    const { bodies } = captureFetch();
    const plan = planOf(fetchArm, fetchInput({ url: 'https://example.com/docs/collation' }))
      .plan as Plan;
    const leg = plan.stages[0]?.[0];
    await leg?.request(plan.question, 1000, new AbortController().signal);
    expect(JSON.stringify(await bodies[0])).toContain('"trigger":"research"');
  });

  it('masks a vendor token sitting in a path segment', async () => {
    // A credential IS the path segment here, and the url is sent whole, so the
    // one thing standing between it and the shelf is the mask every question
    // goes through.
    const token = 'ghp_0123456789abcdefghijklmnopqrstuvwxyz';
    const { bodies } = captureFetch();
    const plan = planOf(fetchArm, fetchInput({ url: `https://acme.com/download/${token}/report` }))
      .plan as Plan;
    const leg = plan.stages[0]?.[0];
    await leg?.request(plan.question, 1000, new AbortController().signal);
    const body = JSON.stringify(await bodies[0]);
    expect(body).not.toContain(token);
    expect(body).not.toContain('0123456789abcdefghijklmnopqrstuvwxyz');
    // The stub keeps the type and the length, so the query still says what was
    // dropped.
    expect(body).toContain('ghp_\u2026[redacted 36 chars]');
  });

  it('masks the fine-grained form in a path segment too', async () => {
    const token = `github_pat_${'1'.repeat(22)}_${'a'.repeat(59)}`;
    const { bodies } = captureFetch();
    const plan = planOf(fetchArm, fetchInput({ url: `https://acme.com/f/${token}/report.pdf` }))
      .plan as Plan;
    const leg = plan.stages[0]?.[0];
    await leg?.request(plan.question, 1000, new AbortController().signal);
    const body = JSON.stringify(await bodies[0]);
    expect(body).not.toContain(token);
    expect(body).not.toContain('a'.repeat(59));
    expect(body).toContain('redacted 89 chars');
  });
});

describe('fetchQuestion', () => {
  it('is the address and the prompt, both as written', () => {
    const q = fetchQuestion({
      url: 'https://docs.acme.dev/guides/pgvector_collation.html',
      prompt: 'did the image bump change the sort order',
    });
    expect(q).toBe(
      'https://docs.acme.dev/guides/pgvector_collation.html ' +
        'did the image bump change the sort order',
    );
  });

  it('cuts at the first `?`, which is where a signed url keeps its credential', () => {
    const q = fetchQuestion({
      url: 'https://example.com/search?q=collation+flip&api_key=sk-live-abcdef123456&sig=zz',
    });
    expect(q).toBe('https://example.com/search');
  });

  it('cuts at the first `#` too: a hash router keeps its credential there', () => {
    expect(
      fetchQuestion({ url: 'https://app.acme.dev/#/invite?email=a@b.co&code=sk-live-abc' }),
    ).toBe('https://app.acme.dev/');
    // A doc anchor goes with it: it is worth nothing to a shelf that ranks on
    // the page, and it is not worth a second rule.
    expect(fetchQuestion({ url: 'https://vitest.dev/config/#restoremocks' })).toBe(
      'https://vitest.dev/config/',
    );
    // Whichever comes first, and the rest is one run.
    expect(fetchQuestion({ url: 'https://vitest.dev/config/?q=1#restoremocks' })).toBe(
      'https://vitest.dev/config/',
    );
  });

  it('sends the address as typed, not the parser’s re-spelling of it', () => {
    // `new URL(...).origin + .pathname` would lower-case the host, drop the
    // default port, fold `..` and percent-encode the space. A url with neither
    // a `?` nor a `#` is untouched.
    const raw = 'https://Docs.Acme.dev:443/a/../guide/pg vector.html';
    expect(fetchQuestion({ url: raw })).toBe(raw);
    expect(fetchQuestion({ url: 'https://例え.jp/パス' })).toBe('https://例え.jp/パス');
  });

  it('is empty for a non-http url and for a malformed one', () => {
    expect(fetchQuestion({ url: 'file:///etc/passwd' })).toBe('');
    expect(fetchQuestion({ url: 'not a url' })).toBe('');
    expect(fetchQuestion({ url: '' })).toBe('');
  });

  it("has no length rule: the search leg's 512 is the only bound", () => {
    const q = fetchQuestion({ url: 'https://example.com/a', prompt: 'x'.repeat(900) });
    expect(q).toBe(`https://example.com/a ${'x'.repeat(900)}`);
  });
});
