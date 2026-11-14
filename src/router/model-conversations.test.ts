import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { ModelConversationStore } from './model-conversations';
import type { ModelJob } from './model-job';

let dir: string;
afterEach(async () => {
  vi.useRealTimers();
  if (dir) await rm(dir, { recursive: true, force: true });
});
async function fixture() {
  dir = await realpath(await mkdtemp(join(tmpdir(), 'tenjin-model-conversations-')));
  const root = join(dir, 'repo'),
    configDir = join(dir, 'claude-config'),
    dataDir = join(dir, 'data');
  for (const path of [root, configDir, dataDir]) await mkdir(path);
  const owner = { parentSessionId: 'parent-session', root, configDir };
  const job: ModelJob = {
    id: randomUUID(),
    sessionId: owner.parentSessionId,
    turnId: 'initial-turn',
    callId: 'initial-call',
    root,
    task: 'Implement exactly the accepted assignment.',
    native: { prompt: 'Implement exactly the accepted assignment.' },
    decision: {
      action: 'model',
      jobId: randomUUID(),
      routerOrigin: 'https://router.example',
      routingFeeAtomic: '3000',
    },
    capAtomic: '1000000',
    state: 'running',
    expiresAt: 1,
  };
  const store = new ModelConversationStore(dataDir),
    sdkSessionId = randomUUID();
  const conversation = await store.create({
    job,
    parentSessionId: owner.parentSessionId,
    configDir,
    sdkSessionId,
  });
  const followup = () => ({
    id: randomUUID(),
    parentTurnId: 'followup-turn',
    callId: 'followup-call',
    task: 'Verify the accepted implementation against the named cases.',
  });
  return { store, owner, job, sdkSessionId, conversation, followup, dataDir };
}

it('fences the initial activation, persists native identity and never resets the original budget', async () => {
  const f = await fixture(),
    handle = f.conversation.handle;
  const budgetDir = join(f.dataDir, 'model-jobs');
  await mkdir(budgetDir);
  const budget = join(budgetDir, `${f.job.id}.budget.json`),
    ledger = '{"charged":"700000","calls":{"uncertain":{"quote":"500000"}}}';
  await writeFile(budget, ledger);
  expect(handle).toMatch(/^tenjin-worker-[a-f0-9-]{36}$/);
  expect(handle).not.toContain(f.sdkSessionId);
  expect(await f.store.offer(handle, f.owner, f.followup())).toBeNull();
  const first = await f.store.accept(handle, f.owner, f.job.id);
  expect(first?.action).toBe('start');
  expect(await f.store.offer(handle, f.owner, f.followup())).toBeNull();
  expect(await f.store.finish(handle, f.owner, f.job.id, 'completed', 'initial result')).toBe(true);
  const restarted = new ModelConversationStore(f.dataDir);
  const kept = await restarted.lookup(handle, f.owner);
  expect(kept).toMatchObject({ state: 'idle', sdkSessionId: f.sdkSessionId, originalJob: f.job });
  const continuation = f.followup();
  expect(await restarted.offer(handle, f.owner, continuation)).toMatchObject(continuation);
  expect(await restarted.accept(handle, f.owner, continuation.id)).toMatchObject({
    action: 'start',
    conversation: { originalJob: f.job },
  });
  expect(await readFile(budget, 'utf8')).toBe(ledger);
  const registry = join(f.dataDir, 'model-conversations');
  expect((await stat(registry)).mode & 0o777).toBe(0o700);
  expect(
    (await stat(join(registry, handle.slice('tenjin-worker-'.length) + '.json'))).mode & 0o777,
  ).toBe(0o600);
});

it('claims one concurrent activation across stores and replays the completed result without another start', async () => {
  const f = await fixture();
  vi.useFakeTimers();
  const a = f.store.accept(f.conversation.handle, f.owner, f.job.id),
    b = new ModelConversationStore(f.dataDir).accept(f.conversation.handle, f.owner, f.job.id);
  expect((await Promise.race([a, b]))?.action).toBe('start');
  await vi.advanceTimersByTimeAsync(25);
  expect((await Promise.all([a, b])).filter((result) => result?.action === 'start')).toHaveLength(
    1,
  );
  expect(
    await f.store.finish(f.conversation.handle, f.owner, f.job.id, 'completed', 'kept result'),
  ).toBe(true);
  expect(await f.store.accept(f.conversation.handle, f.owner, f.job.id)).toEqual({
    action: 'replay',
    result: 'kept result',
  });
  expect(
    await f.store.finish(f.conversation.handle, f.owner, f.job.id, 'completed', 'changed result'),
  ).toBe(false);
});

