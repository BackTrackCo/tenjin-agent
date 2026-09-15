import { afterEach, describe, expect, it } from 'vitest';
import { getMark } from '../gates';
import { stopArm } from './stop';
import { cleanup, fireContext, freshDb, hookInput, kernelConfig, LEAD } from './test-support';

/**
 * The stop arm is registration plus one call into `capture`; the ask rules
 * themselves are `capture.test.ts`. Under test here: the switch, and that a
 * lead with no evidence is left alone whatever its last message said.
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

  it('says nothing to a lead with no evidence, whatever its last message held', async () => {
    const db = freshDb();
    const ctx = fireContext({
      db,
      arm: stopArm,
      input: stop({ stopFuse: true, lastMessage: '# a finding nobody asked for' }),
      config: kernelConfig(),
    });
    expect(await stopArm.after?.(ctx, { reason: 'no-question' }, null)).toBeNull();
    expect(getMark(db, LEAD, 'capture:asked')).toBeNull();
  });
});
