import { expect, test } from 'claude-code/testing';

import {
  DATA,
  MODEL_TEXT,
  NOW,
  SURFACES,
  TOOL,
  keepSpec,
  machine,
  recordPayment,
  resultText,
  sha256Hex,
  shownLines,
  toolRow,
} from './fixtures';

const OFFER = 'b920ff14-5aed-4a50-8c25-240e871602f3';
const SEARCH = { query: 'rust async runtimes https://example.test' };
/** The reason the model read on the deny: never drawn. */
const REASON =
  'Tenjin router (installed by the user): Exa search, $0.007: call ' +
  `mcp__plugin_tenjin_router__request({id: "${OFFER}", input: {...}}).`;
const SPIN = { word: 'Sauteing', message: null, suffix: '…', mode: 'tool-use' } as const;

/** The row the CLI's pre-call hook writes for a native call it held (`src/router/held.ts`). */
async function holdRow(
  files: Map<string, string>,
  toolUseId: string,
  outcome: 'held' | 'routed' = 'held',
): Promise<void> {
  files.set(
    `${DATA}/progress/held/${await sha256Hex(toolUseId)}.json`,
    JSON.stringify({
      version: 1,
      at: NOW,
      outcome,
      label: 'Exa search',
      priceAtomic: '7000',
      offerId: OFFER,
    }),
  );
}

/** A held WebSearch's row as the engine hands it over: refused, the reason as output. */
function heldSearch(toolUseId: string) {
  return {
    ...toolRow(toolUseId, 'WebSearch', SEARCH),
    isRunning: false,
    isErrored: true,
    output: REASON,
  };
}

test('a held search draws one calm line, then nothing once routed', async ($, on) => {
  const { files } = machine(on);
  on('ui.render', { component: 'ToolUse' }, ($, e) => {
    const { Text } = $.ui.resolve(e);
    return Text({ children: ['blocked by hook'] });
  });
  await holdRow(files, 'toolu_held');
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({
      plugin: 'tenjin',
      surface,
      component: 'ToolUse',
      props: heldSearch('toolu_held'),
    });
    const lines = await shownLines(ui);
    expect(lines).toEqual(['Held for Tenjin', 'Exa search · $0.007']);
    expect(lines.join('\n')).not.toContain('rust async runtimes');
    expect(lines.join('\n')).not.toContain('Tenjin router');
    expect(lines.join('\n')).not.toMatch(MODEL_TEXT);
    await ui.unmount();
  }
  await holdRow(files, 'toolu_held', 'routed');
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({
      plugin: 'tenjin',
      surface,
      component: 'ToolUse',
      props: heldSearch('toolu_held'),
    });
    expect(await shownLines(ui)).toEqual([]);
    await ui.unmount();
  }
});

test("a held call's result draws nothing, held or routed", async ($, on) => {
  const { files } = machine(on);
  on('ui.render', { component: 'ToolResult' }, ($, e) => {
    const { Text } = $.ui.resolve(e);
    return Text({ children: ['engine result'] });
  });
  for (const outcome of ['held', 'routed'] as const) {
    await holdRow(files, 'toolu_fetch', outcome);
    for (const surface of SURFACES) {
      const ui = await $.ui.mount({
        plugin: 'tenjin',
        surface,
        component: 'ToolResult',
        props: { tool_use_id: 'toolu_fetch', tool: 'WebFetch', output: REASON, isErrored: true },
      });
      expect(await shownLines(ui)).toEqual([]);
      await ui.unmount();
    }
  }
});

test('a search the CLI did not hold, and an interrupted held one, are the engine rows', async ($, on) => {
  const { files } = machine(on);
  on('ui.render', { component: 'ToolUse' }, ($, e) => {
    const { Text } = $.ui.resolve(e);
    return Text({ children: ['engine row'] });
  });
  on('ui.render', { component: 'ToolResult' }, ($, e) => {
    const { Text } = $.ui.resolve(e);
    return Text({ children: ['engine result'] });
  });
  await holdRow(files, 'toolu_cut');
  for (const surface of SURFACES) {
    const free = await $.ui.mount({
      plugin: 'tenjin',
      surface,
      component: 'ToolUse',
      props: { ...toolRow('toolu_free', 'WebSearch', SEARCH), isRunning: false },
    });
    expect(await shownLines(free)).toEqual(['engine row']);
    await free.unmount();
    const result = await $.ui.mount({
      plugin: 'tenjin',
      surface,
      component: 'ToolResult',
      props: { tool_use_id: 'toolu_free', tool: 'WebSearch', output: 'results', isErrored: false },
    });
    expect(await shownLines(result)).toEqual(['engine result']);
    await result.unmount();
    const cut = await $.ui.mount({
      plugin: 'tenjin',
      surface,
      component: 'ToolUse',
      props: { ...heldSearch('toolu_cut'), isInterrupted: true },
    });
    expect(await shownLines(cut)).toEqual(['engine row']);
    await cut.unmount();
  }
});

test('the spinner says Routing to Tenjin between the hold and the request call', async ($, on) => {
  const { files, clock } = machine(on);
  await keepSpec(files, OFFER, {
    capabilityId: 'exa-search',
    label: 'Exa search',
    priceAtomic: '7000',
    maxAmountAtomic: '7000',
  });
  // Beneath the mod, the engine: the CLI's pre-call hook holds the search.
  on('tool.call', { tool: 'WebSearch' }, async (_$, e) => {
    await holdRow(files, e.tool_use_id);
    return { deny: REASON };
  });
  let release = (): void => undefined;
  const paying = new Promise<void>((resolve) => {
    release = resolve;
  });
  on('tool.call', { tool: TOOL }, async () => {
    await paying;
    await recordPayment(files, OFFER, {
      capabilityId: 'exa-search',
      amountAtomic: '7000',
      txHash: '0xc9fc',
    });
    return { result: resultText('fulfilled'), text: resultText('fulfilled') };
  });
  on('ui.render', { component: 'Spinner' }, ($, e) => {
    const { Text } = $.ui.resolve(e);
    return Text({ children: [`${e.props.message ?? e.props.word}${e.props.suffix}`] });
  });
  const spinner = async (): Promise<string[]> => {
    const shown: string[] = [];
    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ plugin: 'tenjin', surface, component: 'Spinner', props: SPIN });
      shown.push(...(await shownLines(ui)));
      await ui.unmount();
    }
    return shown;
  };

  await $.tool.call({ tool: 'WebSearch', tool_use_id: 'toolu_held', ...SEARCH, mode: 'standard' });
  expect(await spinner()).toEqual([
    'Routing to Tenjin… · Exa search',
    'Routing to Tenjin… · Exa search',
  ]);

  const running = $.tool.call({
    tool: TOOL,
    tool_use_id: 'toolu_request',
    id: OFFER,
    input: { query: 'rust async runtimes' },
  });
  await clock.settle();
  expect(await spinner()).toEqual(['Calling Exa search… · $0.007', 'Calling Exa search… · $0.007']);
  release();
  await running;
  expect(await spinner()).toEqual(['Sauteing…', 'Sauteing…']);
});
