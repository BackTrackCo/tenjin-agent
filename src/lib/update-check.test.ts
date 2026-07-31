import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { maybeNudgeUpdate } from './update-check';
import { updateCheckPath } from './paths';
import type { Io } from './output';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tenjin-update-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function captureIo(isTTY: boolean) {
  const out: string[] = [];
  const err: string[] = [];
  const mk = (sink: string[]) =>
    ({
      write: (chunk: string | Uint8Array) => {
        sink.push(chunk.toString());
        return true;
      },
    }) as unknown as NodeJS.WritableStream;
  const io: Io = { stdout: mk(out), stderr: mk(err), isTTY };
  return { io, stdout: () => out.join(''), stderr: () => err.join('') };
}

/** A registry stub that counts calls, so "did not fetch" is assertable. */
function registry(tags: Record<string, string>) {
  let calls = 0;
  const fetchImpl: typeof fetch = async () => {
    calls += 1;
    return new Response(JSON.stringify(tags), { status: 200 });
  };
  return { fetchImpl, calls: () => calls };
}

/** Fetch that must never run: every skip case asserts through this. */
const forbiddenFetch: typeof fetch = async () => {
  throw new Error('the update check must not reach the network here');
};

const NOW = 1_700_000_000_000;

describe('maybeNudgeUpdate', () => {
  it('nudges toward the alpha tag when a prerelease build is behind', async () => {
    const cap = captureIo(true);
    const reg = registry({ latest: '0.9.0', alpha: '0.1.0-alpha.7' });
    await maybeNudgeUpdate({
      dir,
      io: cap.io,
      json: false,
      env: {},
      now: () => NOW,
      fetchImpl: reg.fetchImpl,
      currentVersion: '0.1.0-alpha.6',
    });
    expect(cap.stderr()).toContain(
      'tenjin-cli 0.1.0-alpha.7 is available (you have 0.1.0-alpha.6)',
    );
    expect(cap.stderr()).toContain('npm i -g tenjin-cli@alpha');
    // The command's own surface is untouched: nothing on stdout, ever.
    expect(cap.stdout()).toBe('');
  });

  it('nudges toward the plain package on the stable channel', async () => {
    const cap = captureIo(true);
    const reg = registry({ latest: '1.1.0', alpha: '2.0.0-alpha.1' });
    await maybeNudgeUpdate({
      dir,
      io: cap.io,
      json: false,
      env: {},
      now: () => NOW,
      fetchImpl: reg.fetchImpl,
      currentVersion: '1.0.0',
    });
    expect(cap.stderr()).toContain('tenjin-cli 1.1.0 is available (you have 1.0.0)');
    expect(cap.stderr()).toContain('npm i -g tenjin-cli\n');
    expect(cap.stderr()).not.toContain('@alpha');
  });

  it('says nothing when the registry version is the same or older', async () => {
    for (const latest of ['0.1.0-alpha.6', '0.1.0-alpha.5', '0.0.9']) {
      const cap = captureIo(true);
      await maybeNudgeUpdate({
        dir,
        io: cap.io,
        json: false,
        env: {},
        now: () => NOW,
        fetchImpl: registry({ alpha: latest }).fetchImpl,
        currentVersion: '0.1.0-alpha.6',
      });
      expect(cap.stderr()).toBe('');
    }
  });

  // A release outranks its own prereleases, so 0.1.0 is news to an alpha.6 user
  // and 0.1.0-alpha.9 is not news to someone already on 0.1.0.
  it('orders a release above its prereleases in both directions', async () => {
    const up = captureIo(true);
    await maybeNudgeUpdate({
      dir,
      io: up.io,
      json: false,
      env: {},
      now: () => NOW,
      fetchImpl: registry({ alpha: '0.1.0' }).fetchImpl,
      currentVersion: '0.1.0-alpha.6',
    });
    expect(up.stderr()).toContain('tenjin-cli 0.1.0 is available');

    const down = captureIo(true);
    await maybeNudgeUpdate({
      dir,
      io: down.io,
      json: false,
      env: {},
      now: () => NOW + 1,
      fetchImpl: registry({ latest: '0.1.0-alpha.9' }).fetchImpl,
      currentVersion: '0.1.0',
    });
    expect(down.stderr()).toBe('');
  });

  // The registry is untrusted input. A version this package could never have
  // published is not compared, not sanitized into something printable, not shown.
  it('refuses a version string it cannot parse, including one carrying escapes', async () => {
    for (const latest of ['not-a-version', '9.9.9-beta.1', '\u001b[2K9.9.9']) {
      const cap = captureIo(true);
      await maybeNudgeUpdate({
        dir,
        io: cap.io,
        json: false,
        env: {},
        now: () => NOW,
        fetchImpl: registry({ alpha: latest }).fetchImpl,
        currentVersion: '0.1.0-alpha.6',
      });
      expect(cap.stderr()).toBe('');
    }
  });

  it('caches the answer 0600 and reuses it for 24h without a second fetch', async () => {
    const first = captureIo(true);
    const reg = registry({ alpha: '0.1.0-alpha.7' });
    const deps = {
      dir,
      json: false,
      env: {},
      currentVersion: '0.1.0-alpha.6',
    };
    await maybeNudgeUpdate({ ...deps, io: first.io, now: () => NOW, fetchImpl: reg.fetchImpl });
    expect(reg.calls()).toBe(1);

    const cached: unknown = JSON.parse(await readFile(updateCheckPath(dir), 'utf8'));
    expect(cached).toEqual({ schemaVersion: 1, checkedAtMs: NOW, latest: '0.1.0-alpha.7' });
    if (process.platform !== 'win32') {
      expect((await stat(updateCheckPath(dir))).mode & 0o777).toBe(0o600);
    }

    // Just under 24h: served from the cache, still nudges, never asks again.
    const second = captureIo(true);
    await maybeNudgeUpdate({
      ...deps,
      io: second.io,
      now: () => NOW + 86_399_000,
      fetchImpl: forbiddenFetch,
    });
    expect(second.stderr()).toContain('0.1.0-alpha.7 is available');
  });

  it('re-fetches once the cache is older than 24h', async () => {
    const stale = { schemaVersion: 1, checkedAtMs: NOW, latest: '0.1.0-alpha.7' };
    await writeFile(updateCheckPath(dir), JSON.stringify(stale), { mode: 0o600 });
    const cap = captureIo(true);
    const reg = registry({ alpha: '0.1.0-alpha.8' });
    await maybeNudgeUpdate({
      dir,
      io: cap.io,
      json: false,
      env: {},
      now: () => NOW + 86_400_001,
      fetchImpl: reg.fetchImpl,
      currentVersion: '0.1.0-alpha.6',
    });
    expect(reg.calls()).toBe(1);
    expect(cap.stderr()).toContain('0.1.0-alpha.8 is available');
  });

  it('treats an unreadable cache as no cache (it is only a cache)', async () => {
    await writeFile(updateCheckPath(dir), 'not json {{{', { mode: 0o600 });
    const cap = captureIo(true);
    const reg = registry({ alpha: '0.1.0-alpha.7' });
    await maybeNudgeUpdate({
      dir,
      io: cap.io,
      json: false,
      env: {},
      now: () => NOW,
      fetchImpl: reg.fetchImpl,
      currentVersion: '0.1.0-alpha.6',
    });
    expect(reg.calls()).toBe(1);
    expect(cap.stderr()).toContain('0.1.0-alpha.7 is available');
  });

  // Every failure mode of the check is the same failure mode: nothing happens,
  // nothing is cached, and the command that just ran is unaffected.
  it('swallows a rejected fetch, a non-200, and a body that is not dist-tags', async () => {
    const failures: (typeof fetch)[] = [
      async () => {
        throw new Error('ENOTFOUND registry.npmjs.org');
      },
      async () => {
        throw Object.assign(new Error('The operation was aborted'), { name: 'TimeoutError' });
      },
      async () => new Response('', { status: 503 }),
      async () => new Response('<html>', { status: 200 }),
      async () => new Response(JSON.stringify({ alpha: 7 }), { status: 200 }),
      async () => new Response(JSON.stringify({ latest: '1.0.0' }), { status: 200 }), // no alpha tag
    ];
    for (const fetchImpl of failures) {
      const cap = captureIo(true);
      await expect(
        maybeNudgeUpdate({
          dir,
          io: cap.io,
          json: false,
          env: {},
          now: () => NOW,
          fetchImpl,
          currentVersion: '0.1.0-alpha.6',
        }),
      ).resolves.toBeUndefined();
      expect(cap.stderr()).toBe('');
      expect(cap.stdout()).toBe('');
      await expect(readFile(updateCheckPath(dir), 'utf8')).rejects.toThrow();
    }
  });

  it('is skipped entirely off a TTY, under --json, and in CI', async () => {
    const cases: { isTTY: boolean; json: boolean; env: NodeJS.ProcessEnv }[] = [
      { isTTY: false, json: false, env: {} },
      { isTTY: true, json: true, env: {} },
      { isTTY: true, json: false, env: { CI: 'true' } },
    ];
    for (const c of cases) {
      const cap = captureIo(c.isTTY);
      await maybeNudgeUpdate({
        dir,
        io: cap.io,
        json: c.json,
        env: c.env,
        now: () => NOW,
        fetchImpl: forbiddenFetch,
        currentVersion: '0.1.0-alpha.6',
      });
      expect(cap.stderr()).toBe('');
      expect(cap.stdout()).toBe('');
    }
  });
});
