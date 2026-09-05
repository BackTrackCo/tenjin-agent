import { describe, expect, it } from 'vitest';
import { CONFIG_DEFAULTS } from '../../lib/config';
import { SHELF_BYPASS_HEADER } from '../../lib/http';
import type { KernelConfig, Question } from '../types';
import { searchLeg } from './search';

/**
 * One leg against a stubbed `fetch`: no daemon, no store, no network. What is
 * under test is the leg's two promises — that it never throws, whatever comes
 * back, and that what it DOES throw away is recorded as a status a reviewer can
 * read off the ledger.
 */

const TEAM = 'https://shelf.acme.internal';
const PUBLIC = 'https://tenjin.blog';

const CONFIG: KernelConfig = {
  hooks: CONFIG_DEFAULTS.hooks,
  loop: CONFIG_DEFAULTS.loop,
  team: CONFIG_DEFAULTS.team,
  baseUrl: TEAM,
  publicShelfUrl: PUBLIC,
  shelfBypassSecret: 'door-key',
};

const SEARCH_ID = '11111111-1111-4111-8111-111111111111';

function q(text: string, identifiers?: string[]): Question {
  return { text, questionKey: 'qk1', ...(identifiers !== undefined ? { identifiers } : {}) };
}

function candidate(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    resourceId: '22222222-2222-4222-8222-222222222222',
    url: `${TEAM}/p/one`,
    slug: 'one',
    title: 'The collation flip',
    artifactType: 'finding',
    price: '0',
    asOf: null,
    validUntil: null,
    matchReasons: ['title'],
    estimatedTokens: 400,
    creator: { handle: 'ali' },
    excerpt: 'the image tag changed',
    ...over,
  };
}

function envelope(items: Array<Record<string, unknown>>, calibration = 'hybrid-v1'): unknown {
  return { schemaVersion: 3, searchId: SEARCH_ID, calibration, items, matched: items.length };
}

/** A stub `fetch` that records what it was asked and answers `res`. It refuses
 *  an aborted signal the way the real one does, so the abort path is real. */
