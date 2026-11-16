import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { ModelJobStore } from './model-job';
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
  expect(await store.nativeRepeat('root', 'later-turn', '/repo', 'Agent', repeat)).toBe(true);
  expect(await store.nativeRepeat('root', 'later-turn', '/repo', 'Agent', repeat)).toBe(false);
  expect(await store.nativeRepeat('root', 'turn', '/repo', 'Agent', HELD)).toBe(false);
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
    expect(await store.nativeRepeat(session, 'turn', root, tool, native)).toBe(false);
  expect(await store.nativeRepeat('root', 'turn', '/repo', 'Agent', HELD)).toBe(true);
});

it('lasts for the rest of the offer turn, and in later turns only until the offer expires', async () => {
  const { store, job } = await heldAgentCall();
  vi.spyOn(Date, 'now').mockReturnValue(job.expiresAt);
  expect(await store.nativeRepeat('root', 'later-turn', '/repo', 'Agent', HELD)).toBe(false);
  expect(await store.nativeRepeat('root', 'turn', '/repo', 'Agent', HELD)).toBe(true);
});

it.each([
  { name: 'cancelled before acceptance', steps: ['fence'], matches: true },
  { name: 'running', steps: ['accept'], matches: false },
  { name: 'failed after acceptance', steps: ['accept', 'unknown'], matches: true },
  { name: 'completed', steps: ['accept', 'completed'], matches: false },
] as const)('repeats a $name offer natively: $matches', async ({ steps, matches }) => {
  const { store, job } = await heldAgentCall();
  for (const step of steps)
    if (step === 'fence') await store.fence('root', 'turn');
    else if (step === 'accept') await store.accept(job.id, 'root', 'turn');
    else await store.finish(job.id, step);
  expect(await store.nativeRepeat('root', 'turn', '/repo', 'Agent', HELD)).toBe(matches);
});

it('lets exactly one of a repeat and an acceptance win across stores', async () => {
  const { store, job } = await heldAgentCall();
  const outcomes = await Promise.all([
    store.nativeRepeat('root', 'turn', '/repo', 'Agent', HELD),
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
