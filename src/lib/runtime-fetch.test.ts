import { createHash } from 'node:crypto';
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  download,
  downloadViaCurl,
  extract,
  nodeArtifact,
  nodeKey,
  unpinnedPlatform,
  type ExtractSpawn,
} from './runtime-fetch';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'runtime-fetch-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('nodeKey', () => {
  it.each([
    ['darwin', 'arm64', undefined, 'darwin-arm64'],
    ['darwin', 'x64', undefined, 'darwin-x64'],
    ['linux', 'x64', '2.28', 'linux-x64'],
    ['linux', 'arm64', '2.39', 'linux-arm64'],
    ['win32', 'x64', undefined, 'win-x64'],
    ['win32', 'arm64', undefined, 'win-arm64'],
  ] as const)('%s %s (glibc %s) is %s', (platform, arch, glibc, key) => {
    expect(nodeKey(platform, arch, glibc)).toBe(key);
  });

  it.each([
    ['linux', 'x64', undefined, 'musl'],
    ['linux', 'x64', null, 'no glibc'],
    ['linux', 'x64', '2.17', 'glibc 2.17'],
    ['linux', 'arm64', '1.99', 'glibc 1.99'],
    ['freebsd', 'x64', undefined, 'freebsd'],
    ['win32', 'ia32', undefined, 'ia32'],
    ['linux', 'ia32', '2.35', 'linux ia32'],
  ] as const)('%s %s is null (%s)', (platform, arch, glibc, _why) => {
    expect(nodeKey(platform as NodeJS.Platform, arch, glibc)).toBeNull();
  });
});

describe('unpinnedPlatform', () => {
  it('names the real cause where no Node is pinned, and nothing where one is', () => {
    expect(unpinnedPlatform('linux', 'x64', undefined)).toBe('linux-x64 with musl, not glibc');
    expect(unpinnedPlatform('linux', 'arm64', '2.17')).toBe(
      'linux-arm64 with glibc 2.17, older than 2.28',
    );
    expect(unpinnedPlatform('freebsd', 'x64', undefined)).toBe('freebsd-x64');
    expect(unpinnedPlatform('win32', 'ia32', undefined)).toBe('win-ia32');
    expect(unpinnedPlatform('linux', 'x64', '2.28')).toBeNull();
    expect(unpinnedPlatform('darwin', 'arm64', null)).toBeNull();
  });
});

describe('nodeArtifact', () => {
  it('names the release archive and the one member kept', () => {
    expect(nodeArtifact('24.14.1', 'linux-x64')).toEqual({
      key: 'linux-x64',
      url: 'https://nodejs.org/dist/v24.14.1/node-v24.14.1-linux-x64.tar.gz',
      file: 'node-v24.14.1-linux-x64.tar.gz',
      member: 'node-v24.14.1-linux-x64/bin/node',
    });
    expect(nodeArtifact('24.14.1', 'win-arm64')).toEqual({
      key: 'win-arm64',
      url: 'https://nodejs.org/dist/v24.14.1/node-v24.14.1-win-arm64.zip',
      file: 'node-v24.14.1-win-arm64.zip',
      member: 'node-v24.14.1-win-arm64/node.exe',
    });
  });
});

