import { afterEach, describe, expect, it } from 'vitest';
import { mask } from '../../lib/redact';
import type { Answer, Arm, Plan, Skip, SkipReason } from '../types';
import { lookupArm, type LookupSpec } from './lookup';
import { cleanup, fireContext, freshDb, hookInput, kernelConfig, toolInput } from './test-support';

/**
 * The factory alone: every arm in PR C and every lookup arm PR D adds is this
 * function plus a spec, so what is under test is the wiring — which spec field
 * lands where, and which of the three "nothing to ask" answers comes back.
 */

afterEach(cleanup);

const ANSWER: Answer = {
  shelf: 'team',
  strength: 'strong',
  resourceId: 'r-1',
  title: 'The collation flip',
  url: 'https://shelf.acme.internal/p/one',
  price: '0',
  text: 'swap the image tag back',
};

function spec(over: Partial<LookupSpec> = {}): LookupSpec {
  return {
    id: 'probe',
    wait: 'tool',
    on: [{ event: 'prompt' }],
    trigger: 'prompt',
    enabled: () => true,
    text: (input) => input.prompt ?? null,
    shape: [mask],
    shelves: ['team', 'public'],
    deliver: 'inject',
    ...over,
  };
}

function planOf(arm: Arm, prompt = 'how do we flip the collation back'): Plan | Skip | null {
  const db = freshDb();
  const ctx = fireContext({ db, arm, input: hookInput({ prompt }) });
  return arm.plan?.(ctx) ?? null;
}

describe('lookupArm wiring', () => {
  it('carries id, wait and on through unchanged', () => {
    const arm = lookupArm(spec({ id: 'probe', wait: 'human', on: [{ event: 'turn.end' }] }));
    expect(arm.id).toBe('probe');
    expect(arm.wait).toBe('human');
    expect(arm.on).toEqual([{ event: 'turn.end' }]);
  });

  it('builds one stage with one leg per shelf, in the spec’s order', () => {
    const plan = planOf(lookupArm(spec()));
    expect(plan).not.toBeNull();
    const stages = (plan as Plan).stages;
    expect(stages).toHaveLength(1);
    expect(stages[0]?.map((l) => l.shelf)).toEqual(['team', 'public']);
  });

  it('runs the shape list over the text and keys the question on the result', () => {
    const plan = planOf(lookupArm(spec()), 'the token is ghp_0123456789abcdefghijklmnopqrstuvwxyz');
    const q = (plan as Plan).question;
    expect(q.text).not.toContain('ghp_0123456789abcdefghijklmnopqrstuvwxyz');
    expect(q.questionKey).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe('lookupArm, the three ways to ask nothing', () => {
  it('a disabled arm plans nothing, whatever text there is', () => {
    expect(planOf(lookupArm(spec({ enabled: () => false })))).toBeNull();
  });

  it('no text is null, not a skip: the ledger reason is no-question', () => {
    expect(planOf(lookupArm(spec({ text: () => null })))).toBeNull();
    expect(planOf(lookupArm(spec({ text: () => '' })))).toBeNull();
  });

  it('a skip passes the reason AND the text through, so the row keeps both', () => {
    const skip: (t: string) => SkipReason | null = (t) => (t.length < 10 ? 'short' : null);
    const planned = planOf(lookupArm(spec({ skip })), 'yes');
    expect(planned).toEqual({ reason: 'short', text: 'yes' });
  });

  it('a shape that empties the text is no-question, never an empty query on the wire', () => {
    expect(planOf(lookupArm(spec({ shape: [() => ''] })))).toBeNull();
  });
});

describe('lookupArm before and after', () => {
  it('gates before on enabled: an arm that is off writes no marks either', () => {
    const seen: string[] = [];
    const arm = lookupArm(
      spec({ enabled: () => false, before: () => seen.push('ran') as unknown as void }),
    );
    const db = freshDb();
    arm.before?.(fireContext({ db, arm, input: hookInput({ prompt: 'x' }) }));
    expect(seen).toEqual([]);
  });

  it('runs before when the arm is on, and leaves before/after off the arm when the spec has none', () => {
    const seen: string[] = [];
    const arm = lookupArm(spec({ before: () => seen.push('ran') as unknown as void }));
    const db = freshDb();
    arm.before?.(fireContext({ db, arm, input: hookInput({ prompt: 'x' }) }));
    expect(seen).toEqual(['ran']);
    expect(lookupArm(spec()).before).toBeUndefined();
    expect(lookupArm(spec()).after).toBeUndefined();
  });
});

describe('lookupArm delivery', () => {
  it('inject renders the finding for the answer’s own shelf', () => {
    const arm = lookupArm(spec());
    const db = freshDb();
    const ctx = fireContext({ db, arm, input: hookInput({ prompt: 'x' }) });
    const delivery = arm.deliver?.(ANSWER, ctx);
    expect(delivery?.mode).toBe('inject');
    expect(delivery?.resourceId).toBe('r-1');
    expect(delivery?.text).toContain('swap the image tag back');
    expect(delivery?.text).toContain('your team shelf');
  });

  it('log carries the resource id and no text at all', () => {
    const arm = lookupArm(spec({ deliver: 'log' }));
    const db = freshDb();
    const ctx = fireContext({ db, arm, input: hookInput({ prompt: 'x' }) });
    expect(arm.deliver?.(ANSWER, ctx)).toEqual({ mode: 'log', resourceId: 'r-1' });
  });
});

describe('lookupArm trigger', () => {
  it('takes a function of the input, for the one arm that asks two questions', () => {
    const arm = lookupArm(
      spec({
        on: [{ event: 'tool.after', kind: 'read' }],
        trigger: (input) => (input.event === 'tool.after' ? 'read' : 'churn'),
        text: () => 'zod gotcha bug workaround',
      }),
    );
    const db = freshDb();
    const ctx = fireContext({
      db,
      arm,
      input: hookInput({
        event: 'tool.after',
        tool: toolInput('read', { file_path: '/p/a.ts' }),
      }),
      config: kernelConfig(),
    });
    // The trigger is the leg's, not the plan's: what it decides is the wire
    // field, asserted against a stubbed fetch in the arm suites.
    expect(arm.plan?.(ctx)).not.toBeNull();
  });
});
