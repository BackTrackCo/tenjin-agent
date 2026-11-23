import { afterEach, expect, it, vi } from 'vitest';
afterEach(() => vi.unstubAllEnvs());
import {
  capturedRequest,
  chatBody,
  chatUsage,
  hoistedForNeon,
  neonLabel,
  neonModel,
  messagesRequest,
  NEON_BESIDE_RESULT_LABEL,
  fittingNeonTokens,
  messageOf,
  replyOfBody,
  NEON_MINIMUM_JOB_ATOMIC,
  NEON_MODEL,
  neonPeakQuoteAtomic,
  NEON_TURN_FLOOR_TOKENS,
  NEON_TURN_MAX_TOKENS,
  NeonNoText,
  NeonReplyInvalid,
  type ThoughtCarry,
} from './neon-chat';
import { completedMessageSse } from './model-messages';

/**
 * A reply as BlockRun's chat completions would carry a tool call. The `extra_content` shape
 * is Google's own OpenAI-compatible one; BlockRun documents none, so this fixture is the
 * assumption the first live call checks.
 */
const REPLY = {
  id: 'chatcmpl-1',
  object: 'chat.completion',
  model: 'google/gemini-4-neon',
  choices: [
    {
      index: 0,
      finish_reason: 'tool_calls',
      message: {
        role: 'assistant',
        content: 'I will read the file first.',
        tool_calls: [
          {
            id: 'call_abc',
            type: 'function',
            function: { name: 'Read', arguments: '{"file_path":"/work/notes.md"}' },
            extra_content: { google: { thought_signature: 'SIG-1' } },
          },
        ],
      },
    },
  ],
  usage: {
    prompt_tokens: 1200,
    completion_tokens: 85,
    prompt_tokens_details: { cached_tokens: 1000 },
  },
};

it('translates a reply with a tool call into the Anthropic message the worker reads', () => {
  const carry: ThoughtCarry = {};
  const message = messageOf(REPLY, carry);
  expect(message).toMatchObject({
    type: 'message',
    role: 'assistant',
    model: 'deepseek-flash',
    stop_reason: 'tool_use',
    content: [
      { type: 'text', text: 'I will read the file first.' },
      { type: 'tool_use', id: 'call_abc', name: 'Read', input: { file_path: '/work/notes.md' } },
    ],
    usage: { input_tokens: 200, output_tokens: 85, cache_read_input_tokens: 1000 },
  });
  // The thought signature is kept for the tool call, whole.
  expect(carry).toEqual({
    call_abc: { extra_content: { google: { thought_signature: 'SIG-1' } } },
  });
  // What the bridge hands the child as an event stream parses as a message.
  expect(() => completedMessageSse(message)).not.toThrow();
});

it('sends the tool call back with its thought signature, and the tool result as a tool message', () => {
  const carry: ThoughtCarry = {};
  const first = messageOf(REPLY, carry);
  const body = chatBody(
    {
      model: 'deepseek-flash',
      max_tokens: 64_000,
      system: [{ type: 'text', text: 'You write documentation.' }],
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'Summarize the notes.' }] },
        { role: 'assistant', content: first.content },
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'call_abc',
              content: [{ type: 'text', text: '# Notes' }],
            },
            { type: 'text', text: 'Go on.' },
          ],
        },
      ],
      tools: [
        {
          name: 'Read',
          description: 'Read a file',
          input_schema: { type: 'object', properties: { file_path: { type: 'string' } } },
        },
      ],
      stop_sequences: ['</done>'],
      thinking: { type: 'enabled' },
    },
    carry,
    NEON_TURN_MAX_TOKENS,
  );
  expect(body).toEqual({
    model: NEON_MODEL,
    max_tokens: NEON_TURN_MAX_TOKENS,
    stream: true,
    stream_options: { include_usage: true },
    reasoning_effort: 'low',
    messages: [
      {
        role: 'system',
        content: `You write documentation.\n${NEON_BESIDE_RESULT_LABEL}\nGo on.`,
      },
      { role: 'user', content: 'Summarize the notes.' },
      {
        role: 'assistant',
        content: 'I will read the file first.',
        tool_calls: [
          {
            id: 'call_abc',
            type: 'function',
            function: { name: 'Read', arguments: '{"file_path":"/work/notes.md"}' },
            extra_content: { google: { thought_signature: 'SIG-1' } },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'call_abc', content: '# Notes' },
    ],
    tools: [
      {
        type: 'function',
        function: {
          name: 'Read',
          description: 'Read a file',
          parameters: { type: 'object', properties: { file_path: { type: 'string' } } },
        },
      },
    ],
    stop: ['</done>'],
  });
});

