import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkBridgeDemo } from './auto-mode-bridge-checks.mjs';
import { previewResult } from '../src/experimental/auto-mode/result-preview.ts';

function fixture(count = 2) {
  const input = {
    model: 'sonnet',
    sessionId: 'bridge-session',
    execution: { code: 0, timedOut: false },
    events: [
      {
        type: 'system',
        subtype: 'init',
        session_id: 'bridge-session',
        model: 'claude-sonnet-4-6',
        permissionMode: 'auto',
      },
    ],
    outcomes: [],
  };
  for (let index = 1; index <= count; index += 1) {
    const toolUseId = `call-${index}`;
    const provider = `https://provider.example/service-${index}`;
    const args =
      index === 1
        ? { body: { query: 'protocol documentation' } }
        : { body: { url: `https://docs.example/${index}` } };
    const amountAtomic = index === 1 ? '7000' : '10000';
    const settlement = {
      status: 'unverified',
      reason: 'Independent settlement verification unavailable.',
    };
    const result = { url: `https://docs.example/${index}`, content: `Document ${index}` };
    const envelope = {
      status: 'fulfilled',
      provider,
      parameters: args,
      parametersTruncated: false,
      httpStatus: 200,
      amountAtomic,
      cached: false,
      settlement,
      result: JSON.stringify(result),
      resultFormat: 'json',
      truncated: false,
      providerContentUntrusted: true,
      fixture: false,
    };
    input.events.push(
      {
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: toolUseId,
              name: index === 1 ? 'mcp__x402__search' : 'mcp__x402__fetch',
              input:
                index === 1
                  ? { query: 'protocol documentation' }
                  : { url: `https://docs.example/${index}` },
            },
          ],
        },
      },
      {
        type: 'user',
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: toolUseId,
              is_error: false,
              content: [
                {
                  type: 'text',
                  text: `Fulfilled by provider.example · ${JSON.stringify(args)} · $${index === 1 ? '0.007' : '0.01'} USDC`,
                },
                { type: 'text', text: JSON.stringify(envelope) },
              ],
            },
          ],
        },
      },
    );
    input.outcomes.push({
      event: {
        session_id: 'bridge-session',
        tool_use_id: toolUseId,
        tool_name: index === 1 ? 'WebSearch' : 'WebFetch',
      },
      outcome: {
        status: 'fulfilled',
        selected: { url: provider, args },
        execution: {
          status: 'fulfilled',
          amountAtomic,
          cached: false,
          settlement,
          response: { status: 200, body: JSON.stringify(result) },
        },
      },
    });
  }
  input.events.push({
    type: 'result',
    subtype: 'success',
    session_id: 'bridge-session',
    result: `Here is the answer. [Source](https://docs.example/${count}#details)`,
  });
  return input;
}

function toolResult(input, index = 0) {
  return input.events[2 + index * 2].message.content[0];
}

function updateEnvelope(input, update, index = 0) {
  const block = toolResult(input, index).content[1];
  const envelope = JSON.parse(block.text);
  update(envelope);
  block.text = JSON.stringify(envelope);
}

test('accepts two real bridge calls in auto mode with matching current receipts and provenance', () => {
  const result = checkBridgeDemo(fixture());
  assert.equal(result.passed, true);
  assert.equal(result.corePassed, true);
  assert.equal(result.totalAmountAtomic, '17000');
  assert.deepEqual(result.observedTools, ['mcp__x402__search', 'mcp__x402__fetch']);
  assert.deepEqual(result.citedReturnedUrls, ['https://docs.example/2']);
  assert.deepEqual(
    result.perCallOutcomes.map((call) => call.toolUseId),
    ['call-1', 'call-2'],
  );
  assert.equal(result.perCallOutcomes[1].provider, 'https://provider.example/service-2');
  assert.deepEqual(result.perCallOutcomes[1].args, { body: { url: 'https://docs.example/2' } });
  assert.equal(result.perCallOutcomes[1].settlement.status, 'unverified');
});

