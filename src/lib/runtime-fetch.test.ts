import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { download, extract, nodeArtifact, nodeKey, type ExtractSpawn } from './runtime-fetch';

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
});

describe('extract', () => {
  const recorder = (): { calls: [string, string[]][]; spawnImpl: ExtractSpawn } => {
    const calls: [string, string[]][] = [];
    return {
      calls,
      spawnImpl: async (command, args) => {
        calls.push([command, args]);
        return { code: 0, stderr: '' };
      },
    };
  };

  it("uses System32's tar.exe with -xf on win32", async () => {
    const { calls, spawnImpl } = recorder();
    const before = process.env.SystemRoot;
    delete process.env.SystemRoot;
    try {
      await extract('C:\\t\\node.zip', 'C:\\t\\out', {
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
          'C:\\t\\node.zip',
          '-C',
          'C:\\t\\out',
          '--strip-components=1',
          'node-v24.14.1-win-x64/node.exe',
        ],
      ],
    ]);
  });

  it('uses tar -xzf on POSIX, with no strip or member when none is asked', async () => {
    const { calls, spawnImpl } = recorder();
    await extract('/t/a.tgz', '/t/out', { platform: 'linux', spawnImpl });
    expect(calls).toEqual([['tar', ['-xzf', '/t/a.tgz', '-C', '/t/out']]]);
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
