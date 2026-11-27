import { expect, it } from 'vitest';
import {
  capturedRequest,
  chatBody,
  chatUsage,
  fittingNeonTokens,
  inputSplit,
  messageOf,
  neonMinimumJobAtomic,
  neonPeakQuoteAtomic,
  NEON_DEFAULT_EFFORT,
  NEON_TURN_FLOOR_TOKENS,
  NEON_TURN_MAX_TOKENS,
  NeonNoText,
  NeonReplyInvalid,
  replyOfBody,
  type ThoughtCarry,
} from './neon-chat';
import { completedMessageSse } from './model-messages';
import type { NeonTerms } from './neon-terms';

/** A row's terms as a test stub: $3.15 in and $15.75 out per million tokens, the nanogpt dialect. */
const TERMS: NeonTerms = {
  rowId: 'row-1',
  label: 'Test Writer',
  url: 'https://seller.example/chat',
  payTo: '0x00000000000000000000000000000000000000aa',
  network: 'eip155:8453',
  asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  model: 'test/model',
  wire: 'chat',
  scheme: 'batch-settlement',
  usage: 'nanogpt',
  inputAtomicPerMillion: '3150000',
  outputAtomicPerMillion: '15750000',
  cacheReadAtomicPerMillion: '157500',
};

/**
 * A reply as a chat completions seller would carry a tool call. The `extra_content` shape
 * is Google's own OpenAI-compatible one.
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
    TERMS.model,
  );
  expect(body).toEqual({
    model: TERMS.model,
    max_tokens: NEON_TURN_MAX_TOKENS,
    stream: false,
    reasoning_effort: NEON_DEFAULT_EFFORT,
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
      // The text that came beside the result is a user message after it, in its place.
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

it('caps a turn at 16,000 tokens and steps it down to what the room has left, by the price rule of its row', () => {
  expect(NEON_TURN_MAX_TOKENS).toBe(16_000);
  // The quote follows the row's price rule: 16,000 output tokens at $15.75 per million.
  expect(neonPeakQuoteAtomic(TERMS, 0, 16_000)).toBe(252_000n);
  // A side request that asks for 65,536 gets the cap.
  expect(fittingNeonTokens(TERMS, 30_000, 65_536, 1_000_000n)).toBe(NEON_TURN_MAX_TOKENS);
  // Little left: the largest cap whose estimate fits, never below the floor.
  const room = neonPeakQuoteAtomic(TERMS, 30_000, 4_000);
  const fits = fittingNeonTokens(TERMS, 30_000, 65_536, room);
  expect(fits).toBe(4_000);
  expect(neonPeakQuoteAtomic(TERMS, 30_000, fits!)).toBeLessThanOrEqual(room);
  expect(
    fittingNeonTokens(
      TERMS,
      30_000,
      65_536,
      neonPeakQuoteAtomic(TERMS, 30_000, NEON_TURN_FLOOR_TOKENS) - 1n,
    ),
  ).toBeNull();
  expect(neonMinimumJobAtomic(TERMS)).toBe(neonPeakQuoteAtomic(TERMS, 0, NEON_TURN_FLOOR_TOKENS));
  // A cheaper row quotes less for the same turn.
  const cheaper = { ...TERMS, outputAtomicPerMillion: '7875000', inputAtomicPerMillion: '1575000' };
  expect(neonPeakQuoteAtomic(cheaper, 0, 16_000)).toBe(126_000n);
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
    TERMS.model,
  );
  expect(body.messages.slice(1)).toEqual([
    { role: 'tool', tool_call_id: 't1', content: '(no output)' },
    { role: 'tool', tool_call_id: 't2', content: 'Error: boom' },
  ]);
  const shown = capturedRequest(
    chatBody({ system: 'You write.', messages: [] }, {}, 64, TERMS.model),
  );
  expect(shown.messages).toEqual([{ role: 'system', content: { bytes: 12, approxTokens: 3 } }]);
});

it('keeps the chat body a prefix of the next one when a system message and text beside a result arrive', () => {
  const first = {
    system: [{ type: 'text', text: 'You are a coding agent.' }],
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'Read README.md, then write notes.' }] },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'README.md' } }],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 't1', content: 'README text' }],
      },
    ],
  };
  const longer = {
    ...first,
    messages: [
      ...first.messages.slice(0, 2),
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 't1', content: 'README text' },
          { type: 'text', text: 'Mind the style guide.' },
        ],
      },
      { role: 'system', content: [{ type: 'text', text: 'Deferred tools are now available.' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] },
      { role: 'user', content: 'Go on.' },
    ],
  };
  const short = chatBody(first, {}, 64, TERMS.model);
  const long = chatBody(longer, {}, 64, TERMS.model);
  // The system message is the real system prompt, the same bytes in both.
  expect(short.messages[0]).toEqual({ role: 'system', content: 'You are a coding agent.' });
  expect(long.messages[0]).toEqual(short.messages[0]);
  expect(long.messages.filter((m) => m.role === 'system')).toHaveLength(1);
  // The earlier request's messages are an exact prefix of the later one's.
  expect(long.messages.slice(0, short.messages.length)).toEqual(short.messages);
  expect(long.messages.slice(short.messages.length).map((m) => [m.role, m.content])).toEqual([
    ['user', 'Mind the style guide.'],
    ['user', 'Deferred tools are now available.'],
    ['assistant', 'Done.'],
    ['user', 'Go on.'],
  ]);
  // Never between an assistant's tool calls and their results: a system message that arrives
  // there waits for the results.
  const between = chatBody(
    {
      messages: [
        { role: 'assistant', content: [{ type: 'tool_use', id: 't9', name: 'Read', input: {} }] },
        { role: 'system', content: 'Mid-turn note.' },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't9', content: 'ok' }] },
      ],
    },
    {},
    64,
    TERMS.model,
  );
  expect(between.messages.map((m) => m.role)).toEqual(['assistant', 'tool', 'user']);
});

// The live cache check (2026-11-27): a follow-up resumes the writer's conversation in a new run,
// and its second and third calls read 14,397 and 17,446 of their 19,495 and 22,533 input tokens
// from the cache, because each request began with the bytes of the one before. A request that
// changed its start (the system text, the tools, an earlier turn) would read none. The captured
// requests were equal over the whole earlier part; this pins that for the bridge's translation.
it('starts a follow-up request with the exact start of the first request', () => {
  const system = [{ type: 'text', text: 'You are a writing assistant.' }];
  const tools = [{ name: 'Read', description: 'Read a file', input_schema: { type: 'object' } }];
  const context = {
    role: 'user',
    content: [{ type: 'text', text: '<system-reminder>context</system-reminder>' }],
  };
  const task = { role: 'user', content: [{ type: 'text', text: 'Write the paragraph.' }] };
  const draft = { role: 'assistant', content: [{ type: 'text', text: 'The first draft.' }] };
  const note = { role: 'user', content: [{ type: 'text', text: 'Make it shorter.' }] };
  const first = chatBody({ system, tools, messages: [context, task] }, {}, 16_000, TERMS.model);
  // The resumed conversation: the draft, the person's note, and Claude Code's context block again.
  const followUp = chatBody(
    { system, tools, messages: [context, task, draft, note, context] },
    {},
    16_000,
    TERMS.model,
  );
  expect(followUp.messages.slice(0, first.messages.length)).toEqual(first.messages);
  expect(followUp.tools).toEqual(first.tools);
  expect(JSON.stringify(followUp).startsWith(JSON.stringify(first).slice(0, 200))).toBe(true);
  // The second follow-up starts as the first follow-up did.
  const again = chatBody(
    { system, tools, messages: [context, task, draft, note, context, draft, note, context] },
    {},
    16_000,
    TERMS.model,
  );
  expect(again.messages.slice(0, followUp.messages.length)).toEqual(followUp.messages);
});

it('reads the nanogpt usage dialect: cache hits that the standard usage fields leave at zero', () => {
  // The shape of job 7e7ad935, call 2: billed at the cached rate, reported in a block of its own.
  const reply = {
    usage: {
      prompt_tokens: 9_000,
      completion_tokens: 300,
      prompt_tokens_details: { cached_tokens: 0 },
    },
    x_nanogpt_cache: {
      requested: false,
      enabledForDispatch: false,
      supported: true,
      status: 'hit',
      readTokens: 6_544,
    },
  };
  expect(chatUsage(reply, 'nanogpt')).toMatchObject({
    inputTokens: 9_000,
    cachedInputTokens: 6_544,
  });
  // Another dialect never reads that block.
  expect(chatUsage(reply, 'standard').cachedInputTokens).toBe(0);
  // A standard field above zero wins, a miss reads as none, and the count never passes the prompt.
  expect(
    chatUsage(
      {
        ...reply,
        usage: { prompt_tokens: 9_000, prompt_tokens_details: { cached_tokens: 100 } },
      },
      'nanogpt',
    ).cachedInputTokens,
  ).toBe(100);
  expect(
    chatUsage({ ...reply, x_nanogpt_cache: { status: 'miss', readTokens: 6_544 } }, 'nanogpt')
      .cachedInputTokens,
  ).toBe(0);
  expect(
    chatUsage({ ...reply, usage: { prompt_tokens: 5_000 } }, 'nanogpt').cachedInputTokens,
  ).toBe(5_000);
});

it('sends the effort the door named, and low where none was named', () => {
  expect(chatBody({ messages: [] }, {}, 64, TERMS.model).reasoning_effort).toBe('low');
  expect(chatBody({ messages: [] }, {}, 64, TERMS.model, 'medium').reasoning_effort).toBe('medium');
});

it('reads a plain JSON reply and refuses anything else', () => {
  expect(replyOfBody(JSON.stringify(REPLY))).toEqual(REPLY);
  expect(() => replyOfBody('data: {}')).toThrow(NeonReplyInvalid);
});

it('shares a call input total by the bytes of its system part, tools and messages', () => {
  const split = inputSplit(
    {
      system: 'x'.repeat(100),
      tools: [{ name: 'Read', input_schema: { type: 'object' } }],
      messages: [{ role: 'user', content: 'y'.repeat(300) }],
    },
    1_000,
  );
  expect(split.systemTokens + split.toolsTokens + split.messageTokens).toBeGreaterThanOrEqual(998);
  expect(split.messageTokens).toBeGreaterThan(split.systemTokens);
  expect(split.systemTokens).toBeGreaterThan(split.toolsTokens);
  // Chat completions carry the system text as a message of its own.
  const chat = inputSplit(
    {
      messages: [
        { role: 'system', content: 'z'.repeat(400) },
        { role: 'user', content: 'hi' },
      ],
    },
    100,
  );
  expect(chat.systemTokens).toBeGreaterThan(chat.messageTokens);
});
