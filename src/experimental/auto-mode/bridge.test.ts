import { mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Outcome } from './runtime';
import {
  BRIDGE_SERVER_NAME,
  buildBridgeServer,
  createBridgeHookOutput,
  normalizeBridgeEvent,
  readBridgeResult,
} from './bridge';

// Loading this path in the delivery server would pull in the wallet/paid executor.
vi.mock('./runtime', () => {
  throw new Error('The result bridge must not load the runtime.');
});
vi.mock('./execution', () => {
  throw new Error('The result bridge must not load the executor.');
});

let stateDir: string;
const now = 1_000_000;
const clock = { now: () => now };
const connections: Array<() => Promise<void>> = [];
const event = {
  hook_event_name: 'PreToolUse',
  session_id: 'bridge-session',
  tool_use_id: 'bridge-call',
  transcript_path: '/not-read-by-the-bridge',
  tool_name: 'mcp__x402__search',
  tool_input: { query: 'current information' },
};
const outcome: Outcome = {
  status: 'fulfilled',
  selected: {
    url: 'https://api.information.example/search',
    args: { body: { query: 'current information', numResults: 2 } },
    contractHash: 'test-contract',
  },
  execution: {
    status: 'fulfilled',
    amountAtomic: '7000',
    response: {
      status: 200,
      headers: {},
      body: JSON.stringify({
        results: [{ title: 'A source', url: 'https://source.example/article' }],
      }),
    },
    settlement: { status: 'unverified', reason: 'No settlement receipt supplied.' },
  },
};

beforeEach(async () => {
  stateDir = await mkdtemp(join(tmpdir(), 'auto-bridge-'));
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('No network in the receipt bridge.'));
});
afterEach(async () => {
  await Promise.all(connections.splice(0).map((close) => close()));
  expect(globalThis.fetch).not.toHaveBeenCalled();
  vi.restoreAllMocks();
  await rm(stateDir, { recursive: true, force: true });
});

function texts(result: CallToolResult): string[] {
  return result.content.flatMap((item) => (item.type === 'text' ? [item.text] : []));
}

async function receipt(raw: unknown = event, result: Outcome = outcome) {
  return (await createBridgeHookOutput({ stateDir }, raw, result, clock)).hookSpecificOutput;
}

async function client(nativeFallback = false) {
  const server = buildBridgeServer({ stateDir, nativeFallback }, clock);
  const connection = new Client({ name: 'bridge-test', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), connection.connect(clientTransport)]);
  connections.push(async () => {
    await connection.close();
    await server.close();
  });
  return connection;
}

describe('MCP hook normalization', () => {
  it('keeps a neutral information request distinct from legacy search and page retrieval', () => {
    expect(
      normalizeBridgeEvent({
        ...event,
        tool_name: 'mcp__x402__request',
        tool_input: {
          query: 'Read https://source.example/article and summarize it.',
          _receipt: 'old',
        },
      }),
    ).toEqual({
      ...event,
      tool_name: 'Request',
      tool_input: { query: 'Read https://source.example/article and summarize it.' },
    });
  });

  it('preserves the current request identity and removes only receipt transport metadata', () => {
    expect(
      normalizeBridgeEvent({
        ...event,
        tool_input: { ...event.tool_input, _receipt: 'old-untrusted-token' },
      }),
    ).toEqual({
      ...event,
      tool_name: 'WebSearch',
    });
    expect(
      normalizeBridgeEvent({
        ...event,
        tool_name: 'mcp__x402__fetch',
        tool_input: { url: 'https://source.example', prompt: 'Find the date.', _receipt: {} },
      }),
    ).toEqual({
      ...event,
      tool_name: 'WebFetch',
      tool_input: { url: 'https://source.example', prompt: 'Find the date.' },
    });
  });

  it.each([
    { ...event, tool_name: 'WebSearch' },
    { ...event, hook_event_name: 'PostToolUse' },
    { ...event, session_id: '' },
    { ...event, tool_input: { query: ' ' } },
    { ...event, tool_input: { query: 'hello', domain: 'constraint-must-not-be-dropped.example' } },
  ])('refuses invalid or unsupported event shapes', (raw) => {
    expect(() => normalizeBridgeEvent(raw)).toThrow();
  });
});

