import { expect, test } from 'claude-code/testing';
import type { Mounted } from 'claude-code/testing';

import {
  DATA,
  NOW,
  SURFACES,
  TOOL,
  keepSpec,
  machine,
  recordPayment,
  resultText,
  rowText,
  sha256Hex,
  shownLines,
  toolRow,
} from './fixtures';

const OFFER = 'b920ff14-5aed-4a50-8c25-240e871602f3';
const INPUT = { query: 'rust async runtimes' };
const EXA = {
  capabilityId: 'exa-search',
  label: 'Exa search',
  priceAtomic: '7000',
  maxAmountAtomic: '7000',
};
/** What the spec says the search returns, as the CLI cut the provider's body to it. */
const FIELDS = {
  results: [
    { title: 'Tokio', url: 'https://tokio.rs' },
    { title: 'smol', url: 'https://github.com/smol-rs/smol' },
    { title: 'async-std', url: 'https://async.rs' },
    { title: 'glommio', url: 'https://github.com/DataDog/glommio' },
  ],
  autopromptString: 'rust async runtimes\nin 2026',
  apiKey: 'sk-never-shown',
};

/** The request tool's result once the CLI cut it to the spec's fields. */
function cutText(fields: unknown, extra: Record<string, unknown> = {}): string {
  return `Fulfilled by api.exa.ai · provider price 0.007 USD${JSON.stringify({
    status: 'fulfilled',
    supplier: 'api.exa.ai',
    cost: ['provider: $0.007'],
    result: JSON.stringify(fields),
    fullResultPath: `${DATA}/results/exa-search.json`,
    ...extra,
    providerContentUntrusted: true,
  })}`;
}

/** The lines in the `⎿` block under a row: each after its gutter or indent. */
async function under(ui: Pick<Mounted, 'findAll'>): Promise<string[]> {
  const lines = await shownLines(ui);
  const at = lines.indexOf('  ⎿  ');
  if (at === -1) return [];
  return lines.slice(at).filter((_, i) => i % 2 === 1);
}

const EXPECTED = [
  'results: 4 items',
  '  Tokio',
  '  smol',
  '  async-std',
  'autopromptString: rust async runtimes in 2026',
];

test('an expanded lookup shows the fields its spec returns; folded, nothing goes under it', async ($, on) => {
  const { files } = machine(on);
  await keepSpec(files, OFFER, EXA);
  on('tool.call', { tool: TOOL }, async () => {
    await recordPayment(files, OFFER, {
      capabilityId: 'exa-search',
      amountAtomic: '7000',
      txHash: '0xc9fc',
    });
    return { result: cutText(FIELDS), text: cutText(FIELDS) };
  });
  await $.tool.call({ tool: TOOL, tool_use_id: 'toolu_s', id: OFFER, input: INPUT });
  const row = (output: string, isExpanded: boolean) =>
    ({
      ...toolRow('toolu_s', TOOL, { id: OFFER, input: INPUT }),
      isRunning: false,
      output,
      isExpanded,
    }) as never;
  for (const surface of SURFACES) {
    const folded = await $.ui.mount({
      plugin: 'tenjin',
      surface,
      component: 'ToolUse',
      props: row(cutText(FIELDS), false),
    });
    expect(await rowText(folded)).toBe('Called Exa search · $0.007 (ctrl+o to expand)');
    expect(await under(folded)).toEqual([]);
    await folded.unmount();
    const open = await $.ui.mount({
      plugin: 'tenjin',
      surface,
      component: 'ToolUse',
      props: row(cutText(FIELDS), true),
    });
    const lines = await shownLines(open);
    expect(lines.slice(0, 4).join('')).toBe('⏺Exa search(rust async runtimes) · $0.007');
    expect(await under(open)).toEqual(EXPECTED);
    // The engine's result block: the gutter, then each line dim.
    const [gutter] = await open.findAll({ type: 'Text', text: '  ⎿  ' });
    expect(gutter?.props.dimColor).toBe(true);
    const [first] = await open.findAll({ type: 'Text', text: 'results: 4 items' });
    expect(first?.props).toMatchObject({ dimColor: true, wrap: 'truncate-end' });
    // A secret-named field and the full result's path are never drawn.
    expect(lines.join('')).not.toMatch(/sk-never|apiKey|results\/exa-search/);
    await open.unmount();
    // A body the CLI did not cut is the provider's whole response: nothing of it.
    const raw = await $.ui.mount({
      plugin: 'tenjin',
      surface,
      component: 'ToolUse',
      props: row(resultText('fulfilled'), true),
    });
    expect(await rowText(raw)).toBe('⏺ Exa search(rust async runtimes) · $0.007');
    expect(await under(raw)).toEqual([]);
    await raw.unmount();
  }
});

