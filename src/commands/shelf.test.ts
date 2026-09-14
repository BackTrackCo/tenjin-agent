import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runShelfUse } from './shelf';
import { testSigner } from '../lib/read-test-utils';
import type { WalletProvider } from '../lib/wallet';
import type { CommandContext } from '../context';

/**
 * `tenjin shelf use`. The one thing worth pinning beyond the write: the slug is
 * VALIDATED against the shelves the wallet can actually reach before it is
 * persisted. The shelf search route answers 404 for an unknown slug and for one
 * this wallet is not a member of, indistinguishably, so a typo persisted here
 * would look exactly like a membership problem on every later lookup.
 */

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tenjin-shelf-'));
  await writeFile(join(dir, 'config.json'), JSON.stringify({ baseUrl: BASE }));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const BASE = 'https://tenjin.blog';
const ORGS = {
  orgs: [
    {
      slug: 'backtrack',
      publicSearch: true,
      shelves: [{ slug: 'backtrack' }, { slug: 'bench' }],
    },
  ],
};

function makeCtx(): CommandContext {
  const sink = () => ({ write: () => true }) as unknown as NodeJS.WritableStream;
  return {
    flags: { json: true, timeout: 5000 },
    dataDir: dir,
    io: { stdout: sink(), stderr: sink(), isTTY: false },
  };
}

function provider(): WalletProvider {
  const inner = testSigner();
  return {
    id: 'local',
    describe: async () => ({
      address: inner.address,
      provider: 'local',
      credentialSource: 'file',
      policyEnforcement: 'client-only',
    }),
    getSigner: async () => inner,
    diagnostics: async () => ({ warnings: [] }),
  };
}

function stub(body: unknown, status = 200): { fetch: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  const fetchFn = (async (url: string | URL) => {
    calls.push(String(url));
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return { fetch: fetchFn, calls };
}

const deps = (fetchImpl: typeof fetch) => ({
  fetchImpl,
  provider: provider(),
  env: {} as NodeJS.ProcessEnv,
});

async function storedShelf(): Promise<unknown> {
  return (JSON.parse(await readFile(join(dir, 'config.json'), 'utf8')) as Record<string, unknown>)
    .shelf;
}

describe('tenjin shelf use', () => {
  it('persists a slug the wallet can reach, after listing to check', async () => {
    const s = stub(ORGS);
    const res = await runShelfUse({ slug: 'bench' }, makeCtx(), deps(s.fetch));
    expect(s.calls).toEqual([`${BASE}/api/orgs`]);
    expect(res.data).toEqual({ shelf: 'bench' });
    expect(await storedShelf()).toBe('bench');
  });

  it('refuses a slug the list does not carry, and writes nothing', async () => {
    const s = stub(ORGS);
    const err = await runShelfUse({ slug: 'nope' }, makeCtx(), deps(s.fetch)).catch(
      (e: unknown) => e,
    );
    expect(err).toMatchObject({ code: 'USAGE' });
    // The remedy is the list itself, not a retry.
    expect(String((err as { fix?: string }).fix)).toContain('backtrack, bench');
    expect(await storedShelf()).toBeUndefined();
  });

  it('refuses when the wallet is in no org, and says who provisions one', async () => {
    const s = stub({ orgs: [] });
    const err = await runShelfUse({ slug: 'backtrack' }, makeCtx(), deps(s.fetch)).catch(
      (e: unknown) => e,
    );
    expect(err).toMatchObject({ code: 'USAGE' });
    expect(String((err as { fix?: string }).fix)).toContain('operator');
  });

  it('refuses a malformed slug before any network call', async () => {
    const s = stub(ORGS);
    for (const bad of ['', 'Backtrack', 'back track', 'a', 'x'.repeat(33)]) {
      await expect(runShelfUse({ slug: bad }, makeCtx(), deps(s.fetch))).rejects.toMatchObject({
        code: 'USAGE',
      });
    }
    expect(s.calls).toHaveLength(0);
  });

  /**
   * `--none` is its own verb because `config set` has no way to say "no value"
   * and the slug regex has no empty form. It asks the server nothing: clearing a
   * local preference is not a membership question.
   */
  it('--none clears the shelf with no network call', async () => {
    const s = stub(ORGS);
    await runShelfUse({ slug: 'backtrack' }, makeCtx(), deps(s.fetch));
    const res = await runShelfUse({ none: true }, makeCtx(), deps(s.fetch));
    expect(res.data).toEqual({ shelf: null });
    expect(await storedShelf()).toBeNull();
    // One call, from the set above; the clear made none.
    expect(s.calls).toHaveLength(1);
  });

  it('refuses a slug and --none together', async () => {
    const s = stub(ORGS);
    await expect(
      runShelfUse({ slug: 'backtrack', none: true }, makeCtx(), deps(s.fetch)),
    ).rejects.toMatchObject({ code: 'USAGE' });
  });

  it('keeps every other key in the file, and leaves it at 0600', async () => {
    await writeFile(
      join(dir, 'config.json'),
      JSON.stringify({ baseUrl: BASE, maxAutoSpend: '250000', team: { publicFallback: 'off' } }),
    );
    const s = stub(ORGS);
    await runShelfUse({ slug: 'backtrack' }, makeCtx(), deps(s.fetch));
    const after = JSON.parse(await readFile(join(dir, 'config.json'), 'utf8')) as Record<
      string,
      unknown
    >;
    expect(after.maxAutoSpend).toBe('250000');
    expect(after.team).toEqual({ publicFallback: 'off' });
    expect(after.shelf).toBe('backtrack');
    if (process.platform !== 'win32') {
      expect((await stat(join(dir, 'config.json'))).mode & 0o777).toBe(0o600);
    }
  });
});
