import { describe, expect, it, vi } from 'vitest';
import { compileResource } from './contracts';
import { FIXTURE_RESOURCE, fixtureChooser, runEvent, hookOutput } from './runtime';
import { createJevChooser, routeIntent } from './routing';
import type { Choose } from './routing';
import type { HookEvent, TaskContext } from './context';

const event: HookEvent = {
  hook_event_name: 'PreToolUse',
  session_id: 'session',
  tool_use_id: 'call1',
  transcript_path: '/unused',
  tool_name: 'WebSearch',
  tool_input: { query: 'neural search research' },
};
const context: TaskContext = {
  messages: [{ role: 'user', text: 'Search for neural search research.' }],
  fingerprint: 'task-context',
};
function contract() {
  const compiled = compileResource(FIXTURE_RESOURCE);
  if (compiled.status !== 'supported') throw new Error(compiled.reasons.join(';'));
  return compiled.contract;
}

describe('Jev intent-to-call boundary', () => {
  it('selects exact argument values from the pending call, without generated strings', async () => {
    const result = await routeIntent(event, context, [contract()], fixtureChooser);
    expect(result.status).toBe('selected');
    if (result.status === 'selected')
      expect(result.args).toEqual({ body: { query: 'neural search research' } });
  });

  it('can select an exact symbol literal from a normal pending search sentence', async () => {
    const symbolContract = contract();
    symbolContract.argumentSchema = {
      type: 'object',
      properties: {
        query: {
          type: 'object',
          properties: { symbol: { type: 'string' } },
          required: ['symbol'],
          additionalProperties: false,
        },
      },
      required: ['query'],
      additionalProperties: false,
    };
    const pending = { ...event, tool_input: { query: 'Find the latest prices for `BTC,ETH`.' } };
    const choose: Choose = async (_state, questions): ReturnType<Choose> => {
      if (questions.route) return { route: { choice: 'c0' } };
      expect(questions.a0!.criteria.v0).toBe(
        'pending tool.query: "Find the latest prices for `BTC,ETH`."',
      );
      const literal = Object.entries(questions.a0!.criteria).find(
        ([, description]) =>
          description.startsWith('pending tool.query literal') &&
          description.endsWith(': "BTC,ETH"'),
      );
      expect(literal).toBeDefined();
      return { a0: { choice: literal![0] } };
    };
    expect(await routeIntent(pending, context, [symbolContract], choose)).toMatchObject({
      status: 'selected',
      args: { query: { symbol: 'BTC,ETH' } },
    });
  });

  it('keeps original user instructions and corrections while exposing the corrected quoted value', async () => {
    const history: TaskContext = {
      fingerprint: 'corrected',
      messages: [
        { role: 'user', text: 'Find market data for `BTC`.' },
        { role: 'assistant', text: 'I will look up that symbol.' },
        { role: 'user', text: 'Correction: use "ETH,SOL" instead.' },
      ],
    };
    const choose: Choose = async (state, questions): ReturnType<Choose> => {
      expect((state as { history: TaskContext['messages'] }).history).toEqual(history.messages);
      if (questions.route) return { route: { choice: 'c0' } };
      const options = questions.a0!.criteria;
      expect(Object.values(options)).toContain('user message 0 literal 0: "BTC"');
      const corrected = Object.entries(options).find(
        ([, description]) => description === 'user message 2 literal 0: "ETH,SOL"',
      );
      expect(corrected).toBeDefined();
      return { a0: { choice: corrected![0] } };
    };
    expect(await routeIntent(event, history, [contract()], choose)).toMatchObject({
      status: 'selected',
      args: { body: { query: 'ETH,SOL' } },
    });
  });

  it('masks secret literals before they become values or leave in model context', async () => {
    const secret = `ghp_${'x'.repeat(36)}`;
    const history: TaskContext = {
      fingerprint: 'redacted',
      messages: [{ role: 'user', text: `Keep "${secret}" private and look up \`BTC\`.` }],
    };
    const pending = {
      ...event,
      tool_input: { query: `Find \`ETH\`; private token is "${secret}".` },
    };
    const choose: Choose = async (state, questions): ReturnType<Choose> => {
      expect(JSON.stringify({ state, questions })).not.toContain(secret);
      if (questions.route) return { route: { choice: 'c0' } };
      const literals = Object.values(questions.a0!.criteria).filter((value) =>
        value.includes(' literal '),
      );
      expect(literals).toContain('pending tool.query literal 0: "ETH"');
      expect(literals).toContain('user message 0 literal 0: "BTC"');
      expect(literals.some((value) => value.includes('[redacted'))).toBe(false);
      return { a0: { choice: 'omit' } };
    };
    expect(await routeIntent(pending, history, [contract()], choose)).toMatchObject({
      status: 'needs_input',
    });
  });

  it('bounds literal length, per-message count and total sources without interpreting apostrophe prose', async () => {
    const quoted = Array.from({ length: 21 }, (_, index) => `\`symbol-${index}\``).join(' ');
    const pending = {
      ...event,
      tool_input: { query: `'apostrophe prose' "${'x'.repeat(201)}" ${quoted}` },
    };
    const choose: Choose = async (_state, questions): ReturnType<Choose> => {
      if (questions.route) return { route: { choice: 'c0' } };
      const literals = Object.values(questions.a0!.criteria).filter((value) =>
        value.startsWith('pending tool.query literal '),
      );
      expect(literals).toHaveLength(20);
      expect(literals[0]).toBe('pending tool.query literal 0: "symbol-0"');
      expect(literals.at(-1)).toBe('pending tool.query literal 19: "symbol-19"');
      return { a0: { choice: 'omit' } };
    };
    await routeIntent(pending, context, [contract()], choose);
    const many = {
      ...event,
      tool_input: Object.fromEntries(
        ['query', 'prompt', 'a', 'b', 'c'].map((key) => [key, quoted]),
      ),
    };
    const countChoices: Choose = async (_state, questions): ReturnType<Choose> => {
      if (questions.route) return { route: { choice: 'c0' } };
      expect(Object.keys(questions.a0!.criteria)).toHaveLength(101); // 100 values plus omit.
      expect(questions.a0!.criteria.v0).toContain('pending tool.query:');
      return { a0: { choice: 'omit' } };
    };
    await routeIntent(many, context, [contract()], countChoices);
  });
  it('returns needs_input when no listed value fills a required argument', async () => {
    const choose: Choose = async (_state, questions) =>
      Object.fromEntries(
        Object.keys(questions).map((key) => [key, { choice: key === 'route' ? 'c0' : 'omit' }]),
      );
    expect(await routeIntent(event, context, [contract()], choose)).toMatchObject({
      status: 'needs_input',
      reason: expect.stringContaining('body.query'),
    });
  });
  it('never discards domain restrictions to make a provider request fit', async () => {
    expect(
      await routeIntent(
        { ...event, tool_input: { ...event.tool_input, allowed_domains: ['example.com'] } },
        context,
        [contract()],
        fixtureChooser,
      ),
    ).toMatchObject({ status: 'unsupported' });
  });
  it('a valid model call cannot bypass deterministic execution refusal', async () => {
    const execute = vi
      .fn()
      .mockResolvedValue({ status: 'refused', reason: 'run budget exhausted' });
    const result = await runEvent(
      event,
      {
        version: 1,
        mode: 'live',
        stateDir: '/unused',
        policyPath: '/unused',
        model: 'jev-latest',
        discoveryQueries: {},
      },
      {
        context,
        contracts: [contract()],
        choose: fixtureChooser,
        execute,
        executionDeps: {
          stateDir: '/unused',
          readPolicy: async () => ({
            runId: 'test',
            revision: '1',
            authorization: 'auto',
            expiresAtMs: Date.now() + 10000,
            maxCallAtomic: '1000',
            maxRunAtomic: '1000',
            allowedOperations: ['search'],
          }),
          signPayment: async () => {
            throw new Error('must not sign');
          },
        },
      },
    );
    expect(result.status).toBe('refused');
    expect(execute).toHaveBeenCalledOnce();
    expect(execute.mock.calls[0]![0].advertisedAccepts).toEqual(FIXTURE_RESOURCE.accepts);
    expect(hookOutput(result).hookSpecificOutput.permissionDecision).toBe('deny');
  });
  it('route mode does not execute or sign', async () => {
    const execute = vi.fn();
    const result = await runEvent(
      event,
      {
        version: 1,
        mode: 'route',
        stateDir: '/unused',
        policyPath: '/unused',
        model: 'jev-latest',
        discoveryQueries: {},
      },
      { context, contracts: [contract()], choose: fixtureChooser, execute },
    );
    expect(result.status).toBe('prepared');
    expect(execute).not.toHaveBeenCalled();
  });
  it('sends the documented Jev choice request and rejects invented answer IDs', async () => {
    const fakeFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(
          JSON.stringify({ answers: { route: { type: 'choice', choice: 'invented' } } }),
        ),
      );
    const choose = createJevChooser({ apiKey: 'fixture-key', fetch: fakeFetch });
    await expect(
      choose(
        { task: 'find docs' },
        { route: { type: 'choice', instructions: 'Pick', criteria: { a: 'Web search' } } },
      ),
    ).rejects.toThrow('invalid choice');
    expect(fakeFetch.mock.calls[0]![0]).toBe('https://api.typesafe.ai/v1/systemone');
    expect(JSON.parse(fakeFetch.mock.calls[0]![1]!.body as string)).toMatchObject({
      model: 'jev-latest',
      questions: { route: { type: 'choice' } },
    });
  });
  it('cancels a streaming Jev response immediately when accumulated bytes exceed the limit', async () => {
    let pulls = 0;
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          pulls += 1;
          controller.enqueue(new Uint8Array(500_001));
        },
        cancel() {
          cancelled = true;
        },
      },
      { highWaterMark: 0 },
    );
    const choose = createJevChooser({
      apiKey: 'fixture-key',
      fetch: vi.fn<typeof fetch>().mockResolvedValue(new Response(stream)),
    });
    await expect(
      choose({}, { route: { type: 'choice', instructions: 'Pick', criteria: { a: 'A' } } }),
    ).rejects.toThrow('exceeds limit');
    expect(pulls).toBe(2);
    expect(cancelled).toBe(true);
  });
  it('applies the response limit to bytes, not decoded Unicode characters', async () => {
    const body = JSON.stringify({
      answers: { route: { choice: 'a' } },
      padding: 'é'.repeat(500_001),
    });
    expect(body.length).toBeLessThan(1_000_000);
    const choose = createJevChooser({
      apiKey: 'fixture-key',
      fetch: vi.fn<typeof fetch>().mockResolvedValue(new Response(body)),
    });
    await expect(
      choose({}, { route: { type: 'choice', instructions: 'Pick', criteria: { a: 'A' } } }),
    ).rejects.toThrow('exceeds limit');
  });
  it('rejects a declared oversized body before reading any stream bytes', async () => {
    let pulls = 0;
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>(
      {
        pull() {
          pulls += 1;
        },
        cancel() {
          cancelled = true;
        },
      },
      { highWaterMark: 0 },
    );
    const choose = createJevChooser({
      apiKey: 'fixture-key',
      fetch: vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response(stream, { headers: { 'content-length': '1000001' } })),
    });
    await expect(
      choose({}, { route: { type: 'choice', instructions: 'Pick', criteria: { a: 'A' } } }),
    ).rejects.toThrow('exceeds limit');
    expect(pulls).toBe(0);
    expect(cancelled).toBe(true);
  });
});
