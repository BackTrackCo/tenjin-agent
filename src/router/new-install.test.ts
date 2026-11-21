import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { loadRawConfig } from '../lib/config';
import { persist } from '../commands/config';
import { testCtx } from '../context-test-utils';
import { modelSettings } from './model-settings';
import {
  captureNewInstall,
  finishNewInstall,
  reserveNewInstall,
  saveSubagentChoice,
} from './new-install';

let parent: string;
let dir: string;
beforeEach(async () => {
  parent = await mkdtemp(join(tmpdir(), 'tenjin-new-install-'));
  dir = join(parent, 'profile');
});
afterEach(async () => {
  await rm(parent, { recursive: true, force: true });
});
const CONSENT = {
  version: 2,
  instructions: 'applicable',
  reads: 'claude-home',
  recipients: ['Tenjin', 'DeepSeek', 'Exa'],
  routerOrigin: 'https://tenjin.sh',
};

it('keeps the fresh-setup marker, and no consent, until an explicit answer is saved', async () => {
  const ctx = testCtx(dir);
  const first = await captureNewInstall(dir);
  await reserveNewInstall(first);
  expect(first.fresh).toBe(true);
  expect(await loadRawConfig(dir)).toEqual({ install: { freshSetup: true } });
  // The rerun that answers the spending question finds an existing profile, and the marker.
  const continuation = await captureNewInstall(dir);
  expect(continuation.absent).toBe(false);
  await reserveNewInstall(continuation);
  expect(continuation.fresh).toBe(true);
  expect(await saveSubagentChoice(dir, ctx, 'on')).toBe(true);
  const config = await loadRawConfig(dir);
  expect(config.install?.freshSetup).toBeUndefined();
  // The record `tenjin config subagents on` writes: no directory and no ceiling.
  expect(config.router).toEqual({ subagents: true, subagentConsent: CONSENT });
});

it.each(['on', 'off', null] as const)(
  'applies the interactive choice %s only once',
  async (answer) => {
    const ctx = testCtx(dir, { json: false });
    const session = await captureNewInstall(dir);
    await reserveNewInstall(session);
    session.completed.push(true, true);
    const promptSubagents = vi.fn(async () => answer);
    const receipt = { data: {} };
    const opts = { isInteractive: true, promptSubagents };
    const result = await finishNewInstall(receipt, session, ctx, opts);
    await finishNewInstall(receipt, session, ctx, opts);

    const enabled = answer === 'on';
    expect(promptSubagents).toHaveBeenCalledTimes(1);
    expect(result.data).toMatchObject({ subagents: { enabled } });
    const config = await loadRawConfig(dir);
    expect(config.router?.subagents).toBe(enabled);
    expect(config.install?.freshSetup).toBeUndefined();
    if (!enabled) expect(config.router?.subagentConsent).toBeUndefined();
  },
);

it('asks nothing on a profile that was already there', async () => {
  await mkdir(dir);
  const session = await captureNewInstall(dir);
  await reserveNewInstall(session);
  session.completed.push(true);
  const promptSubagents = vi.fn(async () => 'on' as const);
  await finishNewInstall({ data: {} }, session, testCtx(dir, { json: false }), {
    isInteractive: true,
    promptSubagents,
  });
  expect(promptSubagents).not.toHaveBeenCalled();
  expect(await loadRawConfig(dir)).toEqual({});
});

