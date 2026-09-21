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
        amountAtomic: '1000',
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

test('URL-labeled Markdown links cite their actual destinations', () => {
  const input = fixture();
  for (const text of [
    '[https://docs.example/protocol](https://docs.example/protocol)',
    '[https://docs.example/protocol](<https://docs.example/protocol>)',
    '[https://docs.example/protocol](https://docs.example/protocol "Protocol guide")',
  ]) {
    input.events.at(-1).result = text;
    assert.equal(checkDemo(input).checks.citesSource, true);
    assert.deepEqual(httpUrls(text), ['https://docs.example/protocol']);
  }
  assert.deepEqual(httpUrls('[Article](https://example.com/Article_(topic))'), [
    'https://example.com/Article_(topic)',
  ]);
});

test('a returned URL in a misleading Markdown label is not a citation to that URL', () => {
  const input = fixture();
  for (const destination of [
    'https://unrelated.example/',
    'https://docs.example.evil/protocol',
    'https://docs.example/protocol-invented',
    'mailto:reader@example.com',
    'javascript:alert(1)',
  ]) {
    input.events.at(-1).result = `[https://docs.example/protocol](${destination})`;
    assert.equal(checkDemo(input).checks.citesSource, false);
  }
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

test('paired inline-code URL wrappers preserve exact citation destinations', () => {
  const input = fixture();
  for (const text of [
    '`https://docs.example/protocol`',
    'Source: `https://docs.example/protocol`.',
    '``https://docs.example/protocol``',
    '````https://docs.example/protocol````',
  ]) {
    input.events.at(-1).result = text;
    assert.equal(checkDemo(input).checks.citesSource, true);
    assert.deepEqual(httpUrls(text), ['https://docs.example/protocol']);
  }
  for (const destination of [
    'https://docs.example.evil/protocol',
    'https://docs.example/protocol-invented',
  ]) {
    input.events.at(-1).result = '`' + destination + '`';
    assert.equal(checkDemo(input).checks.citesSource, false);
  }
});

test('inline-code parsing does not strip genuine URL backticks or mismatched delimiters', () => {
  for (const [text, url] of [
    ['https://docs.example/path`', 'https://docs.example/path`'],
    ['https://docs.example/part`one`two', 'https://docs.example/part`one`two'],
    ['`https://docs.example/path``', 'https://docs.example/path``'],
    ['``https://docs.example/path`', 'https://docs.example/path`'],
    ['\\`https://docs.example/path`', 'https://docs.example/path`'],
    ['``https://docs.example/part`one``', 'https://docs.example/part`one'],
  ])
    assert.deepEqual(httpUrls(text), [url.replaceAll('`', '%60')]);
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

test('auto mode keeps single-call outcomes backward compatible', () => {
  for (const tool of ['WebSearch', 'WebFetch']) {
    const input = fixture();
    input.tool = 'auto';
    input.events[1].message.content[0].name = tool;
    const result = checkDemo(input);
    assert.equal(Object.values(result.checks).every(Boolean), true);
    assert.equal(result.observedTool, tool);
  }
});

test('auto mode rejects unrelated tools and no call', () => {
  const input = fixture();
  input.tool = 'auto';
  input.events[1].message.content[0].name = 'Bash';
  assert.equal(checkDemo(input).checks.boundedToolCalls, false);
  assert.equal(checkDemo(input).observedTool, 'Bash');
  input.events[1].message.content = [];
  assert.equal(checkDemo(input).checks.boundedToolCalls, false);
  assert.equal(checkDemo(input).observedTool, undefined);
});

test('explicit tool mode still rejects the other permitted native tool', () => {
  const input = fixture();
  input.events[1].message.content[0].name = 'WebFetch';
  assert.equal(checkDemo(input).checks.oneToolCall, false);
  input.tool = 'WebFetch';
  assert.equal(Object.values(checkDemo(input).checks).every(Boolean), true);
});

function multipleFixture(count = 3) {
  const input = fixture();
  const template = input.outcome;
  delete input.outcome;
  input.tool = 'auto';
  input.events[1].message.content = [];
  input.events[2].message.content = [];
  input.outcomesByToolUseId = {};
  for (let index = 1; index <= count; index++) {
    const id = `call-${index}`;
    input.events[1].message.content.push({
      type: 'tool_use',
      id,
      name: index === 1 ? 'WebSearch' : 'WebFetch',
    });
    input.events[2].message.content.push({ type: 'tool_result', tool_use_id: id, is_error: true });
    const outcome = globalThis.structuredClone(template);
    outcome.selected = {
      url: `https://provider.example/${index}`,
      args:
        index === 1
          ? { query: 'protocol documentation' }
          : { url: `https://docs.example/${index}` },
    };
    outcome.execution.amountAtomic = index === 1 ? '7000' : '10000';
    outcome.execution.settlement = { status: 'reported', transaction: `transaction-${index}` };
    outcome.execution.response.body = JSON.stringify({
      sourceURL: `https://docs.example/${index}`,
    });
    input.outcomesByToolUseId[id] = outcome;
  }
  input.events.at(-1).result = `[Later source](https://docs.example/${count})`;
  return input;
}

test('auto validates every delivered call, later citations, per-call receipts and unique total cost', () => {
  const result = checkDemo(multipleFixture());
  assert.equal(Object.values(result.checks).every(Boolean), true);
  assert.equal(result.observedTool, undefined);
  assert.deepEqual(result.observedTools, ['WebSearch', 'WebFetch']);
  assert.deepEqual(result.citedReturnedUrls, ['https://docs.example/3']);
  assert.equal(result.totalAmountAtomic, '27000');
  assert.equal(result.perCallOutcomes.length, 3);
  assert.deepEqual(
    result.perCallOutcomes.map((call) => call.toolUseId),
    ['call-1', 'call-2', 'call-3'],
  );
  assert.equal(result.perCallOutcomes[2].provider, 'https://provider.example/3');
  assert.deepEqual(result.perCallOutcomes[2].args, { url: 'https://docs.example/3' });
  assert.deepEqual(result.perCallOutcomes[2].settlement, {
    status: 'reported',
    transaction: 'transaction-3',
  });
});

test('auto bounds the workflow at eight calls while explicit mode remains one call', () => {
  assert.equal(Object.values(checkDemo(multipleFixture(8)).checks).every(Boolean), true);
  assert.equal(checkDemo(multipleFixture(9)).checks.boundedToolCalls, false);
  const input = multipleFixture(2);
  input.tool = 'WebSearch';
  assert.equal(checkDemo(input).checks.oneToolCall, false);
});

test('one failed outcome or HTTP failure fails the entire workflow', () => {
  const input = multipleFixture();
  input.outcomesByToolUseId['call-3'].status = 'failed';
  assert.equal(checkDemo(input).checks.executorFulfilled, false);
  assert.equal(checkDemo(input).checks.citesSource, false);
  input.outcomesByToolUseId['call-3'].status = 'fulfilled';
  input.outcomesByToolUseId['call-3'].execution.response.status = 503;
  assert.equal(checkDemo(input).checks.providerReturned, false);
  assert.equal(checkDemo(input).checks.citesSource, false);
});

test('missing per-call outcomes never inherit a single-call outcome or unrelated cached result', () => {
  const input = multipleFixture();
  input.outcome = input.outcomesByToolUseId['call-2'];
  delete input.outcomesByToolUseId['call-2'];
  input.outcomesByToolUseId['other-run-call'] = input.outcome;
  const result = checkDemo(input);
  assert.equal(result.checks.outcomesMatched, false);
  assert.equal(result.checks.executorFulfilled, false);
  assert.equal(result.totalAmountAtomic, undefined);
  input.events.at(-1).result = 'Source https://docs.example/2';
  assert.equal(checkDemo(input).checks.citesSource, false);
});

test('every native result must be a denial for the exact corresponding ID', () => {
  for (const mutate of [
    (input) => {
      input.events[2].message.content[1].tool_use_id = 'wrong-call';
    },
    (input) => {
      input.events[2].message.content[1].is_error = false;
    },
    (input) => {
      input.events[2].message.content.pop();
    },
    (input) => {
      input.events[2].message.content[1].tool_use_id = 'call-1';
    },
    (input) => {
      input.events[2].message.content.push({
        type: 'tool_result',
        tool_use_id: 'extra-call',
        is_error: true,
      });
    },
  ]) {
    const input = multipleFixture();
    mutate(input);
    assert.equal(checkDemo(input).checks.nativeSuppressed, false);
  }
});

test('duplicate call IDs fail validation and cached repeats are never counted as an additional charge', () => {
  const input = multipleFixture();
  input.events[1].message.content.push({ type: 'tool_use', name: 'WebFetch', id: 'call-3' });
  input.events[2].message.content.push({
    type: 'tool_result',
    tool_use_id: 'call-3',
    is_error: true,
  });
  input.outcomesByToolUseId['call-3'].execution.cached = true;
  const result = checkDemo(input);
  assert.equal(result.checks.uniqueToolCalls, false);
  assert.equal(result.checks.nativeSuppressed, false);
  assert.equal(result.totalAmountAtomic, '27000');
  assert.equal(result.perCallOutcomes.length, 3);
  assert.equal(result.perCallOutcomes[2].cached, true);
});

test('unknown or malformed costs cannot produce a claimed total', () => {
  for (const amount of [undefined, '-1', '1.5', 'Infinity', '1'.repeat(81)]) {
    const input = multipleFixture();
    input.outcomesByToolUseId['call-2'].execution.amountAtomic = amount;
    const result = checkDemo(input);
    assert.equal(result.checks.amountsValid, false);
    assert.equal(result.totalAmountAtomic, undefined);
  }
});
