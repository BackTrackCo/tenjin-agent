import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runDiscover } from './discover';
import type { CommandContext, GlobalFlags } from '../context';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tenjin-discover-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

function makeCtx(): { ctx: CommandContext; stderr: () => string } {
  const err: string[] = [];
  const sink = (parts?: string[]) =>
    ({
      write: (chunk: string | Uint8Array) => {
        parts?.push(chunk.toString());
        return true;
      },
    }) as unknown as NodeJS.WritableStream;
  const flags: GlobalFlags = { json: false, timeout: 5000 };
  return {
    ctx: { flags, dataDir: dir, io: { stdout: sink(), stderr: sink(err), isTTY: false } },
    stderr: () => err.join(''),
  };
}

const REGISTRY = 'https://registry.test';

const ACCEPT = {
  scheme: 'exact',
  network: 'eip155:8453',
  asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  amount: '50000',
  payTo: '0x1111111111111111111111111111111111111111',
  maxTimeoutSeconds: 300,
};

function item(url: string, type: string): Record<string, unknown> {
  return {
    resource: url,
    type,
    x402Version: 2,
    accepts: [ACCEPT],
    lastUpdated: '2026-08-14T00:00:00Z',
    description: 'a listed endpoint',
  };
}

function stubRegistry(handler: (url: string) => Response): { urls: string[] } {
  const urls: string[] = [];
  vi.stubGlobal('fetch', (async (input: Parameters<typeof fetch>[0]) => {
    urls.push(String(input));
    return handler(String(input));
  }) as typeof fetch);
  return { urls };
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

async function writeConfig(over: Record<string, unknown> = {}): Promise<void> {
  await writeFile(
    join(dir, 'config.json'),
    JSON.stringify({ bazaarRegistries: [REGISTRY], ...over }),
  );
}

describe('runDiscover', () => {
  it('lists HTTP resources, skips MCP-type listings, and hints when the toggle is off', async () => {
    await writeConfig();
    stubRegistry(() =>
      json({
        x402Version: 2,
        items: [item('https://seller.example/a', 'http'), item('mcp://somewhere', 'mcp')],
        pagination: { limit: 100, offset: 0, total: 2 },
      }),
    );
    const { ctx, stderr } = makeCtx();
    const result = await runDiscover({}, ctx);
    const data = result.data as {
      resources: { url: string; registry: string }[];
      skippedNonHttp: number;
      errors: unknown[];
      bazaarPay: boolean;
    };
    expect(data.resources).toHaveLength(1);
    expect(data.resources[0]).toMatchObject({
      url: 'https://seller.example/a',
      registry: REGISTRY,
    });
    expect(data.skippedNonHttp).toBe(1);
    expect(data.errors).toEqual([]);
    expect(data.bazaarPay).toBe(false);
    expect(stderr()).toContain('bazaarPay is off');
    expect(result.humanLines!.join('\n')).toContain('seller.example/a');
  });

  it('routes a query through the search endpoint and stays quiet when the toggle is on', async () => {
    await writeConfig({ bazaarPay: true });
    const registry = stubRegistry(() =>
      json({ x402Version: 2, resources: [item('https://seller.example/b', 'http')] }),
    );
    const { ctx, stderr } = makeCtx();
    const result = await runDiscover({ query: 'enrichment' }, ctx);
    const data = result.data as { resources: { url: string }[]; query: string };
    expect(data.query).toBe('enrichment');
    expect(data.resources[0]!.url).toBe('https://seller.example/b');
    expect(registry.urls.some((u) => u.includes('enrichment'))).toBe(true);
    expect(stderr()).toBe('');
  });

  it('reports a registry that did not answer instead of pretending a full sweep', async () => {
    await writeConfig();
    stubRegistry(() => {
      throw new Error('connection refused');
    });
    const { ctx } = makeCtx();
    const result = await runDiscover({}, ctx);
    const data = result.data as { resources: unknown[]; errors: { registry: string }[] };
    expect(data.resources).toEqual([]);
    expect(data.errors[0]!.registry).toBe(REGISTRY);
    expect(result.humanLines!.join('\n')).toContain('did not answer');
  });
});
