import { lstat, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { query, resolveSettings } from '@anthropic-ai/claude-agent-sdk/core';
import { readClaudeCodeCached, meetsFloor } from './claude-cli';
import { registerModelTool } from './model-mcp';
import { ModelJobStore } from './model-job';
import { modelSettings } from './model-settings';
import { qualifiedModelWorker } from './model-worker';
import type { ModelSession } from './model-handoff';
import type { ModelTransport } from './model-transport';
import offer from './fixtures/model-offer.json';

/**
 * THE REAL WORKER RUNTIME UNDER THE REAL ACCEPT CALL, with only the SDK child,
 * the host lookups and the network stubbed: what the accept call writes to
 * Tenjin's data folder went through the runtime's own value replacement.
 */
vi.mock('./worker-github', async (original) => ({
  ...(await original<typeof import('./worker-github')>()),
  prepareWorkerGithub: vi.fn(async () => ({
    directory: '/job',
    env: {},
    secrets: [],
    authenticated: false,
    close: async () => undefined,
  })),
}));
vi.mock('./claude-workspace', async (original) => ({
  ...(await original<typeof import('./claude-workspace')>()),
  claudeWorkspaceWorktrees: vi.fn(async () => []),
}));
vi.mock('@anthropic-ai/claude-agent-sdk/core', () => ({
  query: vi.fn(),
  resolveSettings: vi.fn(),
}));
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ getSessionInfo: vi.fn() }));
vi.mock('./claude-cli', () => ({ readClaudeCodeCached: vi.fn(), meetsFloor: vi.fn() }));
vi.mock('./agent-tools', async (original) => ({
  ...(await original<typeof import('./agent-tools')>()),
  findDefinition: vi.fn(async () => null),
}));
vi.mock('./model-settings', async (original) => ({
  ...(await original<typeof import('./model-settings')>()),
  modelSettings: vi.fn(),
}));
vi.mock('node:http', async (original) => ({
  ...(await original<typeof import('node:http')>()),
  createServer: () => ({
    once: vi.fn(),
    listen: (_port: number, _host: string, ready: () => void) => ready(),
    address: () => ({ port: 12345 }),
    closeAllConnections: vi.fn(),
    close: (done: () => void) => done(),
  }),
}));

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(readClaudeCodeCached).mockResolvedValue({
    binary: { path: '/fixture/claude' },
    version: '2.1.325',
  } as never);
  vi.mocked(meetsFloor).mockReturnValue(true);
  vi.mocked(resolveSettings).mockResolvedValue({ effective: {} } as never);
});
afterEach(() => {
  vi.unstubAllEnvs();
});

async function filesUnder(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true, recursive: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name));
}