// Review of b7974566: `--subagents` was refused on every existing profile, so a scripted
// `install --yes --subagents off` failed on its second run, and nobody who had passed the
// question could reach the install's consent again.
it('--subagents saves the answer on an existing profile that has none, and a second run changes nothing', async () => {
  await mkdir(dir);
  await persist(dir, () => ({ maxAutoSpend: '2000000' }));
  const ctx = testCtx(dir);
  const run = async (choice: 'on' | 'off') => {
    const session = await captureNewInstall(dir);
    await reserveNewInstall(session);
    session.completed.push(true);
    return finishNewInstall({ data: {} }, session, ctx, { choice, yes: true });
  };
  const first = await run('off');
  expect(first.data).toMatchObject({ subagents: { enabled: false } });
  expect((await loadRawConfig(dir)).router).toEqual({ subagents: false });
  const second = await run('off');
  expect(second.data).toMatchObject({ subagents: { enabled: false, changed: false } });
  expect(second.humanLines).toEqual([
    '',
    '○ DeepSeek subagents are off',
    '',
    'Run `tenjin config subagents on` to turn them on.',
  ]);
  // An answer already saved is the config command's to change, and the receipt says so.
  const on = await run('on');
  expect(on.data).toMatchObject({ subagents: { enabled: false, changed: false } });
  expect(on.humanLines?.join(' ')).toContain('tenjin config subagents on');
  expect((await loadRawConfig(dir)).router).toEqual({ subagents: false });
});

it('--subagents on turns the same consent on that the config command writes, with no directory', async () => {
  await mkdir(dir);
  const session = await captureNewInstall(dir);
  await reserveNewInstall(session);
  session.completed.push(true);
  const result = await finishNewInstall({ data: {} }, session, testCtx(dir), { choice: 'on' });
  expect(result.data).toMatchObject({ subagents: { enabled: true, jobCapAtomic: '1000000' } });
  expect((await loadRawConfig(dir)).router).toEqual({ subagents: true, subagentConsent: CONSENT });
  // It covers a session wherever it starts.
  expect(await modelSettings(dir, parent)).toMatchObject({ scope: 'native-workspace' });
});

it.each([{ router: { subagents: false } }, { router: { subagents: true } }])(
  'an answer saved meanwhile wins over the installer: %j',
  async (choice) => {
    const ctx = testCtx(dir);
    const session = await captureNewInstall(dir);
    await reserveNewInstall(session);
    await persist(dir, (config) => ({ ...config, ...choice }));
    expect(await saveSubagentChoice(dir, ctx, 'on')).toBe(false);
    const config = await loadRawConfig(dir);
    expect(config.router).toEqual(choice.router);
    expect(config.install?.freshSetup).toBeUndefined();
  },
);

it('a new config writer wins even if the initial directory snapshot was absent', async () => {
  const session = await captureNewInstall(dir);
  await persist(dir, () => ({ maxAutoSpend: '0' }));
  await reserveNewInstall(session);
  expect(session.fresh).toBe(false);
  expect(await loadRawConfig(dir)).toEqual({ maxAutoSpend: '0' });
});

it('competing absent-profile snapshots share one marker, and only the first answer is saved', async () => {
  const ctx = testCtx(dir);
  const first = await captureNewInstall(dir);
  const second = await captureNewInstall(dir);
  await Promise.all([reserveNewInstall(first), reserveNewInstall(second)]);
  // Either claimant may enter the config lock first: the other then finds the marker.
  await reserveNewInstall(first);
  await reserveNewInstall(second);
  expect([first.fresh, second.fresh]).toEqual([true, true]);
  expect(await saveSubagentChoice(dir, ctx, 'off')).toBe(true);
  expect(await saveSubagentChoice(dir, ctx, 'on')).toBe(false);
  expect((await loadRawConfig(dir)).router).toEqual({ subagents: false });
});

it('refresh and failed or unfinished host setup never grant consent', async () => {
  const ctx = testCtx(dir);
  const refresh = await captureNewInstall(dir);
  await reserveNewInstall(refresh, false);
  expect(await loadRawConfig(dir)).toEqual({});
  const session = await captureNewInstall(dir);
  await reserveNewInstall(session);
  session.completed.push(true, false);
  await finishNewInstall({ data: {} }, session, ctx, { choice: 'on' });
  expect((await loadRawConfig(dir)).router).toBeUndefined();
  expect((await loadRawConfig(dir)).install?.freshSetup).toBe(true);
});