it.each([
  ['stop', 'end_turn'],
  ['length', 'max_tokens'],
  ['content_filter', 'refusal'],
])('maps the finish reason %s to the stop reason %s', (finish, stop) => {
  const message = messageOf(
    { choices: [{ finish_reason: finish, message: { role: 'assistant', content: 'Done.' } }] },
    {},
  );
  expect(message.stop_reason).toBe(stop);
});

it('refuses a reply it cannot read, so the paid call is not repeated as if it were new', () => {
  expect(() => messageOf({ choices: [] }, {})).toThrow(NeonReplyInvalid);
  expect(() =>
    messageOf(
      {
        choices: [
          {
            message: {
              role: 'assistant',
              tool_calls: [{ id: 'x', function: { name: 'Read', arguments: '{not json' } }],
            },
          },
        ],
      },
      {},
    ),
  ).toThrow(NeonReplyInvalid);
});

it('caps a turn near need, and steps it down to what the job ceiling has left', () => {
  // 16,384 output tokens would reserve about $0.26 whatever it writes; the cap is half that.
  expect(NEON_TURN_MAX_TOKENS).toBe(8_192);
  expect(neonPeakQuoteAtomic(0, 16_384)).toBeGreaterThan(250_000n);
  expect(neonPeakQuoteAtomic(0, NEON_TURN_MAX_TOKENS)).toBe(129_024n);
  // A side request that asks for 65,536 gets the cap.
  expect(fittingNeonTokens(30_000, 65_536, 1_000_000n)).toBe(NEON_TURN_MAX_TOKENS);
  // Little left: the largest cap whose estimate fits, never below the floor.
  const room = neonPeakQuoteAtomic(30_000, 4_000);
  const fits = fittingNeonTokens(30_000, 65_536, room);
  expect(fits).toBe(4_000);
  expect(neonPeakQuoteAtomic(30_000, fits!)).toBeLessThanOrEqual(room);
  expect(
    fittingNeonTokens(30_000, 65_536, neonPeakQuoteAtomic(30_000, NEON_TURN_FLOOR_TOKENS) - 1n),
  ).toBeNull();
  expect(NEON_MINIMUM_JOB_ATOMIC).toBe(neonPeakQuoteAtomic(0, NEON_TURN_FLOOR_TOKENS));
});

// Failure caught: a non-streamed call that thinks and writes for two minutes got a 504 from
// the gateway after BlockRun had quoted $0.27. The call is streamed, and the chunks fold into
// the same reply a non-streamed call carries.
it('folds a streamed reply with a split tool call, its signature and its usage into one reply', () => {
  const frame = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
  const body =
    frame({ choices: [{ index: 0, delta: { role: 'assistant', content: 'I will read ' } }] }) +
    frame({ choices: [{ index: 0, delta: { content: 'the file.' } }] }) +
    frame({
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: 0,
                id: 'call_abc',
                type: 'function',
                function: { name: 'Read', arguments: '{"file_path":' },
                extra_content: { google: { thought_signature: 'SIG-1' } },
              },
            ],
          },
        },
      ],
    }) +
    frame({
      choices: [
        {
          index: 0,
          finish_reason: 'tool_calls',
          delta: { tool_calls: [{ index: 0, function: { arguments: '"/work/notes.md"}' } }] },
        },
      ],
    }) +
    frame({ choices: [], usage: REPLY.usage }) +
    'data: [DONE]\n\n';
  const carry: ThoughtCarry = {};
  const message = messageOf(replyOfBody(body), carry);
  expect(message).toMatchObject({
    stop_reason: 'tool_use',
    content: [
      { type: 'text', text: 'I will read the file.' },
      { type: 'tool_use', id: 'call_abc', name: 'Read', input: { file_path: '/work/notes.md' } },
    ],
    usage: { input_tokens: 200, output_tokens: 85, cache_read_input_tokens: 1000 },
  });
  expect(carry).toEqual({
    call_abc: { extra_content: { google: { thought_signature: 'SIG-1' } } },
  });
  // A plain JSON body is still one reply; a stream that carries an error is not a reply.
  expect(replyOfBody(JSON.stringify(REPLY))).toEqual(REPLY);
  expect(() => replyOfBody(frame({ error: { message: 'upstream' } }))).toThrow(NeonReplyInvalid);
});

