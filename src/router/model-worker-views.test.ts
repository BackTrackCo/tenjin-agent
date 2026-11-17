import { randomUUID } from 'node:crypto';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ModelWorkerActivity } from './model-worker-activity';
import { ModelWorkerViews } from './model-worker-views';

const directories: string[] = [];
const registries: ModelWorkerViews[] = [];
beforeEach(() => vi.useFakeTimers());
afterEach(async () => {
  await Promise.allSettled(registries.splice(0).map((registry) => registry.shutdown()));
  vi.restoreAllMocks();
  vi.useRealTimers();
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function fixture() {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'tenjin-worker-views-')));
  directories.push(dir);
  const views = new ModelWorkerViews();
  registries.push(views);
  const activity = () => {
    const result = new ModelWorkerActivity({
      dataDir: join(dir, 'data'),
      binding: {
        parentSessionId: 'owned-parent',
        root: dir,
        configDir: dir,
        offerId: randomUUID(),
        workerHandle: 'tenjin-worker-' + randomUUID(),
        continuationId: randomUUID(),
        sdkSessionId: randomUUID(),
        nativeProfile: 'general-purpose',
        generation: randomUUID(),
      },
    });
    return result;
  };
  return { views, activity };
}

it('waits when the native mirror precedes begin and resolves only when the controller finishes', async () => {
  const f = await fixture();
  const follow = f.views.follow('job-one', new AbortController().signal);
  let resolved = false;
  void follow.then(() => {
    resolved = true;
  });
  await Promise.resolve();
  expect(f.views.get('job-one')).toBeUndefined();
  expect(resolved).toBe(false);
  const activity = f.views.begin('job-one', f.activity)!;
  activity.running();
  await vi.advanceTimersByTimeAsync(31_000);
  expect(resolved).toBe(false);
  activity.finish('completed', { reservedAtomic: '8000', actualAtomic: '4300', uncertain: [] });
  f.views.finished('job-one');
  await expect(follow).resolves.toMatchObject({
    state: 'completed',
    spend: { reservedAtomic: '8000', actualAtomic: '4300' },
  });
  expect(vi.getTimerCount()).toBe(0);
});

// The DeepSeek viewer could only learn a worker's end: a follow did not wake when the
// worker's activity moved, so its transcript could not grow as the worker ran.
it('wakes a reader waiting past a sequence when the activity moves, while one without it waits for the end', async () => {
  const f = await fixture();
  const activity = f.views.begin('job-live', f.activity)!;
  activity.running();
  const seen = activity.snapshot().sequence;
  let ended = false;
  const toTheEnd = f.views.follow('job-live', new AbortController().signal).then((snapshot) => {
    ended = true;
    return snapshot;
  });
  const next = f.views.follow('job-live', new AbortController().signal, seen);
  const alsoNext = f.views.follow('job-live', new AbortController().signal, seen);
  activity.observe({
    type: 'assistant',
    uuid: 'turn-one',
    session_id: activity.snapshot().binding.sdkSessionId,
    message: {
      id: 'message-1',
      usage: { input_tokens: 10, output_tokens: 5 },
      content: [{ type: 'tool_use', id: 'read-1', name: 'Read', input: { file_path: '/a' } }],
    },
  });
  for (const woke of await Promise.all([next, alsoNext])) {
    expect(woke!.sequence).toBeGreaterThan(seen);
    expect(woke!.rows).toEqual([expect.objectContaining({ name: 'Read' })]);
  }
  // Already past it: answered at once, with no wait.
  await expect(f.views.follow('job-live', new AbortController().signal, seen)).resolves.toEqual(
    expect.objectContaining({ state: 'running' }),
  );
  await Promise.resolve();
  expect(ended).toBe(false);
  activity.finish('completed');
  f.views.finished('job-live');
  await expect(toTheEnd).resolves.toMatchObject({ state: 'completed' });
  expect(vi.getTimerCount()).toBe(0);
});

it('expires only the before-start UI wait, allowing the controller to begin later unchanged', async () => {
  const f = await fixture();
  const create = vi.fn(f.activity);
  const follow = f.views.follow('not-started', new AbortController().signal);
  let resolved = false;
  void follow.then(() => {
    resolved = true;
  });
  await vi.advanceTimersByTimeAsync(29_999);
  expect(resolved).toBe(false);
  expect(create).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  await expect(follow).resolves.toBeNull();
  expect(f.views.begin('not-started', create)).toBeInstanceOf(ModelWorkerActivity);
  expect(create).toHaveBeenCalledOnce();
});

it('aborting a native mirror does not cancel or finish its active DeepSeek observation', async () => {
  const f = await fixture();
  const activity = f.views.begin('running', f.activity)!;
  activity.running();
  const finish = vi.spyOn(activity, 'finish');
  const before = activity.snapshot();
  const client = new AbortController();
  const follow = f.views.follow('running', client.signal);
  client.abort();
  await expect(follow).resolves.toBeNull();
  expect(activity.snapshot()).toEqual(before);
  expect(finish).not.toHaveBeenCalled();
  expect(f.views.get('running')).toBe(activity);
});

it('releases only the pre-start waiter that gave up, and bounds how many may wait on one worker', async () => {
  const f = await fixture();
  const firstClient = new AbortController();
  const secondClient = new AbortController();
  const follow = f.views.follow('pending', firstClient.signal);
  // A second reader waits beside the first, never in its place.
  const second = f.views.follow('pending', secondClient.signal);
  const more = [new AbortController(), new AbortController()];
  const others = more.map((client) => f.views.follow('pending', client.signal));
  await expect(f.views.follow('pending', new AbortController().signal)).resolves.toBeNull();
  secondClient.abort();
  await expect(second).resolves.toBeNull();
  for (const client of more) client.abort();
  await expect(Promise.all(others)).resolves.toEqual([null, null]);
  expect(vi.getTimerCount()).toBe(1);
  firstClient.abort();
  await expect(follow).resolves.toBeNull();
  expect(vi.getTimerCount()).toBe(0);
  expect(f.views.begin('pending', f.activity)).toBeInstanceOf(ModelWorkerActivity);
});

