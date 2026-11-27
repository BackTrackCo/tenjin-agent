import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

const worker = vi.hoisted(() => ({
  run: vi.fn(),
  qualified: vi.fn(async (cwd: string, ..._other: unknown[]) => ({
    path: 'worker',
    claudeWorkspace: {
      version: 1 as const,
      root: cwd,
      workingDirectories: [cwd],
      workingDirectorySpellings: [cwd],
      readExceptions: [] as string[],
      writeExceptions: [] as string[],
    },
  })),
}));
vi.mock('./model-worker', () => ({
  runModelWorker: (job: unknown, options: unknown) => worker.run(job, options),
  WorkerStartUnconfirmed: class extends Error {},
  qualifiedModelWorker: worker.qualified,
}));
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ getSessionInfo: vi.fn() }));
import { getSessionInfo } from '@anthropic-ai/claude-agent-sdk';

import { registerModelTool } from './model-mcp';
import { ModelJobStore } from './model-job';
import { modelConsent } from './model-settings';
import { isNeonRevisionQuote, runNeonApprove } from './neon-approve';
import { readNeonRecord } from './neon-transport';
import { readQuote } from '../lib/spend-quotes';
import type { NeonTerms } from './neon-terms';
import type { ModelSession } from './model-handoff';
import type { ModelTransport, WorkerTransport } from './model-transport';

/** The provider row's terms the door saves with a job, as a stub lookup returns them. */
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

let dir: string;
afterEach(async () => {
  vi.unstubAllEnvs();
  // A follow-up runs on in the background: its last files may land while the folder goes.
  if (dir) await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});
beforeEach(() => {
  vi.clearAllMocks();
});

async function door(
  router: Record<string, unknown>,
  lookup: () => Promise<NeonTerms> = async () => TERMS,
  limits: Record<string, unknown> = {},
) {
  dir = await realpath(await mkdtemp(join(tmpdir(), 'neon-door-')));
  const repo = join(dir, 'repo');
  await mkdir(join(repo, '.git'), { recursive: true });
  // The worker's conversation lives under the Claude config folder, which a CI machine lacks.
  const configDir = join(dir, 'claude');
  await mkdir(configDir);
  vi.stubEnv('CLAUDE_CONFIG_DIR', configDir);
  await writeFile(join(dir, 'config.json'), JSON.stringify({ ...limits, router }));
  const transcript = join(dir, 'root.jsonl');
  await writeFile(transcript, '');
  const session: ModelSession = {
    sessionId: 'root',
    turnId: 'turn-1',
    cwd: repo,
    transcript,
    claudePermissionMode: 'default',
  };
  const route = vi.fn();
  const deepseek = {
    origin: 'https://tenjin.sh',
    route,
    reconcile: vi.fn(),
    requireResumeBudget: vi.fn(),
    summary: vi.fn(),
    recoverInferenceRefunds: vi.fn(),
  } as unknown as ModelTransport;
  const summary = vi.fn(async () => ({
    reservedAtomic: '9000',
    actualAtomic: '9000',
    uncertain: [],
  }));
  const neon = {
    origin: 'tenjin:neon',
    summary,
    reconcile: vi.fn(),
    requireResumeBudget: vi.fn(),
    withInferenceRun: <T>(_id: string, _s: AbortSignal, run: (t: WorkerTransport) => Promise<T>) =>
      run(neon),
  } as unknown as WorkerTransport;
  const server = new McpServer({ name: 'test', version: '1' });
  registerModelTool(server, {
    dataDir: dir,
    session: () => session,
    transport: async () => deepseek,
    neonTransport: async () => neon,
    neonTerms: lookup,
  });
  const client = new Client(
    { name: 'test', version: '1' },
    { capabilities: { elicitation: { form: {} } } },
  );
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  await client.connect(b);
  const call = async (args: Record<string, unknown>) => {
    const reply = await client.callTool({ name: 'subagent', arguments: args });
    return JSON.parse((reply.content as Array<{ text: string }>)[0]!.text);
  };
  const listTools = async () => (await client.listTools()).tools;
  return { call, route, repo, neon, listTools, session };
}

