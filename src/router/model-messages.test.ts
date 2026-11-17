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
