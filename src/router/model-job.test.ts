import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { ModelJobStore } from './model-job';
let dir: string;
afterEach(async () => {
  vi.restoreAllMocks();
  if (dir) await rm(dir, { recursive: true, force: true });
});

async function initialNativeJob() {
  dir = await mkdtemp(join(tmpdir(), 'tenjin-model-native-choice-'));
  const store = new ModelJobStore(dir);
  const input = {
    sessionId: 'root',
    turnId: 'turn',
    callId: 'original-call',
    task: 'Read the exact command.\nReturn JSON.\nFINAL LINE',
    root: '/repo',
    native: {
      prompt: 'Read the exact command.\nReturn JSON.\nFINAL LINE',
      description: 'Original description',
      subagent_type: 'Explore',
      model: 'sonnet',
      max_turns: 73,
    },
    nativeTool: 'Agent' as const,
    nativeReplaySupported: true as const,
    decision: { action: 'model', routerOrigin: 'https://router.example' },
    capAtomic: '1000000',
  };
  return { store, input, job: await store.offer(input) };
}

it('does not persist replay windows for turns with no delegation', async () => {
  dir = await mkdtemp(join(tmpdir(), 'tenjin-model-unused-fence-'));
  const store = new ModelJobStore(dir);
  await store.fence('unused-session', 'unused-turn', 'cancelling');
  await store.fence('unused-session', 'unused-turn');
  expect(await readdir(dir)).toEqual([]);
});

it('restores exactly one saved initial call and checks every native-choice owner binding', async () => {
  const { store, input, job } = await initialNativeJob();
  for (const [id, session, turn, root, tool] of [
    ['00000000-0000-4000-8000-000000000001', 'root', 'turn', '/repo', 'Agent'],
    [job.id, 'foreign', 'turn', '/repo', 'Agent'],
    [job.id, 'root', 'foreign', '/repo', 'Agent'],
    [job.id, 'root', 'turn', '/sibling', 'Agent'],
    [job.id, 'root', 'turn', '/repo', 'Task'],
  ] as const)
    expect(await store.chooseNative(id, session, turn, root, tool, 'future-call')).toBeNull();
  expect(
    await store.chooseNative(job.id, 'root', 'turn', '/repo', 'Agent', 'future-call'),
  ).toMatchObject({
    state: 'native',
    native: input.native,
  });
  expect(
    await store.chooseNative(job.id, 'root', 'turn', '/repo', 'Agent', 'future-call'),
  ).toBeNull();
  expect(await store.accept(job.id, 'root', 'turn')).toBeNull();
});

it('serializes short native selection against acceptance across stores with exactly one winner', async () => {
  const { store, job } = await initialNativeJob();
  const other = new ModelJobStore(dir);
  const outcomes = await Promise.all([
    store.chooseNative(job.id, 'root', 'turn', '/repo', 'Agent', 'future-call'),
    other.accept(job.id, 'root', 'turn'),
  ]);
  expect(outcomes.filter(Boolean)).toHaveLength(1);
  expect((await store.pending('root', 'turn'))?.state).toBe(outcomes[0] ? 'native' : 'running');
});

it.each([false, true])(
  'allows an exact full retry once after a failed short replay (fenced: %s)',
  async (fenced) => {
    const { store, input, job } = await initialNativeJob();
    await store.chooseNative(job.id, 'root', 'turn', '/repo', 'Agent', 'future-call');
    if (fenced) await store.fence('root', 'turn');
    expect(await store.nativeRetry('root', 'turn', input.native)).toBe(false);
    expect(await store.nativeRetry('root', 'turn', input.native, undefined, 'Task')).toBe(false);
    expect(
      await store.nativeRetry(
        'root',
        'turn',
        { ...input.native, max_turns: 1 },
        undefined,
        'Agent',
      ),
    ).toBe(false);
    expect(await store.nativeRetry('root', 'turn', input.native, undefined, 'Agent')).toBe(true);
    expect(await store.nativeRetry('root', 'turn', input.native, undefined, 'Agent')).toBe(false);
    expect(
      await store.consumeNativeReplay(
        'root',
        'turn',
        '/repo',
        'Agent',
        'future-call',
        input.native,
      ),
    ).toBe('refused');
    expect(await store.accept(job.id, 'root', 'turn')).toBeNull();
  },
);

