import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { compileResource } from './contracts';
import { demoCatalog } from './demo-catalog';
import { runNativeGate } from './native-gate';
import { routeIntent } from './routing';
import { ConfigSchema, FIXTURE_RESOURCE, hookOutput, runEvent } from './runtime';
import type { HookEvent, TaskContext } from './context';
import type { AutoContract } from './contracts';
import type { Choose } from './routing';
import type { RuntimeDeps } from './runtime';

const targetUrl = 'https://docs.example.org/guide?lang=en&part=1';
const fetchEvent: HookEvent = {
  hook_event_name: 'PreToolUse',
  session_id: 'availability-session',
  tool_use_id: 'availability-call',
  transcript_path: '/unused',
  tool_name: 'WebFetch',
  tool_input: { url: targetUrl, prompt: 'Read this page and summarize it.' },
};
const pageEvent: HookEvent = {
  ...fetchEvent,
  tool_name: 'Request',
  tool_input: { query: `Read ${targetUrl} and summarize it.` },
};
const context: TaskContext = {
  messages: [{ role: 'user', text: `Read ${targetUrl} and summarize it.` }],
  fingerprint: 'page-availability-context',
};
function compile(resource: unknown): AutoContract {
  const compiled = compileResource(resource);
  if (compiled.status !== 'supported') throw new Error(compiled.reasons.join('; '));
  return compiled.contract;
}
const reader = compile(
  demoCatalog().resources.find(
    (resource) => resource.resource === 'https://vaaya.ai/api/run/firecrawl/scrape',
  ),
);
const search = compile(FIXTURE_RESOURCE);
const unavailable = { nativeFallback: true, nativeWebFetch: false };
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

function pageChooser(): Choose {
  return async (state, questions): ReturnType<Choose> => {
    if (questions.operation) return { operation: { choice: 'page0' } };
    if (questions.route) {
      expect(Object.keys(questions.route.criteria)).toEqual(['none', 'c0']);
      expect(state).toMatchObject({
        nativeWebFetchAvailable: false,
        pendingOperation: { kind: 'retrieve_page', targetUrl },
      });
      return { route: { choice: 'c0' } };
    }
    if (questions.arguments) return { arguments: { choice: 'p0' } };
    return Object.fromEntries(
      Object.entries(questions).map(([key, question]) => {
        if (!question.instructions.includes('for body.url of ')) return [key, { choice: 'omit' }];
        const exact = Object.entries(question.criteria).find(
          ([, label]) => label === `pending tool.url: ${JSON.stringify(targetUrl)}`,
        );
        expect(exact).toBeDefined();
        return [key, { choice: exact![0] }];
      }),
    );
  };
}

async function runtimeSetup() {
  const stateDir = await mkdtemp(join(tmpdir(), 'auto-native-availability-'));
  directories.push(stateDir);
  const config = ConfigSchema.parse({
    version: 1,
    mode: 'live',
    stateDir,
    policyPath: '/unused',
    ...unavailable,
  });
  const execute = vi.fn(() => {
    throw new Error('Unavailable or declined native reads cannot execute a provider.');
  });
  const signPayment = vi.fn(() => {
    throw new Error('Unavailable or declined native reads cannot sign payments.');
  });
  const readPolicy = vi.fn(async () => ({
    runId: 'availability-test',
    revision: '1',
    authorization: 'auto' as const,
    expiresAtMs: Date.now() + 60_000,
    maxCallAtomic: '100000',
    maxRunAtomic: '100000',
    allowedOperations: ['request', 'fetch', 'search'],
  }));
  const deps: RuntimeDeps = {
    context,
    contracts: [reader],
    execute,
    executionDeps: { stateDir, signPayment, readPolicy },
  };
  return { config, deps, execute, signPayment, readPolicy };
}

