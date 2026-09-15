import { afterEach, describe, expect, it } from 'vitest';
import { claim, park } from './handoff';
import type { Handoff } from './handoff';
import { cleanup, freshDb, NOW } from './arms/test-support';
import type { Answer } from './types';

/**
 * Two statements over a real `loop.db`. What is under test is the claim
 * order and its scope: oldest first within a turn, never across turns, and a
 * claimed row is gone.
 */

afterEach(cleanup);

const ANSWER: Answer = { shelf: 'team', resourceId: 'r-1', title: 'One', searchId: 'sid-1' };

function row(over: Partial<Handoff> = {}): Handoff {
  return {
    session: 's1',
    promptId: 'p1',
    at: NOW,
    question: 'find the collation flip',
    searchId: 'sid-miss',
    ...over,
  };
}

/** The same row as a harness with no turn id would park it. */
function noTurn(over: Partial<Handoff> = {}): Handoff {
  const { promptId, ...rest } = row(over);
  void promptId;
  return rest;
}

describe('park / claim', () => {
  it('two dispatches in one turn are claimed oldest first, and the rows are gone', () => {
    const db = freshDb();
    park(db, row({ at: NOW + 10, question: 'second', answer: ANSWER }));
    park(db, row({ at: NOW, question: 'first' }));

    const first = claim(db, 's1', 'p1');
    expect(first).toMatchObject({
      session: 's1',
      promptId: 'p1',
      question: 'first',
      searchId: 'sid-miss',
    });
    expect(first?.answer).toBeUndefined();
    const second = claim(db, 's1', 'p1');
    expect(second).toMatchObject({ question: 'second', answer: ANSWER });
    // A third child finds nothing: the rows went with their claims.
    expect(claim(db, 's1', 'p1')).toBeNull();
    expect(db.prepare('SELECT COUNT(*) AS n FROM handoff').get()).toEqual({ n: 0 });
  });

  it('a claim never crosses turns, and a turn with no rows is null', () => {
    const db = freshDb();
    park(db, row({ promptId: 'p1' }));
    expect(claim(db, 's1', 'p2')).toBeNull();
    expect(claim(db, 's2', 'p1')).toBeNull();
    expect(claim(db, 's1', 'p1')).not.toBeNull();
  });

  it('a harness with no turn id parks and claims in arrival order across the session', () => {
    const db = freshDb();
    park(db, noTurn({ at: NOW + 5, question: 'later' }));
    park(db, noTurn({ at: NOW, question: 'earlier' }));
    park(db, row({ promptId: 'p1', at: NOW - 100, question: 'a turn-tagged row' }));
    const first = claim(db, 's1', undefined);
    expect(first?.question).toBe('a turn-tagged row');
    expect(first?.promptId).toBe('p1');
    expect(claim(db, 's1', undefined)?.question).toBe('earlier');
    expect(claim(db, 's1', undefined)?.question).toBe('later');
    expect(claim(db, 's1', undefined)).toBeNull();
  });

  it('a claim with a turn id skips rows parked without one', () => {
    const db = freshDb();
    park(db, noTurn());
    expect(claim(db, 's1', 'p1')).toBeNull();
  });
});