/** The door, with the data folder it runs in. */
async function doorWithDir(router: Record<string, unknown>, limits: Record<string, unknown> = {}) {
  const opened = await door(router, async () => TERMS, limits);
  return { ...opened, dir };
}

const request = { neon: { prompt: 'Write the release notes', description: 'Release notes' } };

// Failure caught: a person who never ran a Neon step, with the DeepSeek subagent setting off,
// could not start a writing job a skill asked for. No setting and no consent gates the door.
it.each([
  ['no setting at all', {}],
  ['the DeepSeek subagent setting off', { subagents: false }],
  [
    'the DeepSeek subagent setting on, with its consent',
    { subagents: true, subagentConsent: modelConsent({ routerOrigin: 'https://tenjin.sh' }) },
  ],
  [
    'a Neon consent left by an older build',
    { neon: true, neonConsent: { version: 1, recipients: ['Old', 'Recipients'] } },
  ],
])(
  'starts a Neon worker on an explicit request with no routing call, no offer and no Agent hold, with %s',
  async (_name, router) => {
    const { call, route, repo } = await door(router);
    worker.run.mockResolvedValue('The release notes are written.');
    const reply = await call(request);
    expect(reply).toMatchObject({
      status: 'completed',
      label: 'Test Writer',
      result: 'The release notes are written.',
      spend: { reservedAtomic: '9000', actualAtomic: '9000' },
    });
    expect(route).not.toHaveBeenCalled();
    // The worker ran as the job record names it: Neon, with the row's saved terms.
    const [job, options] = worker.run.mock.calls[0]! as [
      {
        task: string;
        root: string;
        decision: Record<string, unknown>;
        native: Record<string, unknown>;
      },
      { transport: { origin: string } },
    ];
    expect(job).toMatchObject({
      task: 'Write the release notes',
      root: repo,
      native: { description: 'Release notes', subagent_type: 'general-purpose' },
      decision: {
        provider: 'neon',
        model: 'test/model',
        routerOrigin: 'tenjin:neon',
        neonTerms: TERMS,
        neonEffort: 'low',
        routingAuthorizedAtomic: '0',
        maxOutputTokens: 16000,
      },
      capAtomic: '1000000',
    });
    expect(options.transport.origin).toBe('tenjin:neon');
    expect(await new ModelJobStore(dir).noOffers()).toEqual([]);
  },
);

// Failure caught by the first live Neon job: its result told the parent that a follow-up "goes to
// DeepSeek at once", and the follow-up's answer said "The DeepSeek worker ... continues". A Neon
// job names its own worker in every text it returns to the parent, in either provider's case.
it('names the Neon worker, never DeepSeek, in the result and in the follow-up it returns', async () => {
  const { call, session, repo } = await door({});
  // The worker's own history, as the SDK finds it for the resumed conversation.
  vi.mocked(getSessionInfo).mockImplementation((async (id: string) => ({
    sessionId: id,
    cwd: repo,
  })) as never);
  worker.run.mockResolvedValue('The release notes are written.');
  const first = await call(request);
  expect(first.status).toBe('completed');
  expect(first.continuation).toContain('goes to Test Writer at once');
  expect(JSON.stringify(first)).not.toMatch(/DeepSeek/);
  session.turnId = 'followup-turn';
  const sent = await call({
    capture: {
      session_id: session.sessionId,
      tool_use_id: 'followup',
      tool: 'SendMessage',
      input: { to: first.worker_handle, message: 'Make it shorter.' },
    },
  });
  expect(sent).toMatchObject({
    action: 'continued',
    worker_handle: first.worker_handle,
    message: expect.stringMatching(/^The Test Writer worker tenjin-worker-.* continues with/),
  });
  expect(JSON.stringify(sent)).not.toMatch(/DeepSeek/);
  // The host delivers a background worker's text when the parent's turn ends: the parent is told
  // so, not left to wait or poll for minutes (the live comparison polled 6 x 20 s after each send).
  expect(first.continuation).toContain('when your turn ends');
  expect(sent.message).toContain('when your turn ends');
  expect(sent.message).toContain('do not wait for it or poll');
  await vi.waitFor(() => expect(worker.run).toHaveBeenCalledTimes(2));
});

