import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
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
  it('prefers the executable provided by the desktop host over terminal PATH', async () => {
    const runtime = join(dir, 'desktop codex');
    await writeFile(runtime, '#!/bin/sh\n');
    await chmod(runtime, 0o700);
    await writeFile(join(dir, 'codex'), '');
    expect(resolveCodex({ PATH: dir, CODEX_APP_RUNTIME_CLI_PATH: runtime }, 'darwin')).toEqual({
      cmd: runtime,
      prefix: [],
    });
  });

  it('never selects an existing executable through a relative host hint', async () => {
    const runtime = join(dir, 'desktop-codex');
    await writeFile(runtime, '#!/bin/sh\n');
    await chmod(runtime, 0o700);
    expect(
      resolveCodex(
        { PATH: '', CODEX_APP_RUNTIME_CLI_PATH: relative(process.cwd(), runtime) },
        'darwin',
      ),
    ).toBeNull();
  });

  it.each(['relative/codex', 'codex --dangerous', '/missing/desktop-codex'])(
    'ignores an invalid host executable hint: %s',
    async (runtime) => {
      const fallback = join(dir, 'codex');
      await writeFile(fallback, '');
      expect(resolveCodex({ PATH: dir, CODEX_APP_RUNTIME_CLI_PATH: runtime }, 'darwin')).toEqual({
        cmd: fallback,
        prefix: [],
      });
    },
  );

  it('ignores a directory, non-executable file, or shell shim from the host', async () => {
    const fallback = join(dir, 'codex');
    const nonExecutable = join(dir, 'not-executable');
    const shim = join(dir, 'desktop.cmd');
    await writeFile(fallback, '');
    await writeFile(nonExecutable, '', { mode: 0o600 });
    await writeFile(shim, '');
    await chmod(shim, 0o700);
    for (const runtime of [dir, nonExecutable, shim]) {
      expect(resolveCodex({ PATH: dir, CODEX_APP_RUNTIME_CLI_PATH: runtime }, 'darwin')).toEqual({
        cmd: fallback,
        prefix: [],
      });
    }
  });

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
