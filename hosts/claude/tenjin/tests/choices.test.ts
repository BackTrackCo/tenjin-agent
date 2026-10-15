import { expect, test } from 'claude-code/testing';

import {
  SURFACES,
  TOOL,
  keepChoices,
  keepSpec,
  machine,
  recordPayment,
  resultText,
  shownLines,
  toolRow,
} from './fixtures';

const LINE = 'line-offer';
const FLUX = 'option-flux';
const GPT = 'option-gpt';
const INPUT = { prompt: 'a lighthouse at dusk' };

async function choiceMachine(on: Parameters<typeof machine>[0]) {
  const world = machine(on);
  await keepSpec(world.files, FLUX, {
    capabilityId: 'flux',
    label: 'Flux image',
    priceAtomic: '30000',
    maxAmountAtomic: '30000',
  });
  await keepSpec(world.files, GPT, {
    capabilityId: 'gpt-image',
    label: 'GPT Image 2',
    priceAtomic: '40000',
    maxAmountAtomic: '40000',
  });
  await keepChoices(world.files, LINE, [
    { key: 'flux', id: FLUX, label: 'Flux' },
    { key: 'gpt', id: GPT, label: 'GPT Image 2' },
  ]);
  return world;
}

test('a picked option is named and priced as itself, and only its payment counts', async ($, on) => {
  const { files, toasts } = await choiceMachine(on);
  on('tool.call', { tool: TOOL }, async () => {
    await recordPayment(files, GPT, {
      capabilityId: 'gpt-image',
      amountAtomic: '40000',
      txHash: '0xa1',
    });
    return { result: resultText('fulfilled'), text: resultText('fulfilled') };
  });
  const args = { id: LINE, choice: 'gpt', input: INPUT };
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({
      plugin: 'tenjin',
      surface,
      component: 'ToolUse',
      props: toolRow('toolu_gpt', TOOL, args),
    });
    expect((await shownLines(ui)).slice(0, 2)).toEqual(['Calling GPT Image 2…', 'for $0.04']);
    await ui.unmount();
  }
  await $.tool.call({ tool: TOOL, tool_use_id: 'toolu_gpt', ...args });
  expect(toasts).toEqual(['GPT Image 2 · $0.04']);
});

test('choice "all" totals every option it paid', async ($, on) => {
  const { files, toasts } = await choiceMachine(on);
  on('tool.call', { tool: TOOL }, async () => {
    await recordPayment(files, FLUX, {
      capabilityId: 'flux',
      amountAtomic: '30000',
      txHash: '0xb1',
    });
    await recordPayment(files, GPT, {
      capabilityId: 'gpt-image',
      amountAtomic: '40000',
      txHash: '0xb2',
    });
    return { result: resultText('fulfilled'), text: resultText('fulfilled') };
  });
  const args = { id: LINE, choice: 'all', input: INPUT };
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({
      plugin: 'tenjin',
      surface,
      component: 'ToolUse',
      props: toolRow('toolu_all', TOOL, args),
    });
    expect((await shownLines(ui)).slice(0, 2)).toEqual(['Calling 2 services…', 'for $0.07']);
    await ui.unmount();
  }
  await $.tool.call({ tool: TOOL, tool_use_id: 'toolu_all', ...args });
  expect(toasts).toEqual(['2 services · $0.07']);
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({
      plugin: 'tenjin',
      surface,
      component: 'ToolUse',
      props: {
        ...toolRow('toolu_all', TOOL, args),
        isRunning: false,
        output: resultText('fulfilled'),
      },
    });
    expect((await shownLines(ui)).slice(0, 2)).toEqual(['2 services', '$0.07 · settled']);
    await ui.unmount();
  }
});

test('choice "all" after one option was paid counts only what it paid now', async ($, on) => {
  const { files, toasts } = await choiceMachine(on);
  // GPT was paid by the call just before, under its own id.
  await recordPayment(files, GPT, {
    capabilityId: 'gpt-image',
    amountAtomic: '40000',
    txHash: '0xc1',
  });
  const envelope = JSON.stringify({
    status: 'fulfilled',
    choice: 'all',
    results: [
      { key: 'flux', label: 'Flux', id: FLUX, status: 'fulfilled' },
      { key: 'gpt', label: 'GPT Image 2', id: GPT, status: 'already_paid' },
    ],
  });
  on('tool.call', { tool: TOOL }, async () => {
    await recordPayment(files, FLUX, {
      capabilityId: 'flux',
      amountAtomic: '30000',
      txHash: '0xc2',
    });
    return { result: `Ran 1 of 2 choices${envelope}`, text: `Ran 1 of 2 choices${envelope}` };
  });
  await $.tool.call({
    tool: TOOL,
    tool_use_id: 'toolu_all2',
    id: LINE,
    choice: 'all',
    input: INPUT,
  });
  expect(toasts).toEqual(['2 services · $0.03']);
});