it.each(['completed', 'stopped'] as const)(
  'stores a %s handback with env values replaced by their names, in files only the user can read',
  async (ending) => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'stored-handback-repo-')));
    const dataDir = await realpath(await mkdtemp(join(tmpdir(), 'stored-handback-data-')));
    // The worker's Claude config folder is part of who owns a job: one that exists, on any machine.
    const configDir = await realpath(await mkdtemp(join(tmpdir(), 'stored-handback-config-')));
    vi.stubEnv('CLAUDE_CONFIG_DIR', configDir);
    const password = 'Zq8-v3ry-s3cret-pw';
    const url = `postgres://app:${password}@db.internal:5432/app`;
    try {
      await writeFile(join(root, '.env.local'), `POSTGRES_URL="${url}"\n`);
      const settings = {
        version: 2,
        scope: 'repositories',
        root,
        repositories: [root],
        githubRepositories: [],
        maxJobAtomic: 1_000_000n,
        routerOrigin: 'http://localhost:3939',
        context: 'turn',
      };
      vi.mocked(modelSettings).mockResolvedValue(settings as never);
      const qualified = await qualifiedModelWorker(
        root,
        'general-purpose',
        undefined,
        dataDir,
        undefined,
        'default',
      );
      expect(qualified?.claudeWorkspace).toBeDefined();
      vi.mocked(query).mockImplementation((call) => {
        const session_id = (call.options as { sessionId?: string }).sessionId;
        return {
          async *[Symbol.asyncIterator]() {
            yield {
              type: 'system',
              subtype: 'init',
              permissionMode: 'default',
              cwd: root,
              session_id,
            };
            yield {
              type: 'assistant',
              uuid: 'said',
              session_id,
              message: {
                id: 'message-1',
                role: 'assistant',
                usage: { input_tokens: 10, output_tokens: 5 },
                content: [{ type: 'text', text: `connecting to ${url}` }],
              },
            };
            yield ending === 'completed'
              ? {
                  type: 'result',
                  subtype: 'success',
                  session_id,
                  result: `connected with ${password}`,
                }
              : { type: 'result', subtype: 'error_max_turns', session_id, num_turns: 3 };
          },
          accountInfo: async () => ({ apiProvider: 'firstParty', apiKeySource: 'apiKeyHelper' }),
          mcpServerStatus: async () => [],
          close: vi.fn(),
        } as unknown as ReturnType<typeof query>;
      });
      const session: ModelSession = {
        sessionId: 'root',
        turnId: 'turn',
        cwd: root,
        transcript: 'unused',
        harness: 'claude',
        claudePermissionMode: 'default',
      };
      const store = new ModelJobStore(dataDir);
      const job = await store.offer(
        {
          sessionId: 'root',
          turnId: 'turn',
          callId: 'call',
          root,
          task: 'Check the database connection.',
          native: { prompt: 'Check the database connection.' },
          nativeTool: 'Agent',
          capAtomic: '1000000',
          decision: {},
        },
        'routing',
      );
      await store.decided(job.id, {
        ...offer,
        jobId: job.id,
        routerOrigin: settings.routerOrigin,
        claudePermissionMode: 'default',
        claudeWorkspace: qualified!.claudeWorkspace,
      });
      const spend = { actualAtomic: '3000', reservedAtomic: '3000', uncertain: [] };
      const transport = {
        origin: settings.routerOrigin,
        summary: async () => spend,
        reconcile: async () => undefined,
        // A router with no refund support: the worker runs on the transport as it is.
        withInferenceRun: <T>(
          _runId: string,
          _signal: AbortSignal,
          run: (shared: ModelTransport) => Promise<T>,
        ) => run(transport),
      } as unknown as ModelTransport;
      const server = new McpServer({ name: 'test', version: '1' });
      const model = registerModelTool(server, {
        dataDir,
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
      const call = async () => {
        const reply = await client.callTool({ name: 'subagent', arguments: { offer_id: job.id } });
        return (reply.content as Array<{ text: string }>)[0]!.text;
      };
      try {
        const first = await call();
        expect(JSON.parse(first)).toMatchObject({
          status: ending === 'completed' ? 'completed' : 'stopped',
        });
        // What the parent read, and what a later accept reads back from disk.
        const again = await call();
        for (const text of [first, again]) {
          expect(text).toContain('[env:POSTGRES_URL]');
          expect(text).not.toContain(password);
        }
        expect(JSON.parse(again)).toEqual(JSON.parse(first));
        // HOW IT ENDED, for its row: the job's own status, time and counts. Here beside the
        // live view; in a process that holds none (a restart, a resumed session) from the
        // job's record alone, never with the assignment or the result; for no other session.
        const handed = JSON.parse(first);
        const ended = {
          status: handed.status,
          // What ended a job that did not complete travels with its end, for the row's words.
          ...(handed.endedBy ? { endedBy: handed.endedBy } : {}),
          elapsedMs: handed.elapsedMs,
          toolUses: handed.toolUses,
          tokens: handed.tokens,
          ...(ending === 'completed' ? { spend } : {}),
        };
        const read = async (sessionId: string) => {
          const later = new McpServer({ name: 'test', version: '1' });
          const tool = registerModelTool(later, {
            dataDir,
            harness: 'claude',
            session: () => ({ ...session, sessionId }),
            transport: async () => transport,
          });
          const reader = new Client({ name: 'test', version: '1' });
          const [c, d] = InMemoryTransport.createLinkedPair();
          await later.connect(c);
          await reader.connect(d);
          try {
            const reply = await reader.callTool({
              name: 'subagent_activity',
              arguments: { offer_id: job.id },
            });
            return (reply.content as Array<{ text: string }>)[0]!.text;
          } finally {
            await tool.shutdown();
            await reader.close();
            await later.close();
          }
        };
        const live = await client.callTool({
          name: 'subagent_activity',
          arguments: { offer_id: job.id },
        });
        expect(JSON.parse((live.content as Array<{ text: string }>)[0]!.text).ended).toEqual(ended);
        const restarted = await read('root');
        expect(JSON.parse(restarted)).toEqual({ status: 'ended', ended });
        expect(restarted).not.toMatch(/connect|env:|database/i);
        expect(JSON.parse(await read('another-session'))).toEqual({ status: 'unavailable' });
        await model.shutdown();
        const files = await filesUnder(dataDir);
        const stored = await Promise.all(files.map((file) => readFile(file, 'utf8')));
        expect(stored.some((text) => text.includes('[env:POSTGRES_URL]'))).toBe(true);
        expect(stored.some((text) => text.includes(password))).toBe(false);
        for (const file of files) expect((await lstat(file)).mode & 0o777).toBe(0o600);
      } finally {
        await model.shutdown();
        await client.close();
        await server.close();
      }
    } finally {
      for (const dir of [root, dataDir, configDir]) await rm(dir, { recursive: true, force: true });
    }
  },
);
