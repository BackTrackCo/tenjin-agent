import {
  copyFile,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { readNativeContinuation, saveNativeContinuation } from './native-continuation';
import type { HookEvent, TaskContext } from './context';
import type { AutoConfig } from './runtime';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});
const now = 1_000_000;
const clock = { now: () => now };
const targetUrl = 'https://source.example.org/guide?part=1';
const context: TaskContext = {
  messages: [{ role: 'user', text: 'Research this topic using current sources.' }],
  fingerprint: 'unused-assistant-context-hash',
};
const failure = {
  provider: 'https://api.search.example/search',
  httpStatus: 503,
  originalRequest: {
    tool: 'Request',
    input: { query: 'Research this topic using current sources.', candidates: ['one', 'two'] },
  },
};
const route = { status: 'native_fallback' as const, reason: 'Native search can supply sources.' };

async function setup() {
  const stateDir = await mkdtemp(join(tmpdir(), 'auto-native-continuation-'));
  directories.push(stateDir);
  const config: AutoConfig = {
    version: 1,
    stateDir,
    mode: 'live',
    policyPath: '/unused',
    model: 'jev-latest',
    discoveryQueries: {},
    nativeFallback: true,
  };
  const event: HookEvent = {
    hook_event_name: 'PreToolUse',
    session_id: 'continuation-session',
    tool_use_id: 'failed-call',
    transcript_path: '/unused',
    tool_name: 'Request',
    tool_input: { query: 'Research this topic using current sources.' },
  };
  const nativeEvent: HookEvent = {
    ...event,
    tool_use_id: 'native-call',
    tool_name: 'WebSearch',
  };
  return { config, event, nativeEvent };
}

async function path(config: AutoConfig) {
  const dir = join(config.stateDir, 'native-continuations');
  const files = await readdir(dir);
  expect(files).toHaveLength(1);
  return join(dir, files[0]!);
}

it('preserves trusted failure and request evidence privately, independent of assistant turns or tool-call IDs', async () => {
  const { config, event, nativeEvent } = await setup();
  const saved = await saveNativeContinuation(config, event, context, route, failure, clock);
  expect(saved.failure).toEqual(failure);
  const extended: TaskContext = {
    messages: [...context.messages, { role: 'assistant', text: 'I will use native search.' }],
    fingerprint: 'different-assistant-context',
  };
  expect(await readNativeContinuation(config, nativeEvent, extended, clock)).toEqual(saved);
  expect(saved).toMatchObject({ nativeTool: 'WebSearch', mode: 'live' });
  expect(saved).not.toHaveProperty('targetUrl');
  const markerPath = await path(config);
  if (process.platform !== 'win32') {
    expect((await stat(markerPath)).mode & 0o777).toBe(0o600);
    expect((await stat(join(config.stateDir, 'native-continuations'))).mode & 0o777).toBe(0o700);
  }
  const raw = await readFile(markerPath, 'utf8');
  expect(raw).not.toContain(event.session_id);
  expect(raw).not.toContain('settlement');
});

it('isolates session, mode, user turn, and tool class', async () => {
  const { config, event, nativeEvent } = await setup();
  await saveNativeContinuation(config, event, context, route, failure, clock);
  expect(
    await readNativeContinuation(config, { ...nativeEvent, session_id: 'other' }, context, clock),
  ).toBeUndefined();
  expect(
    await readNativeContinuation({ ...config, mode: 'fixture' }, nativeEvent, context, clock),
  ).toBeUndefined();
  const later: TaskContext = {
    messages: [...context.messages, { ...context.messages[0]! }],
    fingerprint: 'repeated-prompt-is-new-turn',
  };
  expect(await readNativeContinuation(config, nativeEvent, later, clock)).toBeUndefined();
  expect(
    await readNativeContinuation(
      config,
      { ...nativeEvent, tool_name: 'WebFetch', tool_input: { url: targetUrl } },
      context,
      clock,
    ),
  ).toBeUndefined();
  expect(await readNativeContinuation(config, event, context, clock)).toBeUndefined();
});

it('matches exact page URLs, and does not convert a page failure into search authorization', async () => {
  const { config, event, nativeEvent } = await setup();
  const page: HookEvent = {
    ...event,
    tool_name: 'WebFetch',
    tool_input: { url: targetUrl, prompt: 'Read the page.' },
  };
  const saved = await saveNativeContinuation(
    config,
    page,
    context,
    { ...route, targetUrl },
    failure,
    clock,
  );
  expect(await readNativeContinuation(config, page, context, clock)).toEqual(saved);
  expect(
    await readNativeContinuation(
      config,
      { ...page, tool_input: { url: `${targetUrl}#section` } },
      context,
      clock,
    ),
  ).toBeUndefined();
  expect(await readNativeContinuation(config, nativeEvent, context, clock)).toBeUndefined();
  await expect(
    saveNativeContinuation(config, page, context, route, failure, clock),
  ).rejects.toThrow('exact requested URL');
  await expect(
    saveNativeContinuation(
      config,
      page,
      context,
      { ...route, targetUrl: 'https://other.example/' },
      failure,
      clock,
    ),
  ).rejects.toThrow('exact requested URL');
});