test('supports the requested Haiku alias and a coalesced receipt/envelope string', () => {
  const input = fixture(1);
  input.model = 'haiku';
  input.events[0].model = 'claude-haiku-4-5';
  toolResult(input).content = toolResult(input)
    .content.map((block) => block.text)
    .join('\n');
  assert.equal(checkBridgeDemo(input).passed, true);
});

test('accepts the observed synthetic fixture prefix and omitted cached field without claiming payment', () => {
  const input = fixture(1);
  const outcome = input.outcomes[0].outcome;
  outcome.fixture = true;
  outcome.execution.amountAtomic = '0';
  delete outcome.execution.cached;
  toolResult(input).content[0].text =
    `SYNTHETIC FIXTURE; no payment · Fulfilled by provider.example · ${JSON.stringify(outcome.selected.args)} · $0 USDC`;
  updateEnvelope(input, (value) => {
    value.fixture = true;
    value.amountAtomic = '0';
    delete value.cached;
  });
  const result = checkBridgeDemo(input);
  assert.equal(result.passed, true);
  assert.equal(result.totalAmountAtomic, '0');
  delete outcome.fixture;
  assert.equal(checkBridgeDemo(input).passed, false);
});

test('fails auto-mode fallback, wrong model, process failure and mismatched session identities', () => {
  for (const [gate, mutate] of [
    [
      'autoPermissionMode',
      (input) => {
        input.events[0].permissionMode = 'dontAsk';
      },
    ],
    [
      'autoPermissionMode',
      (input) => {
        delete input.events[0].permissionMode;
      },
    ],
    [
      'requestedModel',
      (input) => {
        input.events[0].model = 'claude-haiku-4-5';
      },
    ],
    [
      'processExited',
      (input) => {
        input.execution.code = 1;
      },
    ],
    [
      'processExited',
      (input) => {
        input.execution.timedOut = true;
      },
    ],
    [
      'processExited',
      (input) => {
        delete input.execution;
      },
    ],
    [
      'sessionMatched',
      (input) => {
        input.events.at(-1).session_id = 'old-session';
      },
    ],
    [
      'sessionMatched',
      (input) => {
        input.outcomes[0].event.session_id = 'old-session';
      },
    ],
  ]) {
    const input = fixture();
    mutate(input);
    assert.equal(checkBridgeDemo(input).checks[gate], false, gate);
    assert.equal(checkBridgeDemo(input).passed, false);
  }
});

test('rejects native tool leaks, other tools, duplicate IDs and calls outside the bound', () => {
  const native = fixture();
  native.events[1].message.content[0].name = 'WebSearch';
  assert.equal(checkBridgeDemo(native).checks.noNativeTools, false);
  assert.equal(checkBridgeDemo(native).checks.boundedBridgeCalls, false);
  native.events[1].message.content[0].name = 'Bash';
  assert.equal(checkBridgeDemo(native).checks.boundedBridgeCalls, false);
  const duplicate = fixture();
  duplicate.events[3].message.content[0].id = 'call-1';
  assert.equal(checkBridgeDemo(duplicate).checks.uniqueToolCalls, false);
  assert.equal(checkBridgeDemo(duplicate).totalAmountAtomic, undefined);
  assert.equal(checkBridgeDemo(fixture(0)).checks.boundedBridgeCalls, false);
  assert.equal(checkBridgeDemo(fixture(8)).passed, true);
  assert.equal(checkBridgeDemo(fixture(9)).checks.boundedBridgeCalls, false);
});

test('every actual tool call needs one successful result with the exact same ID', () => {
  for (const mutate of [
    (input) => {
      toolResult(input).is_error = true;
    },
    (input) => {
      toolResult(input).tool_use_id = 'wrong-call';
    },
    (input) => {
      toolResult(input, 1).tool_use_id = 'call-1';
    },
    (input) => {
      input.events.splice(2, 1);
    },
    (input) => {
      input.events[2].message.content.push(globalThis.structuredClone(toolResult(input)));
    },
  ]) {
    const input = fixture();
    mutate(input);
    assert.equal(checkBridgeDemo(input).checks.toolResultsSucceeded, false);
    assert.equal(checkBridgeDemo(input).passed, false);
  }
});

