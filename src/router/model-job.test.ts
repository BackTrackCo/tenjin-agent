import { mkdir, mkdtemp, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { MODEL_RECORD_TTL_MS, ModelJobStore, sweepModelRecords } from './model-job';
import { canonicalHash } from '../lib/request-schema';
let dir: string;
afterEach(async () => {
  vi.restoreAllMocks();
  if (dir) await rm(dir, { recursive: true, force: true });
});

const HELD = {
  prompt: 'Read the exact command.\nReturn JSON.\nFINAL LINE',
  description: 'Original description',
  model: 'sonnet',
};

async function heldAgentCall() {
  dir = await mkdtemp(join(tmpdir(), 'tenjin-model-repeat-'));
  const store = new ModelJobStore(dir);
  const job = await store.offer({
    sessionId: 'root',
    turnId: 'turn',
    callId: 'original-call',
    task: HELD.prompt,
    root: '/repo',
    native: HELD,
    nativeTool: 'Agent',
    decision: { action: 'model' },
    capAtomic: '1000000',
  });
  return { store, job };
}

it('does not persist windows for turns with no delegation', async () => {
  dir = await mkdtemp(join(tmpdir(), 'tenjin-model-unused-fence-'));
  const store = new ModelJobStore(dir);
  await store.fence('unused-session', 'unused-turn', 'cancelling');
  await store.fence('unused-session', 'unused-turn');
  expect(await readdir(dir)).toEqual([]);
});

it('keeps a held Agent call native once when it is sent again unchanged, in a later turn too', async () => {
  const { store, job } = await heldAgentCall();
  // Key order, surrounding whitespace and fields at their defaults leave the call unchanged.
  const repeat = {
    model: 'sonnet',
    description: ' Original description',
    prompt: `${HELD.prompt}\n`,
    subagent_type: 'general-purpose',
    run_in_background: false,
  };
  expect(await store.nativeRepeat('root', '/repo', 'Agent', repeat)).toBe(job.id);
  expect(await store.nativeRepeat('root', '/repo', 'Agent', repeat)).toBeNull();
  expect(await store.nativeRepeat('root', '/repo', 'Agent', HELD)).toBeNull();
  expect(await store.accept(job.id, 'root', 'turn')).toBeNull();
});

it('treats a changed, foreign, other-root or other-tool call as a new call and leaves the repeat unused', async () => {
  const { store } = await heldAgentCall();
  for (const [session, root, tool, native] of [
    ['root', '/repo', 'Agent', { ...HELD, prompt: HELD.prompt.replace('exact', 'whole') }],
    ['root', '/repo', 'Agent', { ...HELD, prompt: HELD.prompt.replace('\n', '\n\n') }],
    ['root', '/repo', 'Agent', { ...HELD, description: 'Another description' }],
    ['root', '/repo', 'Agent', { prompt: HELD.prompt, description: HELD.description }],
    ['root', '/repo', 'Agent', { ...HELD, subagent_type: 'Explore' }],
    ['root', '/repo', 'Agent', { ...HELD, run_in_background: true }],
    ['root', '/repo', 'Task', HELD],
    ['root', '/sibling', 'Agent', HELD],
    ['foreign', '/repo', 'Agent', HELD],
  ] as const)
    expect(await store.nativeRepeat(session, root, tool, native)).toBeNull();
  expect(await store.nativeRepeat('root', '/repo', 'Agent', HELD)).toBeTruthy();
});

it('repeats free until the offer expires, with no turn read, and for as long again after its worker stopped', async () => {
  const { store, job } = await heldAgentCall();
  const now = vi.spyOn(Date, 'now');
  // A session woken by task notifications stays in one turn for hours: the offer still ends.
  now.mockReturnValue(job.expiresAt);
  expect(await store.nativeRepeat('root', '/repo', 'Agent', HELD)).toBeNull();
  // An accepted worker that stopped later than that leaves its call a free repeat from then.
  now.mockReturnValue(job.expiresAt - 1);
  await store.accept(job.id, 'root');
  now.mockReturnValue(job.expiresAt + 20 * 60_000);
  await store.finish(job.id, 'unknown');
  now.mockReturnValue(job.expiresAt + 34 * 60_000);
  expect(await store.nativeRepeat('root', '/repo', 'Agent', HELD)).toBe(job.id);
});

it('gives two calls of one turn a job each, and the same call seen twice one job', async () => {
  const { store, job } = await heldAgentCall();
  const second = { ...job, callId: 'second-call', native: { prompt: 'Another task' } };
  const other = await store.offer({ ...second, task: 'Another task' }, 'routing');
  expect(other.id).not.toBe(job.id);
  // The first is untouched by the second, and each is accepted by its own id.
  expect((await store.owned(job.id, 'root'))?.state).toBe('offered');
  expect(await store.offer({ ...second, task: 'Another task' }, 'routing')).toMatchObject({
    id: other.id,
  });
  await store.decided(other.id, { action: 'model' });
  expect((await store.accept(other.id, 'root'))?.id).toBe(other.id);
  // A third call is offered while that worker runs.
  const third = await store.offer({ ...second, callId: 'third-call' });
  expect((await store.accept(third.id, 'root'))?.id).toBe(third.id);
  expect((await store.accept(job.id, 'root'))?.id).toBe(job.id);
  // Cancelling one leaves the others running.
  await store.fenceOwned(third.id, 'root');
  expect((await store.unfinished()).map((left) => left.id).sort()).toEqual(
    [job.id, other.id].sort(),
  );
});

it('settles one of two open offers for identical assignments a repeat, the oldest first', async () => {
  const { store, job } = await heldAgentCall();
  const twin = await store.offer({ ...job, callId: 'twin-call', step: 'turn:0' });
  expect(twin.id).not.toBe(job.id);
  // A call the same model request made was written before either offer was read.
  expect(await store.nativeRepeat('root', '/repo', 'Agent', HELD, 'turn:0')).toBe(job.id);
  expect(await store.nativeRepeat('root', '/repo', 'Agent', HELD, 'turn:0')).toBeNull();
  expect((await store.owned(twin.id, 'root'))?.state).toBe('offered');
  expect(await store.nativeRepeat('root', '/repo', 'Agent', HELD, 'turn:1')).toBe(twin.id);
  expect(await store.nativeRepeat('root', '/repo', 'Agent', HELD, 'turn:2')).toBeNull();
  // One offer's end never reaches the other's record.
  expect((await store.owned(job.id, 'root'))?.state).toBe('native');
});

it('still repeats an offer whose index an earlier build wrote', async () => {
  const { store, job } = await heldAgentCall();
  const index = join(
    dir,
    'model-jobs',
    `repeat-${canonicalHash({ sessionId: 'root', root: '/repo', tool: 'Agent', native: HELD })}.json`,
  );
  await writeFile(index, JSON.stringify({ id: job.id }));
  expect(await store.nativeRepeat('root', '/repo', 'Agent', HELD)).toBe(job.id);
});

it('keeps why a call got no offer as codes in one private bounded file, with no text of the call', async () => {
  dir = await mkdtemp(join(tmpdir(), 'tenjin-model-no-offer-'));
  const store = new ModelJobStore(dir);
  const now = vi.spyOn(Date, 'now').mockReturnValue(1_000);
  await store.noOffer({ sessionId: 's', tool: 'Agent', code: 'input_filter', detail: 'name' });
  // Free text is refused whole: only a code-shaped detail is ever written.
  await store.noOffer({
    sessionId: 's',
    tool: 'Agent',
    code: 'server_declined',
    detail: 'the assignment said to read /secret',
  });
  now.mockReturnValue(2_000);
  await store.noOffer({
    sessionId: 's',
    tool: 'Agent',
    code: 'over_size_limit',
    bytes: 20_000,
    limit: 16_384,
  });
  expect(await store.noOffers()).toEqual([
    { at: 1_000, sessionId: 's', tool: 'Agent', code: 'input_filter', detail: 'name' },
    {
      at: 2_000,
      sessionId: 's',
      tool: 'Agent',
      code: 'over_size_limit',
      bytes: 20_000,
      limit: 16_384,
    },
  ]);
  const path = join(dir, 'model-jobs', 'no-offers.json');
  expect((await stat(path)).mode & 0o777).toBe(0o600);
  // Bounded: the newest 200, and none older than the other records' 7 days.
  for (let i = 0; i < 205; i++)
    await store.noOffer({ sessionId: 's', tool: 'Task', code: 'expired' });
  expect(await store.noOffers()).toHaveLength(200);
  now.mockReturnValue(2_000 + MODEL_RECORD_TTL_MS);
  await store.noOffer({ sessionId: 's', tool: 'Agent', code: 'no_consent' });
  expect((await store.noOffers()).map((entry) => entry.code)).toEqual(['no_consent']);
  // And the file goes with the other job records once nothing wrote it for 7 days.
  now.mockRestore();
  await sweepModelRecords(dir, Date.now() + MODEL_RECORD_TTL_MS + 60_000);
  expect(await store.noOffers()).toEqual([]);
});

it.each([
  { name: 'cancelled before acceptance', steps: ['fence'], matches: true },
  { name: 'running', steps: ['accept'], matches: false },
  { name: 'failed after acceptance', steps: ['accept', 'unknown'], matches: true },
  { name: 'completed', steps: ['accept', 'completed'], matches: false },
] as const)('repeats a $name offer natively: $matches', async ({ steps, matches }) => {
  const { store, job } = await heldAgentCall();
  for (const step of steps)
    if (step === 'fence') await store.fenceOwned(job.id, 'root');
    else if (step === 'accept') await store.accept(job.id, 'root', 'turn');
    else await store.finish(job.id, step);
  expect(await store.nativeRepeat('root', '/repo', 'Agent', HELD)).toBe(matches ? job.id : null);
});

it('lets exactly one of a repeat and an acceptance win across stores', async () => {
  const { store, job } = await heldAgentCall();
  const outcomes = await Promise.all([
    store.nativeRepeat('root', '/repo', 'Agent', HELD),
    new ModelJobStore(dir).accept(job.id, 'root', 'turn'),
  ]);
  expect(outcomes.filter(Boolean)).toHaveLength(1);
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
    'turn',
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
  await store.offer(input, 'awaiting_prompt', 'turn');
  await expect(
    store.offer({ ...input, callId: 'second' }, 'awaiting_prompt', 'turn'),
  ).rejects.toThrow('unresolved');
});

it('finds an offer by its own id in a later turn and from another process, for its own session only', async () => {
  const { store, job } = await heldAgentCall();
  const restarted = new ModelJobStore(dir);
  expect(await restarted.owned(job.id, 'root')).toMatchObject({ id: job.id, state: 'offered' });
  expect(await restarted.owned(job.id, 'another-session')).toBeNull();
  expect(await restarted.owned('not-an-id', 'root')).toBeNull();
  // The turn that made the offer is not asked for: a later one accepts it, once.
  const accepted = await restarted.accept(job.id, 'root');
  expect(accepted).toMatchObject({ state: 'running', runner: { pid: process.pid } });
  expect(await store.accept(job.id, 'root')).toBeNull();
  expect(await store.accept(job.id, 'root', 'turn')).toBeNull();
});

it('ends a running record only once the process that accepted it is gone', async () => {
  const { store, job } = await heldAgentCall();
  const accepted = (await store.accept(job.id, 'root'))!;
  const path = join(dir, 'model-jobs', `${job.id}.json`);
  const runningIn = (pid: number) =>
    writeFile(path, JSON.stringify({ ...accepted, runner: { pid, acceptedAt: Date.now() } }));
  const other = process.pid + 1;
  // Another live process may still be running the worker: nothing changes.
  await runningIn(other);
  expect(await store.strand(job.id, { isAlive: () => true })).toBeNull();
  expect((await store.owned(job.id, 'root'))?.state).toBe('running');
  // No wall: a live process still holds the run however long it has gone on (a 3-hour-old
  // accept is not over), so nothing changes.
  await writeFile(
    path,
    JSON.stringify({ ...accepted, runner: { pid: other, acceptedAt: Date.now() - 3 * 3600_000 } }),
  );
  expect(await store.strand(job.id, { isAlive: () => true })).toBeNull();
  expect((await store.owned(job.id, 'root'))?.state).toBe('running');
  // A process that is gone left it: it ends as interrupted, and stays ended.
  await runningIn(other);
  const ended = await store.strand(job.id, { isAlive: () => false });
  expect(ended?.state).toBe('unknown');
  expect(JSON.parse(ended!.result!)).toMatchObject({
    status: 'unknown',
    stopReason: { kind: 'interrupted' },
  });
  expect(await store.strand(job.id, { isAlive: () => true })).toMatchObject({ state: 'unknown' });
  expect(await store.unfinished()).toEqual([]);
  // An ended record cannot be accepted again, so no second worker can start from it.
  expect(await store.accept(job.id, 'root')).toBeNull();
});

it('lists what was left running across sessions, and nothing else', async () => {
  const { store, job } = await heldAgentCall();
  const offered = await store.offer({
    sessionId: 'other',
    turnId: 'turn',
    callId: 'call',
    task: 'x',
    root: '/repo',
    native: {},
    decision: {},
    capAtomic: '1',
  });
  await store.accept(job.id, 'root');
  expect((await store.unfinished()).map((left) => left.id)).toEqual([job.id]);
  expect((await store.owned(offered.id, 'other'))?.state).toBe('offered');
});

it('removes a record 7 days after its last write and keeps one written a moment later', async () => {
  const { store, job } = await heldAgentCall();
  await mkdir(join(dir, 'model-conversations'));
  const now = Date.now();
  const files = {
    old: join(dir, 'model-jobs', `${job.id}.budget.json`),
    oldConversation: join(dir, 'model-conversations', 'old.json'),
    kept: join(dir, 'model-jobs', `${job.id}-kept.result.json`),
    keptConversation: join(dir, 'model-conversations', 'kept.json'),
  };
  for (const path of Object.values(files)) await writeFile(path, '{}');
  const at = (ms: number) => new Date(now - ms);
  for (const path of [files.old, files.oldConversation])
    await utimes(path, at(MODEL_RECORD_TTL_MS + 1000), at(MODEL_RECORD_TTL_MS + 1000));
  for (const path of [files.kept, files.keptConversation])
    await utimes(path, at(MODEL_RECORD_TTL_MS - 1000), at(MODEL_RECORD_TTL_MS - 1000));
  await sweepModelRecords(dir, now);
  const exists = async (path: string) =>
    stat(path).then(
      () => true,
      () => false,
    );
  expect(await Promise.all(Object.values(files).map(exists))).toEqual([false, false, true, true]);
  // The offer written a moment ago stands; once it is as old, it is gone as if it never was.
  expect((await store.owned(job.id, 'root'))?.id).toBe(job.id);
  await sweepModelRecords(dir, now + MODEL_RECORD_TTL_MS + 60_000);
  expect(await store.owned(job.id, 'root')).toBeNull();
  expect(await readdir(join(dir, 'model-conversations'))).toEqual([]);
});
