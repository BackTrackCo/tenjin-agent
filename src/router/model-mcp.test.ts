import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
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

let dir: string;
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});
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
          version: 1,
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
