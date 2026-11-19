import Anthropic from '@anthropic-ai/sdk';
import { expect, it } from 'vitest';
import { completedMessageSse, workerMessages } from './model-messages';
it('roundtrips completed thinking, tool IDs/JSON and cumulative usage through the maintained SDK parser', async () => {
  const message = {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    model: 'deepseek-flash',
    content: [
      { type: 'thinking', thinking: 'inspect first', signature: 'sig' },
      { type: 'tool_use', id: 'tool_1', name: 'Read', input: { file_path: 'file with spaces.ts' } },
    ],
    stop_reason: 'tool_use',
    stop_sequence: null,
    usage: {
      input_tokens: 150,
      output_tokens: 50,
      cache_read_input_tokens: 1000,
      cache_creation_input_tokens: 0,
    },
  };
  const client = new Anthropic({
    apiKey: 'test',
    maxRetries: 0,
    fetch: async () =>
      new Response(completedMessageSse(message), {
        headers: { 'content-type': 'text/event-stream' },
      }),
  });
  const result = await client.messages
    .stream({
      model: 'deepseek-flash',
      messages: [{ role: 'user', content: 'Read the file' }],
      max_tokens: 100,
    })
    .finalMessage();
  expect(result.content).toEqual(message.content);
  expect(result.usage).toMatchObject(message.usage);
});
it('does not rewrite a tool JSON key named cache_control and refuses provider tools', () => {
  const result = workerMessages({
    model: 'deepseek-flash',
    messages: [
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: '1', name: 'api', input: { cache_control: 'keep this input' } },
        ],
      },
    ],
  });
  expect(JSON.stringify(result)).toContain('keep this input');
  expect(() => workerMessages({ model: 'claude-opus' })).toThrow();
  expect(() =>
    workerMessages({
      model: 'deepseek-flash',
      tools: [{ type: 'web_search', name: 'search', input_schema: {} }],
    }),
  ).toThrow();
});
it('preserves the native auto classifier stop sequence and non-thinking request', () => {
  const messages = [{ role: 'user', content: [{ type: 'text', text: 'Review the tool call' }] }];
  const result = workerMessages({
    model: 'deepseek-flash',
    messages,
    max_tokens: 2112,
    stop_sequences: ['</block>'],
  });
  expect(result).toMatchObject({
    model: 'deepseek-flash',
    messages,
    max_tokens: 2112,
    thinking: { type: 'disabled' },
    stop_sequences: ['</block>'],
  });
  expect(result).not.toHaveProperty('tools');
});
// A person with thinking off in Claude Code (`MAX_THINKING_TOKENS=0`,
// `alwaysThinkingEnabled: false`) got every worker turn without thinking: Claude Code
// 2.1.328 then sends the turn with no `thinking` field, which went out as disabled.
it("sends a worker's own turn with thinking on, whatever the request asks", () => {
  const tools = [{ name: 'Read', input_schema: { type: 'object' } }];
  for (const turn of [
    { stream: true, tools },
    { stream: true, tools, thinking: { type: 'disabled' } },
    // Either mark alone makes it a turn of the worker.
    { stream: true },
    { tools },
  ])
    expect(workerMessages({ model: 'deepseek-flash', max_tokens: 32000, ...turn })).toMatchObject({
      thinking: { type: 'enabled' },
    });
});
it('keeps worker adaptive thinking enabled and rejects unknown thinking instead of changing it', () => {
  expect(
    workerMessages({ model: 'deepseek-flash', thinking: { type: 'adaptive', display: 'updates' } }),
  ).toMatchObject({ thinking: { type: 'enabled' } });
  expect(
    workerMessages({ model: 'deepseek-flash', thinking: { type: 'enabled', budget_tokens: 1024 } }),
  ).toMatchObject({ thinking: { type: 'enabled' } });
  expect(() =>
    workerMessages({ model: 'deepseek-flash', thinking: { type: 'unknown' } }),
  ).toThrow();
  expect(() =>
    workerMessages({ model: 'deepseek-flash', stop_sequences: ['x'.repeat(257)] }),
  ).toThrow();
});
// The router's Messages contract takes text only in a message and in a tool result
// (checked against its schema, production's and the next one's): a request with one image
// or document block was refused whole with 400 `invalid_model_request`, which is not tried
// again, so the job ended, and a follow-up carried the same block.
it('sends an image or a document block as a stable text placeholder, in a tool result and beside one', () => {
  const png = {
    type: 'image',
    source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' },
    cache_control: { type: 'ephemeral' },
  };
  const pdf = {
    type: 'document',
    source: { type: 'base64', media_type: 'application/pdf', data: 'JVBERi0=' },
  };
  const byUrl = { type: 'image', source: { type: 'url', url: 'https://example.com/a.png' } };
  const request = () => ({
    model: 'deepseek-flash',
    max_tokens: 1000,
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'What is in the screenshot?' }, png] },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'a.png' } }],
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 't1',
            content: [{ type: 'text', text: 'Read image' }, png, pdf],
          },
          byUrl,
        ],
      },
    ],
  });
  const sent = workerMessages(request());
  const image = '[image omitted because this model route accepts text only; attachment sha256:';
  expect(sent.messages).toEqual([
    {
      role: 'user',
      content: [
        { type: 'text', text: 'What is in the screenshot?' },
        { type: 'text', text: expect.stringContaining(image) },
      ],
    },
    request().messages[1],
    {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 't1',
          content: [
            { type: 'text', text: 'Read image' },
            { type: 'text', text: expect.stringContaining(image) },
            {
              type: 'text',
              text: expect.stringMatching(
                /^\[document omitted because this model route accepts text only; attachment sha256:[0-9a-f]{8}\]$/,
              ),
            },
          ],
        },
        { type: 'text', text: '[image omitted because this model route accepts text only]' },
      ],
    },
  ]);
  // No image bytes leave, and the same block reads the same on the next turn.
  expect(JSON.stringify(sent)).not.toContain('iVBORw0KGgo=');
  expect(workerMessages(request()).messages).toEqual(sent.messages);
});
it('preserves the native worker output allowance instead of silently halving it', () => {
  expect(workerMessages({ model: 'deepseek-flash', max_tokens: 32000 }).max_tokens).toBe(32000);
  expect(() => workerMessages({ model: 'deepseek-flash', max_tokens: 65537 })).toThrow();
  expect(() => workerMessages({ model: 'deepseek-flash', max_tokens: 0 })).toThrow();
});
it('serves tool search as the Messages API does, so a ToolSearch result never stops the job', () => {
  // The shape Claude Code 2.1.326 sends with tool search on, after one ToolSearch call:
  // the proxy and DeepSeek take neither `defer_loading` nor a `tool_reference` block.
  const schema = { type: 'object', properties: { offer_id: { type: 'string' } } };
  const result = workerMessages({
    model: 'deepseek-flash',
    tools: [
      { name: 'Read', description: 'Read a file', input_schema: { type: 'object' } },
      {
        name: 'DeferredToolPlaceholder',
        description: 'Reserved placeholder; never call this tool.',
        input_schema: { type: 'object', properties: {} },
        defer_loading: true,
      },
      {
        name: 'mcp__plugin_tenjin_router__subagent_activity',
        description: 'Activity',
        input_schema: schema,
        defer_loading: true,
      },
      { name: 'WebFetch', input_schema: { type: 'object' }, defer_loading: true },
    ],
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'Check the activity.' }] },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 't1', name: 'ToolSearch', input: { query: 'select:x' } }],
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 't1',
            content: [
              { type: 'tool_reference', tool_name: 'mcp__plugin_tenjin_router__subagent_activity' },
            ],
            cache_control: { type: 'ephemeral' },
          },
        ],
      },
    ],
  });
  // The named tool is callable; a deferred tool nothing named is not sent.
  expect(result.tools).toEqual([
    { name: 'Read', description: 'Read a file', input_schema: { type: 'object' } },
    {
      name: 'mcp__plugin_tenjin_router__subagent_activity',
      description: 'Activity',
      input_schema: schema,
    },
  ]);
  // The result reads as the definition, in the form ToolSearch's own description promises.
  expect((result.messages as { content: unknown }[])[2]!.content).toEqual([
    {
      type: 'tool_result',
      tool_use_id: 't1',
      content: [
        {
          type: 'text',
          text: `<functions>\n<function>${JSON.stringify({ description: 'Activity', name: 'mcp__plugin_tenjin_router__subagent_activity', parameters: schema })}</function>\n</functions>`,
        },
      ],
    },
  ]);
  expect(JSON.stringify(result)).not.toMatch(/tool_reference|defer_loading/);
});

