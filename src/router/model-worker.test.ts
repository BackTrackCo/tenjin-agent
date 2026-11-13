import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { expect, it, vi } from 'vitest';
import { nativeGateServer, nativeGateTools } from './model-worker';
import type { CodexModelGates } from './codex-model-gates';

function fixture(schema: Record<string, unknown>) {
  const callMcp = vi.fn(async () => ({ content: [{ type: 'text', text: 'native result' }] }));
  const command = vi.fn(async () => ({ stdout: '', stderr: '', exitCode: 0 }));
  const gates: CodexModelGates = {
    qualified: true,
    reasons: [],
    commands: false,
    tools: [{ server: 'fixture', name: 'lookup', inputSchema: schema }],
    callMcp,
    command,
  };
  return { gates, callMcp, command };
}

it('preserves native MCP JSON Schema and original arguments, including optional defaults and extra keys', async () => {
  const schema = {
    type: 'object',
    properties: {
      id: { type: 'integer', minimum: 1 },
      label: { type: 'string', default: 'annotation only' },
    },
    required: ['id'],
    additionalProperties: { type: 'string' },
  };
  const { gates, callMcp, command } = fixture(schema);
  const definitions = nativeGateTools(gates, '/repo', new AbortController().signal);
  const sdk = nativeGateServer(definitions);
  const client = new Client({ name: 'worker-proof', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await sdk.instance.connect(a);
    await client.connect(b);
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(['native_0']);
    expect(tools[0]!.inputSchema).toEqual(schema);
    await client.callTool({ name: 'native_0', arguments: { id: 2, extra: 'keep' } });
    expect(callMcp).toHaveBeenCalledWith(
      'fixture',
      'lookup',
      { id: 2, extra: 'keep' },
      expect.any(AbortSignal),
    );
    expect(command).not.toHaveBeenCalled();
    await expect(client.callTool({ name: 'native_0', arguments: { id: '2' } })).rejects.toThrow(
      /declared schema/,
    );
    expect(callMcp).toHaveBeenCalledTimes(1);
  } finally {
    await client.close();
    await sdk.instance.close();
  }
});

it('refuses unsupported schemas before worker startup and rechecks consent before native execution', async () => {
  const unsupported = fixture({
    type: 'object',
    properties: { value: { $ref: 'https://untrusted.test/schema' } },
  });
  expect(() => nativeGateTools(unsupported.gates, '/repo', new AbortController().signal)).toThrow(
    /Remote/,
  );
  expect(unsupported.callMcp).not.toHaveBeenCalled();
  const { gates, callMcp } = fixture({ type: 'object', properties: {} });
  const definitions = nativeGateTools(gates, '/repo', new AbortController().signal, async () => {
    throw new Error('Consent revoked');
  });
  await expect(definitions[0]!.handler({})).rejects.toThrow('Consent revoked');
  expect(callMcp).not.toHaveBeenCalled();
});