describe('download', () => {
  const body = Buffer.from('the node archive bytes '.repeat(500));
  const serve =
    (bytes: Buffer, init: ResponseInit = { status: 200 }): typeof fetch =>
    async () =>
      new Response(bytes, init);

  it('returns the digest of a fixture body and the file holding it', async () => {
    const got = await download('https://nodejs.org/dist/x.tar.gz', {
      dir,
      maxBytes: 1_000_000,
      timeoutMs: 5_000,
      hash: 'sha256',
      fetchImpl: serve(body),
    });
    expect(got.digest.equals(createHash('sha256').update(body).digest())).toBe(true);
    expect(readFileSync(got.file).equals(body)).toBe(true);
    const sha512 = await download('https://registry.npmjs.org/x.tgz', {
      dir,
      maxBytes: 1_000_000,
      timeoutMs: 5_000,
      hash: 'sha512',
      fetchImpl: serve(body),
    });
    expect(sha512.digest.equals(createHash('sha512').update(body).digest())).toBe(true);
  });

  it('refuses http: without fetching', async () => {
    let fetched = false;
    const fetchImpl = (async () => {
      fetched = true;
      return new Response(body);
    }) as typeof fetch;
    await expect(
      download('http://nodejs.org/dist/x.tar.gz', {
        dir,
        maxBytes: 1_000_000,
        timeoutMs: 5_000,
        hash: 'sha256',
        fetchImpl,
      }),
    ).rejects.toThrow(/only https/);
    expect(fetched).toBe(false);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('aborts past maxBytes and leaves no file', async () => {
    // A streamed body with no content-length, so the cap is enforced while reading.
    const stream = (): typeof fetch => async () =>
      new Response(
        new ReadableStream({
          start(c) {
            for (let i = 0; i < 10; i += 1) c.enqueue(new Uint8Array(1000));
            c.close();
          },
        }),
      );
    await expect(
      download('https://nodejs.org/dist/x.tar.gz', {
        dir,
        maxBytes: 4_000,
        timeoutMs: 5_000,
        hash: 'sha256',
        fetchImpl: stream(),
      }),
    ).rejects.toThrow(/larger than 4000 bytes/);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('is a NETWORK_ERROR on a failed fetch or a bad status, and leaves no file', async () => {
    const refused = (async () => {
      throw new TypeError('fetch failed');
    }) as typeof fetch;
    for (const fetchImpl of [refused, serve(Buffer.from('nope'), { status: 404 })]) {
      await expect(
        download('https://nodejs.org/dist/x.tar.gz', {
          dir,
          maxBytes: 1_000,
          timeoutMs: 5_000,
          hash: 'sha256',
          fetchImpl,
        }),
      ).rejects.toMatchObject({ code: 'NETWORK_ERROR' });
    }
    expect(readdirSync(dir)).toEqual([]);
  });

  it('names the file and the errno, never the network, when a write to disk fails', async () => {
    // FileHandle is not exported: its prototype is reached through a handle.
    const probe = await open(join(dir, 'probe'), 'w');
    const proto = Object.getPrototypeOf(probe) as { write: (...args: unknown[]) => unknown };
    await probe.close();
    rmSync(join(dir, 'probe'));
    const full = vi
      .spyOn(proto, 'write')
      .mockRejectedValue(
        Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' }),
      );
    try {
      const err = await download('https://nodejs.org/dist/x.tar.gz', {
        dir,
        maxBytes: 1_000_000,
        timeoutMs: 5_000,
        hash: 'sha256',
        fetchImpl: serve(body),
      }).catch((e: unknown) => e);
      expect(err).toMatchObject({
        code: 'UPDATE_FAILED',
        message: expect.stringMatching(/^could not write .*dl-[0-9a-f]+: ENOSPC$/),
      });
      expect((err as Error).message).not.toContain('nodejs.org');
    } finally {
      full.mockRestore();
    }
    expect(readdirSync(dir)).toEqual([]);
  });
});

describe.skipIf(process.platform === 'win32')('proxy download on older npm Node', () => {
  it('passes the proxy environment to curl, hashes its bytes, and removes failed downloads', async () => {
    const curl = join(dir, 'curl');
    writeFileSync(
      curl,
      '#!/bin/sh\nwhile [ "$#" -gt 0 ]; do if [ "$1" = --output ]; then shift; file=$1; fi; shift; done\nprintf "%s" "$HTTPS_PROXY" > "$file"\nexit "${FIXTURE_EXIT:-0}"\n',
    );
    chmodSync(curl, 0o755);
    const env = { PATH: dir, HTTPS_PROXY: 'http://fixture.invalid:8080' };
    const options = { dir, maxBytes: 1000, timeoutMs: 1000, env };
    const got = await downloadViaCurl('https://nodejs.org/archive.tar.gz', options);
    expect(got.digest.toString('hex')).toBe(
      createHash('sha256').update(env.HTTPS_PROXY).digest('hex'),
    );
    rmSync(got.file);
    await expect(
      downloadViaCurl('https://nodejs.org/archive.tar.gz', {
        ...options,
        env: { ...env, FIXTURE_EXIT: '7' },
      }),
    ).rejects.toMatchObject({ code: 'NETWORK_ERROR' });
    expect(readdirSync(dir).filter((name) => name.startsWith('dl-'))).toEqual([]);
    await expect(downloadViaCurl('http://nodejs.org/archive.tar.gz', options)).rejects.toThrow(
      'HTTPS',
    );
  });
});

describe('extract', () => {
  const recorder = (): { calls: [string, string[], string][]; spawnImpl: ExtractSpawn } => {
    const calls: [string, string[], string][] = [];
    return {
      calls,
      spawnImpl: async (command, args, o) => {
        calls.push([command, args, o.cwd]);
        return { code: 0, stderr: '' };
      },
    };
  };

  it("uses System32's tar.exe with -xf on win32, run in the archive's folder with relative names", async () => {
    const { calls, spawnImpl } = recorder();
    const before = process.env.SystemRoot;
    delete process.env.SystemRoot;
    // A user folder outside the ANSI code page never reaches tar's argv.
    const tmp = 'C:\\Users\\Дмитрий\\.tenjin\\runtime\\tmp';
    try {
      await extract(`${tmp}\\dl-1a2b`, `${tmp}\\node-3c4d`, {
        member: 'node-v24.14.1-win-x64/node.exe',
        strip: 1,
        platform: 'win32',
        spawnImpl,
      });
    } finally {
      if (before !== undefined) process.env.SystemRoot = before;
    }
    expect(calls).toEqual([
      [
        'C:\\Windows\\System32\\tar.exe',
        [
          '-xf',
          'dl-1a2b',
          '-C',
          'node-3c4d',
          '--strip-components=1',
          'node-v24.14.1-win-x64/node.exe',
        ],
        tmp,
      ],
    ]);
    expect(calls[0]![1].join(' ')).toMatch(/^[\x20-\x7e]*$/);
  });

  it('uses tar -xzf on POSIX, with no strip or member when none is asked', async () => {
    const { calls, spawnImpl } = recorder();
    await extract('/t/a.tgz', '/t/out', { platform: 'linux', spawnImpl });
    expect(calls).toEqual([['tar', ['-xzf', 'a.tgz', '-C', 'out'], '/t']]);
    // A destination outside the archive's folder keeps its full path.
    await extract('/t/a.tgz', '/elsewhere/out', { platform: 'linux', spawnImpl });
    expect(calls[1]).toEqual(['tar', ['-xzf', 'a.tgz', '-C', '/elsewhere/out'], '/t']);
  });

  it('throws with what tar said, bounded', async () => {
    const spawnImpl: ExtractSpawn = async () => ({
      code: 2,
      stderr: `bad archive ${'x'.repeat(500)}`,
    });
    const err = await extract('/t/a.tgz', '/t/out', { platform: 'linux', spawnImpl }).catch(
      (e: Error) => e,
    );
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/exit 2\): bad archive x+$/);
    expect((err as Error).message.length).toBeLessThan(400);
  });
});
