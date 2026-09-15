import { afterEach, describe, expect, it } from 'vitest';
import { factsWithPrefix, getFact, setFact } from './facts';
import { cleanup, freshDb, NOW } from './arms/test-support';

afterEach(cleanup);

describe('facts', () => {
  it('get, set (upsert), and a prefix scan oldest first', () => {
    const db = freshDb();
    expect(getFact(db, 'finding:1')).toBeNull();
    setFact(db, 'finding:1', 'one', NOW + 5);
    setFact(db, 'finding:2', 'two', NOW);
    setFact(db, 'pairing_post:9', 'nine', NOW);
    setFact(db, 'finding:1', 'one again', NOW + 6);
    expect(getFact(db, 'finding:1')).toBe('one again');
    expect(factsWithPrefix(db, 'finding:')).toEqual([
      { key: 'finding:2', value: 'two', at: NOW },
      { key: 'finding:1', value: 'one again', at: NOW + 6 },
    ]);
    // A prefix is literal: `_` and `%` in a key are characters, not wildcards.
    expect(factsWithPrefix(db, 'pairing_')).toHaveLength(1);
    expect(factsWithPrefix(db, 'pairing%')).toHaveLength(0);
  });
});
