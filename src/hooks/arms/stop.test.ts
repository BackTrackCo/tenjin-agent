import { afterEach, describe, expect, it } from 'vitest';
import { factsWithPrefix } from '../facts';
import { getMark } from '../gates';
import { FINDING_TAG } from '../prose';
import { stopArm } from './stop';
import { cleanup, fireContext, freshDb, hookInput, kernelConfig, LEAD } from './test-support';

/**
 * The stop arm is registration plus two calls into `capture`; the ask and
 * harvest rules themselves are `capture.test.ts`. Under test here: the
 * switch, and that the answer turn of a lead nobody asked is not harvested.
 */

afterEach(cleanup);

function stop(over: { stopFuse?: boolean; lastMessage?: string } = {}) {
  return hookInput({ event: 'turn.end', native: { event: 'Stop' }, stopFuse: false, ...over });
}

describe('the stop arm', () => {
  it('is a human-wait arm on the turn end with no lookup', () => {
    expect(stopArm.on).toEqual([{ event: 'turn.end' }]);
    expect(stopArm.wait).toBe('human');
    expect(stopArm.plan).toBeUndefined();
    expect(stopArm.before).toBeUndefined();
  });

  it('`off` is silent even with evidence', async () => {
    const db = freshDb();
    db.prepare(
      `INSERT INTO fires (id, at, session, agent, arm, harness, event, cwd, wait, deadline_ms,
         elapsed_ms, reason) VALUES ('f1', 1, 's1', '', 'prompt', 'claude', 'prompt', '', 'human', 1, 1, 'hit')`,
    ).run();
    const ctx = fireContext({
      db,
      arm: stopArm,
      input: stop(),
      config: kernelConfig({ publish: false }),
    });
    expect(await stopArm.after?.(ctx, { reason: 'no-question' }, null)).toBeNull();
    expect(getMark(db, LEAD, 'capture:asked')).toBeNull();
  });

  it('does not harvest a fence from a lead it never asked', async () => {
    const db = freshDb();
    const ctx = fireContext({
      db,
      arm: stopArm,
      input: stop({ stopFuse: true, lastMessage: '```' + FINDING_TAG + '\nunasked\n```' }),
      config: kernelConfig(),
    });
    expect(await stopArm.after?.(ctx, { reason: 'no-question' }, null)).toBeNull();
    expect(factsWithPrefix(db, 'finding:')).toEqual([]);
  });
});