it('binds follow-up text, call and turn immutably while retaining old result replay', async () => {
  const f = await fixture(),
    handle = f.conversation.handle;
  await f.store.accept(handle, f.owner, f.job.id);
  await f.store.finish(handle, f.owner, f.job.id, 'completed', 'first result');
  const followup = f.followup();
  expect(await f.store.offer(handle, f.owner, followup)).toMatchObject({ state: 'offered' });
  expect(await f.store.offer(handle, f.owner, followup)).toMatchObject(followup);
  for (const changed of [
    { task: 'Different task' },
    { parentTurnId: 'different-turn' },
    { callId: 'different-call' },
  ])
    expect(await f.store.offer(handle, f.owner, { ...followup, ...changed })).toBeNull();
  expect(await f.store.accept(handle, f.owner, f.job.id)).toEqual({
    action: 'replay',
    result: 'first result',
  });
  expect(await f.store.accept(handle, f.owner, followup.id)).toMatchObject({
    action: 'start',
    continuation: followup,
  });
});

it('allows a later follow-up after a declined unstarted offer without reviving its selection', async () => {
  const f = await fixture(),
    handle = f.conversation.handle;
  await f.store.accept(handle, f.owner, f.job.id);
  await f.store.finish(handle, f.owner, f.job.id, 'completed', 'initial history');
  const declined = f.followup();
  await f.store.offer(handle, f.owner, declined);
  expect(await f.store.fence(handle, f.owner, declined.id)).toBe(true);
  expect(await f.store.lookup(handle, f.owner)).toMatchObject({
    state: 'idle',
    originalJob: f.job,
  });
  expect(await f.store.accept(handle, f.owner, declined.id)).toBeNull();
  const later = { ...f.followup(), parentTurnId: 'later-turn' };
  expect(await f.store.offer(handle, f.owner, later)).toMatchObject({ state: 'offered' });
  expect(await f.store.accept(handle, f.owner, later.id)).toMatchObject({ action: 'start' });
});

it('supersedes only an unstarted follow-up and refuses every stale acceptance', async () => {
  const f = await fixture(),
    handle = f.conversation.handle;
  await f.store.accept(handle, f.owner, f.job.id);
  await f.store.finish(handle, f.owner, f.job.id, 'completed', 'initial history');
  const old = f.followup(),
    next = { ...f.followup(), parentTurnId: 'later-turn', callId: 'later-call' };
  await f.store.offer(handle, f.owner, old);
  expect(await f.store.offer(handle, f.owner, next)).toMatchObject({ state: 'offered' });
  expect(await f.store.accept(handle, f.owner, old.id)).toBeNull();
  expect(await f.store.fence(handle, f.owner, old.id)).toBe(false);
  expect(await f.store.accept(handle, f.owner, next.id)).toMatchObject({ action: 'start' });
  expect(await f.store.offer(handle, f.owner, f.followup())).toBeNull();
  expect(await f.store.accept(handle, f.owner, old.id)).toBeNull();
});

it('keeps the unstarted initial activation closed after fencing', async () => {
  const f = await fixture(),
    handle = f.conversation.handle;
  expect(await f.store.offer(handle, f.owner, f.followup())).toBeNull();
  expect(await f.store.fence(handle, f.owner, f.job.id)).toBe(true);
  expect(await f.store.lookup(handle, f.owner)).toMatchObject({ state: 'cancelled' });
  expect(await f.store.accept(handle, f.owner, f.job.id)).toBeNull();
  expect(await f.store.offer(handle, f.owner, f.followup())).toBeNull();
});

it('finds only the owned original job through a valid immutable index', async () => {
  const f = await fixture();
  expect(await f.store.findByJob(f.job.id, f.owner)).toEqual(f.conversation);
  expect(await f.store.findByJob(f.job.id, { ...f.owner, parentSessionId: 'foreign' })).toBeNull();
  expect(await f.store.findByJob('../not-a-job', f.owner)).toBeNull();
  expect(await f.store.findByJob(randomUUID(), f.owner)).toBeNull();
  const alias = randomUUID();
  await writeFile(
    join(f.dataDir, 'model-conversations', `job-${alias}.json`),
    JSON.stringify({ handle: f.conversation.handle }),
  );
  expect(await f.store.findByJob(alias, f.owner)).toBeNull();
  await writeFile(join(f.dataDir, 'model-conversations', `job-${f.job.id}.json`), '{broken');
  expect(await f.store.findByJob(f.job.id, f.owner)).toBeNull();
});

it('recovers only a durably completed local result after a crash before reopening selection', async () => {
  const f = await fixture(),
    handle = f.conversation.handle;
  await f.store.accept(handle, f.owner, f.job.id);
  await f.store.finish(handle, f.owner, f.job.id, 'completed', 'fully drained result');
  const file = join(
    f.dataDir,
    'model-conversations',
    handle.slice('tenjin-worker-'.length) + '.json',
  );
  const completed = JSON.parse(await readFile(file, 'utf8'));
  await writeFile(file, JSON.stringify({ ...completed, state: 'running' }));
  const restarted = new ModelConversationStore(f.dataDir);
  expect(await restarted.accept(handle, f.owner, f.job.id)).toEqual({
    action: 'replay',
    result: 'fully drained result',
  });
  expect(await restarted.offer(handle, f.owner, f.followup())).toMatchObject({ state: 'offered' });
});

