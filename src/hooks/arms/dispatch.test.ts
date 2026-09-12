import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HookInput } from '../../adapters/types';
import { runFire } from '../fire';
import { getMark } from '../gates';
import type { Deps, KernelConfig, Plan } from '../types';
import { dispatchArm } from './dispatch';
import {
  cleanup,
  fireContext,
  freshDb,
  hookInput,
  kernelConfig,
  LEAD,
  NOW,
  toolInput,
} from './test-support';

/**
 * The dispatch arm. Under test: the description and the WHOLE work order travel
 * as typed and nothing else does; the three modes; what each outcome parks for
 * the child, and that the parent is neither told nor charged a `seen:`.
 */

afterEach(() => {
  vi.unstubAllGlobals();
  cleanup();
});

const SEARCH_ID = '11111111-1111-4111-8111-111111111111';
const POST_ID = '22222222-2222-4222-8222-222222222222';
const ON = kernelConfig();

function dispatch(prompt: string, over: Partial<HookInput> = {}, description?: string): HookInput {
  return hookInput({
    event: 'tool.before',
    native: { event: 'PreToolUse' },
    turn: 'p1',
    tool: toolInput('dispatch', {
      task: prompt,
      ...(description === undefined ? {} : { description }),
    }),
    ...over,
  });
}

/** The body the one stubbed leg was asked with, for a plan built but not fired. */
async function sent(
  bodies: Array<Record<string, unknown>>,
  input: HookInput,
): Promise<{ query: string; trigger: string }> {
  const ctx = fireContext({ db: freshDb(), arm: dispatchArm, input, config: ON });
  const plan = (await dispatchArm.plan?.(ctx)) as Plan;
  expect(plan.stages.map((s) => s.map((l) => l.shelf))).toEqual([['team', 'public']]);
  await plan.stages[0]?.[0]?.request(plan.question, 1000, new AbortController().signal);
  return bodies[0] as { query: string; trigger: string };
}

function candidate(): Record<string, unknown> {
  return {
    resourceId: POST_ID,
    url: 'https://shelf.acme.internal/p/collation',
    slug: 'collation',
    title: 'The pgvector collation flip',
    artifactType: 'finding',
    price: '0',
    asOf: null,
    validUntil: null,
    matchReasons: ['title'],
    estimatedTokens: 120,
    creator: { handle: 'ali' },
    strong: true,
    body: { text: 'swap the image tag back' },
  };
}

