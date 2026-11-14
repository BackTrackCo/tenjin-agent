import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { expect, it, vi } from 'vitest';
import { createRouterMcpServer } from './mcp';

it('initializes the real worker MCP tool catalog without unlocking a wallet or starting any top-up/network request', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'worker-mcp-start-'));
  const signer = vi.fn(async () => {
    throw new Error('No signer authorized');
  });
  const network = vi.fn(async () => {
    throw new Error('No request authorized');
  });
  const client = new Client({ name: 'native-worker-proof', version: '1' });
  const server = await createRouterMcpServer({
    dataDir: dir,
    harness: 'codex',
    env: { ...process.env, TENJIN_MODEL_WORKER: '1' },
    topUpAtStart: true,
    payerDeps: { getSigner: signer, fetchImpl: network },
  });
  try {
    await writeFile(join(dir, 'config.json'), JSON.stringify({ router: { enabled: true } }));
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    await client.connect(b);
    const tools = await client.listTools();
    expect(tools.tools.some((tool) => tool.name === 'request')).toBe(true);
    expect(signer).not.toHaveBeenCalled();
    expect(network).not.toHaveBeenCalled();
  } finally {
    await client.close();
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});
