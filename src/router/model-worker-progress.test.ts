import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ModelWorkerActivity } from './model-worker-activity';
import { startWorkerProgress, workerProgressPath } from './model-worker-progress';

let dir: string;
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  dir = await mkdtemp(join(tmpdir(), 'tenjin-worker-progress-'));
});
afterEach(async () => {
  vi.useRealTimers();
  await rm(dir, { recursive: true, force: true });
});

function worker() {
  const binding = {
    parentSessionId: 'parent-session',
    root: join(dir, 'repo'),
    configDir: join(dir, 'native'),
    offerId: randomUUID(),
    workerHandle: 'tenjin-worker-' + randomUUID(),
    nativeProfile: 'general-purpose' as const,
    continuationId: randomUUID(),
    sdkSessionId: randomUUID(),
    generation: randomUUID(),
  };
  const activity = new ModelWorkerActivity({ dataDir: dir, binding });
  const tool = (id: string) => ({
    type: 'assistant',
    uuid: randomUUID(),
    session_id: binding.sdkSessionId,
    message: { id: randomUUID(), content: [{ type: 'tool_use', id, name: 'Read', input: {} }] },
  });
  const path = workerProgressPath(dir, binding.parentSessionId, binding.offerId);
  const read = async () => JSON.parse(await readFile(path, 'utf8'));
  return { binding, activity, tool, path, read };
}

it('writes the running activity and settled spend where the plugin reads it, then removes it', async () => {
  const w = worker();
  const sha = (text: string) => createHash('sha256').update(text).digest('hex');
  // The plugin computes this path itself (hosts/claude/tenjin/hooks/model-viewer.tsx).
  expect(w.path).toBe(
    join(
      dir,
      'progress',
      'model-workers',
      `${sha('parent-session')}-${sha(w.binding.offerId)}.json`,
    ),
  );
  const settled = { reservedAtomic: '8000', actualAtomic: '4300', uncertain: [] };
  const progress = startWorkerProgress({
    dataDir: dir,
    parentSessionId: w.binding.parentSessionId,
    offerId: w.binding.offerId,
    activity: w.activity,
    spend: async () => settled,
  });
  await vi.waitFor(async () =>
    expect(await w.read()).toMatchObject({
      status: 'activity',
      activity: { offerId: w.binding.offerId, state: 'starting', toolUses: 0, spend: settled },
    }),
  );
  expect((await stat(w.path)).mode & 0o777).toBe(0o600);
  w.activity.running();
  // The file carries the activity's whole window: the viewer's transcript adds rows up from it.
  for (let at = 0; at < 140; at++) w.activity.observe(w.tool('read-' + at));
  await vi.advanceTimersByTimeAsync(1000);
  await vi.waitFor(async () =>
    expect((await w.read()).activity).toMatchObject({
      state: 'running',
      toolUses: 140,
      droppedRows: 12,
    }),
  );
  expect((await w.read()).activity.rows).toHaveLength(128);
  await progress.stop();
  await expect(stat(w.path)).rejects.toThrow();
});

it('never writes again once stopped, even with a tick in flight', async () => {
  const w = worker();
  let settle!: (value: unknown) => void;
  const pending = new Promise((resolve) => {
    settle = resolve;
  });
  const progress = startWorkerProgress({
    dataDir: dir,
    parentSessionId: w.binding.parentSessionId,
    offerId: w.binding.offerId,
    activity: w.activity,
    spend: () => pending,
  });
  const stopped = progress.stop();
  settle({ accounting: 'unknown' });
  await stopped;
  await vi.advanceTimersByTimeAsync(5000);
  await expect(stat(w.path)).rejects.toThrow();
});

it('writes the activity without spend when the accounting cannot be read', async () => {
  const w = worker();
  const progress = startWorkerProgress({
    dataDir: dir,
    parentSessionId: w.binding.parentSessionId,
    offerId: w.binding.offerId,
    activity: w.activity,
    spend: async () => {
      throw new Error('Model accounting is unreadable; exposure is unknown');
    },
  });
  await vi.waitFor(async () => expect((await w.read()).activity.state).toBe('starting'));
  expect((await w.read()).activity).not.toHaveProperty('spend');
  await progress.stop();
});

it('removes only day-old files a crashed run left behind', async () => {
  const w = worker();
  const folder = join(dir, 'progress', 'model-workers');
  await mkdir(folder, { recursive: true });
  const stale = join(folder, `${'a'.repeat(64)}-${'b'.repeat(64)}.json`);
  const fresh = join(folder, `${'c'.repeat(64)}-${'d'.repeat(64)}.json`);
  const foreign = join(folder, 'notes.json');
  for (const path of [stale, fresh, foreign]) await writeFile(path, '{}');
  const old = new Date(Date.now() - 2 * 24 * 60 * 60_000);
  await utimes(stale, old, old);
  await utimes(foreign, old, old);
  const progress = startWorkerProgress({
    dataDir: dir,
    parentSessionId: w.binding.parentSessionId,
    offerId: w.binding.offerId,
    activity: w.activity,
    spend: async () => undefined,
  });
  await vi.waitFor(async () => expect(stat(stale)).rejects.toThrow());
  await expect(stat(fresh)).resolves.toBeTruthy();
  await expect(stat(foreign)).resolves.toBeTruthy();
  await progress.stop();
});