/** A stubbed shelf answering `items` to every leg, recording each body. */
function shelf(items: Array<Record<string, unknown>>): { bodies: Array<Record<string, unknown>> } {
  const bodies: Array<Record<string, unknown>> = [];
  vi.stubGlobal('fetch', async (input: unknown, init?: RequestInit) => {
    bodies.push((await new Request(String(input), init).json()) as Record<string, unknown>);
    return new Response(
      JSON.stringify({
        schemaVersion: 3,
        searchId: SEARCH_ID,
        calibration: 'hybrid-v1',
        items,
        matched: items.length,
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  });
  return { bodies };
}

function deps(db: ReturnType<typeof freshDb>, config: KernelConfig = ON): Deps {
  return {
    db,
    config: () => config,
    clock: () => NOW,
    log: () => undefined,
    arms: [dispatchArm],
    adapters: {},
  };
}

function handoffRows(db: ReturnType<typeof freshDb>): Array<Record<string, unknown>> {
  return db.prepare('SELECT * FROM handoff ORDER BY id').all() as Array<Record<string, unknown>>;
}

async function fire(db: ReturnType<typeof freshDb>, input: HookInput, config: KernelConfig = ON) {
  const result = await runFire(input, deps(db, config));
  result.commit();
  const row = db
    .prepare('SELECT reason, delivered, question FROM fires ORDER BY rowid DESC LIMIT 1')
    .get() as { reason: string; delivered: string | null; question: string | null };
  return { emit: result.emit, row };
}

describe('the dispatch arm', () => {
  it('is a log-only lookup on the Agent tool call', () => {
    expect(dispatchArm.on).toEqual([{ event: 'tool.before', kind: 'dispatch' }]);
    expect(dispatchArm.wait).toBe('tool');
    const delivery = dispatchArm.deliver?.(
      { shelf: 'team', resourceId: POST_ID, text: 'a body' },
      fireContext({ db: freshDb(), arm: dispatchArm, input: dispatch('x') }),
    );
    expect(delivery).toEqual({ mode: 'log', resourceId: POST_ID });
  });

  it('sends the description first, then the WHOLE work order, masked', async () => {
    const { bodies } = shelf([]);
    const token = 'ghp_0123456789abcdefghijklmnopqrstuvwxyz';
    // The task is the LAST sentence of a work order whose first 512 characters
    // are rules. It is the half the shelf has to rank on, so it has to be sent.
    const tail = 'then say whether the ivfflat build is what flipped the collation';
    const order = `find why the index test fails after the image bump, token ${token} ${'detail '.repeat(120)}${tail}`;
    expect(order.length).toBeGreaterThan(512);
    const body = await sent(bodies, dispatch(order, {}, 'Debug the collation flake'));

    expect(body.trigger).toBe('dispatch');
    expect(body.query.startsWith('Debug the collation flake\nfind why the index test fails')).toBe(
      true,
    );
    expect(body.query).toContain(tail);
    expect(body.query.length).toBeGreaterThan(512);
    expect(body.query).not.toContain(token);
    // `subagent_type` ("Explore") is a label that names no task: no adapter
    // carries it and nothing on the wire mentions it.
    expect(JSON.stringify(body)).not.toContain('Explore');
  });

  it('cuts a work order past 8,000 characters at a whole word', async () => {
    const { bodies } = shelf([]);
    const order = `${'detail '.repeat(2000)}the-tail-nobody-sent`;
    expect(order.length).toBeGreaterThan(8000);
    const body = await sent(bodies, dispatch(order));

    expect(body.query.length).toBeLessThanOrEqual(8000);
    expect(body.query.length).toBeGreaterThan(512);
    expect(body.query.endsWith('detail')).toBe(true);
    expect(body.query).not.toContain('the-tail-nobody-sent');
    expect(order.startsWith(`${body.query} `)).toBe(true);
  });

  it('sends the trimmed task alone when the tool carried no description', async () => {
    const { bodies } = shelf([]);
    const body = await sent(bodies, dispatch('  the pgvector collation flip  '));
    expect(body.query).toBe('the pgvector collation flip');
  });

  it('`hooks.subagent` off is silent: nothing asked, nothing parked', async () => {
    const off = kernelConfig({ subagent: false });
    const { bodies } = shelf([candidate()]);
    const db = freshDb();
    const silent = await fire(db, dispatch('anything durable'), off);
    expect(silent.emit).toBeNull();
    expect(silent.row.reason).toBe('no-question');
    expect(bodies).toHaveLength(0);
    expect(handoffRows(db)).toHaveLength(0);
  });

  it('a hit parks the answer with its search id, logs it, and burns no seen: on the parent', async () => {
    shelf([candidate()]);
    const db = freshDb();
    const { emit, row } = await fire(db, dispatch('the pgvector collation flip'));
    expect(emit).toBeNull();
    expect(row.reason).toBe('hit');
    expect(row.delivered).toBe(`log:${POST_ID}`);
    expect(getMark(db, LEAD, `seen:${POST_ID}`)).toBeNull();
    const rows = handoffRows(db);
    expect(rows).toMatchObject([{ session: LEAD.session, prompt_id: 'p1', search_id: SEARCH_ID }]);
    const answer = JSON.parse(String(rows[0]?.answer)) as { resourceId: string; text: string };
    expect(answer.resourceId).toBe(POST_ID);
    expect(answer.text).toBe('swap the image tag back');
    expect(rows[0]?.question).toBe('the pgvector collation flip');
  });

  it('a miss parks the search id alone, so the child can close the loop', async () => {
    shelf([]);
    const db = freshDb();
    const { row } = await fire(db, dispatch('the pgvector collation flip'));
    expect(row.reason).toBe('no-hit');
    expect(handoffRows(db)).toMatchObject([
      {
        search_id: SEARCH_ID,
        answer: null,
        question: 'the pgvector collation flip',
      },
    ]);
  });

  it('a fire with no verdict parks nothing: the child finds nothing and the row says why', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new Error('ECONNREFUSED');
    });
    const db = freshDb();
    const { row } = await fire(db, dispatch('the pgvector collation flip'));
    expect(row.reason).toBe('no-answer');
    expect(handoffRows(db)).toHaveLength(0);
  });

  it('a harness with no turn id parks a row with no prompt_id', async () => {
    shelf([]);
    const db = freshDb();
    const { turn, ...noTurn } = dispatch('the pgvector collation flip');
    void turn;
    await fire(db, noTurn);
    expect(handoffRows(db)).toMatchObject([{ prompt_id: null, answer: null }]);
  });
});
