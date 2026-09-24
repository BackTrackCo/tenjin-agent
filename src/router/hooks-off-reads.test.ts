import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * OFF MEANS NOTHING ABOUT THE TURN IS READ, not only that nothing is sent. The
 * switch is checked before either packet builder opens the transcript, and a
 * spy on the one call the reader makes proves it: with the router off in the
 * project, the session's transcript is never opened.
 */
const opened = vi.hoisted(() => [] as string[]);
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    open: (async (path: Parameters<typeof actual.open>[0], ...rest: unknown[]) => {
      opened.push(String(path));
      return (actual.open as (...args: unknown[]) => unknown)(path, ...rest);
    }) as typeof actual.open,
  };
});

const { runDelegationHook, runNativeHook, runPromptHook, runShortfallHook } =
  await import('./hooks');

let dir: string;
let repo: string;
let transcript: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'router-hooks-off-'));
  repo = join(dir, 'repo');
  await mkdir(join(repo, '.git'), { recursive: true });
  transcript = join(dir, 'session.jsonl');
  await writeFile(
    transcript,
    JSON.stringify({ type: 'user', sessionId: 'sess-1', message: { content: 'earlier words' } }),
  );
  opened.length = 0;
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function setEnabled(enabled: boolean): Promise<void> {
  await mkdir(join(repo, '.tenjin'), { recursive: true });
  await writeFile(join(repo, '.tenjin', 'config.json'), JSON.stringify({ router: { enabled } }));
}

/** Every hook that reads the transcript: prompt, pre-call, shortfall and delegation. */
async function fireAll(): Promise<number> {
  let calls = 0;
  const fetchImpl = (async () => {
    calls += 1;
    return new Response('{}', { status: 500, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  const deps = {
    dataDir: dir,
    baseUrl: 'https://tenjin.sh',
    fetchImpl,
    homeDir: dir,
    warn: () => undefined,
  };
  const base = { session_id: 'sess-1', cwd: repo, transcript_path: transcript };
  const search = { ...base, tool_name: 'WebSearch', tool_input: { query: 'btc price today' } };
  await runPromptHook({ ...base, prompt: 'btc price today' }, deps);
  await runNativeHook({ ...search, hook_event_name: 'PreToolUse' }, deps);
  await runShortfallHook(
    { ...search, hook_event_name: 'PostToolUse', tool_response: { results: [] } },
    deps,
  );
  await runDelegationHook(
    {
      ...base,
      hook_event_name: 'PreToolUse',
      tool_name: 'Agent',
      tool_input: { prompt: 'look up the btc price', subagent_type: 'general-purpose' },
    },
    deps,
  );
  return calls;
}

describe('a hook in a directory where the router is off', () => {
  it('never opens the transcript, on any hook', async () => {
    await setEnabled(false);
    expect(await fireAll()).toBe(0);
    expect(opened.filter((path) => path === transcript)).toEqual([]);
  });

  // The control: the same events with the router on do open it, so the spy
  // above is watching the reader and not nothing.
  it('opens it on every hook when the router is on', async () => {
    await setEnabled(true);
    expect(await fireAll()).toBe(4);
    expect(opened.filter((path) => path === transcript)).toHaveLength(4);
  });
});
