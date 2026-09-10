import { afterEach, describe, expect, it } from 'vitest';
import { actorOf, STARTED_MARK } from './actor';
import { cleanup, freshDb, hookInput, NOW } from './arms/test-support';
import { firstSight, getMark, setMark } from './gates';

afterEach(cleanup);

/**
 * Identity is namespaced by harness at the daemon's ingress and nowhere else:
 * these pin what the plan's assumption audit found missing, that `marks` and
 * every other actor-keyed table share state across harnesses for equal native
 * ids, and that siblings and nested children never share an actor.
 */
describe('actorOf across harnesses and children', () => {
  it('equal native session ids on two harnesses are two actors', () => {
    const db = freshDb();
    const claude = actorOf(hookInput({ harness: 'claude', session: 'same' }), db);
    const codex = actorOf(hookInput({ harness: 'codex', session: 'same' }), db);
    expect(claude).toEqual({ session: 'claude:same', agent: '' });
    expect(codex).toEqual({ session: 'codex:same', agent: '' });
    // A piece shown under one harness is still unseen under the other.
    expect(firstSight(db, claude!, 'piece-1', NOW)).toBe(true);
    expect(firstSight(db, codex!, 'piece-1', NOW)).toBe(true);
    expect(firstSight(db, claude!, 'piece-1', NOW)).toBe(false);
  });

  it('two siblings and a nested child are three actors under one root session', () => {
    const db = freshDb();
    const a = actorOf(hookInput({ harness: 'codex', session: 'root', agent: 'child-a' }), db)!;
    const b = actorOf(hookInput({ harness: 'codex', session: 'root', agent: 'child-b' }), db)!;
    const nested = actorOf(
      hookInput({ harness: 'codex', session: 'root', agent: 'child-a-1' }),
      db,
    )!;
    setMark(db, a, 'capture:asked', 'edited', NOW);
    expect(getMark(db, b, 'capture:asked')).toBeNull();
    expect(getMark(db, nested, 'capture:asked')).toBeNull();
    expect(a.session).toBe(b.session);
    expect(nested.session).toBe(a.session);
  });

  it('a stop needs a start from the same actor on the same harness', () => {
    const db = freshDb();
    const stop = hookInput({ harness: 'codex', event: 'agent.stop', session: 'r', agent: 'c1' });
    expect(actorOf(stop, db)).toBeNull();
    setMark(db, { session: 'claude:r', agent: 'c1' }, STARTED_MARK, 'x', NOW);
    expect(actorOf(stop, db)).toBeNull();
    setMark(db, { session: 'codex:r', agent: 'c1' }, STARTED_MARK, 'x', NOW);
    expect(actorOf(stop, db)).toEqual({ session: 'codex:r', agent: 'c1' });
  });
});
