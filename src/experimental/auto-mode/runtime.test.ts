import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { hookOutput, runEvent, fixtureChooser } from './runtime';
import type { AutoConfig } from './runtime';
import type { HookEvent } from './context';
import type { AutoContract } from './contracts';
import type { Choose } from './routing';
import type { executePaidRequest } from './execution';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});
const event: HookEvent = {
  hook_event_name: 'PreToolUse',
  session_id: 'test-session',
  tool_use_id: 'test-call',
  transcript_path: '/missing-transcript',
  tool_name: 'WebSearch',
  tool_input: { query: 'find the archive' },
};
async function config(): Promise<AutoConfig> {
  const stateDir = await mkdtemp(join(tmpdir(), 'auto-cache-test-'));
  directories.push(stateDir);
  return {
    version: 1,
    mode: 'fixture',
    stateDir,
    policyPath: '/unused',
    model: 'jev-latest',
    discoveryQueries: {},
  };
}

describe('hook result delivery', () => {
  it.each(['search', 'fetch'] as const)(
    'authorizes a neutral Request using its Jev-selected %s scope',
    async (operation) => {
      const setup = { ...(await config()), mode: 'live' as const };
      const url = 'https://source.example/article';
      const query = `Get the requested information from ${url}`;
      const field = operation === 'fetch' ? 'url' : 'query';
      const contract: AutoContract = {
        version: 1,
        id: 'scope-fixture',
        url: 'https://provider.example/call',
        method: 'POST',
        pathTemplate: '/call',
        description: 'Synthetic information capability',
        sourceHash: 'scope-fixture',
        schemaSource: 'bazaar-v2',
        bodyEncoding: 'json',
        responseKind: 'json',
        accepts: [],
        argumentSchema: {
          type: 'object',
          properties: {
            body: {
              type: 'object',
              properties: { [field]: { type: 'string' } },
              required: [field],
            },
          },
          required: ['body'],
        },
      };
      const choose: Choose = async (_state, questions): Promise<Awaited<ReturnType<Choose>>> => {
        if (questions.operation)
          return { operation: { choice: operation === 'fetch' ? 'page0' : 'information' } };
        if (questions.route) return { route: { choice: 'c0' } };
        const source = Object.entries(questions.a0!.criteria).find(([, text]) =>
          text.startsWith(`pending tool.${field}:`),
        )!;
        return { a0: { choice: source[0] } };
      };
      const execute = vi.fn<typeof executePaidRequest>().mockResolvedValue({
        status: 'fulfilled',
        amountAtomic: '1',
        response: { status: 200, headers: {}, body: '{}' },
      });
      const signPayment = vi.fn(async () => {
        throw new Error('No payment signing in this test.');
      });
      const result = await runEvent(
        { ...event, tool_name: 'Request', tool_input: { query } },
        setup,
        {
          context: { messages: [{ role: 'user', text: query }], fingerprint: 'scope-test' },
          contracts: [contract],
          choose,
          execute,
          executionDeps: {
            stateDir: setup.stateDir,
            readPolicy: async () => ({
              runId: 'scope-test',
              revision: '1',
              authorization: 'auto',
              expiresAtMs: Date.now() + 60_000,
              maxCallAtomic: '100',
              maxRunAtomic: '100',
              allowedOperations: ['search', 'fetch'],
            }),
            signPayment,
            nestedTargetValidation: {
              resolveHostname: async () => [{ address: '93.184.216.34', family: 4 }],
            },
          },
        },
      );
      expect(result.status).toBe('fulfilled');
      expect(execute).toHaveBeenCalledOnce();
      expect(execute.mock.calls[0]![0]).toMatchObject({
        operation,
        request: { body: JSON.stringify({ [field]: operation === 'fetch' ? url : query }) },
      });
      expect(signPayment).not.toHaveBeenCalled();
    },
  );

  it('replays a completed event without reading history or calling the router again', async () => {
    const setup = await config();
    const choose = vi.fn(fixtureChooser);
    const deps = {
      context: {
        messages: [{ role: 'user' as const, text: 'Find the archive.' }],
        fingerprint: 'fixture',
      },
      choose,
    };
    expect((await runEvent(event, setup, deps)).status).toBe('fulfilled');
    const count = choose.mock.calls.length;
    const replay = await runEvent(event, setup, { choose });
    expect(replay.execution?.cached).toBe(true);
    expect(choose).toHaveBeenCalledTimes(count);
    expect(
      await runEvent({ ...event, tool_input: { query: 'different' } }, setup, deps),
    ).toMatchObject({ status: 'refused' });
  });
  it('caps the full context even for escaped bodies and oversized metadata', () => {
    const result = hookOutput({
      status: 'fulfilled',
      selected: {
        url: `https://example.com/${'\u0000'.repeat(16000)}`,
        args: {},
        contractHash: 'fixture',
      },
      execution: {
        status: 'fulfilled',
        amountAtomic: '1',
        settlement: { status: 'unverified', reason: 'x'.repeat(16000) },
        response: { status: 200, headers: {}, body: '\\"'.repeat(100000) },
      },
    }).hookSpecificOutput;
    expect(result.permissionDecision).toBe('deny');
    expect(result.additionalContext.length).toBeLessThan(10000);
    expect(
      JSON.parse(result.additionalContext.slice(result.additionalContext.indexOf('\n') + 1))
        .truncated,
    ).toBe(true);
  });
});
