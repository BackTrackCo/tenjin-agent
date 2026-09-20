import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { hookOutput, runEvent, fixtureChooser } from './runtime';
import type { AutoConfig } from './runtime';
import type { HookEvent } from './context';

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