it('stores and exactly replays a maximum raw worker result after two JSON escaping layers', async () => {
  const f = await fixture(),
    handle = f.conversation.handle;
  const raw = '\0'.repeat(224_000) + '"\\'.repeat(16_000);
  expect(Buffer.byteLength(raw)).toBe(256_000);
  const envelope = JSON.stringify({
    status: 'completed',
    worker_handle: handle,
    elapsedMs: 1,
    spend: { actualAtomic: '100000', uncertain: [] },
    result: raw,
  });
  expect(Buffer.byteLength(envelope)).toBeGreaterThan(1_000_000);
  await f.store.accept(handle, f.owner, f.job.id);
  expect(await f.store.finish(handle, f.owner, f.job.id, 'completed', envelope)).toBe(true);
  const restarted = new ModelConversationStore(f.dataDir);
  expect(await restarted.accept(handle, f.owner, f.job.id)).toEqual({
    action: 'replay',
    result: envelope,
  });
  expect(await restarted.lookup(handle, f.owner)).toMatchObject({ state: 'idle' });
});

it.each(['cancelled', 'unknown'] as const)(
  'refuses another activation after %s and preserves the original identity',
  async (state) => {
    const f = await fixture(),
      handle = f.conversation.handle;
    await f.store.accept(handle, f.owner, f.job.id);
    expect(await f.store.finish(handle, f.owner, f.job.id, state)).toBe(true);
    const restarted = new ModelConversationStore(f.dataDir);
    expect(await restarted.accept(handle, f.owner, f.job.id)).toBeNull();
    expect(await restarted.offer(handle, f.owner, f.followup())).toBeNull();
    expect(await restarted.lookup(handle, f.owner)).toMatchObject({ state, originalJob: f.job });
  },
);

it('refuses crashed running selections and prevents late completion from reopening a fenced worker', async () => {
  const f = await fixture(),
    handle = f.conversation.handle;
  await f.store.accept(handle, f.owner, f.job.id);
  const restarted = new ModelConversationStore(f.dataDir);
  expect(await restarted.accept(handle, f.owner, f.job.id)).toBeNull();
  expect(await restarted.offer(handle, f.owner, f.followup())).toBeNull();
  expect(await restarted.fence(handle, f.owner, f.job.id)).toBe(true);
  expect(await f.store.finish(handle, f.owner, f.job.id, 'completed', 'late result')).toBe(false);
  expect(await restarted.offer(handle, f.owner, f.followup())).toBeNull();
});

it('rejects foreign sessions, roots, config directories and malformed or unreadable handles', async () => {
  const f = await fixture(),
    handle = f.conversation.handle;
  const elsewhere = join(dir, 'elsewhere');
  await mkdir(elsewhere);
  for (const owner of [
    { ...f.owner, parentSessionId: 'foreign' },
    { ...f.owner, root: elsewhere },
    { ...f.owner, configDir: elsewhere },
  ]) {
    expect(await f.store.lookup(handle, owner)).toBeNull();
    expect(await f.store.accept(handle, owner, f.job.id)).toBeNull();
    expect(await f.store.fence(handle, owner, f.job.id)).toBe(false);
  }
  for (const invalid of [
    'native-agent',
    'tenjin-worker-../../foreign',
    'tenjin-worker-' + randomUUID(),
  ])
    expect(await f.store.lookup(invalid, f.owner)).toBeNull();
  const alias = join(dir, 'repo-alias');
  await symlink(f.owner.root, alias);
  expect(await f.store.lookup(handle, { ...f.owner, root: alias })).toMatchObject({
    root: f.owner.root,
  });
  const file = join(
    f.dataDir,
    'model-conversations',
    handle.slice('tenjin-worker-'.length) + '.json',
  );
  await writeFile(file, '{broken');
  expect(await f.store.lookup(handle, f.owner)).toBeNull();
  await expect(
    f.store.create({
      job: f.job,
      parentSessionId: f.owner.parentSessionId,
      configDir: f.owner.configDir,
      sdkSessionId: f.sdkSessionId,
    }),
  ).rejects.toThrow('Existing conversation');
});

it('keeps an initial job identity immutable and rejects missing config or oversized result data', async () => {
  const f = await fixture(),
    handle = f.conversation.handle;
  expect(
    await f.store.create({
      job: f.job,
      parentSessionId: f.owner.parentSessionId,
      configDir: f.owner.configDir,
      sdkSessionId: f.sdkSessionId,
    }),
  ).toEqual(f.conversation);
  await expect(
    f.store.create({
      job: { ...f.job, capAtomic: '9999999' },
      parentSessionId: f.owner.parentSessionId,
      configDir: f.owner.configDir,
      sdkSessionId: f.sdkSessionId,
    }),
  ).rejects.toThrow('identity');
  expect(await f.store.lookup(handle, { ...f.owner, configDir: join(dir, 'missing') })).toBeNull();
  await f.store.accept(handle, f.owner, f.job.id);
  expect(await f.store.finish(handle, f.owner, f.job.id, 'completed', 'x'.repeat(2_000_001))).toBe(
    false,
  );
  expect(await f.store.lookup(handle, f.owner)).toMatchObject({ state: 'running' });
});
