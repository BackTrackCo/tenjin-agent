import { expect, test } from 'claude-code/testing';
import type { On } from 'claude-code';

import {
  DATA,
  MODEL_TEXT,
  NOW,
  TOOL,
  keepSpec,
  machine,
  recordPayment,
  resultText,
} from './fixtures';

const EXA = 'offer-exa';
const GLIM = 'offer-glim';
const ANSWER = 'Tokio is the most used async runtime.';

/**
 * Two offers kept, a request tool that pays each from its spec, today's spend
 * at $0.05 of the default $5.00, and the engine's own turn events beneath.
 */
async function paidMachine(on: On): Promise<void> {
  const { files } = machine(on);
  await keepSpec(files, EXA, {
    capabilityId: 'exa-search',
    label: 'Exa search',
    provider: 'Exa',
    priceAtomic: '7000',
    maxAmountAtomic: '7000',
  });
  await keepSpec(files, GLIM, {
    capabilityId: 'glim-x-search',
    provider: 'glim',
    priceAtomic: '5000',
    maxAmountAtomic: '5000',
  });
  files.set(
    `${DATA}/spend.json`,
    JSON.stringify({
      schemaVersion: 2,
      windowStartMs: NOW - 3_600_000,
      committedAtomic: '50000',
      automaticCommittedAtomic: '50000',
      settledAtomic: '50000',
      reservations: [],
      exposures: [],
    }),
  );
  files.set(`${DATA}/config.json`, JSON.stringify({ maxAutoSpend: '250000' }));
  on('tool.call', { tool: TOOL }, async (_$, e) => {
    const isExa = e.id === EXA;
    await recordPayment(files, String(e.id), {
      capabilityId: isExa ? 'exa-search' : 'glim-x-search',
      provider: isExa ? 'Exa' : 'glim',
      amountAtomic: isExa ? '7000' : '5000',
      txHash: isExa ? '0xe1' : '0xe2',
    });
    return { result: resultText('fulfilled'), text: resultText('fulfilled') };
  });
  on('turn.start', (_$, e) => ({ turnId: e.turnId }));
  on('turn.complete', (_$, e) => ({ text: e.answer }));
}

function ended(turnId: string) {
  return { answer: ANSWER, durationMs: 4_000, isAborted: false, turnId, reason: 'answer' as const };
}

test('a turn that paid twice ends with one spend line', async ($, on) => {
  await paidMachine(on);
  await $.turn.start({ text: 'which async runtime?', turnId: 'turn-1' });
  await $.tool.call({ tool: TOOL, tool_use_id: 'toolu_1', id: EXA, input: { query: 'rust' } });
  await $.tool.call({ tool: TOOL, tool_use_id: 'toolu_2', id: GLIM, input: { query: 'tokio' } });
  const { text } = await $.turn.complete(ended('turn-1'));
  expect(text).toBe('Tenjin: 2 paid lookups, $0.012 · today $0.05 of $5.00');
  expect(text).not.toMatch(MODEL_TEXT);
});

test('a turn that paid nothing adds nothing, after one that did', async ($, on) => {
  await paidMachine(on);
  await $.turn.start({ text: 'which async runtime?', turnId: 'turn-1' });
  await $.tool.call({ tool: TOOL, tool_use_id: 'toolu_1', id: EXA, input: { query: 'rust' } });
  expect((await $.turn.complete(ended('turn-1'))).text).toBe(
    'Tenjin: 1 paid lookup, $0.007 · today $0.05 of $5.00',
  );

  await $.turn.start({ text: 'thanks', turnId: 'turn-2' });
  expect((await $.turn.complete(ended('turn-2'))).text).toBe(ANSWER);
});