test('an expanded block stops at eight lines', async ($, on) => {
  const { files } = machine(on);
  await keepSpec(files, OFFER, EXA);
  const many = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`field${i}`, `v${i}`]));
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({
      plugin: 'tenjin',
      surface,
      component: 'ToolUse',
      props: {
        ...toolRow('toolu_many', TOOL, { id: OFFER, input: INPUT }),
        isRunning: false,
        output: cutText(many),
        isExpanded: true,
      } as never,
    });
    expect(await under(ui)).toEqual(Array.from({ length: 8 }, (_, i) => `field${i}: v${i}`));
    await ui.unmount();
  }
});

test('an expanded media lookup shows the file the CLI saved', async ($, on) => {
  const { files } = machine(on);
  await keepSpec(
    files,
    OFFER,
    {
      capabilityId: 'ideogram',
      label: 'Ideogram V4',
      priceAtomic: '30000',
      maxAmountAtomic: '30000',
    },
    null,
  );
  const saved = `${DATA}/media/ideogram-1760000000.png`;
  // A media body is not cut: only the saved path is drawn, never its links.
  const text = `Fulfilled by api.ideogram.ai · provider price 0.03 USD${JSON.stringify({
    status: 'fulfilled',
    supplier: 'api.ideogram.ai',
    cost: ['provider: $0.03'],
    result: '{"data":[{"url":"https://ideogram.ai/api/images/ephemeral/abc.png"}]}',
    savedFiles: [saved],
    providerContentUntrusted: true,
  })}`;
  const args = { id: OFFER, input: { prompt: 'a clean wide repository banner' } };
  for (const surface of SURFACES) {
    for (const isExpanded of [false, true]) {
      const ui = await $.ui.mount({
        plugin: 'tenjin',
        surface,
        component: 'ToolUse',
        props: {
          ...toolRow('toolu_img', TOOL, args),
          isRunning: false,
          output: text,
          isExpanded,
        } as never,
      });
      expect(await under(ui)).toEqual(isExpanded ? [`saved: ${saved}`] : []);
      expect((await shownLines(ui)).join('')).not.toContain('ephemeral');
      await ui.unmount();
    }
  }
});

test('a replacement row gets the same expanded block', async ($, on) => {
  const { files } = machine(on);
  await keepSpec(files, OFFER, EXA);
  const heldFile = async (outcome: 'held' | 'routed', routedToolUseId?: string) => {
    files.set(
      `${DATA}/progress/held/${await sha256Hex('toolu_held')}.json`,
      JSON.stringify({
        version: 1,
        at: NOW,
        outcome,
        label: 'Exa search',
        priceAtomic: '7000',
        offerId: OFFER,
        ...(routedToolUseId !== undefined ? { routedToolUseId } : {}),
      }),
    );
    files.set(
      `${DATA}/progress/held/${await sha256Hex(OFFER)}.offer.json`,
      JSON.stringify({ version: 1, at: NOW, toolUseIds: ['toolu_held'] }),
    );
  };
  await heldFile('held');
  on('tool.call', { tool: TOOL }, async (_$, e) => {
    await heldFile('routed', e.tool_use_id);
    await recordPayment(files, OFFER, {
      capabilityId: 'exa-search',
      amountAtomic: '7000',
      txHash: '0xc9fc',
    });
    return { result: cutText(FIELDS), text: cutText(FIELDS) };
  });
  await $.tool.call({ tool: TOOL, tool_use_id: 'toolu_r', id: OFFER, input: INPUT });
  for (const surface of SURFACES) {
    for (const isExpanded of [false, true]) {
      const ui = await $.ui.mount({
        plugin: 'tenjin',
        surface,
        component: 'ToolUse',
        props: {
          ...toolRow('toolu_held', 'WebSearch', INPUT),
          isRunning: false,
          isErrored: true,
          output: 'Tenjin router: call request',
          isExpanded,
        } as never,
      });
      const lines = await shownLines(ui);
      expect(lines.slice(0, 4).join('')).toBe('⏺Exa search("rust async runtimes") · $0.007');
      expect(await under(ui)).toEqual(isExpanded ? EXPECTED : []);
      await ui.unmount();
    }
  }
});