it('refuses a turn that spent its output cap and wrote nothing, so it is not sent again', () => {
  expect(() =>
    messageOf(
      { choices: [{ finish_reason: 'length', message: { role: 'assistant', content: null } }] },
      {},
    ),
  ).toThrow(NeonNoText);
  // Text that reached the cap is a reply, cut at max_tokens.
  expect(
    messageOf(
      { choices: [{ finish_reason: 'length', message: { role: 'assistant', content: 'Part' } }] },
      {},
    ).stop_reason,
  ).toBe('max_tokens');
});

it('folds content sent as parts and keeps the reasoning it does not hand the worker', () => {
  const frame = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
  const reply = replyOfBody(
    frame({ choices: [{ delta: { reasoning_content: 'thinking...' } }] }) +
      frame({ choices: [{ delta: { content: [{ type: 'text', text: 'Hello' }] } }] }) +
      frame({
        choices: [{ finish_reason: 'stop', delta: {} }],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 40,
          completion_tokens_details: { reasoning_tokens: 30 },
        },
      }),
  ) as { choices: { message: Record<string, unknown> }[] };
  expect(reply.choices[0]!.message).toMatchObject({
    content: 'Hello',
    reasoning_content: 'thinking...',
  });
  const message = messageOf(reply, {});
  expect(message.content).toEqual([{ type: 'text', text: 'Hello' }]);
  expect(chatUsage(reply)).toMatchObject({ outputTokens: 40, reasoningTokens: 30 });
});

it('gives Gemini plain text for a tool result, and says so when there is none', () => {
  const body = chatBody(
    {
      messages: [
        { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }] },
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 't1', content: [], is_error: false },
            {
              type: 'tool_result',
              tool_use_id: 't2',
              content: [{ type: 'text', text: 'boom' }],
              is_error: true,
            },
          ],
        },
      ],
    },
    {},
    1024,
  );
  expect(body.messages.slice(1)).toEqual([
    { role: 'tool', tool_call_id: 't1', content: '(no output)' },
    { role: 'tool', tool_call_id: 't2', content: 'Error: boom' },
  ]);
  const shown = capturedRequest(chatBody({ system: 'You write.', messages: [] }, {}, 64));
  expect(shown.messages).toEqual([{ role: 'system', content: { bytes: 12, approxTokens: 3 } }]);
});

