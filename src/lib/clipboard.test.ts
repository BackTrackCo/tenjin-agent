import { describe, it, expect, vi, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import type { spawn } from 'node:child_process';
import { copyText } from './clipboard';

interface Spawned {
  cmd: string;
  args: string[];
  stdio: unknown;
  stdin: string;
}

/** A spawn whose child takes stdin and exits with `code` (or emits `error`). */
function stubSpawn(outcome: { code?: number; error?: Error; hang?: boolean } = { code: 0 }): {
  impl: typeof spawn;
  calls: Spawned[];
  killed: () => number;
} {
  const calls: Spawned[] = [];
  let kills = 0;
  const impl = ((cmd: string, args: string[], opts: { stdio: unknown }) => {
    const child = new EventEmitter() as EventEmitter & {
      stdin: EventEmitter & { end: (text: string) => void };
      kill: () => boolean;
    };
    const call: Spawned = { cmd, args, stdio: opts.stdio, stdin: '' };
    calls.push(call);
    child.stdin = Object.assign(new EventEmitter(), {
      end: (text: string) => {
        call.stdin = text;
        if (outcome.hang === true) return;
        setImmediate(() =>
          outcome.error !== undefined
            ? child.emit('error', outcome.error)
            : child.emit('exit', outcome.code ?? 0),
        );
      },
    });
    child.kill = () => {
      kills += 1;
      return true;
    };
    return child;
  }) as unknown as typeof spawn;
  return { impl, calls, killed: () => kills };
}

const only =
  (...present: string[]) =>
  (path: string) =>
    present.includes(path);

describe('copyText', () => {
  it('macOS: writes the text to pbcopy on stdin, with the output going nowhere', async () => {
    const { impl, calls } = stubSpawn();
    expect(await copyText('ABCD-1234', { platform: 'darwin', env: {}, spawnImpl: impl })).toBe(
      true,
    );
    expect(calls).toEqual([
      {
        cmd: '/usr/bin/pbcopy',
        args: [],
        stdio: ['pipe', 'ignore', 'ignore'],
        stdin: 'ABCD-1234',
      },
    ]);
  });

  it('Windows: clip.exe under %SystemRoot%', async () => {
    const { impl, calls } = stubSpawn();
    expect(
      await copyText('ABCD-1234', {
        platform: 'win32',
        env: { SystemRoot: 'C:\\WINDOWS' },
        spawnImpl: impl,
      }),
    ).toBe(true);
    expect(calls[0]!.cmd).toBe('C:\\WINDOWS\\System32\\clip.exe');
    expect(calls[0]!.stdin).toBe('ABCD-1234');
  });

  it('Linux: wl-copy under Wayland, else xclip, else xsel, each at an absolute path', async () => {
    const wayland = stubSpawn();
    await copyText('C', {
      platform: 'linux',
      env: { WAYLAND_DISPLAY: 'wayland-0' },
      spawnImpl: wayland.impl,
      existsImpl: only('/usr/bin/wl-copy', '/usr/bin/xclip'),
    });
    expect(wayland.calls.map(({ cmd, args }) => ({ cmd, args }))).toEqual([
      { cmd: '/usr/bin/wl-copy', args: [] },
    ]);

    const x11 = stubSpawn();
    await copyText('C', {
      platform: 'linux',
      env: { DISPLAY: ':0' },
      spawnImpl: x11.impl,
      existsImpl: only('/usr/bin/wl-copy', '/usr/local/bin/xclip', '/usr/bin/xsel'),
    });
    expect(x11.calls.map(({ cmd, args }) => ({ cmd, args }))).toEqual([
      { cmd: '/usr/local/bin/xclip', args: ['-selection', 'clipboard'] },
    ]);

    const xsel = stubSpawn();
    await copyText('C', {
      platform: 'linux',
      env: { DISPLAY: ':0' },
      spawnImpl: xsel.impl,
      existsImpl: only('/bin/xsel'),
    });
    expect(xsel.calls.map(({ cmd, args }) => ({ cmd, args }))).toEqual([
      { cmd: '/bin/xsel', args: ['--clipboard', '--input'] },
    ]);
  });

  it('Linux: false with no copier installed or no display, and nothing is run', async () => {
    const { impl, calls } = stubSpawn();
    expect(
      await copyText('C', {
        platform: 'linux',
        env: { DISPLAY: ':0' },
        spawnImpl: impl,
        existsImpl: only(),
      }),
    ).toBe(false);
    expect(
      await copyText('C', {
        platform: 'linux',
        env: {},
        spawnImpl: impl,
        existsImpl: only('/usr/bin/xclip'),
      }),
    ).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it.each([
    { SSH_CONNECTION: '10.0.0.2 51234 10.0.0.1 22' },
    { SSH_CLIENT: '10.0.0.2 51234 22' },
    { SSH_TTY: '/dev/ttys003' },
  ])('false over SSH %j, where the clipboard is the remote one', async (env) => {
    const { impl, calls } = stubSpawn();
    expect(await copyText('C', { platform: 'darwin', env, spawnImpl: impl })).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('false when the copier fails, cannot start, or hangs past the timeout', async () => {
    expect(
      await copyText('C', { platform: 'darwin', env: {}, spawnImpl: stubSpawn({ code: 1 }).impl }),
    ).toBe(false);
    expect(
      await copyText('C', {
        platform: 'darwin',
        env: {},
        spawnImpl: stubSpawn({ error: new Error('ENOENT') }).impl,
      }),
    ).toBe(false);

    vi.useFakeTimers();
    const hung = stubSpawn({ hang: true });
    const copied = copyText('C', { platform: 'darwin', env: {}, spawnImpl: hung.impl });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(await copied).toBe(false);
    expect(hung.killed()).toBe(1);
  });
});

afterEach(() => {
  vi.useRealTimers();
});
