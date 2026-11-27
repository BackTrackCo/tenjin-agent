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

import { registerModelTool } from './model-mcp';
import { ModelJobStore } from './model-job';
import { modelConsent } from './model-settings';
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
  if (dir) await rm(dir, { recursive: true, force: true });
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
  return { call, route, repo, neon, listTools };
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
