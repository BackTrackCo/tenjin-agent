import { expect, test } from 'claude-code/testing';

import {
  MODEL_TEXT,
  SURFACES,
  TOOL,
  keepSpec,
  machine,
  recordPayment,
  resultText,
  shownLines,
} from './fixtures';

const OFFER = 'b920ff14-5aed-4a50-8c25-240e871602f3';
const SPIN = { word: 'Sauteing', message: null, suffix: '…', mode: 'tool-use' } as const;

test('the spinner names a live paid call and its price, then lets go', async ($, on) => {
  const { files, clock } = machine(on);
  await keepSpec(files, OFFER, {
    capabilityId: 'exa-search',
    label: 'Exa search',
    provider: 'Exa',
    priceAtomic: '7000',
    maxAmountAtomic: '7000',
  });
  let release = (): void => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  on('tool.call', { tool: TOOL }, async () => {
    await held;
    await recordPayment(files, OFFER, {
      capabilityId: 'exa-search',
      provider: 'Exa',
      amountAtomic: '7000',
      txHash: '0xc9fc',
    });
    return { result: resultText('fulfilled'), text: resultText('fulfilled') };
  });
  // The engine's own spinner: the word, or the message over it, then the suffix.
  on('ui.render', { component: 'Spinner' }, ($, e) => {
    const { Text } = $.ui.resolve(e);
    return Text({ children: [`${e.props.message ?? e.props.word}${e.props.suffix}`] });
  });

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ plugin: 'tenjin', surface, component: 'Spinner', props: SPIN });
    expect(await shownLines(ui)).toEqual(['Sauteing…']);
    await ui.unmount();
  }

  const running = $.tool.call({
    tool: TOOL,
    tool_use_id: 'toolu_live',
    id: OFFER,
    input: { query: 'rust async runtimes' },
  });
  await clock.settle();
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ plugin: 'tenjin', surface, component: 'Spinner', props: SPIN });
    const lines = await shownLines(ui);
    expect(lines).toEqual(['Calling Exa search… · $0.007']);
    expect(lines.join('\n')).not.toMatch(MODEL_TEXT);
    await ui.unmount();
  }

  release();
  await running;
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ plugin: 'tenjin', surface, component: 'Spinner', props: SPIN });
    expect(await shownLines(ui)).toEqual(['Sauteing…']);
    await ui.unmount();
  }
});

test('a call of the router that pays nothing leaves the spinner alone', async ($, on) => {
  const { clock } = machine(on);
  let release = (): void => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const spec = JSON.stringify({ status: 'spec', cost: ['no charge'] });
  on('tool.call', { tool: TOOL }, async () => {
    await held;
    return { result: spec, text: spec };
  });
  on('ui.render', { component: 'Spinner' }, ($, e) => {
    const { Text } = $.ui.resolve(e);
    return Text({ children: [`${e.props.word}${e.props.suffix}`] });
  });
  const running = $.tool.call({ tool: TOOL, tool_use_id: 'toolu_pick', query: 'BTC price' });
  await clock.settle();
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ plugin: 'tenjin', surface, component: 'Spinner', props: SPIN });
    expect(await shownLines(ui)).toEqual(['Sauteing…']);
    await ui.unmount();
  }
  release();
  await running;
});
