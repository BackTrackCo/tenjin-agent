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
