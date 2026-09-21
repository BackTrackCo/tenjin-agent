import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { readBridgeResult } from './bridge';
import type { Outcome, RuntimeDeps } from './runtime';

const { runEvent } = vi.hoisted(() => ({ runEvent: vi.fn() }));
vi.mock('./runtime', async (original) => ({
  ...(await original<typeof import('./runtime')>()),
  runEvent,
}));

let directory: string;
let originalArgv: string[];
let originalExitCode: typeof process.exitCode;
let originalSignals: Map<'SIGINT' | 'SIGTERM', Set<unknown>>;
let output: string;
const event = {
  hook_event_name: 'PreToolUse',
  session_id: 'deadline-session',
  tool_use_id: 'deadline-request',
  transcript_path: '/not-read-by-cli',
  tool_name: 'mcp__x402__request',
  tool_input: { query: 'A bounded request.' },
};

beforeEach(async () => {
  vi.resetModules();
  runEvent.mockReset();
  directory = await mkdtemp(join(tmpdir(), 'auto-deadline-cli-'));
  originalArgv = process.argv;
  originalExitCode = process.exitCode;
  originalSignals = new Map(
    (['SIGINT', 'SIGTERM'] as const).map((signal) => [signal, new Set(process.listeners(signal))]),
  );
  output = '';
  vi.spyOn(process.stdout, 'write').mockImplementation((...args: unknown[]) => {
    output += String(args[0]);
    const callback = args.find((value) => typeof value === 'function') as (() => void) | undefined;
    callback?.();
    return true;
  });
  vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('No network in CLI deadline tests.'));
  await writeFile(
    join(directory, 'config.json'),
    JSON.stringify({
      version: 1,
      mode: 'live',
      stateDir: join(directory, 'state'),
      policyPath: join(directory, 'policy-not-read.json'),
    }),
  );
  await writeFile(join(directory, 'event.json'), JSON.stringify(event));
  process.argv = [
    process.execPath,
    'tenjin-auto-mode',
    'bridge-hook',
    '--config',
    join(directory, 'config.json'),
    '--event',
    join(directory, 'event.json'),
  ];
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
});

afterEach(async () => {
  vi.useRealTimers();
  process.argv = originalArgv;
  process.exitCode = originalExitCode;
  for (const [signal, previous] of originalSignals)
    for (const listener of process.listeners(signal))
      if (!previous.has(listener)) process.removeListener(signal, listener);
  expect(globalThis.fetch).not.toHaveBeenCalled();
  vi.restoreAllMocks();
  await rm(directory, { recursive: true, force: true });
});

it('delivers one saved pending receipt and ignores a result arriving after the deadline', async () => {
  let entered!: () => void;
  const started = new Promise<void>((resolve) => (entered = resolve));
  let finish!: (outcome: Outcome) => void;
  const delayed = new Promise<Outcome>((resolve) => (finish = resolve));
  let signal: AbortSignal | undefined;
  runEvent.mockImplementation(async (_event, _config, deps: RuntimeDeps) => {
    signal = deps.signal;
    entered();
    return delayed;
  });
  const cli = import('./main');
  await started;
  await vi.advanceTimersByTimeAsync(70_000);
  await cli;
  expect(signal?.aborted).toBe(true);
  expect(process.exit).toHaveBeenCalledExactlyOnceWith(0);
  const hook = JSON.parse(output).hookSpecificOutput;
  expect(hook.permissionDecision).toBe('allow');
  expect(hook.updatedInput._receipt).toMatch(/^[a-f0-9]{64}$/);
  const delivered = await readBridgeResult(
    { stateDir: join(directory, 'state') },
    'request',
    hook.updatedInput,
  );
  expect(delivered.content).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ type: 'text', text: expect.stringContaining('pending') }),
    ]),
  );
  expect(JSON.stringify(delivered)).not.toContain('valid receipt');
  const records = (await readFile(join(directory, 'state/events.jsonl'), 'utf8'))
    .trim()
    .split('\n');
  expect(records).toHaveLength(1);
  expect(JSON.parse(records[0]!)).toMatchObject({ status: 'pending' });
  const saved = await readFile(join(directory, 'state/last-outcome.json'), 'utf8');
  const firstOutput = output;
  finish({
    status: 'fulfilled',
    execution: { status: 'fulfilled', response: { status: 200, headers: {}, body: '{}' } },
  });
  await Promise.resolve();
  await Promise.resolve();
  expect(output).toBe(firstOutput);
  expect(await readFile(join(directory, 'state/last-outcome.json'), 'utf8')).toBe(saved);
  expect(await readdir(join(directory, 'state/bridge-receipts'))).toHaveLength(1);
});