it('refuses a request that offers more tools than the router takes, counting only the tools it sends', () => {
  // The failure: the router refuses a request over its cap, so every model call of the job failed.
  const tool = (n: number, deferred = false) => ({
    name: `mcp__many__tool_${n}`,
    input_schema: { type: 'object' },
    ...(deferred ? { defer_loading: true } : {}),
  });
  const request = (tools: unknown[]) => ({ model: 'deepseek-flash', tools, messages: [] });
  expect(() => workerMessages(request(Array.from({ length: 257 }, (_, n) => tool(n))))).toThrow(
    expect.objectContaining({ count: 257 }),
  );
  // Tool search on: a deferred tool nothing loaded is not sent, so it does not count.
  const sent = workerMessages(
    request([
      ...Array.from({ length: 256 }, (_, n) => tool(n)),
      ...Array.from({ length: 300 }, (_, n) => tool(1000 + n, true)),
    ]),
  );
  expect(sent.tools).toHaveLength(256);
});

// Live case (job fd128c49, Claude Code 2.1.327): two tools of an MCP server that connected
// after the first request were announced in a system message. The router refused the next
// request with 400 `invalid_model_request`, and the job ended after 2 tool uses.
it('applies a tool change announced in a message to the tools it offers, and sends no tool change block', () => {
  const tool = (name: string, deferred = false) => ({
    name,
    description: `${name} description`,
    input_schema: { type: 'object' },
    ...(deferred ? { defer_loading: true } : {}),
  });
  const announced =
    'The following tools just became available and are ready to use:\nmcp__docs__search\nmcp__docs__read';
  const result = workerMessages({
    model: 'deepseek-flash',
    tools: [
      tool('Bash'),
      tool('mcp__docs__search', true),
      tool('DeferredToolPlaceholder', true),
      tool('mcp__docs__read', true),
    ],
    messages: [
      { role: 'user', content: 'Find the pinned version.' },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'call_1', name: 'Bash', input: { command: 'ls' } }],
      },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'ok' }] },
      {
        role: 'system',
        content: [
          { type: 'text', text: announced },
          { type: 'tool_addition', tool: { type: 'tool_reference', name: 'mcp__docs__search' } },
          {
            type: 'tool_addition',
            tool: { type: 'tool_reference', name: 'mcp__docs__read' },
            cache_control: { type: 'ephemeral' },
          },
        ],
      },
    ],
  });
  expect(result.tools?.map((t) => t.name)).toEqual([
    'Bash',
    'mcp__docs__search',
    'mcp__docs__read',
  ]);
  expect((result.messages as unknown[]).at(-1)).toEqual({
    role: 'system',
    content: [{ type: 'text', text: announced }],
  });
  expect(JSON.stringify(result)).not.toContain('tool_addition');
});