it('serializes an exact full retry against the pre-stream replay without duplicate native execution', async () => {
  const { store, input, job } = await initialNativeJob();
  await store.chooseNative(job.id, 'root', 'turn', '/repo', 'Agent', 'future-call');
  const outcomes = await Promise.all([
    store.nativeRetry('root', 'turn', input.native, undefined, 'Agent'),
    new ModelJobStore(dir).consumeNativeReplay(
      'root',
      'turn',
      '/repo',
      'Agent',
      'future-call',
      input.native,
    ),
  ]);
  expect(outcomes.filter((value) => value === true || value === 'allow')).toHaveLength(1);
  expect(
    await store.consumeNativeReplay('root', 'turn', '/repo', 'Agent', 'future-call', input.native),
  ).toBe('refused');
});

it('permits exactly one full replay and refuses changed owner, tool or arguments without consuming it', async () => {
  const { store, input, job } = await initialNativeJob();
  await store.chooseNative(job.id, 'root', 'turn', '/repo', 'Agent', 'future-call');
  const attempts = [
    ['foreign', 'turn', '/repo', 'Agent', input.native],
    ['root', 'foreign', '/repo', 'Agent', input.native],
    ['root', 'turn', '/other', 'Agent', input.native],
    ['root', 'turn', '/repo', 'Task', input.native],
    ['root', 'turn', '/repo', 'Agent', { ...input.native, prompt: 'truncated' }],
    ['root', 'turn', '/repo', 'Agent', { ...input.native, max_turns: 1 }],
  ] as const;
  for (const [session, turn, root, tool, native] of attempts)
    expect(await store.consumeNativeReplay(session, turn, root, tool, 'future-call', native)).toBe(
      'refused',
    );
  const competing = await Promise.all([
    store.consumeNativeReplay('root', 'turn', '/repo', 'Agent', 'future-call', input.native),
    new ModelJobStore(dir).consumeNativeReplay(
      'root',
      'turn',
      '/repo',
      'Agent',
      'future-call',
      input.native,
    ),
  ]);
  expect(competing.sort()).toEqual(['allow', 'refused']);
  expect(
    await store.consumeNativeReplay('root', 'turn', '/repo', 'Agent', 'unrelated', input.native),
  ).toBe('none');
});

it.each([false, true])(
  'keeps a selected replay one-shot after the pending window rotates (already consumed: %s)',
  async (consumed) => {
    const { store, input, job } = await initialNativeJob();
    await store.chooseNative(job.id, 'root', 'turn', '/repo', 'Agent', 'old-replay');
    if (consumed)
      expect(
        await store.consumeNativeReplay(
          'root',
          'turn',
          '/repo',
          'Agent',
          'old-replay',
          input.native,
        ),
      ).toBe('allow');
    const next = await store.offer({ ...input, callId: 'next-call' });
    expect(
      await store.consumeNativeReplay('root', 'turn', '/repo', 'Agent', 'old-replay', input.native),
    ).toBe(consumed ? 'refused' : 'allow');
    expect(
      await store.consumeNativeReplay('root', 'turn', '/repo', 'Agent', 'old-replay', input.native),
    ).toBe('refused');
    expect(
      await store.chooseNative(next.id, 'root', 'turn', '/repo', 'Agent', 'old-replay'),
    ).toBeNull();
    expect((await store.pending('root', 'turn'))?.id).toBe(next.id);
  },
);