it('saves the effort the door was given and refuses one it does not know', async () => {
  const { call } = await door({});
  worker.run.mockResolvedValue('Done.');
  await call({ neon: { prompt: 'Write it', effort: 'medium' } });
  expect(worker.run.mock.calls[0]![0]).toMatchObject({ decision: { neonEffort: 'medium' } });
  // An effort outside the five is refused by the tool's own input schema, before anything runs.
  await expect(call({ neon: { prompt: 'Write it', effort: 'wild' } })).rejects.toThrow();
  expect(worker.run).toHaveBeenCalledTimes(1);
});

// Failure caught: a failed provider lookup must fail the job with nothing sent, never fall back to
// a seller this build knows.
it('fails the job with nothing sent when the provider lookup fails', async () => {
  const { call } = await door({}, async () => {
    throw new Error('The Tenjin router could not be reached for the provider row');
  });
  const reply = await call(request);
  expect(reply).toMatchObject({ action: 'refused', charged: false });
  expect(reply.reason).toContain('could not be reached');
  expect(worker.run).not.toHaveBeenCalled();
});

it('refuses a job whose ceiling has no room for one call to the row, and sends nothing', async () => {
  const { call } = await door({}, async () => TERMS, { maxAutoSpend: '1000' });
  const reply = await call(request);
  expect(reply).toMatchObject({ action: 'refused', charged: false });
  // No Neon path reads a `--max-job` ceiling, so the refusal names none: the limit is the cap.
  expect(reply.reason).not.toContain('max-job');
  expect(reply.reason).toContain('per-call limit');
  expect(worker.run).not.toHaveBeenCalled();
});

// Failure caught by review: a first draft over the person's limits met the seller before any
// spend decision and failed with no way to ask. It is sized from the draft and the row's price
// rule at the door: nothing is sent, the answer is the quote, and only the yes runs the draft.
it('asks about a first draft the per-call limit cannot carry, sends nothing, and runs it only after the yes', async () => {
  // Room for one floor-sized turn and not for a draft with its context.
  const { call, dir: folder } = await doorWithDir({}, { maxAutoSpend: '20000' });
  const asked = await call({ neon: { prompt: 'SECRET-DRAFT-TEXT', description: 'Notes' } });
  expect(asked).toMatchObject({
    status: 'needs_approval',
    action: 'refused',
    started: false,
    instruction: expect.stringContaining('approve({quote: "q_'),
  });
  expect(typeof asked.offer_id).toBe('string');
  expect(JSON.stringify(asked)).not.toMatch(/DeepSeek/);
  // Nothing ran: no worker started, so no request of any kind left for the seller.
  expect(worker.run).not.toHaveBeenCalled();
  const quote = (await readQuote(folder, asked.quote.id))!;
  expect(isNeonRevisionQuote(quote)).toBe(true);

  // Failure caught by review: the queued draft was an ordinary offer, so accepting it started the
  // worker before any yes. It waits for its quote: nothing starts, and the offer stays available.
  const early = await call({ offer_id: asked.offer_id });
  expect(early).toMatchObject({ status: 'needs_approval', started: false });
  expect(early.instruction).toContain(`approve({quote: "${asked.quote.id}"`);
  expect(worker.run).not.toHaveBeenCalled();

  // A yes that shows other numbers than the quote's grants nothing.
  expect(
    await runNeonApprove(
      { quote: quote.id, total: '$0.01', what: quote.what },
      { dataDir: folder },
    ),
  ).toMatchObject({ ok: false });
  const yes = await runNeonApprove(
    { quote: quote.id, total: asked.quote.total, what: quote.what },
    { dataDir: folder },
  );
  expect(yes).toMatchObject({ ok: true, text: expect.stringContaining(asked.offer_id) });
  const record = await readNeonRecord(folder, asked.offer_id);
  expect(BigInt(record!.grantedAtomic)).toBeGreaterThan(0n);

  // The draft runs when it is accepted, on the same job.
  worker.run.mockResolvedValue('Written.');
  expect(await call({ offer_id: asked.offer_id })).toMatchObject({
    status: 'completed',
    result: 'Written.',
  });
  expect(worker.run).toHaveBeenCalledTimes(1);
});

