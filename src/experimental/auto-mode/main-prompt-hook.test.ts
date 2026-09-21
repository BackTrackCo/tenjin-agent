import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const { runPromptGate } = vi.hoisted(() => ({ runPromptGate: vi.fn() }));
vi.mock('./prompt-gate', () => ({ runPromptGate }));

let directory: string;
let originalArgv: string[];
let originalExitCode: typeof process.exitCode;
let originalSignals: Map<'SIGINT' | 'SIGTERM', Set<unknown>>;
let output: string;
const event = {
  hook_event_name: 'UserPromptSubmit',
  session_id: 'prompt-cli-test',
  transcript_path: '/not-read-by-cli',
  prompt: 'Help with this request.',
};

beforeEach(async () => {
  vi.resetModules();
  runPromptGate.mockReset();
  directory = await mkdtemp(join(tmpdir(), 'auto-prompt-cli-'));
  originalArgv = process.argv;
  originalExitCode = process.exitCode;
  originalSignals = new Map(
    (['SIGINT', 'SIGTERM'] as const).map((signal) => [signal, new Set(process.listeners(signal))]),
  );
  output = '';
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    output += String(chunk);
    return true;
  });
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('No network in CLI handoff tests.'));
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
    'prompt-hook',
    '--config',
    join(directory, 'config.json'),
    '--event',
    join(directory, 'event.json'),
  ];
});

afterEach(async () => {
  process.argv = originalArgv;
  process.exitCode = originalExitCode;
  for (const [signal, previous] of originalSignals)
    for (const listener of process.listeners(signal))
      if (!previous.has(listener)) process.removeListener(signal, listener);
  expect(globalThis.fetch).not.toHaveBeenCalled();
  vi.restoreAllMocks();
  await rm(directory, { recursive: true, force: true });
});

it.each([
  {},
  {
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: 'Use the generic request bridge for this selected task.',
    },
  },
])(
  'returns the prompt classifier output without a PreToolUse permission envelope (%j)',
  async (value) => {
    runPromptGate.mockResolvedValue(value);
    await import('./main');
    expect(JSON.parse(output)).toEqual(value);
    expect(runPromptGate).toHaveBeenCalledOnce();
    expect(runPromptGate).toHaveBeenCalledWith(
      event,
      expect.objectContaining({ mode: 'live', stateDir: join(directory, 'state') }),
      expect.objectContaining({ env: expect.any(Object) }),
    );
    expect(output).not.toMatch(/PreToolUse|permissionDecision|execution|amountAtomic/);
    expect(process.exitCode).toBe(originalExitCode);
  },
);

it('returns an empty result when the classifier throws without exposing its error', async () => {
  runPromptGate.mockRejectedValue(new Error('private-classifier-error'));
  await import('./main');
  expect(JSON.parse(output)).toEqual({});
  expect(output).not.toContain('private-classifier-error');
  expect(process.exitCode).toBe(originalExitCode);
});

it('returns an empty result for invalid input before invoking the classifier', async () => {
  await writeFile(join(directory, 'event.json'), 'not JSON');
  await import('./main');
  expect(JSON.parse(output)).toEqual({});
  expect(runPromptGate).not.toHaveBeenCalled();
  expect(process.exitCode).toBe(originalExitCode);
});