it('durably fences older replay tickets across window rotation and permits a fresh later choice', async () => {
  const { store, input, job } = await initialNativeJob();
  await store.chooseNative(job.id, 'root', 'turn', '/repo', 'Agent', 'before-cancel');
  await store.offer({ ...input, callId: 'rotated' });
  await store.fence('root', 'turn');
  const restarted = new ModelJobStore(dir);
  expect(
    await restarted.consumeNativeReplay(
      'root',
      'turn',
      '/repo',
      'Agent',
      'before-cancel',
      input.native,
    ),
  ).toBe('refused');
  // Legacy full retries still finish the cancelled window without a marker.
  expect(await restarted.nativeRetry('root', 'turn', input.native)).toBe(true);
  const next = await restarted.offer({ ...input, callId: 'fresh-after-cancel' });
  expect(
    await restarted.chooseNative(next.id, 'root', 'turn', '/repo', 'Agent', 'after-cancel'),
  ).not.toBeNull();
  expect(
    await restarted.consumeNativeReplay(
      'root',
      'turn',
      '/repo',
      'Agent',
      'after-cancel',
      input.native,
    ),
  ).toBe('allow');
});

it('refuses changed saved arguments and missing window generations for an indexed replay', async () => {
  const { store, input, job } = await initialNativeJob();
  await store.chooseNative(job.id, 'root', 'turn', '/repo', 'Agent', 'future-call');
  const path = join(dir, 'model-jobs', `${job.id}.json`);
  const saved = await readFile(path, 'utf8');
  const changed = JSON.parse(saved);
  changed.native.description = 'changed after selection';
  await writeFile(path, JSON.stringify(changed));
  expect(await store.nativeRetry('root', 'turn', changed.native, undefined, 'Agent')).toBe(false);
  expect(
    await store.consumeNativeReplay('root', 'turn', '/repo', 'Agent', 'future-call', input.native),
  ).toBe('refused');
  await writeFile(path, saved);
  const names = await readdir(join(dir, 'model-jobs'));
  const windowPath = join(
    dir,
    'model-jobs',
    names.find((name) => name.startsWith('window-'))!,
  );
  const windowState = JSON.parse(await readFile(windowPath, 'utf8'));
  delete windowState.replayEpoch;
  await writeFile(windowPath, JSON.stringify(windowState));
  expect(
    await store.consumeNativeReplay('root', 'turn', '/repo', 'Agent', 'future-call', input.native),
  ).toBe('refused');
});

it('refuses an expired ID and an old ID after a later call owns the window', async () => {
  const { store, input, job } = await initialNativeJob();
  const now = Date.now();
  vi.spyOn(Date, 'now').mockReturnValue(job.expiresAt);
  expect(
    await store.chooseNative(job.id, 'root', 'turn', '/repo', 'Agent', 'future-call'),
  ).toBeNull();
  vi.spyOn(Date, 'now').mockReturnValue(now);
  await store.accept(job.id, 'root', 'turn');
  await store.finish(job.id, 'completed');
  const next = await store.offer({ ...input, callId: 'next-call' });
  expect(
    await store.chooseNative(job.id, 'root', 'turn', '/repo', 'Agent', 'future-call'),
  ).toBeNull();
  expect(
    await store.chooseNative(next.id, 'root', 'turn', '/repo', 'Agent', 'next-future-call'),
  ).not.toBeNull();
});

it.each([
  { name: 'legacy unbound call', nativeTool: undefined },
  { name: 'continuation', decision: { workerHandle: 'tenjin-worker-owned' } },
  { name: 'resume address', native: { prompt: 'X', resume: 'tenjin-worker-owned' } },
  { name: 'reserved tool', native: { prompt: 'X', tool: 'Bash' } },
  { name: 'reserved call ID', native: { prompt: 'X', tool_use_id: 'old-call' } },
  { name: 'reserved agent ID', native: { prompt: 'X', agentId: 'child' } },
  { name: 'recursive marker', native: { prompt: 'tenjin-native:unavailable' } },
])('never replays a $name by short ID', async ({ name: _name, ...overrides }) => {
  const { store, input } = await initialNativeJob();
  await store.fence('root', 'turn');
  const other = new ModelJobStore(dir);
  const job = await other.offer({ ...input, ...overrides, turnId: 'separate', callId: 'separate' });
  expect(
    await store.chooseNative(job.id, 'root', 'separate', '/repo', 'Agent', 'future-call'),
  ).toBeNull();
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
