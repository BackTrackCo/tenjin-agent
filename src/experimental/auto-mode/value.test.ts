import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { compileResource } from './contracts';
import { FIXTURE_RESOURCE, runEvent, hookOutput } from './runtime';
import { routeIntent } from './routing';
import type { Choose } from './routing';
import type { HookEvent } from './context';

const event: HookEvent = {
  hook_event_name: 'PreToolUse',
  session_id: 'value-session',
  tool_use_id: 'value-call',
  transcript_path: '/unused',
  tool_name: 'Request',
  tool_input: { query: 'Find the official site.' },
};
const context = {
  messages: [{ role: 'user' as const, text: 'Find the official site.' }],
  fingerprint: 'value-context',
};
const compiled = compileResource(FIXTURE_RESOURCE);
if (compiled.status !== 'supported') throw new Error('Invalid fixture');
const contract = compiled.contract;
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

it('offers native alongside capability descriptions without payment prices when configured', async () => {
  const choose = vi.fn<Choose>(async (state, questions) => {
    expect(questions.route!.criteria.native).toBeDefined();
    expect(JSON.parse(questions.route!.criteria.c0!)).not.toHaveProperty('advertisedOffers');
    expect(state).toMatchObject({ latestUserInstruction: context.messages[0]!.text });
    return { route: { choice: 'native' } };
  });
  expect(
    await routeIntent(event, context, [contract], choose, { nativeFallback: true }),
  ).toMatchObject({ status: 'native_fallback' });
  expect(choose).toHaveBeenCalledOnce(); // No argument generation or provider execution.
  expect(
    await routeIntent(event, context, [contract], async (_state, questions) => {
      expect(questions.route!.criteria.native).toBeUndefined();
      return { route: { choice: 'native' } };
    }),
  ).toMatchObject({ status: 'needs_input' });
});

it('can select native with no compatible paid candidates and preserves an exact page target', async () => {
  const targetUrl = 'https://docs.example.org/start';
  const choose: Choose = async (_state, questions) => {
    expect(Object.keys(questions.route!.criteria)).toEqual(['none', 'native']);
    return { route: { choice: 'native' } };
  };
  expect(
    await routeIntent(
      {
        ...event,
        tool_name: 'WebFetch',
        tool_input: { url: targetUrl, prompt: 'Read this page.' },
      },
      context,
      [],
      choose,
      { nativeFallback: true },
    ),
  ).toMatchObject({ status: 'native_fallback', targetUrl });
});

it('does not silently fall back on invalid model output or model failure', async () => {
  expect(
    await routeIntent(event, context, [contract], async () => ({ route: { choice: 'invented' } }), {
      nativeFallback: true,
    }),
  ).toMatchObject({ status: 'needs_input' });
  await expect(
    routeIntent(
      event,
      context,
      [contract],
      async () => {
        throw new Error('model unavailable');
      },
      { nativeFallback: true },
    ),
  ).rejects.toThrow('model unavailable');
});

it('native handoff never reaches the executor, signer, ledger or provider', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'auto-value-'));
  directories.push(stateDir);
  const execute = vi.fn(async () => {
    throw new Error('Native handoff must not execute');
  });
  const outcome = await runEvent(
    event,
    {
      version: 1,
      mode: 'live',
      stateDir,
      policyPath: '/unused',
      model: 'jev-latest',
      discoveryQueries: {},
      nativeFallback: true,
    },
    {
      context,
      contracts: [contract],
      choose: async () => ({ route: { choice: 'native' } }),
      execute,
      executionDeps: {
        stateDir,
        readPolicy: async () => ({
          runId: 'run',
          revision: '1',
          authorization: 'auto',
          expiresAtMs: Date.now() + 1000,
          maxCallAtomic: '1000',
          maxRunAtomic: '1000',
          allowedOperations: ['request'],
        }),
        signPayment: async () => {
          throw new Error('No signing');
        },
      },
    },
  );
  expect(outcome).toMatchObject({ status: 'native_fallback' });
  expect(execute).not.toHaveBeenCalled();
  expect(outcome.execution).toBeUndefined();
  expect(outcome.selected).toBeUndefined();
  expect(await readdir(stateDir)).toEqual([]);
  expect(hookOutput(outcome)).toMatchObject({
    hookSpecificOutput: { permissionDecision: 'allow' },
  });
});
