import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { runNativeGate } from './native-gate';
import { compileResource } from './contracts';
import { FIXTURE_RESOURCE, fixtureChooser, hookOutput } from './runtime';
import type { AutoConfig, RuntimeDeps } from './runtime';
import type { HookEvent } from './context';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});
async function setup() {
  const stateDir = await mkdtemp(join(tmpdir(), 'auto-native-gate-'));
  directories.push(stateDir);
  const config: AutoConfig = {
    version: 1,
    mode: 'fixture',
    stateDir,
    policyPath: '/unused',
    model: 'jev-latest',
    discoveryQueries: {},
    nativeFallback: true,
  };
  const event: HookEvent = {
    hook_event_name: 'PreToolUse',
    session_id: 'native-session',
    tool_use_id: 'native-call',
    transcript_path: join(stateDir, 'transcript.jsonl'),
    tool_name: 'WebSearch',
    tool_input: { query: 'Find the official city website.' },
  };
  await writeFile(
    event.transcript_path,
    JSON.stringify({
      type: 'user',
      sessionId: event.session_id,
      message: { content: 'Find the official city website.' },
    }),
  );
  const compiled = compileResource(FIXTURE_RESOURCE);
  if (compiled.status !== 'supported') throw new Error('Fixture must compile.');
  const execute = vi.fn(() => {
    throw new Error('Native routing cannot execute providers.');
  });
  const signPayment = vi.fn(() => {
    throw new Error('Native routing cannot sign payments.');
  });
  const onSelected = vi.fn(async () => {
    throw new Error('Native routing is not execution progress.');
  });
  const deps: RuntimeDeps = {
    contracts: [compiled.contract],
    choose: async () => ({ route: { choice: 'native' } }),
    execute,
    onSelected,
    executionDeps: {
      stateDir,
      signPayment,
      readPolicy: async () => ({
        runId: 'gate-test',
        revision: '1',
        authorization: 'auto',
        expiresAtMs: Date.now() + 60_000,
        maxCallAtomic: '10000',
        maxRunAtomic: '10000',
        allowedOperations: ['search', 'fetch'],
      }),
    },
  };
  return { config, event, deps, execute, signPayment, onSelected };
}

it('reads the actual session and allows a native decision without executing, signing, or paid progress', async () => {
  const { config, event, deps, execute, signPayment, onSelected } = await setup();
  const choose = vi.fn(deps.choose!);
  const outcome = await runNativeGate(event, config, { ...deps, choose });
  expect(outcome.status).toBe('native_fallback');
  expect(hookOutput(outcome).hookSpecificOutput.permissionDecision).toBe('allow');
  expect(JSON.stringify(choose.mock.calls[0]?.[0])).toContain('Find the official city website.');
  expect(outcome.execution).toBeUndefined();
  expect(execute).not.toHaveBeenCalled();
  expect(signPayment).not.toHaveBeenCalled();
  expect(onSelected).not.toHaveBeenCalled();
});

it('preserves the exact native fetch URL', async () => {
  const { config, event, deps } = await setup();
  const url = 'https://city.example/official?section=about';
  const outcome = await runNativeGate(
    { ...event, tool_name: 'WebFetch', tool_input: { url, prompt: 'Read it.' } },
    config,
    deps,
  );
  expect(outcome).toMatchObject({ status: 'native_fallback', targetUrl: url });
});

it('returns paid preference as a denial and never executes the selected request', async () => {
  const { config, event, deps, execute, signPayment, onSelected } = await setup();
  const outcome = await runNativeGate(event, config, { ...deps, choose: fixtureChooser });
  expect(outcome).toMatchObject({
    status: 'paid_preferred',
    selected: { url: FIXTURE_RESOURCE.resource, args: { body: { query: event.tool_input.query } } },
  });
  expect(outcome.reason).toContain('mcp__x402__request');
  expect(outcome.selected?.contractHash).toMatch(/^[a-f0-9]{64}$/);
  expect(hookOutput(outcome).hookSpecificOutput.permissionDecision).toBe('deny');
  expect(outcome.execution).toBeUndefined();
  expect(execute).not.toHaveBeenCalled();
  expect(signPayment).not.toHaveBeenCalled();
  expect(onSelected).not.toHaveBeenCalled();
});

it('fails closed for disabled configuration, unsupported tools, missing context, and unresolved choices', async () => {
  const { config, event, deps } = await setup();
  const choose = vi.fn(deps.choose!);
  for (const raw of [{ ...event, tool_name: 'Request' }, { ...event, tool_name: 'Bash' }, {}])
    expect((await runNativeGate(raw, config, { ...deps, choose })).status).toBe('refused');
  expect(
    (await runNativeGate(event, { ...config, nativeFallback: false }, { ...deps, choose })).status,
  ).toBe('refused');
  expect(choose).not.toHaveBeenCalled();
  for (const outcome of [
    await runNativeGate(
      { ...event, transcript_path: join(config.stateDir, 'missing') },
      config,
      deps,
    ),
    await runNativeGate(event, config, {
      ...deps,
      choose: async () => ({ route: { choice: 'none' } }),
    }),
    await runNativeGate(event, config, {
      ...deps,
      choose: async () => {
        throw new Error('Unavailable');
      },
    }),
  ]) {
    expect(outcome.status).not.toBe('native_fallback');
    expect(outcome.reason).toContain('mcp__x402__request');
    expect(hookOutput(outcome).hookSpecificOutput.permissionDecision).toBe('deny');
    expect(outcome.execution).toBeUndefined();
  }
});
