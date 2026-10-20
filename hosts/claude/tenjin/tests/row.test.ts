import { expect, test } from 'claude-code/testing';

import {
  DATA,
  MODEL_TEXT,
  SURFACES,
  TOOL,
  keepSpec,
  machine,
  recordPayment,
  resultText,
  rowText,
  shownLines,
  toolRow,
} from './fixtures';

const OFFER = 'b920ff14-5aed-4a50-8c25-240e871602f3';
const INPUT = { query: 'rust async runtimes', numResults: 5 };
const EXA = {
  capabilityId: 'exa-search',
  label: 'Exa search',
  priceAtomic: '40000',
  maxAmountAtomic: '40000',
};

test('a paid row is one line: the label, the query and the price, then the amount paid', async ($, on) => {
  const { files, toasts, logs } = machine(on);
  await keepSpec(files, OFFER, EXA);
  on('tool.call', { tool: TOOL }, async () => {
    await recordPayment(files, OFFER, {
      capabilityId: 'exa-search',
      amountAtomic: '40000',
      txHash: '0xc9fc',
    });
    return { result: resultText('fulfilled'), text: resultText('fulfilled') };
  });
  const row = toolRow('toolu_paid', TOOL, { id: OFFER, input: INPUT });

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ plugin: 'tenjin', surface, component: 'ToolUse', props: row });
    expect(await rowText(ui)).toBe('Calling Exa search(rust async runtimes)… · $0.04');
    await ui.unmount();
  }

  await $.tool.call({ tool: TOOL, tool_use_id: 'toolu_paid', id: OFFER, input: INPUT });
  // The settle toast, and no transcript line: the row says it.
  expect(toasts).toEqual(['Exa search · $0.04']);
  expect(logs).toEqual([]);

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({
      plugin: 'tenjin',
      surface,
      component: 'ToolUse',
      props: { ...row, isRunning: false, output: resultText('fulfilled') },
    });
    const line = await rowText(ui);
    expect(line).toBe('Exa search(rust async runtimes) · $0.04');
    expect([line, ...toasts].join('\n')).not.toMatch(MODEL_TEXT);
    await ui.unmount();
  }
});

test('a payment whose settlement is unknown reads as paid', async ($, on) => {
  const { files, logs } = machine(on);
  await keepSpec(files, OFFER, EXA);
  on('tool.call', { tool: TOOL }, async () => {
    await recordPayment(files, OFFER, {
      capabilityId: 'exa-search',
      amountAtomic: '40000',
      txHash: '0xd00d',
      settlement: 'unknown',
    });
    return { result: resultText('fulfilled'), text: resultText('fulfilled') };
  });
  await $.tool.call({ tool: TOOL, tool_use_id: 'toolu_unknown', id: OFFER, input: INPUT });
  expect(logs).toEqual([]);
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({
      plugin: 'tenjin',
      surface,
      component: 'ToolUse',
      props: {
        ...toolRow('toolu_unknown', TOOL, { id: OFFER, input: INPUT }),
        isRunning: false,
        output: resultText('fulfilled'),
      },
    });
    expect(await rowText(ui)).toBe('Exa search(rust async runtimes) · $0.04');
    await ui.unmount();
  }
});

test('a spec without a label is a Tenjin lookup, never its provider', async ($, on) => {
  const { files } = machine(on);
  await keepSpec(files, OFFER, {
    capabilityId: 'glim-x-search',
    provider: 'glim',
    priceAtomic: '5000',
    maxAmountAtomic: '5000',
  });
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({
      plugin: 'tenjin',
      surface,
      component: 'ToolUse',
      props: toolRow('toolu_glim', TOOL, { id: OFFER, input: { query: 'from:tenjin' } }),
    });
    expect(await rowText(ui)).toBe('Calling Tenjin lookup(from:tenjin)… · $0.005');
    await ui.unmount();
  }
});

test('an id-less query is the router picking: Calling Tenjin…', async ($, on) => {
  machine(on);
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({
      plugin: 'tenjin',
      surface,
      component: 'ToolUse',
      props: toolRow('toolu_pick', TOOL, { query: 'latest BTC price' }),
    });
    expect(await rowText(ui)).toBe('Calling Tenjin(latest BTC price)…');
    await ui.unmount();
  }
});

test('a refusal reads as its state beside the price, with no toast and nothing paid', async ($, on) => {
  const { files, toasts } = machine(on);
  await keepSpec(files, OFFER, { ...EXA, priceAtomic: '420000', maxAmountAtomic: '420000' });
  const refused = JSON.stringify({
    status: 'needs_approval',
    reason: 'over the $0.25 cap',
    policyReason: 'above_auto_spend',
  });
  on('tool.call', { tool: TOOL }, () => ({ result: refused, text: refused }));
  await $.tool.call({ tool: TOOL, tool_use_id: 'toolu_cap', id: OFFER, input: INPUT });
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({
      plugin: 'tenjin',
      surface,
      component: 'ToolUse',
      props: {
        ...toolRow('toolu_cap', TOOL, { id: OFFER, input: INPUT }),
        isRunning: false,
        output: refused,
      },
    });
    expect(await rowText(ui)).toBe('Exa search(rust async runtimes) · $0.42 · needs approval');
    await ui.unmount();
  }
  expect(toasts).toEqual([]);
  expect(files.has(`${DATA}/paid/ledger.jsonl`)).toBe(false);
});

test('the result under our row draws nothing of what the model read', async ($, on) => {
  machine(on);
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({
      plugin: 'tenjin',
      surface,
      component: 'ToolResult',
      props: {
        tool_use_id: 'toolu_paid',
        tool: TOOL,
        output: resultText('fulfilled'),
        isErrored: false,
      },
    });
    expect((await shownLines(ui)).join('\n')).not.toMatch(MODEL_TEXT);
    await ui.unmount();
  }
});

test('any other tool row is left to the engine', async ($, on) => {
  machine(on);
  on('ui.render', { component: 'ToolUse' }, ($, e) => {
    const { Text } = $.ui.resolve(e);
    return Text({ children: ['engine row'] });
  });
  on('ui.render', { component: 'ToolResult' }, ($, e) => {
    const { Text } = $.ui.resolve(e);
    return Text({ children: ['engine result'] });
  });
  for (const surface of SURFACES) {
    const row = await $.ui.mount({
      plugin: 'tenjin',
      surface,
      component: 'ToolUse',
      props: toolRow('toolu_bash', 'Bash', { command: 'ls' }),
    });
    expect(await shownLines(row)).toEqual(['engine row']);
    await row.unmount();
    const result = await $.ui.mount({
      plugin: 'tenjin',
      surface,
      component: 'ToolResult',
      props: { tool_use_id: 'toolu_bash', tool: 'Bash', output: 'a\nb', isErrored: false },
    });
    expect(await shownLines(result)).toEqual(['engine result']);
    await result.unmount();
  }
});
