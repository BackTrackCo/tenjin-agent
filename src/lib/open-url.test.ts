import { describe, it, expect, vi } from 'vitest';
import type { execFile } from 'node:child_process';
import { openerFor, openInBrowser } from './open-url';

type ExecCb = (err: Error | null) => void;

function stubExec(err: Error | null): {
  impl: typeof execFile;
  calls: { cmd: string; args: string[] }[];
} {
  const calls: { cmd: string; args: string[] }[] = [];
  const impl = ((cmd: string, args: string[], _opts: unknown, cb: ExecCb) => {
    calls.push({ cmd, args });
    cb(err);
  }) as unknown as typeof execFile;
  return { impl, calls };
}

describe('openerFor', () => {
  it('picks the platform opener, never a shell', () => {
    expect(openerFor('darwin')).toEqual({ cmd: 'open', args: [] });
    expect(openerFor('win32')).toEqual({ cmd: 'rundll32', args: ['url.dll,FileProtocolHandler'] });
    expect(openerFor('linux')).toEqual({ cmd: 'xdg-open', args: [] });
    expect(openerFor('freebsd')).toEqual({ cmd: 'xdg-open', args: [] });
  });
});

describe('openInBrowser', () => {
  it('passes the URL as a single argv element and reports success', async () => {
    const { impl, calls } = stubExec(null);
    const ok = await openInBrowser('https://pay.coinbase.com/buy?a=1&b=2', {
      platform: 'linux',
      execFileImpl: impl,
    });
    expect(ok).toBe(true);
    expect(calls).toEqual([{ cmd: 'xdg-open', args: ['https://pay.coinbase.com/buy?a=1&b=2'] }]);
  });

  it('returns false on failure instead of throwing', async () => {
    const { impl } = stubExec(new Error('no opener'));
    await expect(
      openInBrowser('https://pay.coinbase.com/buy', { platform: 'darwin', execFileImpl: impl }),
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
