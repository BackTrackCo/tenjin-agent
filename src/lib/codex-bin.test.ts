import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveCodex } from './codex-bin';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tenjin-codex-bin-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const NODE = '/usr/bin/node';

describe('resolveCodex', () => {
  it('runs the script behind npm’s codex.cmd under Node on win32, never the shim', async () => {
    const npm = join(dir, 'npm');
    await mkdir(join(npm, 'node_modules', '@openai', 'codex', 'bin'), { recursive: true });
    await writeFile(join(npm, 'codex'), '#!/bin/sh\n');
    await writeFile(join(npm, 'codex.cmd'), '@ECHO off\n');
    const script = join(npm, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
    await writeFile(script, '');
    const env = { PATH: `${join(dir, 'empty')};${npm}`, PATHEXT: '.COM;.EXE;.BAT;.CMD' };
    expect(resolveCodex(env, 'win32', NODE)).toEqual({ cmd: NODE, prefix: [script] });
  });

  it('runs a native codex.exe as found, by PATHEXT order', async () => {
    await writeFile(join(dir, 'codex.cmd'), '');
    await writeFile(join(dir, 'codex.exe'), '');
    const found = resolveCodex({ PATH: dir }, 'win32', NODE);
    // The PATHEXT spelling, which a case-insensitive filesystem matches.
    expect(found?.cmd.toLowerCase()).toBe(join(dir, 'codex.exe').toLowerCase());
    expect(found?.prefix).toEqual([]);
  });

  it('skips a .cmd shim with no script beside it, and finds nothing', async () => {
    await writeFile(join(dir, 'codex.cmd'), '');
    expect(resolveCodex({ PATH: dir, PATHEXT: '.CMD' }, 'win32', NODE)).toBeNull();
  });

  it('runs the bare name off PATH elsewhere', async () => {
    await writeFile(join(dir, 'codex'), '');
    expect(resolveCodex({ PATH: `/nonexistent:${dir}` }, 'linux', NODE)).toEqual({
      cmd: join(dir, 'codex'),
      prefix: [],
    });
    expect(resolveCodex({ PATH: '' }, 'linux', NODE)).toBeNull();
  });
});