it('offers a tool defined in a tool change, stops offering a removed one, and sends no message of changes alone', () => {
  const schema = { type: 'object', properties: { query: { type: 'string' } } };
  const result = workerMessages({
    model: 'deepseek-flash',
    tools: [
      { name: 'Bash', input_schema: { type: 'object' } },
      { name: 'Monitor', input_schema: { type: 'object' } },
    ],
    messages: [
      { role: 'user', content: 'Search the notes.' },
      {
        role: 'system',
        content: [
          {
            type: 'tool_addition',
            tool: {
              type: 'tool_definition',
              definition: {
                name: 'mcp__notes__search',
                description: 'Search',
                input_schema: schema,
              },
            },
          },
          { type: 'tool_removal', tool: { type: 'tool_reference', name: 'Monitor' } },
        ],
      },
    ],
  });
  expect(result.tools).toEqual([
    { name: 'Bash', input_schema: { type: 'object' } },
    { name: 'mcp__notes__search', description: 'Search', input_schema: schema },
  ]);
  expect(result.messages).toEqual([{ role: 'user', content: 'Search the notes.' }]);
  // A change the bridge cannot apply fails this request alone, before anything is sent.
  expect(() =>
    workerMessages({
      model: 'deepseek-flash',
      messages: [
        {
          role: 'system',
          content: [{ type: 'tool_addition', tool: { type: 'web_search_20250305' } }],
        },
      ],
    }),
  ).toThrow();
});
