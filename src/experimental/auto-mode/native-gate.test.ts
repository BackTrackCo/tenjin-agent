import { mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { runNativeGate } from './native-gate';
import { compileResource } from './contracts';
import { readTaskContext } from './context';
import { saveNativeContinuation } from './native-continuation';
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
  const [missingContext, unresolvedChoice, unavailableChooser] = [
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
  ];
  for (const outcome of [missingContext!, unresolvedChoice!, unavailableChooser!]) {
    expect(outcome.status).not.toBe('native_fallback');
    expect(hookOutput(outcome).hookSpecificOutput.permissionDecision).toBe('deny');
    expect(outcome.execution).toBeUndefined();
  }
  expect(unresolvedChoice!.reason).toContain('mcp__x402__request');
  for (const outcome of [missingContext!, unavailableChooser!]) {
    expect(outcome.reason).toContain('Do not retry automatically');
    expect(outcome.reason).not.toContain('mcp__x402__request');
  }
});

it.each(['malformed', 'symlink'])(
  'does not suggest a paid retry when a %s recovery marker cannot be read',
  async (corruption) => {
    const { config, event, deps, execute, signPayment, onSelected } = await setup();
    const context = await readTaskContext(event.transcript_path, event.session_id);
    await saveNativeContinuation(
      config,
      event,
      context,
      { status: 'native_fallback', reason: 'Native search can continue this step.' },
      { provider: FIXTURE_RESOURCE.resource, httpStatus: 503 },
    );
    const directory = join(config.stateDir, 'native-continuations');
    const marker = join(directory, (await readdir(directory))[0]!);
    if (corruption === 'malformed') await writeFile(marker, '{');
    else {
      const target = join(config.stateDir, 'invalid-recovery.json');
      await writeFile(target, '{}');
      await rm(marker);
      await symlink(target, marker);
    }
    const choose = vi.fn(deps.choose!);
    const result = await runNativeGate(event, config, { ...deps, choose });
    expect(result.status).toBe('needs_input');
    expect(result.reason).toContain('Do not retry automatically');
    expect(result.reason).not.toContain('mcp__x402__request');
    expect(hookOutput(result).hookSpecificOutput.permissionDecision).toBe('deny');
    expect(choose).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    expect(signPayment).not.toHaveBeenCalled();
    expect(onSelected).not.toHaveBeenCalled();
  },
);
