import { expect, it } from 'vitest';
import {
  chatBody,
  fittingNeonTokens,
  messageOf,
  replyOfBody,
  NEON_MINIMUM_JOB_ATOMIC,
  NEON_MODEL,
  neonPeakQuoteAtomic,
  NEON_TURN_FLOOR_TOKENS,
  NEON_TURN_MAX_TOKENS,
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
    messages: [
      { role: 'system', content: 'You write documentation.' },
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
      { role: 'user', content: 'Go on.' },
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
