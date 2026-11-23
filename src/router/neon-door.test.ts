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
import { modelConsent, neonConsent } from './model-settings';
import type { ModelSession } from './model-handoff';
import type { ModelTransport, WorkerTransport } from './model-transport';
import { NEON_CONSENT_REFUSAL } from './model-handoff';

let dir: string;
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});
beforeEach(() => {
  vi.clearAllMocks();
});

async function door(router: Record<string, unknown>) {
  dir = await realpath(await mkdtemp(join(tmpdir(), 'neon-door-')));
  const repo = join(dir, 'repo');
  await mkdir(join(repo, '.git'), { recursive: true });
  await writeFile(join(dir, 'config.json'), JSON.stringify({ router }));
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
    origin: 'https://blockrun.ai',
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
  return { call, route, repo, neon };
}

it('starts a Neon worker on an explicit request with no routing call, no offer and no Agent hold', async () => {
  const { call, route, repo } = await door({ neon: true, neonConsent: neonConsent({}) });
  worker.run.mockResolvedValue('The release notes are written.');
  const reply = await call({
    neon: { prompt: 'Write the release notes', description: 'Release notes' },
  });
  expect(reply).toMatchObject({
    status: 'completed',
    label: 'Gemini 4 Neon',
    result: 'The release notes are written.',
    spend: { reservedAtomic: '9000', actualAtomic: '9000' },
  });
  expect(route).not.toHaveBeenCalled();
  // The worker ran as the job record names it: Neon, on BlockRun, with the output cap.
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
      model: 'google/gemini-4-neon',
      routerOrigin: 'https://blockrun.ai',
      routingAuthorizedAtomic: '0',
      maxOutputTokens: 8192,
    },
    capAtomic: '1000000',
  });
  expect(options.transport.origin).toBe('https://blockrun.ai');
  expect(await new ModelJobStore(dir).noOffers()).toEqual([]);
});

it('refuses without Neon consent, naming the consent step, also under DeepSeek consent', async () => {
  const { call } = await door({
    subagents: true,
    subagentConsent: modelConsent({ routerOrigin: 'https://tenjin.sh' }),
  });
  expect(await call({ neon: { prompt: 'Write the release notes' } })).toEqual({
    action: 'refused',
    reason: NEON_CONSENT_REFUSAL,
    charged: false,
  });
  expect(worker.run).not.toHaveBeenCalled();
});

it('takes no other operation beside it', async () => {
  const { call } = await door({ neon: true, neonConsent: neonConsent({}) });
  expect(
    await call({ neon: { prompt: 'Write it' }, cancel: '6f2f8f0e-2b64-4b4f-9a39-6d3b2f1c0a11' }),
  ).toMatchObject({ action: 'refused' });
  expect(worker.run).not.toHaveBeenCalled();
});