it.each([
  ['direct WebFetch', fetchEvent],
  ['neutral request resolved to page0', pageEvent],
] as const)('routes %s through the real page reader with the exact URL', async (_name, event) => {
  const choose = vi.fn(pageChooser());
  const result = await routeIntent(event, context, [reader], choose, unavailable);
  expect(result).toMatchObject({
    status: 'selected',
    contract: { url: reader.url },
    args: { body: { url: targetUrl } },
  });
  if (result.status === 'selected') expect(result.args).toEqual({ body: { url: targetUrl } });
});

it('retains native WebSearch and reasoning when native page reads are disabled', async () => {
  const choose = vi.fn<Choose>(async (state, questions): ReturnType<Choose> => {
    expect(state).toMatchObject({ nativeWebFetchAvailable: false });
    expect(Object.keys(questions.route!.criteria)).toEqual(['none', 'native']);
    expect(questions.route!.criteria.native).toContain('WebSearch');
    expect(questions.route!.criteria.native).toContain('WebFetch is unavailable');
    return { route: { choice: 'native' } };
  });
  expect(
    await routeIntent(
      { ...fetchEvent, tool_name: 'WebSearch', tool_input: { query: 'capital of France' } },
      { ...context, messages: [{ role: 'user', text: 'What is the capital of France?' }] },
      [],
      choose,
      unavailable,
    ),
  ).toMatchObject({ status: 'native_fallback' });
  expect(choose).toHaveBeenCalledOnce();
});

it.each([undefined, true])(
  'retains legacy native page reads with nativeWebFetch=%s',
  async (flag) => {
    const choose = vi.fn<Choose>(async (_state, questions): ReturnType<Choose> => {
      expect(Object.keys(questions.route!.criteria)).toEqual(['none', 'native']);
      return { route: { choice: 'native' } };
    });
    expect(
      await routeIntent(fetchEvent, context, [], choose, {
        nativeFallback: true,
        ...(flag === undefined ? {} : { nativeWebFetch: flag }),
      }),
    ).toMatchObject({ status: 'native_fallback', targetUrl });
  },
);

it.each([false, true])(
  'rejects an unavailable native choice with priceAware=%s',
  async (priceAware) => {
    const expensive = {
      ...reader,
      accepts: reader.accepts.map((offer) => ({ ...(offer as object), amount: '2000000' })),
    };
    const choose = vi.fn<Choose>(async (state, questions): ReturnType<Choose> => {
      expect(questions.route!.criteria.native).toBeUndefined();
      expect(questions.route!.criteria.c0).toBeDefined();
      if (priceAware)
        expect(state).toMatchObject({
          advertisedPrices: { c0: { comparisonCeilingUSDC: '2' } },
        });
      return { route: { choice: 'native' } };
    });
    const result = await routeIntent(fetchEvent, context, [expensive], choose, {
      ...unavailable,
      priceAware,
    });
    expect(result.status).toBe('needs_input');
    expect(hookOutput(result).hookSpecificOutput.permissionDecision).toBe('deny');
    expect(choose).toHaveBeenCalledOnce();
  },
);

it.each([
  { name: 'empty catalog', contracts: [] },
  { name: 'search-only catalog', contracts: [search] },
])('returns unsupported without calling Jev for $name', async ({ contracts }) => {
  const choose = vi.fn<Choose>();
  expect(await routeIntent(fetchEvent, context, contracts, choose, unavailable)).toMatchObject({
    status: 'unsupported',
  });
  expect(choose).not.toHaveBeenCalled();
});

it('returns unsupported after resolving a neutral request when only search is available', async () => {
  const choose = vi.fn<Choose>(async (_state, questions): ReturnType<Choose> => {
    expect(questions.operation).toBeDefined();
    return { operation: { choice: 'page0' } };
  });
  expect(await routeIntent(pageEvent, context, [search], choose, unavailable)).toMatchObject({
    status: 'unsupported',
  });
  expect(choose).toHaveBeenCalledOnce();
});

