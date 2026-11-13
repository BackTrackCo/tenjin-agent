import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileClientChannelStorage } from '@x402/evm/batch-settlement/client/file-storage';
import { afterEach, expect, it } from 'vitest';
import { payerDir } from './fee';
import { channelCredit } from './channel-credit';
import { modelChannelDir } from './model-channel';
let dir: string;
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});
it('keeps inference credit visible without making it available for router fees', async () => {
  dir = await mkdtemp(join(tmpdir(), 'model-credit-'));
  const address = `0x${'12'.repeat(20)}`;
  const base = payerDir(dir, address);
  await new FileClientChannelStorage({ directory: base }).set(`0x${'ab'.repeat(32)}`, {
    balance: '30000',
    chargedCumulativeAmount: '9000',
  });
  await new FileClientChannelStorage({
    directory: modelChannelDir(dir, address, 'model-inference', 'https://router.test'),
  }).set(`0x${'cd'.repeat(32)}`, {
    balance: '1000000',
    chargedCumulativeAmount: '23000',
  });
  expect(await channelCredit(dir, address)).toBe(21000n);
  await new FileClientChannelStorage({
    directory: modelChannelDir(dir, address, 'model-routing', 'https://router.test'),
  }).set(`0x${'ef'.repeat(32)}`, {
    balance: '50000',
    chargedCumulativeAmount: '3000',
  });
  expect(await channelCredit(dir, address, 'model', 'https://router.test')).toBe(977000n);
  expect(await channelCredit(dir, address, 'model-routing', 'https://router.test')).toBe(47000n);
  expect(await channelCredit(dir, address, 'model', 'http://localhost:3939')).toBe(0n);
  expect(await channelCredit(dir, address, 'model-routing', 'http://localhost:3939')).toBe(0n);
});
