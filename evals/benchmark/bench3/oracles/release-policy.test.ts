import { describe, expect, it } from 'vitest';
import { channelTag, resolveTarget } from './lib/update-check';

// Mounted as src/bench3-independent.test.ts only in the verifier image.
// These synthetic version tables specify the requested release policy.
describe('the promoted release controls updates', () => {
  it.each(['3.7.0-alpha.4', '3.7.0', '0.8.0-alpha.12'])(
    'follows latest for supported build %s',
    (current) => {
      expect(channelTag(current)).toBe('latest');
      expect(resolveTarget(current, { latest: '3.8.0', alpha: '9.0.0-alpha.3' })).toBe('3.8.0');
    },
  );

  it.each([{}, { alpha: '9.0.0-alpha.3' }, { latest: 'broken', alpha: '9.0.0-alpha.3' }])(
    'does not substitute an unpromoted release when latest is unusable: %j',
    (tags) => {
      expect(resolveTarget('3.7.0-alpha.4', tags)).toBeNull();
    },
  );

  it('refuses unknown current builds and accepts a lower promoted target as policy data', () => {
    expect(channelTag('development')).toBeNull();
    expect(resolveTarget('development', { latest: '3.8.0' })).toBeNull();
    // Resolver policy is separate from the caller deciding whether to install.
    expect(resolveTarget('3.7.0-alpha.4', { latest: '3.6.0', alpha: '3.9.0-alpha.1' })).toBe(
      '3.6.0',
    );
  });
});

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { maybeUpdate, readUpdateSignal } from './lib/update-check';
import { runUpdate } from './commands/update';

const silentIo = () => ({
  isTTY: false,
  stdout: new Writable({
    write(_chunk, _encoding, done) {
      done();
    },
  }),
  stderr: new Writable({
    write(_chunk, _encoding, done) {
      done();
    },
  }),
});
const answer = (tags: Record<string, string>) =>
  (async () =>
    new Response(JSON.stringify(tags), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as typeof fetch;

async function temporary(run: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'historical-release-'));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe('update command and daily checks share the promoted policy', () => {
  it.each(['3.7.0-alpha.4', '3.7.0'])(
    'explicit check on %s never installs or reports a channel',
    async (currentVersion) => {
      await temporary(async (dir) => {
        const result = await runUpdate(
          { check: true },
          { flags: { json: true, timeout: 1000 }, dataDir: dir, io: silentIo() },
          {
            currentVersion,
            fetchImpl: answer({ latest: '3.8.0', alpha: '9.0.0-alpha.3' }),
            spawnImpl: async () => {
              throw new Error('check must not install');
            },
          },
        );
        expect(result.data).toEqual({
          current: currentVersion,
          latest: '3.8.0',
          updateAvailable: true,
          updated: false,
        });
      });
    },
  );

  it('distinguishes absent and malformed latest from a network failure', async () => {
    await temporary(async (dir) => {
      const ctx = { flags: { json: true, timeout: 1000 }, dataDir: dir, io: silentIo() };
      await expect(
        runUpdate({ check: true }, ctx, {
          currentVersion: '3.7.0-alpha.4',
          fetchImpl: answer({ alpha: '9.0.0-alpha.3' }),
        }),
      ).rejects.toMatchObject({
        code: 'RESOURCE_NOT_FOUND',
        message: expect.stringContaining('no published'),
      });
      await expect(
        runUpdate({ check: true }, ctx, {
          currentVersion: '3.7.0',
          fetchImpl: answer({ latest: 'garbled' }),
        }),
      ).rejects.toMatchObject({
        code: 'RESOURCE_NOT_FOUND',
        message: expect.stringContaining('not a version'),
      });
    });
  });

  it.each([{}, { latest: 'garbled' }])(
    'caches answered but unusable registry response %j',
    async (tags) => {
      await temporary(async (dir) => {
        let calls = 0;
        const fetchImpl = (async () => {
          calls++;
          return answer(tags)('https://example.invalid');
        }) as typeof fetch;
        const deps = {
          dir,
          io: silentIo(),
          json: true,
          env: {},
          currentVersion: '3.7.0-alpha.4',
          fetchImpl,
        };
        for (const now of [10_000, 11_000]) await maybeUpdate({ ...deps, now: () => now });
        expect(calls).toBe(1);
        await maybeUpdate({ ...deps, now: () => 10_000 + 86_400_001 });
        expect(calls).toBe(2);
      });
    },
  );

  it('retries transport errors and never queries for an unknown build', async () => {
    await temporary(async (dir) => {
      let calls = 0;
      const fetchImpl = (async () => {
        calls++;
        throw new Error('offline');
      }) as typeof fetch;
      const deps = {
        dir,
        io: silentIo(),
        json: true,
        env: {},
        currentVersion: '3.7.0-alpha.4',
        fetchImpl,
        now: () => 10_000,
      };
      await maybeUpdate(deps);
      await maybeUpdate(deps);
      expect(calls).toBe(2);
      await maybeUpdate({ ...deps, currentVersion: 'development' });
      expect(calls).toBe(2);
    });
  });

  it('records a latest-only signal without the obsolete channel field', async () => {
    await temporary(async (dir) => {
      await maybeUpdate({
        dir,
        io: silentIo(),
        json: true,
        env: {},
        currentVersion: '3.7.0-alpha.4',
        fetchImpl: answer({ latest: '3.8.0', alpha: '9.0.0-alpha.3' }),
        now: () => Date.now(),
      });
      expect(await readUpdateSignal(dir, '3.7.0-alpha.4')).toEqual({
        current: '3.7.0-alpha.4',
        latest: '3.8.0',
      });
    });
  });
});