// Failure caught by review: a day's budget with less left than the first call needs started a worker
// that then stopped at the budget with no question. It is asked about like the per-call limit is.
it('asks about a first draft the day budget cannot carry, with the day named, and queues it unrunnable', async () => {
  const { call, dir: folder } = await doorWithDir({}, { sessionBudget: '20000' });
  const asked = await call({ neon: { prompt: 'Write the notes' } });
  expect(asked).toMatchObject({ status: 'needs_approval', started: false });
  expect(asked.reason).toContain("today's automatic budget");
  expect(worker.run).not.toHaveBeenCalled();
  // The offer does not run before the yes, and the quote is the one it waits on.
  expect(await call({ offer_id: asked.offer_id })).toMatchObject({ status: 'needs_approval' });
  expect(worker.run).not.toHaveBeenCalled();
  const quote = (await readQuote(folder, asked.quote.id))!;
  await runNeonApprove(
    { quote: quote.id, total: asked.quote.total, what: quote.what },
    { dataDir: folder },
  );
  worker.run.mockResolvedValue('Done.');
  expect(await call({ offer_id: asked.offer_id })).toMatchObject({ status: 'completed' });
  expect(worker.run).toHaveBeenCalledTimes(1);
  // The quote runs once: a second yes grants nothing more.
  expect(
    await runNeonApprove(
      { quote: quote.id, total: asked.quote.total, what: quote.what },
      { dataDir: folder },
    ),
  ).toMatchObject({ ok: false });
});

it('refuses a draft larger than one channel deposit holds, with nothing sent', async () => {
  const { call } = await door({}, async () => ({ ...TERMS, inputAtomicPerMillion: '40000000' }));
  const reply = await call({ neon: { prompt: 'x'.repeat(200_000) } });
  expect(reply).toMatchObject({ action: 'refused', charged: false });
  expect(reply.reason).toContain('larger than one Neon call can carry');
  expect(worker.run).not.toHaveBeenCalled();
});

it('takes no other operation beside it', async () => {
  const { call } = await door({});
  expect(
    await call({ neon: { prompt: 'Write it' }, cancel: '6f2f8f0e-2b64-4b4f-9a39-6d3b2f1c0a11' }),
  ).toMatchObject({ action: 'refused' });
  expect(worker.run).not.toHaveBeenCalled();
});

// The one sentence a teammate asked for, which the operator kept.
it('describes the neon option in exactly one sentence', async () => {
  const { tools } = await door({}).then(async (d) => ({ tools: await d.listTools() }));
  const description = tools.find((tool) => tool.name === 'subagent')!.description!;
  expect(
    description.endsWith(
      'With neon, start a Neon writing draft when the user or a skill they run requests it.',
    ),
  ).toBe(true);
  expect(description.match(/With neon/g)).toHaveLength(1);
  expect(description).not.toMatch(/asked for by name/i);
  expect(description.slice(description.indexOf('With neon'))).not.toMatch(
    /consent|BlockRun|Gemini|Google/i,
  );
});