test('missing current outcomes never inherit historical receipts or URLs', () => {
  const input = fixture();
  input.outcomes[1].event.tool_use_id = 'previous-turn-call';
  const result = checkBridgeDemo(input);
  assert.equal(result.checks.outcomesMatched, false);
  assert.equal(result.checks.citesSource, false);
  assert.equal(result.totalAmountAtomic, undefined);
  const extra = fixture();
  extra.outcomes.push({
    ...globalThis.structuredClone(extra.outcomes[0]),
    event: { session_id: 'bridge-session', tool_use_id: 'previous-turn-call' },
  });
  assert.equal(checkBridgeDemo(extra).checks.outcomesMatched, false);
});

test('a resumed current turn passes with only its new stream calls and current per-event outcome', () => {
  const input = fixture(1);
  input.events[1].message.content[0].id = 'second-turn-call';
  toolResult(input).tool_use_id = 'second-turn-call';
  input.outcomes[0].event.tool_use_id = 'second-turn-call';
  assert.equal(checkBridgeDemo(input).passed, true);
  input.outcomes[0].event.tool_use_id = 'first-turn-call';
  assert.equal(checkBridgeDemo(input).passed, false);
});

test('a success-looking tool receipt cannot replace actual fulfillment, body or selected arguments', () => {
  for (const [gate, mutate] of [
    [
      'executorFulfilled',
      (input) => {
        input.outcomes[0].outcome.status = 'failed';
      },
    ],
    [
      'executorFulfilled',
      (input) => {
        input.outcomes[0].outcome.execution.status = 'ambiguous';
      },
    ],
    [
      'providerReturned',
      (input) => {
        input.outcomes[0].outcome.execution.response.status = 503;
      },
    ],
    [
      'providerReturned',
      (input) => {
        input.outcomes[0].outcome.execution.response.body = '';
      },
    ],
    [
      'selectedRequestPresent',
      (input) => {
        delete input.outcomes[0].outcome.selected.args;
      },
    ],
    [
      'selectedRequestPresent',
      (input) => {
        input.outcomes[0].outcome.selected.url = 'https://user:secret@provider.example/';
      },
    ],
  ]) {
    const input = fixture();
    mutate(input);
    assert.equal(checkBridgeDemo(input).checks[gate], false, gate);
    assert.equal(checkBridgeDemo(input).passed, false);
  }
});

test('requires the visible service receipt and a matching bounded provider envelope', () => {
  for (const mutate of [
    (input) => {
      toolResult(input).content.shift();
    },
    (input) => {
      toolResult(input).content[0].text = 'Fulfilled by wrong.example · {} · $0.007 USDC';
    },
    (input) => {
      toolResult(input).content[0].text = 'Fulfilled by provider.example · {} · $0.07 USDC';
    },
    (input) => {
      toolResult(input).content[0].text =
        'Fulfilled by provider.example · {"wrong":"parameters"} · $0.007 USDC';
    },
    (input) => {
      updateEnvelope(input, (value) => {
        value.provider = 'https://other.example/';
      });
    },
    (input) => {
      updateEnvelope(input, (value) => {
        value.parameters = { body: { query: 'different request' } };
      });
    },
    (input) => {
      updateEnvelope(input, (value) => {
        value.amountAtomic = '999';
      });
    },
    (input) => {
      updateEnvelope(input, (value) => {
        value.providerContentUntrusted = false;
      });
    },
    (input) => {
      updateEnvelope(input, (value) => {
        delete value.result;
      });
    },
    (input) => {
      updateEnvelope(input, (value) => {
        value.result = JSON.stringify({ fabricated: 'content absent from the saved response' });
      });
    },
    (input) => {
      toolResult(input).content.push(globalThis.structuredClone(toolResult(input).content[1]));
    },
  ]) {
    const input = fixture();
    mutate(input);
    assert.equal(checkBridgeDemo(input).passed, false);
  }
});

