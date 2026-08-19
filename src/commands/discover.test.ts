import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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

const PIN_URL = 'https://tenjin.blog/api/phone-lookup';

interface PinnedRow {
  url: string;
  kind: string;
  description: string;
  registry?: string;
  accepts?: { amount: string }[];
}

describe('runDiscover, the pinned block', () => {
  it('renders first-party pins ahead of the sweep, labeled, and carries them in JSON', async () => {
    await writeConfig();
    stubRegistry(() =>
      json({
        x402Version: 2,
        items: [item('https://seller.example/a', 'http')],
        pagination: { limit: 100, offset: 0, total: 1 },
      }),
    );
    const { ctx } = makeCtx();
    const result = await runDiscover({}, ctx);
    const data = result.data as { pinned: PinnedRow[]; resources: { url: string }[] };
    expect(data.pinned.map((p) => p.url)).toEqual([PIN_URL]);
    expect(data.pinned[0]!.kind).toBe('first-party');
    // Additive only: the existing envelope keys are untouched.
    expect(data.resources.map((r) => r.url)).toEqual(['https://seller.example/a']);
    const lines = result.humanLines!;
    expect(lines[0]).toContain('first-party');
    expect(lines[0]).toContain(PIN_URL);
    expect(lines.indexOf(lines.find((l) => l.includes('seller.example/a'))!)).toBeGreaterThan(0);
  });

  it('shows only the pins a query names', async () => {
    await writeConfig();
    stubRegistry(() =>
      json({ x402Version: 2, resources: [item('https://seller.example/b', 'http')] }),
    );
    const { ctx } = makeCtx();
    const hit = await runDiscover({ query: 'phone carrier' }, ctx);
    expect((hit.data as { pinned: PinnedRow[] }).pinned.map((p) => p.url)).toEqual([PIN_URL]);

    const miss = await runDiscover({ query: 'inference' }, ctx);
    expect((miss.data as { pinned: PinnedRow[] }).pinned).toEqual([]);
    expect(miss.humanLines!.join('\n')).not.toContain('first-party');
  });

  it('renders a pin the sweep also lists exactly once, with the registry price', async () => {
    await writeConfig();
    stubRegistry(() =>
      json({
        x402Version: 2,
        items: [item(PIN_URL, 'http'), item('https://seller.example/a', 'http')],
        pagination: { limit: 100, offset: 0, total: 2 },
      }),
    );
    const { ctx } = makeCtx();
    const result = await runDiscover({}, ctx);
    const data = result.data as { pinned: PinnedRow[]; resources: { url: string }[] };
    // Once: in the pinned block, carrying the registry's live terms.
    expect(data.pinned[0]!.accepts?.[0]!.amount).toBe('50000');
    expect(data.pinned[0]!.registry).toBe(REGISTRY);
    expect(data.resources.map((r) => r.url)).toEqual(['https://seller.example/a']);
    const pinLines = result.humanLines!.filter((l) => l.includes(PIN_URL));
    expect(pinLines).toHaveLength(1);
    expect(pinLines[0]).toContain('0.05 USD on eip155:8453');
  });

  // THE HARD RULE. A pin is this repo's own say-so; the evidence store is what a
  // registry returned. A pin must contribute nothing to what `pay` verifies
  // against, including via the dedupe path, so the store a run with a matching
  // pin writes has to be byte-identical to the one a run without any writes.
  it('leaves the pay-time evidence store byte-identical whether or not pins are in play', async () => {
    const listing = {
      x402Version: 2,
      items: [item(PIN_URL, 'http'), item('https://seller.example/a', 'http')],
      pagination: { limit: 100, offset: 0, total: 2 },
    };
    // fetchedAt is stamped from the clock; freeze it so the two stores differ
    // only if the pinned block actually touched one of them.
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-08-18T00:00:00.000Z'));

    await writeConfig();
    stubRegistry(() => json(listing));
    await runDiscover({}, makeCtx().ctx);
    const withPins = await readFile(join(dir, 'bazaar-listings.json'), 'utf8');

    const other = await mkdtemp(join(tmpdir(), 'tenjin-discover-nopins-'));
    try {
      await writeFile(
        join(other, 'config.json'),
        JSON.stringify({ bazaarRegistries: [REGISTRY], baseUrl: 'https://elsewhere.example' }),
      );
      const sink = () => ({ write: () => true }) as unknown as NodeJS.WritableStream;
      const result = await runDiscover(
        {},
        {
          flags: { json: false, timeout: 5000 },
          dataDir: other,
          io: { stdout: sink(), stderr: sink(), isTTY: false },
        },
      );
      // The control run really is pin-free for this URL: it lists PIN_URL as an
      // ordinary swept resource, so the comparison is not two identical no-ops.
      expect(
        (result.data as { resources: { url: string }[] }).resources.map((r) => r.url),
      ).toContain(PIN_URL);
      expect(withPins).toBe(await readFile(join(other, 'bazaar-listings.json'), 'utf8'));
    } finally {
      await rm(other, { recursive: true, force: true });
    }
    expect(withPins).not.toContain('first-party');
  });
});
