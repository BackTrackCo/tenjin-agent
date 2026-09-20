import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inspectProbe, inspectFailureProbe } from './auto-mode-headless-probe.mjs';

const expected = {
  tool: 'WebSearch',
  token: 'opaque-random-code',
  url: 'https://example.com/source',
};
const calls = [{ tool_name: 'WebSearch', transcriptUserMessages: 1 }];
const assistant = {
  type: 'assistant',
  message: { content: [{ type: 'tool_use', name: 'WebSearch' }] },
};
const denied = {
  type: 'user',
  message: { content: [{ type: 'tool_result', is_error: true, content: 'blocked' }] },
};
const result = {
  type: 'result',
  subtype: 'success',
  result: `${expected.token} [Source](${expected.url})`,
  total_cost_usd: 0.01,
};

test('transport evidence requires a denied native call and a final source citation', () => {
  assert.equal(inspectProbe([assistant, denied, result], calls, expected).passed, true);
  assert.equal(
    inspectProbe(
      [
        assistant,
        { ...denied, message: { content: [{ type: 'tool_result', is_error: false }] } },
        result,
      ],
      calls,
      expected,
    ).passed,
    false,
  );
  assert.equal(
    inspectProbe([assistant, denied, { ...result, result: expected.token }], calls, expected)
      .passed,
    false,
  );
});

test('a duplicate tool attempt or missing hook invocation fails the transport gate', () => {
  assert.equal(inspectProbe([assistant, assistant, denied, result], calls, expected).passed, false);
  assert.equal(inspectProbe([assistant, denied, result], [], expected).passed, false);
  assert.equal(
    inspectProbe(
      [assistant, denied, result],
      [{ tool_name: 'WebSearch', transcriptUserMessages: 0 }],
      expected,
    ).passed,
    false,
  );
});

test('the observed model must match the explicitly requested model', () => {
  const events = [
    { type: 'system', subtype: 'init', model: 'claude-sonnet-5' },
    assistant,
    denied,
    result,
  ];
  expectModel(events, 'sonnet', true);
  expectModel(events, 'haiku', false);
  function expectModel(stream, model, passed) {
    assert.equal(inspectProbe(stream, calls, { ...expected, model }).passed, passed);
  }
});

test('failed-hook protection requires a real hook failure and denies native success', () => {
  const events = [
    { type: 'system', subtype: 'init', model: 'claude-haiku-4-5' },
    { type: 'system', subtype: 'hook_response', hook_event: 'PreToolUse', outcome: 'error' },
    {
      type: 'assistant',
      message: { content: [{ type: 'tool_use', name: 'WebSearch', id: 'call-1' }] },
    },
    {
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 'call-1', is_error: true }] },
    },
    { type: 'result', subtype: 'success', result: 'The tool could not run.' },
  ];
  const execution = { code: 0, timedOut: false };
  assert.equal(inspectFailureProbe(events, execution, 'haiku', 'WebSearch').passed, true);
  events[3].message.content[0].is_error = false;
  assert.equal(inspectFailureProbe(events, execution, 'haiku', 'WebSearch').passed, false);
  events[3].message.content[0].is_error = true;
  events[1].outcome = 'success';
  assert.equal(inspectFailureProbe(events, execution, 'haiku', 'WebSearch').passed, false);
});
