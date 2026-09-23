import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  classifyStatusLine,
  composeCommand,
  ensureStatusLine,
  inspectStatusLine,
  removeStatusLine,
  statusLineMode,
  STATUS_LINE_COMMAND,
} from './status-line-wiring';

/**
 * The one setting this CLI writes into a file people configure by hand, so the
 * tests are mostly about what it REFUSES to do: a status line that is not ours
 * survives an install, a refresh, and an uninstall, byte for byte.
 */

let dir: string;
let settingsPath: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'router-status-wiring-'));
  await mkdir(join(dir, '.claude'), { recursive: true });
  settingsPath = join(dir, '.claude', 'settings.json');
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const MINE = { type: 'command', command: 'starship prompt --status-line' };

async function settings(): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(settingsPath, 'utf8')) as Record<string, unknown>;
}

describe('installing the status line', () => {
  it('registers ours when the key is free, and leaves every other key alone', async () => {
    await writeFile(settingsPath, JSON.stringify({ model: 'opus', hooks: {} }, null, 2));

    const result = await ensureStatusLine(settingsPath);

    expect(result).toMatchObject({ state: 'ours', wrote: true, command: STATUS_LINE_COMMAND });
    expect(await settings()).toEqual({
      model: 'opus',
      hooks: {},
      statusLine: { type: 'command', command: STATUS_LINE_COMMAND, refreshInterval: 1 },
    });
  });

  it('is a no-op the second time', async () => {
    await writeFile(settingsPath, JSON.stringify({}, null, 2));
    await ensureStatusLine(settingsPath);
    const before = await readFile(settingsPath, 'utf8');

    const again = await ensureStatusLine(settingsPath);

    expect(again).toMatchObject({ state: 'ours', wrote: false });
    expect(await readFile(settingsPath, 'utf8')).toBe(before);
  });

  it('never replaces a status line the user already set', async () => {
    const raw = `${JSON.stringify({ statusLine: MINE }, null, 2)}\n`;
    await writeFile(settingsPath, raw);

    const result = await ensureStatusLine(settingsPath);

    expect(result.state).toBe('foreign');
    expect(result.wrote).toBe(false);
    expect(result.compose).toContain(MINE.command);
    expect(result.compose).toContain(STATUS_LINE_COMMAND);
    expect(await readFile(settingsPath, 'utf8')).toBe(raw);
  });

  it('appends ours to theirs only when asked to compose', async () => {
    await writeFile(settingsPath, JSON.stringify({ statusLine: MINE }, null, 2));

    const result = await ensureStatusLine(settingsPath, { mode: 'compose' });

    expect(result).toMatchObject({ state: 'composed', wrote: true });
    const written = (await settings()).statusLine as { command: string };
    expect(written.command).toBe(composeCommand(MINE.command));
    expect(written.command).toContain(MINE.command);
    expect(classifyStatusLine(written)).toBe('composed');
  });

  it('leaves the key untouched under --status-line skip', async () => {
    const raw = `${JSON.stringify({ model: 'opus' }, null, 2)}\n`;
    await writeFile(settingsPath, raw);

    const result = await ensureStatusLine(settingsPath, { mode: 'skip' });

    expect(result).toMatchObject({ state: 'absent', wrote: false });
    expect(await readFile(settingsPath, 'utf8')).toBe(raw);
  });

  it('escapes a quote in the status line it wraps', async () => {
    const command = `echo 'it''s mine'`;
    expect(composeCommand(command)).toContain(String.raw`'\''`);
    expect(composeCommand(command).startsWith("sh -c '")).toBe(true);
  });

  it('refuses a mode it does not know', () => {
    expect(() => statusLineMode('maybe')).toThrow(/--status-line takes/);
    expect(statusLineMode('compose')).toBe('compose');
  });

  it('will not write over a settings file it cannot parse', async () => {
    await writeFile(settingsPath, '{ broken');

    const result = await ensureStatusLine(settingsPath);

    expect(result.wrote).toBe(false);
    expect(result.warning).toBeDefined();
    expect(await readFile(settingsPath, 'utf8')).toBe('{ broken');
  });
});

describe('a refresh', () => {
  it('converges a status line of ours that is already registered', async () => {
    await writeFile(
      settingsPath,
      JSON.stringify({ statusLine: { type: 'command', command: STATUS_LINE_COMMAND } }, null, 2),
    );

    const result = await ensureStatusLine(settingsPath, { refreshOnly: true });

    expect(result).toMatchObject({ state: 'ours', wrote: true });
    expect((await settings()).statusLine).toMatchObject({ refreshInterval: 1 });
  });

  it('adds nothing on a machine that never had one', async () => {
    const raw = `${JSON.stringify({ model: 'opus' }, null, 2)}\n`;
    await writeFile(settingsPath, raw);

    const result = await ensureStatusLine(settingsPath, { refreshOnly: true });

    expect(result).toMatchObject({ state: 'absent', wrote: false });
    expect(await readFile(settingsPath, 'utf8')).toBe(raw);
  });
});

describe('uninstalling the status line', () => {
  it('removes ours and keeps the rest of the file', async () => {
    await writeFile(settingsPath, JSON.stringify({ model: 'opus' }, null, 2));
    await ensureStatusLine(settingsPath);

    const result = await removeStatusLine(settingsPath);

    expect(result).toMatchObject({ state: 'absent', wrote: true });
    expect(await settings()).toEqual({ model: 'opus' });
  });

  it('keeps a composed line, because the user wrote most of it', async () => {
    await writeFile(settingsPath, JSON.stringify({ statusLine: MINE }, null, 2));
    await ensureStatusLine(settingsPath, { mode: 'compose' });
    const raw = await readFile(settingsPath, 'utf8');

    const result = await removeStatusLine(settingsPath);

    expect(result).toMatchObject({ state: 'composed', wrote: false });
    expect(await readFile(settingsPath, 'utf8')).toBe(raw);
  });

  it('leaves a status line of the user own exactly as it found it', async () => {
    const raw = `${JSON.stringify({ statusLine: MINE }, null, 2)}\n`;
    await writeFile(settingsPath, raw);

    const result = await removeStatusLine(settingsPath);

    expect(result).toMatchObject({ state: 'foreign', wrote: false });
    expect(await readFile(settingsPath, 'utf8')).toBe(raw);
  });
});

describe('what doctor reads', () => {
  it('reports each state without writing', async () => {
    await writeFile(settingsPath, JSON.stringify({}, null, 2));
    expect((await inspectStatusLine(settingsPath)).state).toBe('absent');

    await ensureStatusLine(settingsPath);
    expect((await inspectStatusLine(settingsPath)).state).toBe('ours');

    await writeFile(settingsPath, JSON.stringify({ statusLine: MINE }, null, 2));
    expect((await inspectStatusLine(settingsPath)).state).toBe('foreign');
  });
});
