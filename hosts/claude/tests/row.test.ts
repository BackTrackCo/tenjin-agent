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
  shownLines,
  toolRow,
} from './fixtures';

const OFFER = 'b920ff14-5aed-4a50-8c25-240e871602f3';
const INPUT = { query: 'rust async runtimes', numResults: 5 };

test('a paid row names the label, the price and the fields, then how it ended', async ($, on) => {
  const { files } = machine(on);
  await keepSpec(files, OFFER, {
    capabilityId: 'exa-search',
    label: 'Exa search',
    provider: 'Exa',
    priceAtomic: '7000',
    maxAmountAtomic: '7000',
  });
  on('tool.call', { tool: TOOL }, async () => {
    await recordPayment(files, OFFER, {
      capabilityId: 'exa-search',
      provider: 'Exa',
      amountAtomic: '7000',
      txHash: '0xc9fc',
    });
    return { result: resultText('fulfilled'), text: resultText('fulfilled') };
  });
  const row = toolRow('toolu_paid', TOOL, { id: OFFER, input: INPUT });

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ plugin: 'tenjin', surface, component: 'ToolUse', props: row });
    expect(await shownLines(ui)).toEqual([
      'Calling Exa search…',
      'for $0.007',
      'query: rust async runtimes',
      'numResults: 5',
    ]);
    await ui.unmount();
  }

  await $.tool.call({ tool: TOOL, tool_use_id: 'toolu_paid', id: OFFER, input: INPUT });

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({
      plugin: 'tenjin',
      surface,
      component: 'ToolUse',
      props: { ...row, isRunning: false, output: resultText('fulfilled') },
    });
    const lines = await shownLines(ui);
    expect(lines).toEqual([
      'Exa search',
      '$0.007 · settled',
      'query: rust async runtimes',
      'numResults: 5',
    ]);
    expect(lines.join('\n')).not.toMatch(MODEL_TEXT);
    await ui.unmount();
  }
});

test('a payment whose settlement is unknown reads as pending', async ($, on) => {
  const { files } = machine(on);
  await keepSpec(files, OFFER, {
    capabilityId: 'exa-search',
    label: 'Exa search',
    provider: 'Exa',
    priceAtomic: '7000',
    maxAmountAtomic: '7000',
  });
  on('tool.call', { tool: TOOL }, async () => {
    await recordPayment(files, OFFER, {
      capabilityId: 'exa-search',
      provider: 'Exa',
      amountAtomic: '7000',
      txHash: '0xd00d',
      settlement: 'unknown',
    });
    return { result: resultText('fulfilled'), text: resultText('fulfilled') };
  });
  await $.tool.call({ tool: TOOL, tool_use_id: 'toolu_unknown', id: OFFER, input: INPUT });
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
    expect((await shownLines(ui)).slice(0, 2)).toEqual(['Exa search', 'pending']);
    await ui.unmount();
  }
});

test('a spec without a label falls back to its provider', async ($, on) => {
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
    expect((await shownLines(ui)).slice(0, 2)).toEqual(['Calling glim…', 'for $0.005']);
    await ui.unmount();
  }
});

test('a call with no spec kept is a Tenjin lookup, with no price', async ($, on) => {
  machine(on);
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({
      plugin: 'tenjin',
      surface,
      component: 'ToolUse',
      props: toolRow('toolu_bare', TOOL, { id: 'expired-offer', input: { query: 'q' } }),
    });
    expect(await shownLines(ui)).toEqual(['Calling Tenjin lookup…', 'query: q']);
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
      props: toolRow('toolu_pick', 'mcp__plugin_tenjin_router__request', {
        query: 'latest BTC price',
      }),
    });
    expect(await shownLines(ui)).toEqual(['Calling Tenjin…', 'query: latest BTC price']);
    await ui.unmount();
  }
});

test('a refusal reads as its state, with no price and nothing paid', async ($, on) => {
  const { files } = machine(on);
  await keepSpec(files, OFFER, {
    capabilityId: 'exa-search',
    label: 'Exa search',
    provider: 'Exa',
    priceAtomic: '420000',
    maxAmountAtomic: '420000',
  });
  const refused = JSON.stringify({ status: 'needs_approval', reason: 'over the $0.25 cap' });
  on('tool.call', { tool: TOOL }, () => ({ isError: true, result: refused, text: refused }));
  await $.tool.call({ tool: TOOL, tool_use_id: 'toolu_cap', id: OFFER, input: INPUT });
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({
      plugin: 'tenjin',
      surface,
      component: 'ToolUse',
      props: {
        ...toolRow('toolu_cap', TOOL, { id: OFFER, input: INPUT }),
        isRunning: false,
        isErrored: true,
        output: refused,
      },
    });
    expect((await shownLines(ui)).slice(0, 2)).toEqual(['Exa search', 'needs approval']);
    await ui.unmount();
  }
  expect(files.has(`${DATA}/paid/ledger.jsonl`)).toBe(false);
});

test('a spec fetch reads as no charge, whatever status its example holds', async ($, on) => {
  machine(on);
  // Drawn with no tool.call before it (a resumed session): from the stored
  // result alone, MCP content blocks whose spec text carries a `status` too.
  const output = [
    { type: 'text', text: 'Spec for glim. Example: {"status":"open","limit":5}' },
    { type: 'text', text: JSON.stringify({ status: 'spec', id: OFFER, cost: ['no charge'] }) },
  ];
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({
      plugin: 'tenjin',
      surface,
      component: 'ToolUse',
      props: { ...toolRow('toolu_spec', TOOL, { id: OFFER }), isRunning: false, output },
    });
    expect(await shownLines(ui)).toEqual(['Tenjin', 'no charge']);
    await ui.unmount();
  }
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
