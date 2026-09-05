import { afterEach, describe, expect, it, vi } from 'vitest';
import type { KernelConfig, Plan } from '../types';
import { fetchArm, fetchQuestion, REMIND_LINE, researchArm } from './research';
import { cleanup, fireContext, freshDb, hookInput, kernelConfig, toolInput } from './test-support';

/**
 * The two web arms. What matters here is that they are TWO — separate ids,
 * separate events, separate questions and so separate claims — and that
 * nothing an agent typed into a search box reaches a shelf unmasked.
 */

afterEach(() => {
  vi.unstubAllGlobals();
  cleanup();
});

const PUSH_ON = kernelConfig({ push: 'on' });

function searchInput(query: string) {
  return hookInput({
    event: 'tool.before',
    native: { event: 'PreToolUse' },
    tool: toolInput('web', { query }),
  });
}

function fetchInput(input: Record<string, unknown>) {
  return hookInput({
    event: 'tool.before',
    native: { event: 'PreToolUse' },
    tool: toolInput('fetch', input),
  });
}

function planOf(
  arm: typeof researchArm,
  input: ReturnType<typeof hookInput>,
  config: KernelConfig = PUSH_ON,
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
  it('asks both shelves with the raw query, masked and never condensed', () => {
    const planned = planOf(researchArm, searchInput('pgvector testcontainer collation')).plan;
    const plan = planned as Plan;
    expect(plan.stages[0]?.map((l) => l.shelf)).toEqual(['team', 'public']);
    // Condensing this would have emptied it: three plain words, no clause of
    // four. The shape list is `[mask]` for exactly that reason.
    expect(plan.question.text).toBe('pgvector testcontainer collation');
    expect(plan.question.identifiers).toBeUndefined();
  });

  it('`off` is the kill switch: no question and no line', () => {
    const config = kernelConfig({ push: 'on', webSearch: 'off' });
    const { plan, ctx } = planOf(researchArm, searchInput('anything at all'), config);
    expect(plan).toBeNull();
    expect(researchArm.after?.(ctx, { reason: 'no-question' })).toBeNull();
  });

  it('`remind` says the line and sends nothing anywhere: no plan, no leg', () => {
    const config = kernelConfig({ push: 'on', webSearch: 'remind' });
    const { plan, ctx } = planOf(researchArm, searchInput('pgvector collation'), config);
    expect(plan).toBeNull();
    expect(researchArm.after?.(ctx, { reason: 'no-question' })).toEqual({ context: REMIND_LINE });
  });

  it('`auto` says no line of its own', () => {
    const { ctx } = planOf(researchArm, searchInput('pgvector collation'));
    expect(researchArm.after?.(ctx, { reason: 'no-hit' })).toBeNull();
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
  it('is gated on the push experiment, not on hooks.webSearch', () => {
    const url = { url: 'https://example.com/docs/collation', prompt: 'what changed' };
    expect(planOf(fetchArm, fetchInput(url), kernelConfig({ push: 'off' })).plan).toBeNull();
    expect(
      planOf(fetchArm, fetchInput(url), kernelConfig({ push: 'on', webSearch: 'off' })).plan,
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
});

describe('fetchQuestion', () => {
  it('is the path words plus the prompt head, and never the hostname', () => {
    const q = fetchQuestion({
      url: 'https://docs.acme.dev/guides/pgvector_collation.html',
      prompt: 'did the image bump change the sort order',
    });
    expect(q).toBe('guides pgvector collation did the image bump change the sort order');
    expect(q).not.toContain('acme');
  });

  it('reads allow-listed param values only: a key or a signature is never a topic', () => {
    const q = fetchQuestion({
      url: 'https://example.com/search?q=collation+flip&api_key=sk-live-abcdef123456&sig=zz',
    });
    expect(q).toBe('search collation flip');
  });

  it('is empty for a non-http url and for a malformed one', () => {
    expect(fetchQuestion({ url: 'file:///etc/passwd' })).toBe('');
    expect(fetchQuestion({ url: 'not a url' })).toBe('');
    expect(fetchQuestion({})).toBe('');
  });

  it('cuts the prompt at its head and leaves the length rule to the search leg', () => {
    const q = fetchQuestion({ url: 'https://example.com/a', prompt: 'x'.repeat(900) });
    expect(q).toBe(`a ${'x'.repeat(400)}`);
  });
});
