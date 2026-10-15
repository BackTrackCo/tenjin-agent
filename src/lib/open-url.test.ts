import { describe, it, expect, vi } from 'vitest';
import type { execFile } from 'node:child_process';
import { openerFor, openInBrowser } from './open-url';

type ExecCb = (err: Error | null, stdout?: string) => void;

interface Call {
  cmd: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
}

/** `respond` may answer per command; the default is a bare success with no stdout. */
function stubExec(
  err: Error | null,
  respond?: (cmd: string, args: string[]) => { err: Error | null; stdout?: string },
): { impl: typeof execFile; calls: Call[] } {
  const calls: Call[] = [];
  const impl = ((cmd: string, args: string[], opts: { env?: NodeJS.ProcessEnv }, cb: ExecCb) => {
    calls.push({ cmd, args, env: opts.env });
    const r = respond?.(cmd, args) ?? { err };
    cb(r.err, r.stdout ?? '');
  }) as unknown as typeof execFile;
  return { impl, calls };
}

const none = (): boolean => false;
const HOME = '/Users/someone';

describe('openerFor', () => {
  it('picks an absolute platform opener, never a shell or a PATH lookup', () => {
    expect(openerFor('darwin')).toEqual({ cmd: '/usr/bin/open', args: [] });
    expect(openerFor('win32')).toEqual({ cmd: 'rundll32', args: ['url.dll,FileProtocolHandler'] });
    expect(openerFor('linux', (p) => p === '/usr/bin/xdg-open')).toEqual({
      cmd: '/usr/bin/xdg-open',
      args: [],
    });
    expect(openerFor('freebsd', (p) => p === '/usr/local/bin/xdg-open')).toEqual({
      cmd: '/usr/local/bin/xdg-open',
      args: [],
    });
  });

  it('falls back to the standard absolute path when no xdg-open is found', () => {
    expect(openerFor('linux', none)).toEqual({ cmd: '/usr/bin/xdg-open', args: [] });
  });
});

describe('openInBrowser', () => {
  it('passes the URL as a single argv element and reports success', async () => {
    const { impl, calls } = stubExec(null);
    const ok = await openInBrowser('https://pay.coinbase.com/buy?a=1&b=2', {
      platform: 'linux',
      execFileImpl: impl,
      existsImpl: (p) => p === '/usr/bin/xdg-open',
    });
    expect(ok).toBe(true);
    expect(calls.map(({ cmd, args }) => ({ cmd, args }))).toEqual([
      { cmd: '/usr/bin/xdg-open', args: ['https://pay.coinbase.com/buy?a=1&b=2'] },
    ]);
  });

  it('ignores the BROWSER variable and does not hand it to the opener', async () => {
    const { impl, calls } = stubExec(null);
    await openInBrowser('https://tenjin.sh/fund#t', {
      platform: 'linux',
      execFileImpl: impl,
      existsImpl: (p) => p === '/usr/bin/xdg-open',
      env: { BROWSER: '/tmp/embedded-view', PATH: '/tmp/shim', HOME: '/h' },
    });
    expect(calls[0]!.cmd).toBe('/usr/bin/xdg-open');
    expect(calls[0]!.env).not.toHaveProperty('BROWSER');
    expect(calls[0]!.env).toMatchObject({ HOME: '/h' });
  });

  describe('on macOS', () => {
    const URL_ = 'https://tenjin.sh/fund?amount=5#tok';
    const plist = (handlers: unknown): string => JSON.stringify({ LSHandlers: handlers });

    it('opens with the default https handler named by bundle id', async () => {
      const { impl, calls } = stubExec(null, (cmd) =>
        cmd === '/usr/bin/plutil'
          ? {
              err: null,
              stdout: plist([
                { LSHandlerURLScheme: 'mailto', LSHandlerRoleAll: 'com.apple.mail' },
                { LSHandlerURLScheme: 'https', LSHandlerRoleAll: 'com.google.chrome' },
              ]),
            }
          : { err: null },
      );
      const ok = await openInBrowser(URL_, {
        platform: 'darwin',
        execFileImpl: impl,
        homeDir: HOME,
        env: { BROWSER: '/tmp/embedded-view' },
      });
      expect(ok).toBe(true);
      const open = calls.find((c) => c.cmd === '/usr/bin/open')!;
      expect(open.args).toEqual(['-b', 'com.google.chrome', URL_]);
      expect(open.env).not.toHaveProperty('BROWSER');
      expect(calls[0]!.args.at(-1)).toBe(
        `${HOME}/Library/Preferences/com.apple.LaunchServices/com.apple.launchservices.secure.plist`,
      );
    });

    it.each([
      ['no https entry', () => ({ err: null, stdout: plist([]) })],
      ['an unreadable preferences file', () => ({ err: new Error('no file') })],
      ['output that is not JSON', () => ({ err: null, stdout: 'garbage' })],
      [
        'a bundle id that could be a flag',
        () => ({
          err: null,
          stdout: plist([{ LSHandlerURLScheme: 'https', LSHandlerRoleAll: '-a evil' }]),
        }),
      ],
    ])('falls back to a plain open with %s', async (_label, plutil) => {
      const { impl, calls } = stubExec(null, (cmd) =>
        cmd === '/usr/bin/plutil' ? plutil() : { err: null },
      );
      const ok = await openInBrowser(URL_, {
        platform: 'darwin',
        execFileImpl: impl,
        homeDir: HOME,
      });
      expect(ok).toBe(true);
      const opens = calls.filter((c) => c.cmd === '/usr/bin/open');
      expect(opens.map((c) => c.args)).toEqual([[URL_]]);
    });

    it('retries without -b when the named browser fails to launch', async () => {
      const { impl, calls } = stubExec(null, (cmd, args) => {
        if (cmd === '/usr/bin/plutil') {
          return {
            err: null,
            stdout: plist([{ LSHandlerURLScheme: 'https', LSHandlerRoleAll: 'com.gone.app' }]),
          };
        }
        return { err: args.includes('-b') ? new Error('no such app') : null };
      });
      const ok = await openInBrowser(URL_, {
        platform: 'darwin',
        execFileImpl: impl,
        homeDir: HOME,
      });
      expect(ok).toBe(true);
      expect(calls.filter((c) => c.cmd === '/usr/bin/open').map((c) => c.args)).toEqual([
        ['-b', 'com.gone.app', URL_],
        [URL_],
      ]);
    });
  });

  it('returns false on failure instead of throwing', async () => {
    const { impl } = stubExec(new Error('no opener'));
    await expect(
      openInBrowser('https://pay.coinbase.com/buy', {
        platform: 'darwin',
        execFileImpl: impl,
        homeDir: HOME,
      }),
    ).resolves.toBe(false);
  });

  it('keeps the failure path exception-free even for a rejecting callback wrapper', async () => {
    const spy = vi.fn();
    const { impl } = stubExec(new Error('boom'));
    const ok = await openInBrowser('https://pay.coinbase.com/buy', {
      platform: 'win32',
      execFileImpl: impl,
    }).catch(spy);
    expect(ok).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });
});