test('opaque hook tokens are not required, echoed, or included in the report', () => {
  const input = fixture();
  const token = 'opaque-private-bridge-token';
  input.events[1].message.content[0].input._receipt = token;
  input.outcomes[0].event.tool_input = { _receipt: token };
  assert.equal(checkBridgeDemo(input).passed, true);
  assert.equal(JSON.stringify(checkBridgeDemo(input)).includes(token), false);
  toolResult(input).content.push({ type: 'text', text: token });
  assert.equal(checkBridgeDemo(input).checks.noReceiptTokenLeak, false);
  toolResult(input).content.pop();
  updateEnvelope(input, (value) => {
    value._receipt = 'unexpected-private-metadata';
  });
  assert.equal(checkBridgeDemo(input).checks.noReceiptTokenLeak, false);
});

test('accepts only the canonical bounded preview of a long provider response', () => {
  const input = fixture(1);
  const body = JSON.stringify({
    url: 'https://docs.example/1',
    sections: Array.from({ length: 30 }, (_, index) => ({
      title: `Part ${index}`,
      text: 'Long document content. '.repeat(100),
    })),
  });
  input.outcomes[0].outcome.execution.response.body = body;
  const preview = previewResult(body, 6000);
  assert.equal(preview.truncated, true);
  updateEnvelope(input, (value) => {
    value.result = preview.result;
    value.resultFormat = preview.format;
    value.truncated = preview.truncated;
    value.previewNote = preview.note;
  });
  assert.equal(checkBridgeDemo(input).passed, true);
  updateEnvelope(input, (value) => {
    value.result = value.result.replace('Part 0', 'False claim');
  });
  assert.equal(checkBridgeDemo(input).checks.deliveredEnvelopeMatched, false);
});

test('verifies the 220-codepoint receipt header while preserving full structured parameters', () => {
  const input = fixture(1);
  const parameters = { body: { query: '😀'.repeat(180) } };
  input.outcomes[0].outcome.selected.args = parameters;
  updateEnvelope(input, (value) => {
    value.parameters = parameters;
  });
  const leading = 'Fulfilled by provider.example · ';
  const trailing = ' · $0.007 USDC';
  const chars = Array.from(JSON.stringify(parameters));
  const budget = 220 - Array.from(leading + trailing).length;
  toolResult(input).content[0].text =
    leading + chars.slice(0, budget - 1).join('') + '…' + trailing;
  assert.equal(Array.from(toolResult(input).content[0].text).length, 220);
  assert.equal(checkBridgeDemo(input).passed, true);
  toolResult(input).content[0].text = toolResult(input).content[0].text.replace('😀', 'X');
  assert.equal(checkBridgeDemo(input).checks.receiptsRendered, false);
});

test('reports missing or misleading citations separately without relaxing overall pass', () => {
  const input = fixture();
  input.events.at(-1).result = 'Here is the answer without a source.';
  assert.equal(checkBridgeDemo(input).corePassed, true);
  assert.equal(checkBridgeDemo(input).passed, false);
  input.events.at(-1).result = '[https://docs.example/2](https://unrelated.example/)';
  assert.equal(checkBridgeDemo(input).checks.citesSource, false);
  input.events.at(-1).result =
    '[Good](https://docs.example/2) and [Invented](https://unrelated.example/)';
  assert.equal(checkBridgeDemo(input).checks.citesSource, true);
  assert.equal(checkBridgeDemo(input).checks.citationDestinationsValid, false);
  input.events.at(-1).result = '[Supplying service](https://provider.example/service-2)';
  assert.equal(checkBridgeDemo(input).passed, true);
});

test('requires an actual final answer and refuses malformed payment amounts', () => {
  const input = fixture();
  input.events.at(-1).result = '';
  assert.equal(checkBridgeDemo(input).checks.finalAnswerPresent, false);
  for (const amount of [undefined, '-1', '1.5', 'Infinity', '1'.repeat(81)]) {
    const invalid = fixture();
    invalid.outcomes[0].outcome.execution.amountAtomic = amount;
    const result = checkBridgeDemo(invalid);
    assert.equal(result.checks.amountsValid, false);
    assert.equal(result.totalAmountAtomic, undefined);
  }
});
