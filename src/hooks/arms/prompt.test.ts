import { afterEach, describe, expect, it, vi } from 'vitest';
import { ask } from '../ask';
import type { Plan, Skip } from '../types';
import { promptArm } from './prompt';
import { cleanup, fireContext, freshDb, hookInput, kernelConfig } from './test-support';

/**
 * The prompt arm's spec: which prompts become a question, which become a skip
 * row, and that the question is the prompt itself with its secrets stubbed.
 */

afterEach(cleanup);

const ON = kernelConfig();

/** A real question, of the shape a person actually types. */
const PROMPT =
  'the pgvector testcontainer flipped its collation after the image bump in #772 and every ivfflat index test now fails on sort order';

function plan(prompt: string, config = ON): Plan | Skip | null {
  const db = freshDb();
  const ctx = fireContext({ db, arm: promptArm, input: hookInput({ prompt }), config });
  // The prompt arm's `text` is synchronous, so its plan is (lookup.ts).
  return (promptArm.plan?.(ctx) ?? null) as Plan | Skip | null;
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
  it('asks nothing at all while `hooks.prompt` is off', () => {
    expect(plan(PROMPT, kernelConfig({ prompt: false }))).toBeNull();
  });

  it('asks both shelves at once: one stage, team first', () => {
    const planned = plan(PROMPT) as Plan;
    expect(planned.stages).toHaveLength(1);
    expect(planned.stages[0]?.map((l) => l.shelf)).toEqual(['team', 'public']);
  });

  it('asks the prompt itself: nothing is rewritten, dropped or reordered', () => {
    expect((plan(PROMPT) as Plan).question.text).toBe(PROMPT);
  });

  it('a prompt with no prompt field at all is no-question, not a skip', () => {
    const db = freshDb();
    const ctx = fireContext({ db, arm: promptArm, input: hookInput(), config: ON });
    expect(promptArm.plan?.(ctx)).toBeNull();
  });
});

describe('the prompt arm skips, each with its own reason', () => {
  it('slash: a harness command', () => {
    const slash = `/compact ${PROMPT}`;
    expect(plan(slash)).toEqual({ reason: 'slash', text: slash });
  });

  it('harness: the tooling talking to itself through the prompt channel', () => {
    const notice = '<task-notification>agent a-1 finished its work order</task-notification>';
    expect(plan(notice)).toEqual({ reason: 'harness', text: notice });
  });

  it('words: not three words of three characters', () => {
    const noWords = `${'a '.repeat(45)}`.trim();
    expect(plan(noWords)).toEqual({ reason: 'words', text: noWords });
  });

  it('asks a short prompt and a pasted one: there is no length rule', () => {
    expect(plan('why did the collation flip?')).toMatchObject({ stages: expect.anything() });
    const pasted = `${'collation '.repeat(500)}pgvector`;
    expect((plan(pasted) as Plan).question.text).toBe(pasted);
  });
});

describe('the prompt arm and secrets', () => {
  it('masks the text it SKIPS too: a token in a refused prompt is never stored', () => {
    const token = 'ghp_0123456789abcdefghijklmnopqrstuvwxyz';
    const slash = plan(`/compact ${PROMPT} with the ${token} in it`) as Skip;
    expect(slash.reason).toBe('slash');
    expect(slash.text).not.toContain(token);
  });

  it('masks the question, and masking is the only thing it does to it', () => {
    const token = 'ghp_0123456789abcdefghijklmnopqrstuvwxyz';
    const q = (plan(`${PROMPT} and the token ${token} keeps being refused`) as Plan).question;
    expect(q.text).not.toContain(token);
    expect(JSON.stringify(q)).not.toContain(token);
    // Everything either side of the stub is the prompt, word for word.
    expect(q.text.startsWith(`${PROMPT} and the token `)).toBe(true);
    expect(q.text.endsWith(' keeps being refused')).toBe(true);
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
      const config = kernelConfig({}, { publicFallback: 'off' });
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
