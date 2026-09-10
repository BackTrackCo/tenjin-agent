import { afterEach, describe, expect, it } from 'vitest';
import type { HookInput } from '../../adapters/types';
import { STARTED_MARK } from '../actor';
import { runFire } from '../fire';
import { getMark } from '../gates';
import { park } from '../handoff';
import { INSPECT_POINTER, TEAM_OPENER } from '../prose';
import type { LoopDb } from '../store';
import type { Answer, Deps } from '../types';
import { subagentStartArm } from './subagent-start';
import { CHILD, cleanup, freshDb, hookInput, kernelConfig, LEAD, NOW } from './test-support';

/**
 * The subagent-start arm through the kernel: the `started` mark, then the
 * parked row claimed and delivered under the CHILD's actor with the lead's
 * form, a miss recorded as the child's evidence, and nothing when nothing was
 * parked.
 */

afterEach(cleanup);

const POST_ID = '22222222-2222-4222-8222-222222222222';
const SEARCH_ID = '11111111-1111-4111-8111-111111111111';

function start(over: Partial<HookInput> = {}): HookInput {
  return hookInput({
    event: 'agent.start',
    native: { event: 'SubagentStart' },
    agent: CHILD.agent,
    agentType: 'Explore',
    turn: 'p1',
    ...over,
  });
}

function deps(db: LoopDb): Deps {
  return {
    db,
    config: () => kernelConfig(),
    clock: () => NOW,
    log: () => undefined,
    arms: [subagentStartArm],
    adapters: {},
  };
}

async function fire(db: LoopDb, input: HookInput) {
  const result = await runFire(input, deps(db));
  result.commit();
  const row = db
    .prepare('SELECT agent, reason, delivered FROM fires ORDER BY rowid DESC LIMIT 1')
    .get() as { agent: string; reason: string; delivered: string | null };
  const legs = db
    .prepare(
      'SELECT stage, shelf, outcome FROM legs WHERE fire_id = (SELECT id FROM fires ORDER BY rowid DESC LIMIT 1)',
    )
    .all() as Array<{ stage: number; shelf: string; outcome: string }>;
  return { emit: result.emit, row, legs };
}

function hit(over: Partial<Answer> = {}): Answer {
  return {
    shelf: 'team',
    resourceId: POST_ID,
    title: 'The pgvector collation flip',
    url: 'https://shelf.acme.internal/p/collation',
    price: '0',
    handle: 'ali',
    text: 'swap the image tag back to pg16 and re-seed',
    searchId: SEARCH_ID,
    ...over,
  };
}

describe('the subagent-start arm', () => {
  it('writes `started` with the agent type before anything else, and a start with no row is no-question', async () => {
    const db = freshDb();
    const { emit, row } = await fire(db, start());
    expect(getMark(db, CHILD, STARTED_MARK)).toBe('Explore');
    expect(emit).toBeNull();
    expect(row).toEqual({ agent: CHILD.agent, reason: 'no-question', delivered: null });
  });

  it('delivers a parked free hit whole, under the child, in the lead form, and burns the child seen:', async () => {
    const db = freshDb();
    park(db, {
      session: LEAD.session,
      promptId: 'p1',
      at: NOW - 10,
      question: 'the pgvector collation flip',
      searchId: SEARCH_ID,
      answer: hit(),
    });
    const { emit, row, legs } = await fire(db, start());
    expect(row).toEqual({ agent: CHILD.agent, reason: 'hit', delivered: `inject:${POST_ID}` });
    expect(emit?.context?.startsWith(TEAM_OPENER)).toBe(true);
    expect(emit?.context).toContain('swap the image tag back to pg16 and re-seed');
    expect(emit?.context).not.toContain('tenjin outcome');
    expect(legs).toEqual([{ stage: 0, shelf: 'team', outcome: 'hit' }]);
    expect(getMark(db, CHILD, `seen:${POST_ID}`)).not.toBeNull();
    expect(getMark(db, LEAD, `seen:${POST_ID}`)).toBeNull();
    expect(db.prepare('SELECT COUNT(*) AS n FROM handoff').get()).toEqual({ n: 0 });
  });

  it('a paid hit is a pointer, on the shelf it was parked from', async () => {
    const db = freshDb();
    park(db, {
      session: LEAD.session,
      promptId: 'p1',
      at: NOW,
      question: 'q',
      answer: hit({ shelf: 'public', price: '250000', text: undefined }),
    });
    const { emit, legs } = await fire(db, start());
    expect(emit?.context).toContain(INSPECT_POINTER + POST_ID);
    expect(emit?.context).not.toContain('swap the image tag');
    expect(legs).toEqual([{ stage: 0, shelf: 'public', outcome: 'hit' }]);
  });

  it('a parked miss is no-hit and becomes the child evidence, with the search id', async () => {
    const db = freshDb();
    park(db, {
      session: LEAD.session,
      promptId: 'p1',
      at: NOW,
      question: 'the pgvector collation flip',
      searchId: SEARCH_ID,
    });
    const { emit, row, legs } = await fire(db, start());
    expect(emit).toBeNull();
    expect(row.reason).toBe('no-hit');
    expect(legs).toEqual([{ stage: 0, shelf: 'team', outcome: 'miss' }]);
    expect(getMark(db, CHILD, 'handoff:miss')).toBe(SEARCH_ID);
  });

  it('claims only its own turn', async () => {
    const db = freshDb();
    park(db, {
      session: LEAD.session,
      promptId: 'p2',
      at: NOW,
      question: 'q',
      answer: hit(),
    });
    const { row } = await fire(db, start({ turn: 'p1' }));
    expect(row.reason).toBe('no-question');
    expect(db.prepare('SELECT COUNT(*) AS n FROM handoff').get()).toEqual({ n: 1 });
  });
});