it('keeps a hard sixteen-active cap without calling the seventeenth observer factory', async () => {
  const f = await fixture();
  for (let n = 0; n < 16; n++)
    expect(f.views.begin('active-' + n, f.activity)).toBeInstanceOf(ModelWorkerActivity);
  const create = vi.fn(f.activity);
  expect(f.views.begin('seventeenth', create)).toBeUndefined();
  await expect(f.views.follow('seventeenth', new AbortController().signal)).resolves.toBeNull();
  expect(create).not.toHaveBeenCalled();
  const old = f.views.get('active-0')!;
  old.finish('completed');
  f.views.finished('active-0');
  expect(f.views.begin('seventeenth', create)).toBeInstanceOf(ModelWorkerActivity);
  expect(f.views.get('active-0')).toBeUndefined();
  expect(create).toHaveBeenCalledOnce();
});

it('bounds pending-before-start waiters as well as activities', async () => {
  const f = await fixture();
  const clients = Array.from({ length: 16 }, () => new AbortController());
  const waits = clients.map((client, n) => f.views.follow('pending-' + n, client.signal));
  await expect(f.views.follow('overflow', new AbortController().signal)).resolves.toBeNull();
  expect(vi.getTimerCount()).toBe(16);
  clients[0]!.abort();
  expect(f.views.begin('replacement', f.activity)).toBeInstanceOf(ModelWorkerActivity);
  await f.views.shutdown();
  await expect(Promise.all(waits)).resolves.toEqual(Array(16).fill(null));
  expect(vi.getTimerCount()).toBe(0);
});

it('returns a completed snapshot on replay without recreating or reactivating the observer', async () => {
  const f = await fixture();
  const create = vi.fn(f.activity);
  const activity = f.views.begin('done', create)!;
  const finish = vi.spyOn(activity, 'finish');
  activity.finish('completed');
  f.views.finished('done');
  expect(f.views.begin('done', create)).toBe(activity);
  const replay = await f.views.follow('done', new AbortController().signal);
  expect(replay?.state).toBe('completed');
  replay!.rows.push({ id: 'mutated', sequence: 99, kind: 'status', state: 'error' });
  expect(activity.snapshot().rows).toHaveLength(0);
  expect(create).toHaveBeenCalledOnce();
  expect(finish).toHaveBeenCalledOnce();
});

it('finishes pending mirrors when execution is refused before any projection exists', async () => {
  const f = await fixture();
  const waiting = f.views.follow('refused', new AbortController().signal);
  f.views.finished('refused');
  await expect(waiting).resolves.toBeNull();
  const create = vi.fn(f.activity);
  expect(f.views.begin('refused', create)).toBeUndefined();
  await expect(f.views.follow('refused', new AbortController().signal)).resolves.toBeNull();
  expect(create).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

it('treats a failed observer factory as absent display data without retrying or claiming early completion', async () => {
  const f = await fixture();
  const create = vi.fn(() => {
    throw new Error('private-observer-error');
  });
  expect(() => f.views.begin('broken', create)).not.toThrow();
  expect(f.views.begin('broken', create)).toBeUndefined();
  expect(create).toHaveBeenCalledOnce();
  const follow = f.views.follow('broken', new AbortController().signal);
  let resolved = false;
  void follow.then(() => {
    resolved = true;
  });
  await vi.advanceTimersByTimeAsync(31_000);
  expect(resolved).toBe(false);
  f.views.finished('broken');
  await expect(follow).resolves.toBeNull();
});

it('contains snapshot failures and never turns the display failure into an execution action', async () => {
  const f = await fixture();
  const activity = f.views.begin('broken-snapshot', f.activity)!;
  const finish = vi.spyOn(activity, 'finish');
  vi.spyOn(activity, 'snapshot').mockImplementation(() => {
    throw new Error('private-view-error');
  });
  const follow = f.views.follow('broken-snapshot', new AbortController().signal);
  expect(() => f.views.finished('broken-snapshot')).not.toThrow();
  await expect(follow).resolves.toBeNull();
  await expect(f.views.follow('broken-snapshot', new AbortController().signal)).resolves.toBeNull();
  expect(finish).not.toHaveBeenCalled();
});

it('shutdown resolves waiters once and never invokes worker completion or later factories', async () => {
  const f = await fixture();
  const activity = f.views.begin('active', f.activity)!;
  const finish = vi.spyOn(activity, 'finish');
  const active = f.views.follow('active', new AbortController().signal);
  const pending = f.views.follow('pending', new AbortController().signal);
  const shutdown = f.views.shutdown();
  expect(f.views.shutdown()).toBe(shutdown);
  await expect(active).resolves.toBeNull();
  await expect(pending).resolves.toBeNull();
  expect(vi.getTimerCount()).toBe(0);
  expect(finish).not.toHaveBeenCalled();
  const create = vi.fn(f.activity);
  expect(f.views.begin('after-shutdown', create)).toBeUndefined();
  expect(f.views.get('active')).toBeUndefined();
  await expect(f.views.follow('active', new AbortController().signal)).resolves.toBeNull();
  expect(create).not.toHaveBeenCalled();
  await expect(shutdown).resolves.toBeUndefined();
});
