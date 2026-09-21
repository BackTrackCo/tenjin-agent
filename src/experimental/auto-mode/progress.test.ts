import { createHash } from 'node:crypto';
import { mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { renderProgress, writeProgress } from './progress';
import { fixtureChooser, runEvent } from './runtime';
import type { AutoConfig } from './runtime';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});
async function setup(): Promise<AutoConfig> {
  const stateDir = await mkdtemp(join(tmpdir(), 'auto-progress-'));
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
const event = {
  hook_event_name: 'PreToolUse' as const,
  session_id: 'session',
  tool_use_id: 'call1',
  tool_name: 'WebSearch' as const,
  transcript_path: '/unused',
  tool_input: { query: 'find the archive' },
};
const selected = {
  phase: 'calling' as const,
  provider: 'https://reader.example/scrape',
  args: { body: { url: 'https://example.com/page' } },
};

it('labels neutral bridge activity as a request while showing the selected provider', async () => {
  const config = await setup();
  await writeProgress(config, { ...event, tool_name: 'Request' }, selected);
  expect(await renderProgress(config, event.session_id)).toContain(
    'request: calling reader.example/scrape',
  );
});

it('publishes selection before execution completes, not just in the result', async () => {
  const config = await setup();
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  let selectedReady!: () => void;
  const ready = new Promise<void>((resolve) => {
    selectedReady = resolve;
  });
  let finished = false;
  const run = runEvent(event, config, {
    context: { messages: [{ role: 'user', text: 'Find the archive.' }], fingerprint: 'fixture' },
    choose: fixtureChooser,
    onSelected: async (selection) => {
      await writeProgress(config, event, {
        phase: 'calling',
        provider: selection.url,
        args: selection.args,
        fixture: true,
      });
      selectedReady();
      await blocked;
    },
  }).then((outcome) => {
    finished = true;
    return outcome;
  });
  await ready;
  try {
    const display = await renderProgress(config, event.session_id, { columns: 180 });
    expect(display).toContain('fixture · search: calling');
    expect(display).toContain('query');
    expect(finished).toBe(false);
  } finally {
    release();
  }
  expect((await run).status).toBe('fulfilled');
});

it('keeps concurrent calls and other sessions separate with private, hashed files', async () => {
  const config = await setup();
  await Promise.all([
    writeProgress(config, event, selected, 1000),
    writeProgress(
      config,
      { ...event, tool_use_id: 'call2', tool_name: 'WebFetch' },
      { phase: 'routing' },
      1001,
    ),
    writeProgress(
      config,
      { ...event, session_id: 'elsewhere' },
      { ...selected, provider: 'https://secret.example/' },
      1002,
    ),
  ]);
  const display = await renderProgress(config, event.session_id, { now: 1003, columns: 180 });
  expect(display).toContain('fetch: selecting service');
  expect(display).toContain('search: calling reader.example/scrape');
  expect(display).not.toContain('secret.example');
  expect(display.split('\n')).toHaveLength(2);
  const directory = join(
    config.stateDir,
    'progress',
    createHash('sha256').update(event.session_id).digest('hex'),
  );
  const files = await readdir(directory);
  expect(files).toHaveLength(2);
  expect(files.every((name) => /^[a-f0-9]{64}\.json$/.test(name))).toBe(true);
  if (process.platform !== 'win32') {
    expect((await stat(directory)).mode & 0o777).toBe(0o700);
    expect((await stat(join(directory, files[0]!))).mode & 0o777).toBe(0o600);
  }
});

it('distinguishes finished, cached, stale and idle without pretending a lost call finished', async () => {
  const config = await setup();
  expect(await renderProgress(config, 'absent')).toBe('x402 · ready');
  await writeProgress(config, event, selected, 1000);
  expect(await renderProgress(config, 'session', { now: 87000 })).toContain('status stale');
  await writeProgress(
    config,
    event,
    { ...selected, phase: 'finished', status: 'fulfilled' },
    88000,
  );
  expect(await renderProgress(config, 'session', { now: 88001 })).toContain(
    'fulfilled reader.example/scrape',
  );
  await writeProgress(config, event, { ...selected, phase: 'finished', cached: true }, 88002);
  expect(await renderProgress(config, 'session', { now: 88003 })).toContain(
    'cached reader.example/scrape',
  );
  expect(await renderProgress(config, 'session', { now: 108002 })).toBe('x402 · ready');
});

it('a stale call never hides a newly completed call', async () => {
  const config = await setup();
  await writeProgress(config, event, selected, 1000);
  await writeProgress(
    config,
    { ...event, tool_use_id: 'call2' },
    { ...selected, phase: 'finished', status: 'fulfilled' },
    100000,
  );
  const display = await renderProgress(config, 'session', { now: 100001 });
  expect(display).toContain('fulfilled reader.example/scrape');
  expect(display).toContain('status stale');
});

it('ignores broken/oversized files and strips secrets and terminal controls', async () => {
  const config = await setup();
  await writeProgress(
    config,
    event,
    {
      ...selected,
      provider: 'https://reader.example/scrape?token=secret',
      args: {
        query: 'BTC\u001b[31m\nETH\u202e',
        token: 'ghp_abcdefghijklmnopqrstuvwxyz1234567890',
      },
    },
    1000,
  );
  const directory = join(
    config.stateDir,
    'progress',
    createHash('sha256').update(event.session_id).digest('hex'),
  );
  await writeFile(join(directory, `${'a'.repeat(64)}.json`), '{');
  await writeFile(join(directory, `${'b'.repeat(64)}.json`), 'x'.repeat(5000));
  const display = await renderProgress(config, 'session', { now: 1001, columns: 180 });
  expect(display).toContain('reader.example/scrape');
  expect(display).not.toContain('?token=secret');
  expect(display).not.toContain('abcdefghijklmnopqrstuvwxyz1234567890');
  expect(display).not.toMatch(/[\p{Cc}\p{Cf}]/u);
  expect(Array.from(display).length).toBeLessThanOrEqual(180);
});

it('display write failures never affect the executor', async () => {
  const config = await setup();
  const file = join(config.stateDir, 'file');
  await writeFile(file, 'not a directory');
  await expect(writeProgress({ stateDir: file }, event, selected)).resolves.toBeUndefined();
});
