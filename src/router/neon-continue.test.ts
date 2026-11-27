import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ getSessionInfo: vi.fn() }));
import { getSessionInfo } from '@anthropic-ai/claude-agent-sdk';
vi.mock('./model-worker', () => ({ qualifiedModelWorker: vi.fn() }));
import { qualifiedModelWorker } from './model-worker';
import { ModelHandoff, type ModelSession } from './model-handoff';
import type { ModelTransport, WorkerTransport } from './model-transport';
import type { NeonTerms } from './neon-terms';
import { neonRecordPath } from './neon-transport';
import { isQuoteId, readQuote } from '../lib/spend-quotes';
import { runNeonApprove } from './neon-approve';

let dir: string;
afterEach(async () => {
  vi.unstubAllEnvs();
  if (dir) await rm(dir, { recursive: true, force: true });
});

const TERMS: NeonTerms = {
  rowId: 'row-1',
  label: 'Test Writer',
  url: 'https://seller.example/chat',
  payTo: '0x00000000000000000000000000000000000000aa',
  network: 'eip155:8453',
  asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  model: 'test/model',
  wire: 'chat',
  scheme: 'batch-settlement',
  usage: 'nanogpt',
  inputAtomicPerMillion: '3150000',
  outputAtomicPerMillion: '15750000',
  cacheReadAtomicPerMillion: '157500',
};

/** A finished Neon job with a worker conversation, and a record that has spent `spent`. */
async function fixture(
  spent: string,
  config: Record<string, unknown> = {},
  calls: Record<string, unknown>[] = [],
  cap = '20000',
) {
  dir = await realpath(await mkdtemp(join(tmpdir(), 'neon-continue-')));
  const repo = join(dir, 'repo');
  const configDir = join(dir, 'claude');
  await mkdir(join(repo, '.git'), { recursive: true });
  await mkdir(configDir);
  vi.stubEnv('CLAUDE_CONFIG_DIR', configDir);
  await writeFile(join(dir, 'config.json'), JSON.stringify(config));
  const workspace = {
    version: 1 as const,
    root: repo,
    workingDirectories: [repo],
    workingDirectorySpellings: [repo],
    readExceptions: [],
    writeExceptions: [],
    droppedDirectories: [],
  };
  const neon = {
    origin: 'tenjin:neon',
    requireResumeBudget: vi.fn(async () => {}),
    reconcile: vi.fn(async () => {}),
  } as unknown as WorkerTransport;
  const model = new ModelHandoff({
    dataDir: dir,
    transport: { origin: 'https://tenjin.sh' } as unknown as ModelTransport,
    neonTransport: async () => neon,
  });
  const initial = await model.store.offer({
    sessionId: 'root',
    turnId: 'initial',
    callId: 'neon-initial',
    root: repo,
    task: 'Draft the letter',
    native: { prompt: 'Draft the letter', subagent_type: 'general-purpose' },
    decision: {
      action: 'model',
      provider: 'neon',
      model: TERMS.model,
      routerOrigin: 'tenjin:neon',
      neonTerms: TERMS,
      routingAuthorizedAtomic: '0',
      claudePermissionMode: 'default',
      claudeWorkspace: workspace,
    },
    capAtomic: cap,
  });
  await mkdir(join(dir, 'model-jobs'), { recursive: true });
  await writeFile(
    neonRecordPath(dir, initial.id),
    JSON.stringify({
      version: 1,
      jobId: initial.id,
      taskClass: 'writing',
      startedAt: 1,
      wallMs: 0,
      spentAtomic: spent,
      settledAtomic: spent,
      calls,
      signatures: {},
    }),
  );
  const sdkSessionId = randomUUID();
  const conversation = await model.conversations.create({
    job: initial,
    parentSessionId: 'root',
    sdkSessionId,
    configDir,
  });
  const owner = { parentSessionId: 'root', root: repo, configDir };
  await model.conversations.accept(conversation.handle, owner, initial.id);
  await model.conversations.finish(conversation.handle, owner, initial.id, 'completed', 'Draft.');
  vi.mocked(qualifiedModelWorker).mockResolvedValue({
    path: '/fixture/worker',
    source: 'path',
    claudeWorkspace: workspace,
  });
  vi.mocked(getSessionInfo).mockResolvedValue({ sessionId: sdkSessionId, cwd: repo } as Awaited<
    ReturnType<typeof getSessionInfo>
  >);
  const session: ModelSession = {
    sessionId: 'root',
    turnId: 'later-turn',
    cwd: repo,
    transcript: '',
    claudePermissionMode: 'default',
  };
  return { model, session, conversation, initial };
}

const revision = (handle: string) => ({ to: handle, message: 'Make it shorter.' });

