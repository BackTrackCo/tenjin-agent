import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkDemo, httpUrls } from './auto-mode-demo-checks.mjs';

function fixture() {
  return {
    model: 'haiku',
    tool: 'WebSearch',
    sessionId: 'session-test',
    execution: { code: 0, timedOut: false },
    events: [
      { type: 'system', subtype: 'init', model: 'claude-haiku-4-5', session_id: 'session-test' },
      {
        type: 'assistant',
        message: { content: [{ type: 'tool_use', name: 'WebSearch', id: 'call-1' }] },
      },
      {
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: 'call-1', is_error: true }] },
      },
      {
        type: 'result',
        subtype: 'success',
        session_id: 'session-test',
        result: '[Source](https://docs.example/protocol#payments)',
      },
    ],
    outcome: {
      status: 'fulfilled',
      execution: {
        response: {
          status: 200,
          body: JSON.stringify({ results: [{ url: 'https://docs.example/protocol' }] }),
        },
      },
    },
  };
}

test('accepts a returned result URL including a section anchor', () => {
  const result = checkDemo(fixture());
  assert.equal(Object.values(result.checks).every(Boolean), true);
  assert.deepEqual(result.citedReturnedUrls, ['https://docs.example/protocol']);
});

test('a bold bare URL cites the returned canonical URL without weakening host matching', () => {
  const input = fixture();
  input.outcome.execution.response.body = JSON.stringify({ sourceURL: 'https://example.com/' });
  input.events.at(-1).result = '**https://example.com** is a simple, standardized domain.';
  assert.equal(checkDemo(input).checks.citesSource, true);
  assert.deepEqual(checkDemo(input).citedReturnedUrls, ['https://example.com/']);
  for (const url of [
    'https://example.com.evil/',
    'https://example.com/other',
    'https://example.com@evil.example/',
  ]) {
    input.events.at(-1).result = `**${url}** is the source.`;
    assert.equal(checkDemo(input).checks.citesSource, false);
  }
  assert.deepEqual(httpUrls('https://example.com/path*'), ['https://example.com/path*']);
});

test('unrelated, host-suffix, or merely prefix-sharing citations do not pass', () => {
  for (const url of [
    'https://other.example/',
    'https://docs.example.evil/protocol',
    'https://docs.example/protocol-invented',
  ]) {
    const input = fixture();
    input.events.at(-1).result = `Could not fetch that, try ${url}`;
    assert.equal(checkDemo(input).checks.citesSource, false);
  }
});

test('supports generic text or nested Markdown provider results', () => {
  const input = fixture();
  input.outcome.execution.response.body = 'See [Protocol](https://docs.example/protocol).';
  assert.equal(checkDemo(input).checks.citesSource, true);
  assert.deepEqual(
    httpUrls({
      data: ['https://example.com/Article_(topic)', 'https://example.com/Article_(topic)'],
    }),
    ['https://example.com/Article_(topic)'],
  );
});

test('numeric API data can cite the exact endpoint that supplied it', () => {
  const input = fixture();
  input.outcome.selected = { url: 'https://data.example/market' };
  input.outcome.execution.response.body = JSON.stringify({ value: 42, classification: 'neutral' });
  input.events.at(-1).result = 'Value: 42 ([source](https://data.example/market)).';
  assert.equal(checkDemo(input).checks.citesSource, true);
  input.events.at(-1).result = 'Value: 42 ([source](https://data.example/other)).';
  assert.equal(checkDemo(input).checks.citesSource, false);
});

test('a success result cannot mask timeout, nonzero process exit, or stale session output', () => {
  const input = fixture();
  input.execution.timedOut = true;
  assert.equal(checkDemo(input).checks.completed, false);
  input.execution.timedOut = false;
  input.execution.code = 1;
  assert.equal(checkDemo(input).checks.completed, false);
  input.execution.code = 0;
  input.events.at(-1).session_id = 'other-session';
  assert.equal(checkDemo(input).checks.sessionMatched, false);
});

test('denial must belong to this tool call and the model must match explicitly', () => {
  const input = fixture();
  input.events[2].message.content[0].tool_use_id = 'unrelated-call';
  assert.equal(checkDemo(input).checks.nativeSuppressed, false);
  input.events[0].model = 'claude-sonnet-5';
  assert.equal(checkDemo(input).checks.requestedModel, false);
});
