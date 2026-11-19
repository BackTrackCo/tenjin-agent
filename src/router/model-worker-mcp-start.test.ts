import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { expect, it, vi } from 'vitest';
import { createRouterMcpServer } from './mcp';
import { RoutingPayer } from './routing-payer';
import { FakeRouter, payerDeps } from './fee-test-utils';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import * as settings from './settings';
import * as context from '../lib/settings';

it('initializes the real worker MCP tool catalog without unlocking a wallet or starting any top-up/network request', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'worker-mcp-start-'));
  const payer = new RoutingPayer(
    payerDeps(new FakeRouter(), dir, privateKeyToAccount(generatePrivateKey())),
  );
  const prewarm = vi.spyOn(payer, 'prewarm').mockResolvedValue(undefined);
  vi.spyOn(payer, 'signVerdict').mockReturnValue({ status: 'ready' });
  const topUp = vi.spyOn(payer, 'topUpIfLow').mockResolvedValue(undefined);
  vi.spyOn(settings, 'routerSettings').mockResolvedValue({ enabled: { value: true } } as never);
  vi.spyOn(context, 'resolveContextSettings').mockResolvedValue({
    baseUrl: 'https://router.test',
  } as never);
  const client = new Client({ name: 'native-worker-proof', version: '1' });
  const server = await createRouterMcpServer({
    dataDir: dir,
    harness: 'codex',
    env: { ...process.env, TENJIN_MODEL_WORKER: '1' },
    topUpAtStart: true,
    payer,
  });
  try {
    await writeFile(join(dir, 'config.json'), JSON.stringify({ router: { enabled: true } }));
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    await client.connect(b);
    const tools = await client.listTools();
    // The catalog a worker's host reads at start: the hook legs' tool alone. A worker has
    // none of Tenjin's own tools, so `request` is no longer in it.
    expect(tools.tools.map((tool) => tool.name)).toEqual(['hook']);
    expect(topUp).not.toHaveBeenCalled();
    expect(prewarm).not.toHaveBeenCalled();
  } finally {
    await client.close();
    await server.close();
    await rm(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  }
});
