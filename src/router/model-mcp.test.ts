import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
const worker = vi.hoisted(() => ({ run: vi.fn(), qualified: vi.fn(async () => 'worker') }));
vi.mock('./model-worker', () => ({
  runModelWorker: worker.run,
  qualifiedModelWorker: worker.qualified,
}));
import { registerModelTool } from './model-mcp';
import { ModelJobStore } from './model-job';
import type { ModelSession } from './model-handoff';
import type { ModelTransport } from './model-transport';
import offer from './fixtures/model-offer.json';
import parentPolicy from './model-parent-policy.json';

let dir: string;
beforeEach(() => vi.clearAllMocks());
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

it.each(['default', 'acceptEdits', 'auto', 'dontAsk'] as const)(
  'binds an owned Claude %s offer independently of model-supplied mode claims',
  async (mode) => {
    worker.run.mockResolvedValue('completed fixture');
    dir = await realpath(await mkdtemp(join(tmpdir(), 'claude-mode-offer-')));
    const repo = join(dir, 'repo');
    await mkdir(join(repo, '.git'), { recursive: true });
    await writeFile(
      join(dir, 'config.json'),
      JSON.stringify({
        router: {
          subagents: true,
          subagentConsent: {
            version: 2,
            instructions: 'applicable',
            recipients: ['Tenjin', 'DeepSeek'],
            repositories: [repo],
            maxJobAtomic: '1000000',
            routerOrigin: 'http://localhost:3939',
          },
        },
      }),
    );
    const transcript = join(dir, 'root.jsonl');
    await writeFile(
      transcript,
      JSON.stringify({
        type: 'user',
        sessionId: 'root',
        message: { role: 'user', content: 'Check the selected function.' },
      }),
    );
    const session: ModelSession = {
      sessionId: 'root',
      turnId: 'turn',
      cwd: repo,
      transcript,
      harness: 'claude',
      claudePermissionMode: mode,
    };
    const route = vi.fn(async (body: { jobId: string }) => ({ ...offer, jobId: body.jobId }));
    const transport = {
      origin: 'http://localhost:3939',
      route,
      summary: async () => ({ actualAtomic: '0' }),
    } as unknown as ModelTransport;
    const server = new McpServer({ name: 'test', version: '1' });
    const model = registerModelTool(server, {
      dataDir: dir,
      harness: 'claude',
      session: () => session,
      transport: async () => transport,
    });
    const client = new Client(
      { name: 'test', version: '1' },
      { capabilities: { elicitation: { form: {} } } },
    );
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    await client.connect(b);
    try {
      const listed = await client.listTools();
      const tool = listed.tools.find((tool) => tool.name === 'subagent');
      expect(tool?.description).toContain('Accept with offer_id');
      expect(tool?.description).not.toContain(parentPolicy);
      expect(tool?._meta?.['anthropic/alwaysLoad']).toBeUndefined();
      const captured = await client.callTool({
        name: 'subagent',
        arguments: {
          capture: {
            session_id: 'root',
            tool_use_id: 'native-call',
            input: {
              prompt: 'Read the selected function and report facts.',
              subagent_type: 'general-purpose',
              permission_mode: 'bypassPermissions',
            },
          },
        },
      });
      expect(JSON.stringify(captured)).toContain('offer_id');
      const store = new ModelJobStore(dir);
      const pending = await store.pending('root', 'turn');
      expect(pending?.decision.claudePermissionMode).toBe(mode);
      expect(JSON.stringify(route.mock.calls)).not.toContain('permissionMode');
      const accepted = await client.callTool({
        name: 'subagent',
        arguments: { offer_id: pending!.id },
      });
      expect(JSON.stringify(accepted)).toContain('completed fixture');
      const options = worker.run.mock.calls.at(-1)?.[1];
      expect(options.claudePermissionMode).toBe(mode);
      expect(options.currentClaudePermissionMode()).toBe(mode);
      session.claudePermissionMode = mode === 'auto' ? 'default' : 'auto';
      expect(options.currentClaudePermissionMode()).toBe(session.claudePermissionMode);
      session.claudePermissionMode = mode;
      const second = await store.offer({
        sessionId: 'root',
        turnId: 'next-turn',
        callId: 'next',
        root: repo,
        task: 'Read',
        native: {},
        capAtomic: '1000000',
        decision: { routerOrigin: transport.origin, claudePermissionMode: mode },
      });
      await store.decided(second.id, {
        action: 'model',
        routerOrigin: transport.origin,
        claudePermissionMode: mode,
      });
      session.turnId = 'next-turn';
      session.claudePermissionMode = mode === 'auto' ? 'default' : 'auto';
      const before = worker.run.mock.calls.length;
      expect(
        JSON.stringify(
          await client.callTool({ name: 'subagent', arguments: { offer_id: second.id } }),
        ),
      ).toContain('native');
      expect(worker.run.mock.calls.length).toBe(before);
      expect((await store.pending('root', 'next-turn'))?.state).toBe('offered');
    } finally {
      await model.shutdown();
      await client.close();
      await server.close();
    }
  },
);
it('cancels and drains an accepted Codex worker on the trusted lifecycle bridge; stale acceptance never restarts it', async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), 'model-mcp-')));
  const repo = join(dir, 'repo');
  await mkdir(repo);
  await mkdir(join(repo, '.git'));
  await writeFile(
    join(dir, 'config.json'),
    JSON.stringify({
      router: {
        subagents: true,
        subagentConsent: {
          version: 2,
          instructions: 'applicable',
          recipients: ['Tenjin', 'DeepSeek'],
          repositories: [repo],
          maxJobAtomic: '1000000',
          routerOrigin: 'http://localhost:3939',
        },
      },
    }),
  );
  const session: ModelSession = {
    sessionId: 'root',
    turnId: 'turn',
    cwd: repo,
    transcript: 'unused',
    harness: 'codex',
    codexPolicy: { approvalPolicy: 'never', approvalsReviewer: 'user', sandbox: {} },
  };
  const store = new ModelJobStore(dir);
  const job = await store.offer({
    sessionId: 'root',
    turnId: 'turn',
    callId: 'call',
    root: repo,
    task: 'Read fixture',
    native: {},
    capAtomic: '1000000',
    decision: { routerOrigin: 'http://localhost:3939' },
  });
  let started!: () => void;
  const began = new Promise<void>((resolve) => {
    started = resolve;
  });
  worker.run.mockImplementation(async (_job, options) => {
    started();
    await new Promise<void>((resolve) =>
      options.signal.addEventListener('abort', () => resolve(), { once: true }),
    );
    throw new Error('cancelled');
  });
  const server = new McpServer({ name: 'test', version: '1' });
  const model = registerModelTool(server, {
    dataDir: dir,
    harness: 'codex',
    session: () => session,
    transport: async () =>
      ({
        origin: 'http://localhost:3939',
        summary: async () => ({ actualAtomic: '3000', reservedAtomic: '3000', uncertain: [] }),
      }) as unknown as ModelTransport,
  });
  const client = new Client({ name: 'test', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  await client.connect(b);
  try {
    const foreign = await client.callTool({
      name: 'subagent',
      arguments: { offer_id: job.id },
      _meta: { threadId: 'foreign' },
    });
    expect(JSON.stringify(foreign)).toContain('native');
    expect(worker.run).not.toHaveBeenCalled();
    const running = client.callTool({
      name: 'subagent',
      arguments: { offer_id: job.id },
      _meta: { threadId: 'root' },
    });
    await Promise.race([
      began,
      running.then((result) => {
        throw new Error(`Worker did not start: ${JSON.stringify(result)}`);
      }),
    ]);
    await model.fence(session);
    expect(JSON.stringify(await running)).toContain('cancelled');
    const retry = await client.callTool({
      name: 'subagent',
      arguments: { offer_id: job.id },
      _meta: { threadId: 'root' },
    });
    expect(JSON.stringify(retry)).toContain('native');
    expect(worker.run).toHaveBeenCalledTimes(1);
  } finally {
    await model.shutdown();
    await client.close();
    await server.close();
  }
});