it('honors disabled native fallback and disabled native page reads', async () => {
  const { config, event, nativeEvent } = await setup();
  await saveNativeContinuation(config, event, context, route, failure, clock);
  const disabled = { ...config, nativeFallback: false };
  expect(await readNativeContinuation(disabled, nativeEvent, context, clock)).toBeUndefined();
  await expect(
    saveNativeContinuation(disabled, event, context, route, failure, clock),
  ).rejects.toThrow('disabled');
  const page: HookEvent = { ...event, tool_name: 'WebFetch', tool_input: { url: targetUrl } };
  await saveNativeContinuation(config, page, context, { ...route, targetUrl }, failure, clock);
  const noFetch = { ...config, nativeWebFetch: false };
  expect(await readNativeContinuation(noFetch, page, context, clock)).toBeUndefined();
  await expect(
    saveNativeContinuation(noFetch, page, context, { ...route, targetUrl }, failure, clock),
  ).rejects.toThrow('disabled');
  expect(await readNativeContinuation(noFetch, nativeEvent, context, clock)).toBeDefined();
});

it('expires after ten minutes and does not accept markers from the future', async () => {
  const { config, event, nativeEvent } = await setup();
  await saveNativeContinuation(config, event, context, route, failure, clock);
  expect(
    await readNativeContinuation(config, nativeEvent, context, { now: () => now + 599_999 }),
  ).toBeDefined();
  expect(
    await readNativeContinuation(config, nativeEvent, context, { now: () => now + 600_000 }),
  ).toBeUndefined();
  expect(
    await readNativeContinuation(config, nativeEvent, context, { now: () => now - 1 }),
  ).toBeUndefined();
});

it('redacts credential-shaped request evidence before storing it', async () => {
  const { config, event, nativeEvent } = await setup();
  const token = `ghp_${'A'.repeat(36)}`;
  const saved = await saveNativeContinuation(
    config,
    event,
    context,
    route,
    { ...failure, originalRequest: { tool: 'Request', input: { query: `Look up ${token}` } } },
    clock,
  );
  expect(JSON.stringify(saved)).not.toContain(token);
  expect(await readFile(await path(config), 'utf8')).not.toContain(token);
  expect(await readNativeContinuation(config, nativeEvent, context, clock)).toEqual(saved);
});

it.each([200, 402, 429, 499, 600, 503.5])(
  'rejects non-5xx failure status %s',
  async (httpStatus) => {
    const { config, event } = await setup();
    await expect(
      saveNativeContinuation(config, event, context, route, { ...failure, httpStatus }, clock),
    ).rejects.toThrow();
  },
);

it.each([
  'http://provider.example/search',
  'https://user:password@provider.example/search',
  'not a URL',
])('rejects invalid provider identity %s', async (provider) => {
  const { config, event } = await setup();
  await expect(
    saveNativeContinuation(config, event, context, route, { ...failure, provider }, clock),
  ).rejects.toThrow();
});

it('rejects oversized request evidence and userless contexts', async () => {
  const { config, event } = await setup();
  await expect(
    saveNativeContinuation(
      config,
      event,
      context,
      route,
      { ...failure, originalRequest: 'x'.repeat(16_385) },
      clock,
    ),
  ).rejects.toThrow('bound');
  await expect(
    saveNativeContinuation(
      config,
      event,
      { messages: [], fingerprint: 'none' },
      route,
      failure,
      clock,
    ),
  ).rejects.toThrow('user task');
});

it.each(['malformed', 'oversized', 'altered-scope', 'overlong-ttl', 'unknown-field'])(
  'fails closed for %s markers',
  async (corruption) => {
    const { config, event, nativeEvent } = await setup();
    const saved = await saveNativeContinuation(config, event, context, route, failure, clock);
    const bad =
      corruption === 'malformed'
        ? '{'
        : corruption === 'oversized'
          ? ' '.repeat(24_577)
          : JSON.stringify({
              ...saved,
              ...(corruption === 'altered-scope' ? { sessionHash: '0'.repeat(64) } : {}),
              ...(corruption === 'overlong-ttl' ? { expiresAt: now + 600_001 } : {}),
              ...(corruption === 'unknown-field' ? { providerBody: 'untrusted data' } : {}),
            });
    await writeFile(await path(config), bad);
    await expect(readNativeContinuation(config, nativeEvent, context, clock)).rejects.toThrow();
  },
);

it('rejects a symlink marker and returns undefined for a missing marker', async () => {
  const { config, event, nativeEvent } = await setup();
  expect(await readNativeContinuation(config, nativeEvent, context, clock)).toBeUndefined();
  await saveNativeContinuation(config, event, context, route, failure, clock);
  const markerPath = await path(config);
  const copied = join(config.stateDir, 'copied-marker.json');
  await copyFile(markerPath, copied);
  await rm(markerPath);
  await symlink(copied, markerPath);
  await expect(readNativeContinuation(config, nativeEvent, context, clock)).rejects.toThrow();
});