// Failure caught by paid replays of a live run: a system message among the messages made Neon
// spend its whole cap on hidden thought, and text beside a tool result made BlockRun lose the
// result. The shape is run 6's second call.
it('moves system messages and text beside a tool result into the system prompt', () => {
  const body = {
    model: 'deepseek-flash',
    system: [
      { type: 'text', text: 'You are a coding agent.', cache_control: { type: 'ephemeral' } },
    ],
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'Read README.md, then write notes.' }] },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'plan', signature: 'S' },
          { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'README.md' } },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 't1', content: 'README text' },
          { type: 'text', text: 'Mind the style guide.' },
        ],
      },
      { role: 'system', content: [{ type: 'text', text: 'Deferred tools are now available.' }] },
      { role: 'user', content: 'Go on.' },
    ],
  };
  const out = hoistedForNeon(body) as {
    system: unknown[];
    messages: { role: string; content: unknown[] }[];
  };
  expect(out.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
  expect(out.messages.some((m) => m.role === 'system')).toBe(false);
  // The tool result is alone in its message, and the thinking block survives.
  expect(out.messages[2]!.content).toEqual([
    { type: 'tool_result', tool_use_id: 't1', content: 'README text' },
  ]);
  expect(out.messages[1]!.content[0]).toMatchObject({ type: 'thinking', signature: 'S' });
  // The real system prompt (with its cache control) first, the hoisted system text next, then
  // the labelled text that came beside the result and the user text that followed it.
  expect(out.system).toEqual([
    { type: 'text', text: 'You are a coding agent.', cache_control: { type: 'ephemeral' } },
    { type: 'text', text: 'Deferred tools are now available.' },
    { type: 'text', text: NEON_BESIDE_RESULT_LABEL },
    { type: 'text', text: 'Mind the style guide.' },
    { type: 'text', text: 'Go on.' },
  ]);
  // A body with neither shape is left as it is, and a user message with no tool result keeps its text.
  const plain = { messages: [{ role: 'user', content: 'Hi' }] };
  expect(hoistedForNeon(plain)).toBe(plain);
  // The chat route reads the same hoisted body.
  const chat = chatBody(body, {}, 64);
  expect(chat.messages.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'tool']);
  expect(String(chat.messages[0]!.content)).toContain('Deferred tools are now available.');
});

it('reads the eval reasoning override on both routes, and keeps low as the default', () => {
  const send = (env?: string) => {
    if (env !== undefined) vi.stubEnv('TENJIN_NEON_REASONING_EFFORT', env);
    return {
      chat: chatBody({ messages: [] }, {}, 8192) as Record<string, unknown>,
      messages: messagesRequest({ messages: [] }, 8192),
    };
  };
  expect(send().chat.reasoning_effort).toBe('low');
  expect(send().messages.thinking).toEqual({ type: 'enabled', budget_tokens: 2048 });
  const none = send('none');
  expect(none.chat.reasoning_effort).toBe('none');
  expect(none.messages.thinking).toEqual({ type: 'disabled' });
  const high = send('high');
  expect(high.chat.reasoning_effort).toBe('high');
  expect(high.messages.thinking).toEqual({ type: 'enabled', budget_tokens: 7168 });
  const omit = send('omit');
  expect('reasoning_effort' in omit.chat).toBe(false);
  expect('thinking' in omit.messages).toBe(false);
  // A value it does not know is the default.
  expect(send('wild').chat.reasoning_effort).toBe('low');
});

it('lets the eval name one of four Gemini 4 models, falls back to Neon, and prices each as itself', () => {
  expect(neonModel({})).toBe('google/gemini-4-neon');
  expect(neonModel({ TENJIN_NEON_MODEL: 'google/gemini-4-hydrogen' })).toBe(
    'google/gemini-4-hydrogen',
  );
  expect(neonModel({ TENJIN_NEON_MODEL: 'google/gemini-4-carbon' })).toBe('google/gemini-4-carbon');
  for (const wild of ['gpt-6', 'google/gemini-3.8-flash', '', 'toString'])
    expect(neonModel({ TENJIN_NEON_MODEL: wild })).toBe('google/gemini-4-neon');
  // The label follows the model that ran, and an unknown one reads as the default.
  expect(neonLabel('google/gemini-4-hydrogen')).toBe('Gemini 4 Hydrogen');
  expect(neonLabel(undefined)).toBe('Gemini 4 Neon');
  // The body names the model and the quote uses its prices: 2,048 output tokens, no input.
  vi.stubEnv('TENJIN_NEON_MODEL', 'google/gemini-4-hydrogen');
  expect(chatBody({ messages: [] }, {}, 64).model).toBe('google/gemini-4-hydrogen');
  expect(messagesRequest({ messages: [] }, 64).model).toBe('google/gemini-4-hydrogen');
  expect(neonPeakQuoteAtomic(0, 2_048)).toBe(16_128n);
  expect(neonPeakQuoteAtomic(0, 2_048, 'google/gemini-4-neon')).toBe(32_256n);
});
