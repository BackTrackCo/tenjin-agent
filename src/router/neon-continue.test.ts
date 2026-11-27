import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
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
async function fixture(spent: string, config: Record<string, unknown> = {}) {
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
    capAtomic: '20000',
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
      calls: [],
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
  });
});

it('offers a revision the job still has room for with no question, whatever the DeepSeek setting is', async () => {
  for (const config of [{}, { router: { subagents: false } }]) {
    const f = await fixture('1000', config);
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
