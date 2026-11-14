import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { ModelJobStore } from './model-job';
let dir: string;
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});
it('claims acceptance once across processes and refuses a foreign root or changed task', async () => {
  dir = await mkdtemp(join(tmpdir(), 'tenjin-model-jobs-'));
  const a = new ModelJobStore(dir),
    b = new ModelJobStore(dir);
  const job = await a.offer({
    sessionId: 's1',
    turnId: 't1',
    callId: 'call1',
    task: 'Read exactly A',
    root: '/repo',
    native: { prompt: 'Read exactly A' },
    decision: { action: 'model' },
    capAtomic: '100000',
  });
  expect(await b.accept(job.id, 's2', 't1')).toBeNull();
  const claims = await Promise.all([a.accept(job.id, 's1', 't1'), b.accept(job.id, 's1', 't1')]);
  expect(claims.filter(Boolean)).toHaveLength(1);
  expect(await a.nativeRetry('s1', 't1', { prompt: 'Read B' })).toBe(false);
  expect(await a.nativeRetry('s1', 't1', { prompt: 'Read exactly A' })).toBe(false);
});
it('allows the unchanged native retry only once after an offer, and fences acceptance', async () => {
  dir = await mkdtemp(join(tmpdir(), 'tenjin-model-jobs-'));
  const store = new ModelJobStore(dir);
  const job = await store.offer({
    sessionId: 's',
    turnId: 't',
    callId: 'c',
    task: 'X',
    root: '/repo',
    native: { prompt: 'X' },
    decision: {},
    capAtomic: '1',
  });
  expect(await store.nativeRetry('s', 't', { prompt: 'X' })).toBe(true);
  expect(await store.nativeRetry('s', 't', { prompt: 'X' })).toBe(false);
  expect(await store.accept(job.id, 's', 't')).toBeNull();
});
it('binds one Codex plaintext submission and fences stale selection on interruption', async () => {
  dir = await mkdtemp(join(tmpdir(), 'tenjin-model-jobs-'));
  const store = new ModelJobStore(dir);
  const job = await store.offer(
    {
      sessionId: 'root',
      turnId: 'turn',
      callId: 'encrypted-call',
      task: '',
      root: '/repo',
      native: { message: 'ciphertext', fork_turns: 'none' },
      decision: {},
      capAtomic: '1000000',
    },
    'awaiting_prompt',
  );
  expect(await store.submit(job.id, 'foreign', 'turn', 'assignment')).toBeNull();
  expect(await store.submit(job.id, 'root', 'old-turn', 'assignment')).toBeNull();
  expect(await store.submit(job.id, 'root', 'turn', 'assignment')).toMatchObject({
    state: 'routing',
    task: 'assignment',
  });
  expect(await store.submit(job.id, 'root', 'turn', 'changed assignment')).toBeNull();
  await store.decided(job.id, { action: 'model' });
  await store.fence('root', 'turn');
  expect(await store.accept(job.id, 'root', 'turn')).toBeNull();
});
it('never permits a second held assignment to take the first assignment’s window', async () => {
  dir = await mkdtemp(join(tmpdir(), 'tenjin-model-jobs-'));
  const store = new ModelJobStore(dir);
  const input = {
    sessionId: 'root',
    turnId: 'turn',
    callId: 'first',
    task: '',
    root: '/repo',
    native: { message: 'ciphertext' },
    decision: {},
    capAtomic: '1000000',
  };
  await store.offer(input, 'awaiting_prompt');
  await expect(store.offer({ ...input, callId: 'second' }, 'awaiting_prompt')).rejects.toThrow(
    'unresolved',
  );
});