// Failure caught: a revision that the job's ceiling could not hold was offered as if it would run
// and failed at its first call, with no way on but a new worker that has no history.
it('asks about a revision with no room left, and offers it on the same worker once the person said yes', async () => {
  // Spent 12,000 of 20,000: less than one more call needs. No consent, no setting.
  const f = await fixture('12000');
  const asked = await f.model.capture(
    f.session,
    'rev-1',
    revision(f.conversation.handle),
    undefined,
    'SendMessage',
  );
  expect(asked).toMatchObject({
    action: 'refused',
    status: 'needs_approval',
    started: false,
    reason: expect.stringContaining('needs_approval'),
    instruction: expect.stringContaining('approve({quote: "q_'),
  });
  // A Neon job never reads a DeepSeek name in what it asks or offers.
  expect(JSON.stringify(asked)).not.toMatch(/DeepSeek/);
  const id = (asked as unknown as { quote: { id: string } }).quote.id;
  expect(isQuoteId(id)).toBe(true);
  const quote = (await readQuote(dir, id))!;
  // The yes grows the same job's ceiling, and the revision is then offered on the same worker,
  // with the same handle and its history, and no routing fee.
  expect(
    await runNeonApprove({ quote: id, total: '$1', what: quote.what }, { dataDir: dir }),
  ).toMatchObject({ ok: true });
  const offered = await f.model.capture(
    f.session,
    'rev-2',
    revision(f.conversation.handle),
    undefined,
    'SendMessage',
  );
  expect(offered).toMatchObject({
    action: 'offer',
    continuation: true,
    worker_handle: f.conversation.handle,
    routingFeeAtomic: '0',
    label: 'Test Writer',
    parentPolicy: expect.stringContaining('continues a Test Writer worker'),
    instruction: expect.stringContaining('forbid this text for a Test Writer worker'),
  });
  expect(JSON.stringify(offered)).not.toMatch(/DeepSeek/);
});

// Failure caught by review: a first call whose real request was larger than the door's estimate
// failed after the yes and ended the worker. The record keeps what that request measured, and the
// same worker is asked about at that amount, with a grant that covers it.
it('asks about a call that measured more than the job has, with a grant that covers it, on the same worker', async () => {
  const f = await fixture('0', {}, [], '1000000');
  const recordPath = neonRecordPath(dir, f.initial.id);
  const kept = JSON.parse(await readFile(recordPath, 'utf8'));
  await writeFile(recordPath, JSON.stringify({ ...kept, needAtomic: '1800000' }));
  // Over what one channel holds: nothing could carry it, and nothing is sent.
  expect(
    await f.model.capture(
      f.session,
      'rev-1',
      revision(f.conversation.handle),
      undefined,
      'SendMessage',
    ),
  ).toMatchObject({ action: 'refused' });
  await writeFile(
    recordPath,
    JSON.stringify({
      ...kept,
      needAtomic: '400000',
      spentAtomic: '900000',
      settledAtomic: '900000',
    }),
  );
  const asked = await f.model.capture(
    f.session,
    'rev-2',
    revision(f.conversation.handle),
    undefined,
    'SendMessage',
  );
  expect(asked).toMatchObject({ status: 'needs_approval', started: false });
  const quote = (await readQuote(dir, (asked as unknown as { quote: { id: string } }).quote.id))!;
  // 100,000 is left of the 1,000,000 ceiling and 400,000 is needed: the grant is the one ceiling
  // (1,000,000), which covers the 300,000 that was missing.
  expect(BigInt((quote.call as { ceilingAtomic: string }).ceilingAtomic)).toBeGreaterThanOrEqual(
    300_000n,
  );
  expect(
    await runNeonApprove({ quote: quote.id, total: '$1', what: quote.what }, { dataDir: dir }),
  ).toMatchObject({ ok: true });
  expect(
    await f.model.capture(
      f.session,
      'rev-3',
      revision(f.conversation.handle),
      undefined,
      'SendMessage',
    ),
  ).toMatchObject({ action: 'offer', continuation: true, worker_handle: f.conversation.handle });
});

it('offers a revision the job still has room for with no question, whatever the DeepSeek setting is', async () => {
  for (const config of [{}, { router: { subagents: false } }]) {
    const f = await fixture('1000', config, [], '1000000');
    const offered = await f.model.capture(
      f.session,
      'rev-1',
      revision(f.conversation.handle),
      undefined,
      'SendMessage',
    );
    expect(offered).toMatchObject({ action: 'offer', continuation: true });
    await rm(dir, { recursive: true, force: true });
  }
});

// Failure caught by review: the check for room counted one floor-sized turn of output and no input,
// so a revision with 0.03 USD left passed it. The resumed conversation sends its whole history
// (87 KB at the live job's fourth call, about 0.14 USD of input at the estimate), so the first call
// failed with "no room", which ends the conversation: the person could no longer approve more room
// for that writer. The history's size is kept with each call and counts in the check.
it('asks about a revision whose history alone does not fit what is left, before anything is sent', async () => {
  const last = {
    n: 1,
    at: 1,
    inputTokens: 25_000,
    cachedInputTokens: 0,
    outputTokens: 800,
    maxTokens: 16_000,
    quotedAtomic: '300000',
    settledAtomic: '90000',
    settlement: 'settled',
    ok: true,
    ms: 1,
    bytes: 87_000,
  };
  // The job's ceiling is 30,000 and nothing is spent, so 30,000 is left: one floor-sized turn
  // fits, 87 KB of history does not.
  const f = await fixture('0', {}, [last], '30000');
  const asked = await f.model.capture(
    f.session,
    'rev-near',
    revision(f.conversation.handle),
    undefined,
    'SendMessage',
  );
  expect(asked).toMatchObject({ status: 'needs_approval', started: false });
});
