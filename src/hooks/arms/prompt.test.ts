import { afterEach, describe, expect, it, vi } from 'vitest';
import { ask } from '../ask';
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

  it('long: a pasted payload, 40 of 474, stored as a scrubbed 512-char head', () => {
    const pasted = 'x'.repeat(4001);
    // The row keeps the head, not the paste: `long` IS the pasted-payload case,
    // and a paste is where a token and another session's transcript live.
    expect(plan(pasted)).toEqual({ reason: 'long', text: 'x'.repeat(512) });
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
  it('masks the text it SKIPS too: a token in a refused prompt is never stored', () => {
    const token = 'ghp_0123456789abcdefghijklmnopqrstuvwxyz';
    const slash = plan(`/compact ${PROMPT} with the ${token} in it`) as Skip;
    expect(slash.reason).toBe('slash');
    expect(slash.text).not.toContain(token);

    // `long` is the one that matters most: it IS the pasted-payload case.
    const pasted = plan(`${'x'.repeat(4001)} ${token}`) as Skip;
    expect(pasted.reason).toBe('long');
    expect(pasted.text).not.toContain(token);
  });

  it('masks before it condenses, so a token is never promoted to an identifier', () => {
    const token = 'ghp_0123456789abcdefghijklmnopqrstuvwxyz';
    const q = (plan(`${PROMPT} and the token ${token} keeps being refused`) as Plan).question;
    expect(q.text).not.toContain(token);
    expect(q.identifiers ?? []).not.toContain(token);
    expect(JSON.stringify(q)).not.toContain(token);
  });
});

describe('the prompt arm under team.publicFallback off', () => {
  it('sends the question to the team shelf only, out of its one mixed stage', async () => {
    const asked: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      asked.push(String(input));
      return new Response(JSON.stringify({ schemaVersion: 3, searchId: 'x', items: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };
    vi.stubGlobal('fetch', fetchImpl);
    try {
      const config = kernelConfig({ push: 'on' }, { publicFallback: 'off' });
      const db = freshDb();
      const ctx = fireContext({
        db,
        arm: promptArm,
        input: hookInput({ prompt: PROMPT }),
        config,
      });
      const planned = promptArm.plan?.(ctx) as Plan;
      // The arm plans both shelves in ONE stage, so nothing but a leg-level
      // filter can keep the public marketplace from being asked.
      expect(planned.stages[0]?.map((l) => l.shelf)).toEqual(['team', 'public']);
      await ask(ctx, planned);
      expect(asked).toHaveLength(1);
      expect(asked[0]).toContain('shelf.acme.internal');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
