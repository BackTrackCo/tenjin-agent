import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { ModelSession } from './model-handoff';

/** The session each server hands its model tool: the turn identity under test. */
const sessions = vi.hoisted(() => [] as Array<() => ModelSession | undefined>);
vi.mock('./model-mcp', () => ({
  registerModelTool: (_server: unknown, options: { session: () => ModelSession | undefined }) => {
    sessions.push(options.session);
    return { shutdown: async () => {}, fence: async () => {}, codexHook: async () => null };
  },
  stopModelWorkers: async () => {},
}));
import { hookToolInput } from './hook-tool';
import { buildRouterMcpServer } from './mcp';
import { testWalletProvider } from '../lib/read-test-utils';

let dir: string;
afterEach(async () => {
  sessions.length = 0;
  if (dir) await rm(dir, { recursive: true, force: true });
});

it('names a typed prompt turn so that a restarted process can never repeat an earlier turn of the session', async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), 'tenjin-model-turn-')));
  const homeDir = join(dir, 'home');
  const project = join(homeDir, '.claude', 'projects', '-repo');
  await mkdir(project, { recursive: true });
  const transcript = join(project, 'resumed.jsonl');
  await writeFile(transcript, '');
  const event: Record<string, string> = {
    hook_event_name: 'UserPromptSubmit',
    session_id: 'resumed',
    transcript_path: transcript,
    cwd: dir,
    prompt: 'continue',
  };
  /** One `tenjin mcp` process serving one typed prompt of the same session. */
  const firstTurnOfAProcess = async () => {
    const server = buildRouterMcpServer({
      dataDir: dir,
      homeDir,
      handlerDeps: { provider: testWalletProvider() },
      hookDeps: {
        baseUrl: 'https://router.test',
        fetchImpl: async () => new Response('', { status: 503 }),
        warn: () => undefined,
        env: {},
      },
    });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '0.0.0' });
    await Promise.all([server.connect(b), client.connect(a)]);
    try {
      await client.callTool({
        name: 'hook',
        arguments: Object.fromEntries(
          Object.entries(hookToolInput('prompt')).map(([key, value]) => {
            const field = /^\$\{(.+)\}$/.exec(value)?.[1];
            return [key, field === undefined ? value : (event[field] ?? '')];
          }),
        ),
      });
      return sessions.at(-1)!()?.turnId;
    } finally {
      await client.close();
      await server.close();
    }
  };
  const turns = [await firstTurnOfAProcess(), await firstTurnOfAProcess()];
  expect(turns.every((turn) => typeof turn === 'string' && turn.length > 8)).toBe(true);
  expect(turns[0]).not.toBe(turns[1]);
});