function stub(res: () => Response): { fetchImpl: typeof fetch; calls: Request[] } {
  const calls: Request[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    if (init?.signal?.aborted === true) throw new DOMException('aborted', 'AbortError');
    calls.push(new Request(String(input), init));
    return res();
  };
  return { fetchImpl, calls };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function html(status: number): Response {
  return new Response('<!doctype html><title>Sign in</title>', {
    status,
    headers: { 'content-type': 'text/html' },
  });
}

async function body(calls: Request[]): Promise<Record<string, unknown>> {
  const call = calls[0];
  if (call === undefined) throw new Error('no request was made');
  return (await call.json()) as Record<string, unknown>;
}

describe('searchLeg request', () => {
  it('cuts a long question at 512 on a word boundary rather than throwing USAGE', async () => {
    const { fetchImpl, calls } = stub(() => json(200, envelope([])));
    const leg = searchLeg('team', 'prompt', CONFIG, fetchImpl);
    const long = 'collation '.repeat(60).trim(); // 599 characters
    expect(long.length).toBeGreaterThan(512);
    const result = await leg.request(q(long), 4000, new AbortController().signal);
    expect(result.status).toBe('ok');
    const sent = (await body(calls)).query as string;
    expect(sent.length).toBeLessThanOrEqual(512);
    expect(sent.endsWith('collation')).toBe(true);
    expect(long.startsWith(sent)).toBe(true);
  });

  it('puts the trigger, the limit, the identifiers and budget_ms on the wire', async () => {
    const { fetchImpl, calls } = stub(() => json(200, envelope([])));
    const leg = searchLeg('team', 'research', CONFIG, fetchImpl);
    await leg.request(
      q('why the collation flipped', ['pgvector', 'pr-751']),
      3200,
      new AbortController().signal,
    );
    expect(await body(calls)).toMatchObject({
      trigger: 'research',
      limit: 3,
      identifiers: ['pgvector', 'pr-751'],
      budget_ms: 3200,
    });
  });

  it('sends the bypass key to the team origin and never to the public one', async () => {
    const team = stub(() => json(200, envelope([])));
    await searchLeg('team', 'prompt', CONFIG, team.fetchImpl).request(
      q('why'),
      2000,
      new AbortController().signal,
    );
    expect(team.calls[0]?.url).toBe(`${TEAM}/api/search`);
    expect(team.calls[0]?.headers.get(SHELF_BYPASS_HEADER)).toBe('door-key');

    const pub = stub(() => json(200, envelope([])));
    await searchLeg('public', 'prompt', CONFIG, pub.fetchImpl).request(
      q('why'),
      2000,
      new AbortController().signal,
    );
    expect(pub.calls[0]?.url).toBe(`${PUBLIC}/api/search`);
    expect(pub.calls[0]?.headers.get(SHELF_BYPASS_HEADER)).toBeNull();
  });

  it('records the calibration and the top row on an ok leg', async () => {
    const { fetchImpl } = stub(() => json(200, envelope([candidate()], 'lexical-v1')));
    const leg = searchLeg('team', 'prompt', CONFIG, fetchImpl);
    const result = await leg.request(q('why'), 2000, new AbortController().signal);
    expect(result).toMatchObject({
      status: 'ok',
      searchId: SEARCH_ID,
      calibration: 'lexical-v1',
      title: 'The collation flip',
      form: 'finding',
    });
  });
});

describe('searchLeg statuses', () => {
  const cases: Array<[string, () => Response, string]> = [
    ['a 429', () => json(429, { error: 'slow down' }), 'http_429'],
    ['a 500', () => json(500, { error: 'boom' }), 'http_500'],
    ['a 404', () => json(404, { error: 'no route' }), 'http_404'],
    ['a gate page', () => html(401), 'refused'],
    ['HTML with a 200', () => html(200), 'bad_json'],
  ];
  for (const [name, res, status] of cases) {
    it(`${name} is ${status}`, async () => {
      const { fetchImpl } = stub(res);
      const leg = searchLeg('team', 'prompt', CONFIG, fetchImpl);
      const result = await leg.request(q('why'), 2000, new AbortController().signal);
      expect(result.status).toBe(status);
      expect(result.payload).toBeUndefined();
    });
  }

  it('a candidate missing resourceId is bad_shape', async () => {
    const broken = candidate();
    delete broken.resourceId;
    const { fetchImpl } = stub(() => json(200, envelope([broken])));
    const leg = searchLeg('team', 'prompt', CONFIG, fetchImpl);
    expect((await leg.request(q('why'), 2000, new AbortController().signal)).status).toBe(
      'bad_shape',
    );
  });

  it('a signal already aborted is aborted, not timeout', async () => {
    const { fetchImpl } = stub(() => json(200, envelope([])));
    const controller = new AbortController();
    controller.abort();
    const leg = searchLeg('team', 'prompt', CONFIG, fetchImpl);
    expect((await leg.request(q('why'), 2000, controller.signal)).status).toBe('aborted');
  });

  it('the leg deadline is timeout, and the leg still does not throw', async () => {
    const fetchImpl: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
    const leg = searchLeg('team', 'prompt', CONFIG, fetchImpl);
    expect((await leg.request(q('why'), 5, new AbortController().signal)).status).toBe('timeout');
  });

  it('a transport that never answers is error', async () => {
    const fetchImpl: typeof fetch = async () => {
      throw new Error('ECONNREFUSED');
    };
    const leg = searchLeg('team', 'prompt', CONFIG, fetchImpl);
    expect((await leg.request(q('why'), 2000, new AbortController().signal)).status).toBe('error');
  });
});

describe('searchLeg verdict', () => {
  async function verdictOf(items: Array<Record<string, unknown>>) {
    const { fetchImpl } = stub(() => json(200, envelope(items)));
    const leg = searchLeg('team', 'prompt', CONFIG, fetchImpl);
    const result = await leg.request(q('why'), 2000, new AbortController().signal);
    return leg.verdict(result);
  }

  it('no candidates is a miss', async () => {
    expect(await verdictOf([])).toBeNull();
  });

  it('the strong candidate at rank 2 beats an un-strong rank 1', async () => {
    const answer = await verdictOf([
      candidate({ resourceId: '33333333-3333-4333-8333-333333333333' }),
      candidate({ strong: true, title: 'The real one' }),
    ]);
    expect(answer).toMatchObject({
      shelf: 'team',
      strength: 'strong',
      title: 'The real one',
      searchId: SEARCH_ID,
      form: 'finding',
      price: '0',
      handle: 'ali',
      excerpt: 'the image tag changed',
    });
  });

  it('absent strong is never strong: rank 1 rides as weak, and calibration says why', async () => {
    const { fetchImpl } = stub(() => json(200, envelope([candidate(), candidate()], 'lexical-v1')));
    const leg = searchLeg('team', 'prompt', CONFIG, fetchImpl);
    const result = await leg.request(q('why'), 2000, new AbortController().signal);
    // `lexical-v1` is the shelf saying the meaning step never ran, which is why
    // a spent embedding budget is not the same fact as an empty shelf.
    expect(result.calibration).toBe('lexical-v1');
    expect(leg.verdict(result)?.strength).toBe('weak');
  });

  it('reads the candidate body into answer.text, and a strong row without one carries none', async () => {
    const withBody = await verdictOf([
      candidate({
        strong: true,
        body: { text: 'the collation flips on an image swap', truncated: false },
      }),
    ]);
    expect(withBody?.text).toBe('the collation flips on an image swap');

    const bare = await verdictOf([
      candidate({ resourceId: '44444444-4444-4444-8444-444444444444' }),
      candidate({ strong: true }),
    ]);
    expect(bare?.strength).toBe('strong');
    expect(bare?.text).toBeUndefined();
  });
});
