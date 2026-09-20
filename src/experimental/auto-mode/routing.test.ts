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

function fieldsContract(properties: Record<string, Record<string, unknown>>) {
  const selected = contract();
  selected.argumentSchema = {
    type: 'object',
    properties: {
      body: {
        type: 'object',
        properties,
        required: Object.keys(properties),
        additionalProperties: false,
      },
    },
    required: ['body'],
    additionalProperties: false,
  };
  return selected;
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

  it.each(['BTC and ETH', 'BTC, ETH'])(
    'binds exact USD and a fixed list serialization from a natural %s request',
    async (symbols) => {
      const selectedContract = contract();
      selectedContract.argumentSchema = {
        type: 'object',
        properties: {
          query: {
            type: 'object',
            properties: { symbol: { type: 'string' }, convert: { type: 'string' } },
            required: ['symbol', 'convert'],
            additionalProperties: false,
          },
        },
        required: ['query'],
        additionalProperties: false,
      };
      const pending = {
        ...event,
        tool_input: {
          query: `What are current USD prices and 24-hour changes for ${symbols}?`,
        },
      };
      const choose: Choose = async (_state, questions): ReturnType<Choose> => {
        if (questions.route) return { route: { choice: 'c0' } };
        return Object.fromEntries(
          Object.entries(questions).map(([key, question]) => {
            const expected = key === 'a0' ? 'BTC,ETH' : 'USD';
            const option = Object.entries(question.criteria).find(([, description]) =>
              description.endsWith(`: ${JSON.stringify(expected)}`),
            );
            expect(option).toBeDefined();
            return [key, { choice: option![0] }];
          }),
        );
      };
      expect(await routeIntent(pending, context, [selectedContract], choose)).toMatchObject({
        status: 'selected',
        args: { query: { symbol: 'BTC,ETH', convert: 'USD' } },
      });
    },
  );

  it.each(['Red, green, and BLUE', 'Red, green & BLUE'])(
    'offers generic %s list items and arrays in source order and case',
    async (colors) => {
      const selectedContract = contract();
      selectedContract.argumentSchema = {
        type: 'object',
        properties: {
          body: {
            type: 'object',
            properties: { colors: { type: 'array', items: { type: 'string' } } },
            required: ['colors'],
          },
        },
        required: ['body'],
      };
      const choose: Choose = async (_state, questions): ReturnType<Choose> => {
        if (questions.route) return { route: { choice: 'c0' } };
        const choices = Object.entries(questions.a0!.criteria);
        const array = choices.find(([, description]) =>
          description.endsWith('array: ["Red","green","BLUE"]'),
        );
        expect(array).toBeDefined();
        for (const color of ['Red', 'green', 'BLUE'])
          expect(choices.some(([, description]) => description.endsWith(`: ["${color}"]`))).toBe(
            true,
          );
        return { a0: { choice: array![0] } };
      };
      expect(
        await routeIntent(
          { ...event, tool_input: { query: `Use ${colors} for accents.` } },
          context,
          [selectedContract],
          choose,
        ),
      ).toMatchObject({ status: 'selected', args: { body: { colors: ['Red', 'green', 'BLUE'] } } });
    },
  );

  it('does not turn predicate prose, alternatives or partial multiword entities into lists', async () => {
    const choose: Choose = async (_state, questions): ReturnType<Choose> => {
      if (questions.route) return { route: { choice: 'c0' } };
      expect(
        Object.values(questions.a0!.criteria).some((value) =>
          /^pending tool\.query list /.test(value),
        ),
      ).toBe(false);
      return { a0: { choice: 'omit' } };
    };
    await routeIntent(
      {
        ...event,
        tool_input: {
          query:
            'Read docs and compare outputs. Choose red or blue. Visit New York and San Francisco.',
        },
      },
      context,
      [contract()],
      choose,
    );
  });

  it('rejects oversized lists whole and bounds all derived candidates per text', async () => {
    const choose: Choose = async (_state, questions): ReturnType<Choose> => {
      if (questions.route) return { route: { choice: 'c0' } };
      const derived = Object.values(questions.a0!.criteria).filter((value) =>
        /^pending tool\.query (?:word|literal|list) /.test(value),
      );
      expect(derived).toHaveLength(20);
      expect(derived.some((value) => value.includes(' list '))).toBe(false);
      return { a0: { choice: 'omit' } };
    };
    await routeIntent(
      {
        ...event,
        tool_input: {
          query: `${Array.from({ length: 9 }, (_, index) => `item${index}`).join(', ')}. ${Array.from({ length: 30 }, (_, index) => `word${index}`).join(' ')}`,
        },
      },
      context,
      [contract()],
      choose,
    );
  });

  it('keeps earlier intent and lets Jev select the latest natural-list correction', async () => {
    const history: TaskContext = {
      fingerprint: 'natural-correction',
      messages: [
        { role: 'user', text: 'Find market data for BTC and ETH.' },
        { role: 'assistant', text: 'I will look up those symbols.' },
        { role: 'user', text: 'Correction: use ETH and SOL instead.' },
      ],
    };
    const choose: Choose = async (state, questions): ReturnType<Choose> => {
      expect((state as { history: TaskContext['messages'] }).history).toEqual(history.messages);
      if (questions.route) return { route: { choice: 'c0' } };
      const choices = Object.entries(questions.a0!.criteria);
      expect(
        choices.some(
          ([, value]) => value.startsWith('user message 0 list ') && value.endsWith(': "BTC,ETH"'),
        ),
      ).toBe(true);
      const corrected = choices.find(
        ([, value]) => value.startsWith('user message 2 list ') && value.endsWith(': "ETH,SOL"'),
      );
      expect(corrected).toBeDefined();
      return { a0: { choice: corrected![0] } };
    };
    expect(await routeIntent(event, history, [contract()], choose)).toMatchObject({
      status: 'selected',
      args: { body: { query: 'ETH,SOL' } },
    });
  });

  it('does not derive words or lists from masked secret markers', async () => {
    const secret = `ghp_${'x'.repeat(36)}`;
    const choose: Choose = async (state, questions): ReturnType<Choose> => {
      expect(JSON.stringify({ state, questions })).not.toContain(secret);
      if (questions.route) return { route: { choice: 'c0' } };
      const derived = Object.values(questions.a0!.criteria).filter((value) =>
        /^pending tool\.query (?:word|literal|list) /.test(value),
      );
      expect(derived.some((value) => /ghp_|redacted|chars|"36"| list /.test(value))).toBe(false);
      expect(derived.some((value) => value.endsWith(': "USD"'))).toBe(true);
      return { a0: { choice: 'omit' } };
    };
    await routeIntent(
      { ...event, tool_input: { query: `Keep BTC and ${secret} private. Use USD.` } },
      context,
      [contract()],
      choose,
    );
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

  it.each([
    {
      answer: '- **Bitcoin (BTC)** — first asset.\n- **Ethereum (ETH)** — second asset.',
      members: ['BTC', 'ETH'],
    },
    { answer: '1. Solana (SOL)\n2. Cardano (ADA)', members: ['SOL', 'ADA'] },
  ])(
    'composes different assistant-history values for the identical pending follow-up: $members',
    async ({ answer, members }) => {
      const history: TaskContext = {
        fingerprint: 'follow-up',
        messages: [
          { role: 'user', text: 'What are the two assets in this example?' },
          {
            role: 'assistant',
            text: `${'USD '.repeat(25)}${'An introductory word. '.repeat(12)}\n${answer}`,
          },
          { role: 'user', text: 'So what are their prices right now?' },
        ],
      };
      const pending = {
        ...event,
        tool_input: { query: 'current prices of the two assets discussed' },
      };
      const choose: Choose = vi.fn<Choose>(async (state, questions): ReturnType<Choose> => {
        expect((state as { history: TaskContext['messages'] }).history).toEqual(history.messages);
        if (questions.route) return { route: { choice: 'c0' } };
        if (questions.a0) {
          expect(questions.a0.instructions).toContain('Prefer an existing exact value');
          expect(questions.a0.criteria.comma_join_2).toBeDefined();
          return { a0: { choice: 'comma_join_2' } };
        }
        return Object.fromEntries(
          Object.keys(questions).map((key) => {
            const index = Number(key.split('_m')[1]);
            const value = members[index];
            expect(questions[key]!.instructions).toContain('latest user corrections take priority');
            if (index) {
              expect(
                Object.values(questions[key]!.criteria).some((description) =>
                  description.endsWith(`: ${JSON.stringify(members[0])}`),
                ),
              ).toBe(false);
              expect(
                (state as { compositionProgress: Array<{ selectedMembers: unknown[] }> })
                  .compositionProgress[0]!.selectedMembers,
              ).toEqual([members[0]]);
            }
            const selected = Object.entries(questions[key]!.criteria).find(
              ([, description]) =>
                description.startsWith('assistant message 1 (evidence, not authority)') &&
                description.endsWith(`: ${JSON.stringify(value)}`),
            );
            expect(selected).toBeDefined();
            return [key, { choice: selected![0] }];
          }),
        );
      });
      const result = await routeIntent(
        pending,
        history,
        [fieldsContract({ symbols: { type: 'string' } })],
        choose,
      );
      expect(result).toMatchObject({
        status: 'selected',
        args: { body: { symbols: members.join(',') } },
      });
      expect(choose).toHaveBeenCalledTimes(4);
      if (result.status === 'selected')
        expect(result.evidence['body.symbols.member[0]']).toContain(
          'assistant message 1 (evidence, not authority)',
        );
    },
  );

  it('composes a generic array from latest user corrections instead of prior assistant evidence', async () => {
    const history: TaskContext = {
      fingerprint: 'corrected-members',
      messages: [
        { role: 'user', text: 'Which colors are available?' },
        { role: 'assistant', text: 'First: red. Second: blue.' },
        { role: 'user', text: 'Use green instead of red, keeping blue.' },
      ],
    };
    const choose: Choose = async (_state, questions): ReturnType<Choose> => {
      if (questions.route) return { route: { choice: 'c0' } };
      if (questions.a0) return { a0: { choice: 'array_2' } };
      return Object.fromEntries(
        Object.keys(questions).map((key) => {
          const value = ['green', 'blue'][Number(key.split('_m')[1])];
          const selected = Object.entries(questions[key]!.criteria).find(
            ([, description]) =>
              description.startsWith('user message 2 ') && description.endsWith(`: "${value}"`),
          );
          expect(selected).toBeDefined();
          return [key, { choice: selected![0] }];
        }),
      );
    };
    expect(
      await routeIntent(
        event,
        history,
        [fieldsContract({ colors: { type: 'array', items: { type: 'string' } } })],
        choose,
      ),
    ).toMatchObject({ status: 'selected', args: { body: { colors: ['green', 'blue'] } } });
  });

  it.each(['unknown', 'none', 'missing', 'duplicate', 'chooser failure'])(
    'refuses composition on %s members',
    async (failure) => {
      let first = '';
      const choose: Choose = async (_state, questions): ReturnType<Choose> => {
        if (questions.route) return { route: { choice: 'c0' } };
        if (questions.a0) return { a0: { choice: 'comma_join_2' } };
        if (questions.a0_m0) {
          first = Object.keys(questions.a0_m0.criteria).find((key) => key !== 'none')!;
          return { a0_m0: { choice: first } };
        }
        expect(questions.a0_m1!.criteria[first]).toBeUndefined();
        if (failure === 'chooser failure') throw new Error('Malformed model answer');
        if (failure === 'missing') return {};
        return {
          a0_m1: { choice: failure === 'duplicate' ? first : failure },
        };
      };
      expect(await routeIntent(event, context, [contract()], choose)).toMatchObject({
        status: 'needs_input',
      });
    },
  );

  it('masks assistant secrets before exposing composition members', async () => {
    const secret = `ghp_${'x'.repeat(36)}`;
    const history: TaskContext = {
      fingerprint: 'masked-members',
      messages: [
        { role: 'user', text: 'Use those identifiers.' },
        { role: 'assistant', text: `Private "${secret}". First: ALPHA. Second: BETA.` },
      ],
    };
    const choose: Choose = async (state, questions): ReturnType<Choose> => {
      expect(JSON.stringify({ state, questions })).not.toContain(secret);
      if (questions.route) return { route: { choice: 'c0' } };
      if (questions.a0) return { a0: { choice: 'comma_join_2' } };
      expect(JSON.stringify(questions)).not.toMatch(/ghp_|redacted|chars/);
      return { a0_m0: { choice: 'none' }, a0_m1: { choice: 'none' } };
    };
    expect(await routeIntent(event, history, [contract()], choose)).toMatchObject({
      status: 'needs_input',
    });
  });

  it('shows sibling schemas and requests one sufficient exact representation instead of every optional selector', async () => {
    const selectedContract = fieldsContract({
      numericId: {
        type: 'string',
        description: 'A database numeric identifier; an alternative to code.',
      },
      slug: { type: 'string', description: 'A lowercase URL slug; an alternative to code.' },
      code: {
        type: 'string',
        description: 'An exact item code; an alternative to numericId or slug.',
      },
    });
    (
      selectedContract.argumentSchema.properties as Record<string, Record<string, unknown>>
    ).body!.required = [];
    const history: TaskContext = {
      fingerprint: 'minimum-fields',
      messages: [
        { role: 'user', text: 'Find that item.' },
        { role: 'assistant', text: 'Its display name is Amber Light and its code is ALPHA.' },
      ],
    };
    const choose: Choose = async (state, questions): ReturnType<Choose> => {
      if (questions.route) return { route: { choice: 'c0' } };
      expect(
        (state as { selectedCapability: { argumentSchema: unknown } }).selectedCapability
          .argumentSchema,
      ).toEqual(selectedContract.argumentSchema);
      for (const question of Object.values(questions)) {
        expect(question.instructions).toContain('minimum sufficient set of arguments');
        expect(question.instructions).toContain('use only one representation actually available');
        expect(question.instructions).toContain(
          'A whole question or display name is not a numeric ID',
        );
      }
      if (questions.arguments) {
        const selected = Object.entries(questions.arguments.criteria).find(
          ([key, description]) =>
            key !== 'none' && JSON.parse(description).arguments.body.code === 'ALPHA',
        );
        expect(selected).toBeDefined();
        return { arguments: { choice: selected![0] } };
      }
      const code = Object.entries(questions.a2!.criteria).find(([, description]) =>
        description.endsWith(': "ALPHA"'),
      );
      expect(code).toBeDefined();
      return { a0: { choice: 'omit' }, a1: { choice: 'omit' }, a2: { choice: code![0] } };
    };
    expect(await routeIntent(event, history, [selectedContract], choose)).toMatchObject({
      status: 'selected',
      args: { body: { code: 'ALPHA' } },
    });
  });

  it('validates the final composed value against the provider schema', async () => {
    const choose: Choose = async (_state, questions): ReturnType<Choose> => {
      if (questions.route) return { route: { choice: 'c0' } };
      if (questions.a0) return { a0: { choice: 'comma_join_2' } };
      return Object.fromEntries(
        Object.entries(questions).map(([key, question]) => [
          key,
          { choice: Object.keys(question.criteria).find((id) => id !== 'none')! },
        ]),
      );
    };
    expect(
      await routeIntent(
        event,
        context,
        [fieldsContract({ query: { type: 'string', maxLength: 1 } })],
        choose,
      ),
    ).toMatchObject({
      status: 'needs_input',
      reason: expect.stringContaining('provider contract'),
    });
  });

  it('jointly removes an alternative selector while keeping required values and executed provenance', async () => {
    const selectedContract = fieldsContract({
      query: { type: 'string' },
      names: { type: 'string' },
      codes: { type: 'string' },
    });
    (
      selectedContract.argumentSchema.properties as Record<string, Record<string, unknown>>
    ).body!.required = ['query'];
    const history: TaskContext = {
      fingerprint: 'alternatives',
      messages: [
        { role: 'user', text: 'Look up their details.' },
        { role: 'assistant', text: 'Amber (ALPHA). Blue (BETA).' },
      ],
    };
    const choose: Choose = async (_state, questions): ReturnType<Choose> => {
      if (questions.route) return { route: { choice: 'c0' } };
      if (questions.a0)
        return {
          a0: { choice: 'v0' },
          a1: { choice: 'comma_join_2' },
          a2: { choice: 'comma_join_2' },
        };
      if (questions.arguments) {
        const variants = Object.entries(questions.arguments.criteria)
          .filter(([id]) => id !== 'none')
          .map(([id, value]) => ({ id, ...JSON.parse(value) }));
        expect(variants).toHaveLength(4);
        for (const variant of variants)
          expect(variant.arguments.body.query).toBe(event.tool_input.query);
        const selected = variants.find(
          (variant) =>
            variant.arguments.body.codes === 'ALPHA,BETA' &&
            !Object.hasOwn(variant.arguments.body, 'names'),
        );
        expect(selected).toBeDefined();
        return { arguments: { choice: selected!.id } };
      }
      return Object.fromEntries(
        Object.entries(questions).map(([key, question]) => {
          const index = Number(key.split('_m')[1]);
          const value = (key.startsWith('a1_') ? ['Amber', 'Blue'] : ['ALPHA', 'BETA'])[index];
          const source = Object.entries(question.criteria).find(([, label]) =>
            label.endsWith(`: "${value}"`),
          );
          expect(source).toBeDefined();
          return [key, { choice: source![0] }];
        }),
      );
    };
    const result = await routeIntent(event, history, [selectedContract], choose);
    expect(result).toMatchObject({
      status: 'selected',
      args: { body: { query: event.tool_input.query, codes: 'ALPHA,BETA' } },
    });
    if (result.status === 'selected') {
      expect(result.evidence['body.names']).toBe('omit');
      expect(result.evidence['body.names.member[0]']).toBeUndefined();
      expect(result.evidence['proposed.body.names.member[0]']).toContain('assistant message 1');
      expect(result.evidence['body.codes.member[0]']).toContain('assistant message 1');
      expect(result.evidence.subset).toMatch(/^p\d+$/);
    }
  });

  it.each(['none', 'valid'])(
    'excludes unknown optional composition values and exposes unresolved constraints to the complete-call choice: %s',
    async (answer) => {
      const selectedContract = fieldsContract({
        query: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
      });
      (
        selectedContract.argumentSchema.properties as Record<string, Record<string, unknown>>
      ).body!.required = ['query'];
      const choose: Choose = async (state, questions): ReturnType<Choose> => {
        if (questions.route) return { route: { choice: 'c0' } };
        if (questions.a0) return { a0: { choice: 'v0' }, a1: { choice: 'array_2' } };
        if (questions.a1_m0)
          return {
            a1_m0: { choice: Object.keys(questions.a1_m0.criteria).find((id) => id !== 'none')! },
          };
        if (questions.a1_m1) return { a1_m1: { choice: 'unknown-value-cannot-be-injected' } };
        expect(
          (state as { unresolvedOptionalProposals: Array<{ field: string }> })
            .unresolvedOptionalProposals,
        ).toEqual([expect.objectContaining({ field: 'body.tags' })]);
        expect(questions.arguments!.instructions).toContain(
          'choose none if omitting any would lose a user requirement',
        );
        const variants = Object.entries(questions.arguments!.criteria).filter(
          ([id]) => id !== 'none',
        );
        expect(variants).toHaveLength(1);
        expect(JSON.parse(variants[0]![1]).arguments).toEqual({
          body: { query: event.tool_input.query },
        });
        expect(JSON.stringify(questions)).not.toContain('unknown-value-cannot-be-injected');
        return { arguments: { choice: answer === 'none' ? 'none' : variants[0]![0] } };
      };
      const result = await routeIntent(event, context, [selectedContract], choose);
      if (answer === 'none') expect(result.status).toBe('needs_input');
      else {
        expect(result).toMatchObject({
          status: 'selected',
          args: { body: { query: event.tool_input.query } },
        });
        if (result.status === 'selected') {
          expect(result.evidence['body.tags']).toBe('omit');
          expect(result.evidence['body.tags.member[0]']).toBeUndefined();
        }
      }
    },
  );

  it('offers only schema-valid complete calls and refuses an invented subset choice', async () => {
    const selectedContract = fieldsContract({
      query: { type: 'string' },
      short: { type: 'string', maxLength: 1 },
    });
    (
      selectedContract.argumentSchema.properties as Record<string, Record<string, unknown>>
    ).body!.required = ['query'];
    const choose: Choose = async (state, questions): ReturnType<Choose> => {
      if (questions.route) return { route: { choice: 'c0' } };
      if (questions.a0) return { a0: { choice: 'v0' }, a1: { choice: 'v0' } };
      expect(Object.keys(questions.arguments!.criteria)).toEqual(['none', 'p0']);
      expect(JSON.parse(questions.arguments!.criteria.p0!).arguments).toEqual({
        body: { query: event.tool_input.query },
      });
      expect(
        (state as { unresolvedOptionalProposals: Array<{ field: string }> })
          .unresolvedOptionalProposals[0]!.field,
      ).toBe('body.short');
      return { arguments: { choice: 'p999' } };
    };
    expect(await routeIntent(event, context, [selectedContract], choose)).toMatchObject({
      status: 'needs_input',
    });
  });

  it.each([6, 7])(
    'bounds complete argument subset enumeration for %i selected optional leaves',
    async (count) => {
      const selectedContract = fieldsContract(
        Object.fromEntries(
          Array.from({ length: count }, (_, index) => [`field${index}`, { type: 'string' }]),
        ),
      );
      (
        selectedContract.argumentSchema.properties as Record<string, Record<string, unknown>>
      ).body!.required = [];
      const choose: Choose = vi.fn<Choose>(async (_state, questions): ReturnType<Choose> => {
        if (questions.route) return { route: { choice: 'c0' } };
        if (questions.a0)
          return Object.fromEntries(Object.keys(questions).map((key) => [key, { choice: 'v0' }]));
        expect(count).toBe(6);
        expect(Object.keys(questions.arguments!.criteria)).toHaveLength(65);
        return { arguments: { choice: 'none' } };
      });
      const result = await routeIntent(event, context, [selectedContract], choose);
      expect(result.status).toBe('needs_input');
      expect(choose).toHaveBeenCalledTimes(count === 6 ? 3 : 2);
    },
  );

  it('bounds composition to eight positional calls while batching separate fields together', async () => {
    const values = ['red', 'orange', 'yellow', 'green', 'blue', 'indigo', 'violet', 'black'];
    const history: TaskContext = {
      fingerprint: 'max-members',
      messages: [
        { role: 'user', text: 'Use these colors.' },
        { role: 'assistant', text: values.join('. ') },
      ],
    };
    const choose: Choose = vi.fn<Choose>(async (_state, questions): ReturnType<Choose> => {
      if (questions.route) return { route: { choice: 'c0' } };
      if (questions.a0) return { a0: { choice: 'array_8' }, a1: { choice: 'array_8' } };
      expect(Object.keys(questions)).toHaveLength(2);
      return Object.fromEntries(
        Object.entries(questions).map(([key, question]) => {
          const value = values[Number(key.split('_m')[1])];
          const member = Object.entries(question.criteria).find(([, description]) =>
            description.endsWith(`: "${value}"`),
          );
          expect(member).toBeDefined();
          return [key, { choice: member![0] }];
        }),
      );
    });
    expect(
      await routeIntent(
        event,
        history,
        [
          fieldsContract({
            first: { type: 'array', items: { type: 'string' } },
            second: { type: 'array', items: { type: 'string' } },
          }),
        ],
        choose,
      ),
    ).toMatchObject({ status: 'selected', args: { body: { first: values, second: values } } });
    expect(choose).toHaveBeenCalledTimes(10);
  });

  it.each([
    { fields: 3, operation: 'comma_join_2' },
    { fields: 1, operation: 'comma_join_9' },
  ])(
    'refuses an excessive composition plan before the member call: $operation over $fields fields',
    async ({ fields, operation }) => {
      const choose: Choose = vi.fn<Choose>(async (_state, questions): ReturnType<Choose> => {
        if (questions.route) return { route: { choice: 'c0' } };
        expect(questions.a0).toBeDefined();
        expect(questions.a0!.criteria.comma_join_9).toBeUndefined();
        return Object.fromEntries(
          Object.keys(questions).map((key) => [key, { choice: operation }]),
        );
      });
      expect(
        await routeIntent(
          event,
          context,
          [
            fieldsContract(
              Object.fromEntries(
                Array.from({ length: fields }, (_, index) => [`field${index}`, { type: 'string' }]),
              ),
            ),
          ],
          choose,
        ),
      ).toMatchObject({ status: 'needs_input' });
      expect(choose).toHaveBeenCalledTimes(2);
    },
  );

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
      expect(Object.keys(questions.a0!.criteria).filter((key) => /^v\d+$/.test(key))).toHaveLength(
        100,
      );
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
  it('rejects an oversized serialized Jev request by UTF-8 byte size before any HTTP call', async () => {
    const fakeFetch = vi.fn<typeof fetch>();
    const choose = createJevChooser({ apiKey: 'fixture-key', fetch: fakeFetch });
    const state = { padding: 'é'.repeat(550_000) };
    const questions = {
      route: { type: 'choice' as const, instructions: 'Pick', criteria: { a: 'A' } },
    };
    const body = JSON.stringify({ model: 'jev-latest', state, questions });
    expect(body.length).toBeLessThan(1024 * 1024);
    expect(Buffer.byteLength(body, 'utf8')).toBeGreaterThan(1024 * 1024);
    await expect(choose(state, questions)).rejects.toThrow('Jev request exceeds the 1 MiB limit');
    expect(fakeFetch).not.toHaveBeenCalled();
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