it('does not mistake a company URL in an information request for a mandatory page read', async () => {
  const text =
    'What does the company at https://stripe.com do? A brief public description is enough.';
  const choose = vi.fn<Choose>(async (state, questions): ReturnType<Choose> => {
    if (questions.operation) return { operation: { choice: 'information' } };
    expect(state).toMatchObject({ pendingOperation: { kind: 'request' } });
    expect(questions.route!.criteria.native).toBeDefined();
    return { route: { choice: 'native' } };
  });
  expect(
    await routeIntent(
      { ...pageEvent, tool_input: { query: text } },
      { ...context, messages: [{ role: 'user', text }] },
      [search],
      choose,
      unavailable,
    ),
  ).toMatchObject({ status: 'native_fallback' });
  expect(choose).toHaveBeenCalledTimes(2);
});

it('forwards disabled page availability through runtime configuration and rejects string booleans', async () => {
  const { config, deps, execute, signPayment } = await runtimeSetup();
  expect(config.nativeWebFetch).toBe(false);
  expect(ConfigSchema.safeParse({ ...config, nativeWebFetch: 'false' }).success).toBe(false);
  const choose = vi.fn<Choose>(async (state, questions): ReturnType<Choose> => {
    if (questions.operation) return { operation: { choice: 'page0' } };
    expect(state).toMatchObject({ nativeWebFetchAvailable: false });
    expect(questions.route!.criteria.native).toBeUndefined();
    return { route: { choice: 'native' } };
  });
  const outcome = await runEvent(pageEvent, config, { ...deps, choose });
  expect(outcome.status).toBe('needs_input');
  expect(outcome.execution).toBeUndefined();
  expect(execute).not.toHaveBeenCalled();
  expect(signPayment).not.toHaveBeenCalled();
  expect(await readdir(config.stateDir)).toEqual([]);
});

it('preserves a no-paid page constraint as deferral without inventing native availability or executing', async () => {
  const { config, deps, execute, signPayment } = await runtimeSetup();
  const noPaidContext: TaskContext = {
    ...context,
    messages: [{ role: 'user', text: `Read ${targetUrl}, but do not use any paid service.` }],
  };
  const choose = vi.fn<Choose>(async (state, questions): ReturnType<Choose> => {
    if (questions.operation) return { operation: { choice: 'page0' } };
    expect(state).toMatchObject({ latestUserInstruction: noPaidContext.messages[0]!.text });
    expect(questions.route!.criteria.native).toBeUndefined();
    expect(questions.route!.criteria.none).toBeDefined();
    expect(questions.route!.instructions).toContain('user forbids paid tools');
    return { route: { choice: 'none' } };
  });
  const outcome = await runEvent(pageEvent, config, { ...deps, context: noPaidContext, choose });
  expect(outcome.status).toBe('needs_input');
  expect(outcome.execution).toBeUndefined();
  expect(execute).not.toHaveBeenCalled();
  expect(signPayment).not.toHaveBeenCalled();
  expect(await readdir(config.stateDir)).toEqual([]);
});

it('refuses disabled native WebFetch at the gate before reading context, choosing, executing or signing', async () => {
  const { config, deps, execute, signPayment, readPolicy } = await runtimeSetup();
  const choose = vi.fn<Choose>();
  const outcome = await runNativeGate(fetchEvent, config, { ...deps, context: undefined, choose });
  expect(outcome).toMatchObject({
    status: 'refused',
    reason: expect.stringContaining('Native WebFetch is disabled'),
  });
  expect(hookOutput(outcome).hookSpecificOutput.permissionDecision).toBe('deny');
  expect(choose).not.toHaveBeenCalled();
  expect(readPolicy).not.toHaveBeenCalled();
  expect(execute).not.toHaveBeenCalled();
  expect(signPayment).not.toHaveBeenCalled();
  expect(await readdir(config.stateDir)).toEqual([]);
});