describe('request-bound local receipts', () => {
  it.each([undefined, 'https://source.example/article'])(
    'delivers an opted-in native handoff without claiming provider fulfillment (%s)',
    async (targetUrl) => {
      const config = { stateDir, nativeFallback: true };
      const raw = { ...event, tool_name: 'mcp__x402__request' };
      const hook = (
        await createBridgeHookOutput(
          config,
          raw,
          {
            status: 'native_fallback',
            reason: 'Normal tools suffice; no x402 execution.',
            ...(targetUrl === undefined ? {} : { targetUrl }),
          },
          clock,
        )
      ).hookSpecificOutput;
      const result = await readBridgeResult(config, 'request', hook.updatedInput, clock);
      expect(result.isError).toBe(false);
      expect(texts(result)[0]).toContain('Jev selected normal tools or host reasoning');
      expect(texts(result)[0]).not.toContain('Fulfilled by');
      expect(JSON.parse(texts(result)[1]!)).toEqual({
        status: 'native_fallback',
        reason: 'Normal tools suffice; no x402 execution.',
        nativeTool: targetUrl === undefined ? 'WebSearch' : 'WebFetch',
        nativeToolRequired: targetUrl !== undefined,
        ...(targetUrl === undefined ? {} : { targetUrl }),
        x402Executed: false,
      });
      expect(hook.additionalContext).toContain('Use native tools if this step needs retrieval');
      expect(hook.additionalContext).toContain('no x402 provider result');
      expect(JSON.stringify(result)).not.toContain('amountAtomic');
    },
  );

  it('refuses native success without opt-in or with execution, fixture, selected provider or unsafe target data', async () => {
    const raw = { ...event, tool_name: 'mcp__x402__request' };
    const native: Outcome = { status: 'native_fallback', reason: 'Normal tools suffice.' };
    for (const [config, value] of [
      [{ stateDir }, native],
      [
        { stateDir, nativeFallback: true },
        { ...native, execution: outcome.execution },
      ],
      [
        { stateDir, nativeFallback: true },
        { ...native, selected: outcome.selected },
      ],
      [
        { stateDir, nativeFallback: true },
        { ...native, fixture: true },
      ],
      [
        { stateDir, nativeFallback: true },
        { ...native, targetUrl: 'http://source.example/' },
      ],
      [
        { stateDir, nativeFallback: true },
        { ...native, targetUrl: 'https://user:password@source.example/' },
      ],
    ] as const) {
      const hook = (await createBridgeHookOutput(config, raw, value, clock)).hookSpecificOutput;
      expect((await readBridgeResult(config, 'request', hook.updatedInput, clock)).isError).toBe(
        true,
      );
    }
  });

  it('binds neutral request receipts separately from legacy search receipts', async () => {
    const hook = await receipt({ ...event, tool_name: 'mcp__x402__request' });
    expect(
      (await readBridgeResult({ stateDir }, 'request', hook.updatedInput, clock)).isError,
    ).toBe(false);
    expect((await readBridgeResult({ stateDir }, 'search', hook.updatedInput, clock)).isError).toBe(
      true,
    );
    const legacy = await receipt();
    expect(
      (await readBridgeResult({ stateDir }, 'request', legacy.updatedInput, clock)).isError,
    ).toBe(true);
    expect(
      (
        await readBridgeResult(
          { stateDir },
          'request',
          { ...hook.updatedInput, query: 'changed' },
          clock,
        )
      ).isError,
    ).toBe(true);
  });

  it('returns successful MCP content with a visible supplier, selected parameters, and amount', async () => {
    const hook = await receipt();
    expect(hook).toMatchObject({
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      updatedInput: {
        query: event.tool_input.query,
        _receipt: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    });
    expect(hook.additionalContext).toContain('cite its actual source URL or endpoint');
    const result = await readBridgeResult({ stateDir }, 'search', hook.updatedInput, clock);
    expect(result.isError).toBe(false);
    expect(texts(result)[0]).toBe(
      'Fulfilled by api.information.example · {"body":{"query":"current information","numResults":2}} · $0.007 USDC',
    );
    const envelope = JSON.parse(texts(result)[1]!);
    expect(envelope).toMatchObject({
      status: 'fulfilled',
      provider: outcome.selected!.url,
      parameters: outcome.selected!.args,
      amountAtomic: '7000',
      httpStatus: 200,
      providerContentUntrusted: true,
      settlement: { status: 'unverified' },
      resultFormat: 'json',
      truncated: false,
    });
    expect(JSON.parse(envelope.result)).toEqual(JSON.parse(outcome.execution!.response!.body));
    expect(JSON.stringify(result)).not.toContain(hook.updatedInput._receipt);
    expect(hook.additionalContext).not.toContain(hook.updatedInput._receipt);
    const files = await readdir(join(stateDir, 'bridge-receipts'));
    expect(files).toEqual([`${hook.updatedInput._receipt}.json`]);
    if (process.platform !== 'win32') {
      expect((await stat(join(stateDir, 'bridge-receipts', files[0]!))).mode & 0o777).toBe(0o600);
      expect((await stat(join(stateDir, 'bridge-receipts'))).mode & 0o777).toBe(0o700);
    }
  });

  it('replays the exact saved receipt idempotently without another execution', async () => {
    const hook = await receipt();
    const first = await readBridgeResult({ stateDir }, 'search', hook.updatedInput, clock);
    const second = await readBridgeResult({ stateDir }, 'search', hook.updatedInput, clock);
    expect(second).toEqual(first);
    expect(await readdir(join(stateDir, 'bridge-receipts'))).toHaveLength(1);
  });

  it('keeps long parameters concise on the first line and complete in the bounded envelope', async () => {
    const args = { body: { query: 'A long but useful search query. '.repeat(12) } };
    const hook = await receipt(event, {
      ...outcome,
      selected: { ...outcome.selected!, args },
    });
    const result = await readBridgeResult({ stateDir }, 'search', hook.updatedInput, clock);
    const firstLine = texts(result)[0]!;
    expect(Array.from(firstLine)).toHaveLength(220);
    expect(firstLine).toMatch(/^Fulfilled by api\.information\.example · /);
    expect(firstLine).toMatch(/… · \$0\.007 USDC$/);
    expect(JSON.parse(texts(result)[1]!).parameters).toEqual(args);
    expect(JSON.parse(texts(result)[1]!).parametersTruncated).toBe(false);
  });

  it('binds tool, URL, query and optional prompt exactly while ignoring object key order', async () => {
    const raw = {
      ...event,
      tool_name: 'mcp__x402__fetch',
      tool_input: { url: 'https://source.example/', prompt: 'Extract the date.' },
    };
    const hook = await receipt(raw);
    const token = hook.updatedInput._receipt;
    expect(
      (
        await readBridgeResult(
          { stateDir },
          'fetch',
          { _receipt: token, prompt: 'Extract the date.', url: 'https://source.example/' },
          clock,
        )
      ).isError,
    ).toBe(false);
    for (const args of [
      { url: 'https://other.example/', prompt: 'Extract the date.' },
      { url: 'https://source.example/', prompt: 'Extract the author.' },
      { url: 'https://source.example/' },
    ]) {
      const result = await readBridgeResult(
        { stateDir },
        'fetch',
        { ...args, _receipt: token },
        clock,
      );
      expect(result.isError).toBe(true);
      expect(texts(result)[0]).toContain('does not match');
    }
    expect(
      (
        await readBridgeResult(
          { stateDir },
          'search',
          { query: 'current information', _receipt: token },
          clock,
        )
      ).isError,
    ).toBe(true);
    const searchHook = await receipt();
    expect(
      (
        await readBridgeResult(
          { stateDir },
          'search',
          { ...searchHook.updatedInput, query: 'changed' },
          clock,
        )
      ).isError,
    ).toBe(true);
  });

  it.each([undefined, '../../outside', 'a'.repeat(63), 'A'.repeat(64), 123])(
    'rejects missing or malformed token %s without revealing it',
    async (token) => {
      const result = await readBridgeResult(
        { stateDir },
        'search',
        { query: 'anything', _receipt: token },
        clock,
      );
      expect(result.isError).toBe(true);
      expect(texts(result)[0]).toBe(
        'Local x402 bridge: A valid receipt from the configured PreToolUse hook is required.',
      );
    },
  );

  it('expires exactly at ten minutes and refuses future or extended receipts', async () => {
    const hook = await receipt();
    expect(
      (
        await readBridgeResult({ stateDir }, 'search', hook.updatedInput, {
          now: () => now + 599_999,
        })
      ).isError,
    ).toBe(false);
    expect(
      (
        await readBridgeResult({ stateDir }, 'search', hook.updatedInput, {
          now: () => now + 600_000,
        })
      ).isError,
    ).toBe(true);
    expect(
      (await readBridgeResult({ stateDir }, 'search', hook.updatedInput, { now: () => now - 1 }))
        .isError,
    ).toBe(true);
    const path = join(stateDir, 'bridge-receipts', `${hook.updatedInput._receipt}.json`);
    const saved = JSON.parse(await readFile(path, 'utf8'));
    await writeFile(path, JSON.stringify({ ...saved, expiresAt: now + 600_001 }));
    expect((await readBridgeResult({ stateDir }, 'search', hook.updatedInput, clock)).isError).toBe(
      true,
    );
  });

  it('fails closed on unknown, corrupt, oversized or symlinked receipt files', async () => {
    const hook = await receipt();
    const path = join(stateDir, 'bridge-receipts', `${hook.updatedInput._receipt}.json`);
    for (const body of ['invalid json', 'a'.repeat(65_537)]) {
      await writeFile(path, body);
      const result = await readBridgeResult({ stateDir }, 'search', hook.updatedInput, clock);
      expect(result.isError).toBe(true);
      expect(texts(result)[0]).toBe('Local x402 bridge: Receipt unavailable.');
    }
    await rm(path);
    expect((await readBridgeResult({ stateDir }, 'search', hook.updatedInput, clock)).isError).toBe(
      true,
    );
    await writeFile(join(stateDir, 'other.json'), '{}');
    await symlink(join(stateDir, 'other.json'), path);
    expect((await readBridgeResult({ stateDir }, 'search', hook.updatedInput, clock)).isError).toBe(
      true,
    );
  });

  it.each<Outcome>([
    { status: 'needs_input', reason: 'A required value is missing.' },
    { status: 'refused', reason: 'Outside the permitted resource scope.' },
    {
      ...outcome,
      status: 'failed',
      execution: {
        ...outcome.execution!,
        status: 'failed',
        response: { status: 503, headers: {}, body: 'Unavailable' },
      },
    },
    { status: 'fulfilled' },
    {
      ...outcome,
      execution: { ...outcome.execution!, response: { status: 500, headers: {}, body: 'Error' } },
    },
  ])('delivers non-success outcomes as truthful MCP errors', async (failed) => {
    const hook = await receipt(event, failed);
    const result = await readBridgeResult({ stateDir }, 'search', hook.updatedInput, clock);
    expect(hook.permissionDecision).toBe('allow');
    expect(result.isError).toBe(true);
    expect(texts(result)[0]).toContain('Local x402 result:');
    expect(texts(result)[0]).not.toContain('Fulfilled by');
    expect(JSON.parse(texts(result)[1]!).status).not.toBe('fulfilled');
  });

  it('labels synthetic output and bounds/redacts previews without changing real parameters', async () => {
    const secret = 'ghp_' + 'a'.repeat(36);
    const hook = await receipt(event, {
      ...outcome,
      fixture: true,
      selected: {
        ...outcome.selected!,
        args: { body: { query: 'x'.repeat(4000), credentials: secret } },
      },
      execution: {
        ...outcome.execution!,
        amountAtomic: '0',
        response: {
          status: 200,
          headers: {},
          body: JSON.stringify({ text: 'x'.repeat(40_000), token: secret }),
        },
      },
    });
    const result = await readBridgeResult({ stateDir }, 'search', hook.updatedInput, clock);
    const envelope = JSON.parse(texts(result)[1]!);
    expect(texts(result)[0]).toMatch(/^SYNTHETIC FIXTURE; no payment/);
    expect(envelope).toMatchObject({ fixture: true, truncated: true, parametersTruncated: true });
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(() => JSON.parse(envelope.result)).not.toThrow();
    expect(JSON.stringify(result).length).toBeLessThan(20_000);
  });
});

describe('read-only MCP server', () => {
  it('advertises native handoffs only when explicitly enabled', async () => {
    const pure = await client();
    const mixed = await client(true);
    expect((await pure.listTools()).tools[0]!.description).not.toContain('native_fallback');
    expect((await mixed.listTools()).tools[0]!.description).toContain('native_fallback');
  });
  it('advertises one provider-free request tool without an execution-category choice', async () => {
    expect(BRIDGE_SERVER_NAME).toBe('x402');
    const connection = await client();
    const { tools } = await connection.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(['request']);
    expect(tools[0]!.inputSchema.required).toEqual(['query']);
    expect(Object.keys(tools[0]!.inputSchema.properties!)).toEqual(['query', '_receipt']);
    expect(JSON.stringify(tools)).not.toMatch(/Exa|Firecrawl|CoinMarketCap|Vaaya/);
    const missing = await connection.callTool({
      name: 'request',
      arguments: { query: 'information' },
    });
    expect(missing.isError).toBe(true);
  });

  it('delivers neutral request receipts through the actual MCP protocol', async () => {
    const connection = await client();
    const hook = await receipt({ ...event, tool_name: 'mcp__x402__request' });
    const result = await connection.callTool({ name: 'request', arguments: hook.updatedInput });
    expect(result.isError).toBe(false);
    expect(result.content).toEqual(
      (await readBridgeResult({ stateDir }, 'request', hook.updatedInput, clock)).content,
    );
  });
});
