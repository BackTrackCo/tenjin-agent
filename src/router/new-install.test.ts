import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { loadRawConfig } from '../lib/config';
import { persist } from '../commands/config';
import { testCtx } from '../context-test-utils';
import { captureNewInstall, completeNewInstall, reserveNewInstall } from './new-install';

let parent: string;
let dir: string;
beforeEach(async () => {
  parent = await mkdtemp(join(tmpdir(), 'tenjin-new-install-'));
  dir = join(parent, 'profile');
});
afterEach(async () => {
  await rm(parent, { recursive: true, force: true });
});

it('retains a pending new-install claim without consent until accepted setup completes', async () => {
  const ctx = testCtx(dir);
  const first = await captureNewInstall(dir);
  await reserveNewInstall(first, ctx);
  first.completed.push(true);
  expect(await completeNewInstall(first, ctx)).toBe(false);
  const pending = (await loadRawConfig(dir)).install?.pendingDeepSeekSetup;
  expect(pending).toMatchObject({ version: 1, routerOrigin: 'https://tenjin.sh' });
  expect((await loadRawConfig(dir)).router).toBeUndefined();
  const continuation = await captureNewInstall(dir);
  expect(continuation.absent).toBe(false);
  await reserveNewInstall(continuation, ctx);
  expect(continuation.claimId).toBe(pending?.id);
  continuation.accepted = true;
  continuation.completed.push(true);
  expect(await completeNewInstall(continuation, ctx)).toBe(true);
  const config = await loadRawConfig(dir);
  expect(config.install?.pendingDeepSeekSetup).toBeUndefined();
  expect(config.router).toEqual({
    subagents: true,
    subagentConsent: {
      version: 3,
      scope: 'native-workspace',
      instructions: 'applicable',
      reads: 'claude-home',
      recipients: ['Tenjin', 'DeepSeek', 'Exa'],
      routerOrigin: 'https://tenjin.sh',
      maxJobAtomic: '1000000',
    },
  });
});

it('leaves an existing empty profile without a pending claim untouched', async () => {
  await mkdir(dir);
  const session = await captureNewInstall(dir);
  await reserveNewInstall(session, testCtx(dir));
  session.accepted = true;
  session.completed.push(true);
  expect(await completeNewInstall(session, testCtx(dir))).toBe(false);
  expect(await loadRawConfig(dir)).toEqual({});
});

it.each([
  { router: { subagents: false } },
  { router: { enabled: false } },
  { router: { subagentConsent: { version: 2, repositories: ['/kept'] } } },
])('a concurrent existing choice wins over the installer: %j', async (choice) => {
  const ctx = testCtx(dir);
  const session = await captureNewInstall(dir);
  await reserveNewInstall(session, ctx);
  await persist(dir, (config) => ({ ...config, ...choice }));
  session.accepted = true;
  session.completed.push(true);
  expect(await completeNewInstall(session, ctx)).toBe(false);
  const config = await loadRawConfig(dir);
  expect(config.router).toEqual(choice.router);
  expect(config.install?.pendingDeepSeekSetup).toBeUndefined();
});

it('a new config writer wins even if the initial directory snapshot was absent', async () => {
  const session = await captureNewInstall(dir);
  await persist(dir, () => ({ maxAutoSpend: '0' }));
  await reserveNewInstall(session, testCtx(dir));
  session.accepted = true;
  session.completed.push(true);
  expect(await completeNewInstall(session, testCtx(dir))).toBe(false);
  expect(await loadRawConfig(dir)).toEqual({ maxAutoSpend: '0' });
});

it('one shared claim survives competing absent-profile snapshots without replacing another choice', async () => {
  const ctx = testCtx(dir);
  const first = await captureNewInstall(dir);
  const second = await captureNewInstall(dir);
  await Promise.all([reserveNewInstall(first, ctx), reserveNewInstall(second, ctx)]);
  // Either directory claimant may enter the config lock first. A continuation
  // finds its durable claim even when the competing setup got the lock first.
  await reserveNewInstall(first, ctx);
  await reserveNewInstall(second, ctx);
  expect(first.claimId).toBeTruthy();
  expect(second.claimId).toBe(first.claimId);
  await persist(dir, (config) => ({ ...config, router: { subagents: false } }));
  for (const session of [first, second]) {
    session.accepted = true;
    session.completed.push(true);
    expect(await completeNewInstall(session, ctx)).toBe(false);
  }
  expect((await loadRawConfig(dir)).router).toEqual({ subagents: false });
});

it('origin changes clear an unfinished claim instead of redirecting disclosure', async () => {
  const session = await captureNewInstall(dir);
  const ctx = testCtx(dir);
  await reserveNewInstall(session, ctx);
  await persist(dir, (config) => ({ ...config, baseUrl: 'https://other.example' }));
  session.accepted = true;
  session.completed.push(true);
  expect(await completeNewInstall(session, ctx)).toBe(false);
  expect((await loadRawConfig(dir)).router).toBeUndefined();
  expect((await loadRawConfig(dir)).install?.pendingDeepSeekSetup).toBeUndefined();
});

it('does not enable or change config when its pending claim was removed before completion', async () => {
  const session = await captureNewInstall(dir);
  const ctx = testCtx(dir);
  await reserveNewInstall(session, ctx);
  await persist(dir, () => ({ maxAutoSpend: '0' }));
  session.accepted = true;
  session.completed.push(true);
  expect(await completeNewInstall(session, ctx)).toBe(false);
  expect(await loadRawConfig(dir)).toEqual({ maxAutoSpend: '0' });
});

it('refresh and failed or unfinished host setup never grant consent', async () => {
  const ctx = testCtx(dir);
  const refresh = await captureNewInstall(dir);
  await reserveNewInstall(refresh, ctx, false);
  expect(await loadRawConfig(dir)).toEqual({});
  const session = await captureNewInstall(dir);
  await reserveNewInstall(session, ctx);
  session.accepted = true;
  session.completed.push(true, false);
  expect(await completeNewInstall(session, ctx)).toBe(false);
  expect((await loadRawConfig(dir)).router).toBeUndefined();
  expect((await loadRawConfig(dir)).install?.pendingDeepSeekSetup).toBeDefined();
});
