import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileClientChannelStorage } from '@x402/evm/batch-settlement/client/file-storage';
import { afterEach, expect, it } from 'vitest';
import { payerDir } from './fee';
import { channelCredit, routingSpent } from './channel-credit';
import { modelChannelDir } from './model-channel';
let dir: string;
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});
it('shows the credit from both inference slots separately from routing credit', async () => {
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
  const parallel = new FileClientChannelStorage({
    directory: modelChannelDir(dir, address, 'model-inference', 'https://router.test', 1),
  });
  await parallel.set(`0x${'34'.repeat(32)}`, {
    balance: '500000',
    chargedCumulativeAmount: '50000',
  });
  await parallel.set(`0x${'56'.repeat(32)}`, {
    balance: '120000',
    chargedCumulativeAmount: '10000',
  });
  expect(await channelCredit(dir, address, 'model', 'https://router.test')).toBe(1427000n);
  expect(await channelCredit(dir, address, 'model-routing', 'https://router.test')).toBe(47000n);
  expect(await channelCredit(dir, address, 'model', 'http://localhost:3939')).toBe(0n);
  expect(await channelCredit(dir, address, 'model-routing', 'http://localhost:3939')).toBe(0n);
  expect(await routingSpent(dir, address)).toBe(9000n);
  await new FileClientChannelStorage({ directory: base }).set(`0x${'01'.repeat(32)}`, {
    balance: '10000',
    chargedCumulativeAmount: '4000',
  });
  expect(await routingSpent(dir, address)).toBe(13000n);
  expect(await channelCredit(dir, address)).toBe(21000n);
});

it('shows available inference credit when the other slot is absent or unreadable', async () => {
  dir = await mkdtemp(join(tmpdir(), 'model-credit-'));
  const address = `0x${'12'.repeat(20)}`;
  const origin = 'https://router.test';
  await new FileClientChannelStorage({
    directory: modelChannelDir(dir, address, 'model-inference', origin, 1),
  }).set(`0x${'34'.repeat(32)}`, {
    balance: '500000',
    chargedCumulativeAmount: '50000',
  });
  expect(await channelCredit(dir, address, 'model', origin)).toBe(450000n);
  await new FileClientChannelStorage({
    directory: modelChannelDir(dir, address, 'model-inference', origin),
  }).set(`0x${'cd'.repeat(32)}`, {
    balance: 'unreadable',
    chargedCumulativeAmount: '23000',
  });
  expect(await channelCredit(dir, address, 'model', origin)).toBe(450000n);
});
