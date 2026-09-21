import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { hookOutput, runEvent, fixtureChooser } from './runtime';
import type { AutoConfig, RuntimeDeps } from './runtime';
import type { HookEvent } from './context';
import type { AutoContract } from './contracts';
import type { Choose } from './routing';
import type { ExecutionDeps, executePaidRequest } from './execution';

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
  it('keeps retry authorization stable across assistant/tool updates until another user turn', async () => {
    const setup = { ...(await config()), mode: 'live' as const };
    const transcriptPath = join(setup.stateDir, 'transcript.jsonl');
    const contract: AutoContract = {
      version: 1,
      id: 'stable-endpoint-identity',
      url: 'https://provider.example/report',
      method: 'GET',
      pathTemplate: '/report',
      description: 'Return the requested report.',
      sourceHash: 'metadata-revision',
      schemaSource: 'bazaar-v2',
      responseKind: 'json',
      accepts: [],
      argumentSchema: { type: 'object', properties: {}, additionalProperties: false },
    };
    const execute = vi.fn<typeof executePaidRequest>().mockResolvedValue({
      status: 'fulfilled',
      amountAtomic: '0',
      response: { status: 200, headers: {}, body: '{}' },
    });
    const signPayment = vi.fn(async () => {
      throw new Error('No signing in a runtime identity test.');
    });
    const user = {
      type: 'user',
      sessionId: event.session_id,
      message: { content: 'Get the report.' },
    };
    const assistant = {
      type: 'assistant',
      sessionId: event.session_id,
      message: { content: 'The previous request failed; I will try again.' },
    };
    const toolResult = {
      type: 'user',
      sessionId: event.session_id,
      message: { content: [{ type: 'tool_result', content: 'Renew payment authorization.' }] },
    };
    const histories = [[user], [user, assistant, toolResult], [user, assistant, toolResult, user]];
    for (const [index, rows] of histories.entries()) {
      await writeFile(transcriptPath, rows.map((row) => JSON.stringify(row)).join('\n'));
      expect(
        (
          await runEvent(
            {
              ...event,
              transcript_path: transcriptPath,
              tool_use_id: `identity-${index}`,
              tool_name: 'Request',
              tool_input: { query: 'Get the report.' },
            },
            setup,
            {
              contracts: [contract],
              choose: async () => ({ route: { choice: 'c0' } }),
              execute,
              executionDeps: {
                stateDir: setup.stateDir,
                readPolicy: async () => ({
                  runId: 'identity-test',
                  revision: '1',
                  authorization: 'auto',
                  expiresAtMs: Date.now() + 60_000,
                  maxCallAtomic: '100',
                  maxRunAtomic: '100',
                  allowedOperations: ['request'],
                }),
                signPayment,
              },
            },
          )
        ).status,
      ).toBe('fulfilled');
    }
    const [first, retry, nextTurn] = execute.mock.calls.map(([input]) => input.identity);
    expect(first!.userTurnHash).toMatch(/^[a-f0-9]{64}$/);
    expect(retry!.userTurnHash).toBe(first!.userTurnHash);
    expect(retry!.contextHash).not.toBe(first!.contextHash);
    expect(nextTurn!.userTurnHash).not.toBe(first!.userTurnHash);
    expect(first).toMatchObject({
      capabilityId: 'stable-endpoint-identity',
      contractHash: 'metadata-revision',
    });
    expect(signPayment).not.toHaveBeenCalled();
  });

  it('fetches a new observation on a later user turn and only replays the same tool call', async () => {
    const setup = { ...(await config()), mode: 'live' as const };
    const transcriptPath = join(setup.stateDir, 'transcript.jsonl');
    const contract: AutoContract = {
      version: 1,
      id: 'current-observation',
      url: 'https://provider.example/observation',
      method: 'GET',
      pathTemplate: '/observation',
      description: 'Return the current observation.',
      sourceHash: 'observation-contract',
      schemaSource: 'bazaar-v2',
      responseKind: 'json',
      accepts: [],
      argumentSchema: { type: 'object', properties: {}, additionalProperties: false },
    };
    const choose = vi.fn<Choose>(async () => ({ route: { choice: 'c0' } }));
    const transport = vi
      .fn<NonNullable<ExecutionDeps['transport']>>()
      .mockResolvedValueOnce({
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ observation: 'observation-v1' }),
      })
      .mockResolvedValueOnce({
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ observation: 'observation-v2' }),
      });
    const signPayment = vi.fn(async () => {
      throw new Error('No signing in a cross-turn refresh test.');
    });
    const deps: RuntimeDeps = {
      contracts: [contract],
      choose,
      executionDeps: {
        stateDir: setup.stateDir,
        readPolicy: async () => ({
          runId: 'refresh-test',
          revision: '1',
          authorization: 'auto',
          expiresAtMs: Date.now() + 60_000,
          maxCallAtomic: '100',
          maxRunAtomic: '100',
          allowedOperations: ['request'],
        }),
        transport,
        signPayment,
      },
    };
    const user = {
      type: 'user',
      sessionId: event.session_id,
      message: { content: 'Get the current observation.' },
    };
    await writeFile(transcriptPath, JSON.stringify(user));
    const firstEvent: HookEvent = {
      ...event,
      transcript_path: transcriptPath,
      tool_use_id: 'observation-1',
      tool_name: 'Request',
      tool_input: { query: 'Get the current observation.' },
    };
    const first = await runEvent(firstEvent, setup, deps);
    expect(first.status).toBe('fulfilled');
    expect(first.execution?.response?.body).toBe('{"observation":"observation-v1"}');
    expect(first.execution?.cached).not.toBe(true);

    await writeFile(
      transcriptPath,
      [
        user,
        {
          type: 'assistant',
          sessionId: event.session_id,
          message: { content: 'The current observation is observation-v1.' },
        },
        {
          type: 'user',
          sessionId: event.session_id,
          message: { content: 'Check it now.' },
        },
      ]
        .map((row) => JSON.stringify(row))
        .join('\n'),
    );
    const secondEvent = { ...firstEvent, tool_use_id: 'observation-2' };
    const second = await runEvent(secondEvent, setup, deps);
    expect(second.status).toBe('fulfilled');
    expect(second.execution?.response?.body).toBe('{"observation":"observation-v2"}');
    expect(second.execution?.cached).not.toBe(true);
    expect(second.selected?.args).toEqual(first.selected?.args);
    expect(transport).toHaveBeenCalledTimes(2);
    expect(transport.mock.calls[1]).toEqual(transport.mock.calls[0]);
    const routeCalls = choose.mock.calls.length;

    const replay = await runEvent(secondEvent, setup, deps);
    expect(replay.status).toBe('fulfilled');
    expect(replay.execution?.response).toEqual(second.execution?.response);
    expect(replay.execution?.cached).toBe(true);
    expect(choose).toHaveBeenCalledTimes(routeCalls);
    expect(transport).toHaveBeenCalledTimes(2);
    expect(signPayment).not.toHaveBeenCalled();
  });

  it.each(['request', 'fetch'] as const)(
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
              allowedOperations: ['request', 'search', 'fetch'],
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
