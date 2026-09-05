import { afterEach, describe, expect, it } from 'vitest';
import type { Plan, Skip } from '../types';
import { promptArm } from './prompt';
import { cleanup, fireContext, freshDb, hookInput, kernelConfig } from './test-support';

/**
 * The prompt arm's spec: which prompts become a question, which become a skip
 * row, and what the shape list does to the words on the way.
 */

afterEach(cleanup);

const ON = kernelConfig({ push: 'on' });

/** A real question, over the `short` floor and under `long`, carrying one
 *  identifier-shaped token so the identifiers list has something to lift. */
const PROMPT =
  'the pgvector testcontainer flipped its collation after the image bump in #772 and every ivfflat index test now fails on sort order';

function plan(prompt: string, config = ON): Plan | Skip | null {
  const db = freshDb();
  const ctx = fireContext({ db, arm: promptArm, input: hookInput({ prompt }), config });
  return promptArm.plan?.(ctx) ?? null;
}

describe('the prompt arm registration', () => {
  it('is one human-wait arm on the prompt event', () => {
    expect(promptArm.id).toBe('prompt');
    expect(promptArm.wait).toBe('human');
    expect(promptArm.on).toEqual([{ event: 'prompt' }]);
    // Nothing local to write and nothing to say on its own.
    expect(promptArm.before).toBeUndefined();
    expect(promptArm.after).toBeUndefined();
  });
});

describe('the prompt arm plan', () => {
  it('asks nothing at all while `hooks.push` is off', () => {
    expect(plan(PROMPT, kernelConfig({ push: 'off' }))).toBeNull();
  });

  it('asks both shelves at once: one stage, team first', () => {
    const planned = plan(PROMPT) as Plan;
    expect(planned.stages).toHaveLength(1);
    expect(planned.stages[0]?.map((l) => l.shelf)).toEqual(['team', 'public']);
  });

  it('condenses the prose and lifts its identifiers, which no other arm does', () => {
    const q = (plan(PROMPT) as Plan).question;
    expect(q.text.length).toBeLessThan(PROMPT.length);
    expect(q.text).toContain('pgvector');
    expect(q.identifiers).toContain('pr-772');
  });

  it('a prompt with no prompt field at all is no-question, not a skip', () => {
    const db = freshDb();
    const ctx = fireContext({ db, arm: promptArm, input: hookInput(), config: ON });
    expect(promptArm.plan?.(ctx)).toBeNull();
  });
});

describe('the prompt arm skips, each with its own reason', () => {
  it('short: a conversational reply, 48 of 474 real prompts', () => {
    expect(plan('yes')).toEqual({ reason: 'short', text: 'yes' });
  });

  it('long: a pasted payload, 40 of 474', () => {
    const pasted = 'x'.repeat(4001);
    expect(plan(pasted)).toEqual({ reason: 'long', text: pasted });
  });

  it('slash: a harness command', () => {
    const slash = `/compact ${PROMPT}`;
    expect(plan(slash)).toEqual({ reason: 'slash', text: slash });
  });

  it('words: long enough, but not three words of three characters', () => {
    const noWords = `${'a '.repeat(45)}`.trim();
    expect(plan(noWords)).toEqual({ reason: 'words', text: noWords });
  });
});

describe('the prompt arm and secrets', () => {
  it('masks before it condenses, so a token is never promoted to an identifier', () => {
    const token = 'ghp_0123456789abcdefghijklmnopqrstuvwxyz';
    const q = (plan(`${PROMPT} and the token ${token} keeps being refused`) as Plan).question;
    expect(q.text).not.toContain(token);
    expect(q.identifiers ?? []).not.toContain(token);
    expect(JSON.stringify(q)).not.toContain(token);
  });
});
