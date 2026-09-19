import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runShelfUse } from './shelf';
import { testSigner } from '../lib/read-test-utils';
import type { WalletProvider } from '../lib/wallet';
import type { CommandContext } from '../context';

/**
 * `tenjin shelf use`. Two things worth pinning beyond the write.
 *
 * VALIDATED against the shelves the wallet can actually reach before it is
 * persisted. A search naming a shelf answers 404 for an unknown one and for one
 * this wallet is not a member of, indistinguishably, so a typo persisted here
 * would look exactly like a membership problem on every later lookup.
 *
 * RESOLVED, AND ALWAYS STORED QUALIFIED. The shelf rides in the request body
 * now, so `notes` alone names a different shelf in every org that has one. This
 * verb is the one place that may resolve a bare name, because it is the one
 * place that asks the server which shelves this wallet can reach: exactly one
 * match is stored as `<org>/<shelf>`, several is a refusal that lists them.
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

/** Two orgs that each own a shelf called `notes`: the ambiguity this verb
 *  refuses to guess at. */
const TWO_ORGS = {
  orgs: [
    { slug: 'backtrack', publicSearch: true, shelves: [{ slug: 'notes' }] },
    { slug: 'acme', publicSearch: false, shelves: [{ slug: 'notes' }] },
  ],
};

function makeCtx(baseUrl?: string): CommandContext {
  const sink = () => ({ write: () => true }) as unknown as NodeJS.WritableStream;
  return {
    flags: { json: true, timeout: 5000, ...(baseUrl !== undefined ? { baseUrl } : {}) },
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
  it('resolves a bare slug against the one org that has it, and stores it qualified', async () => {
    const s = stub(ORGS);
    const res = await runShelfUse({ slug: 'bench' }, makeCtx(), deps(s.fetch));
    expect(s.calls).toEqual([`${BASE}/api/orgs`]);
    expect(res.data).toEqual({ shelf: 'backtrack/bench' });
    expect(await storedShelf()).toBe('backtrack/bench');
  });

  it('takes the qualified form explicitly, and stores it as given', async () => {
    const s = stub(ORGS);
    const res = await runShelfUse({ slug: 'backtrack/bench' }, makeCtx(), deps(s.fetch));
    expect(res.data).toEqual({ shelf: 'backtrack/bench' });
    expect(await storedShelf()).toBe('backtrack/bench');
  });

  /**
   * AMBIGUOUS IS A REFUSAL, never a pick. Guessing an org would silently send
   * this machine's questions to the wrong team's shelf for as long as nobody
   * noticed, and nothing about the guess would show up in a ledger row.
   */
  it('refuses a bare slug two orgs both have, and lists both candidates', async () => {
    const s = stub(TWO_ORGS);
    const err = await runShelfUse({ slug: 'notes' }, makeCtx(), deps(s.fetch)).catch(
      (e: unknown) => e,
    );
    expect(err).toMatchObject({ code: 'USAGE' });
    expect(String((err as { fix?: string }).fix)).toContain('backtrack/notes');
    expect(String((err as { fix?: string }).fix)).toContain('acme/notes');
    expect(await storedShelf()).toBeUndefined();
  });

  it('takes the qualified form when the bare one is ambiguous', async () => {
    const s = stub(TWO_ORGS);
    const res = await runShelfUse({ slug: 'acme/notes' }, makeCtx(), deps(s.fetch));
    expect(res.data).toEqual({ shelf: 'acme/notes' });
    expect(await storedShelf()).toBe('acme/notes');
  });

  it('refuses a name the list does not carry, and writes nothing', async () => {
    const s = stub(ORGS);
    const err = await runShelfUse({ slug: 'nope' }, makeCtx(), deps(s.fetch)).catch(
      (e: unknown) => e,
    );
    expect(err).toMatchObject({ code: 'USAGE' });
    // The remedy is the list itself, not a retry, and it is qualified.
    expect(String((err as { fix?: string }).fix)).toContain('backtrack/backtrack, backtrack/bench');
    expect(await storedShelf()).toBeUndefined();
  });

  it('refuses a qualified name whose org half is wrong, however real the shelf', async () => {
    const s = stub(ORGS);
    const err = await runShelfUse({ slug: 'acme/bench' }, makeCtx(), deps(s.fetch)).catch(
      (e: unknown) => e,
    );
    expect(err).toMatchObject({ code: 'USAGE' });
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

  it('refuses a malformed name before any network call', async () => {
    const s = stub(ORGS);
    for (const bad of ['', 'Backtrack', 'back track', 'a', 'acme/notes/extra', '/notes', 'acme/']) {
      await expect(runShelfUse({ slug: bad }, makeCtx(), deps(s.fetch))).rejects.toMatchObject({
        code: 'USAGE',
      });
    }
    expect(s.calls).toHaveLength(0);
  });

  /**
   * `--none` is its own verb because `config set` has no way to say "no value"
   * and the name regex has no empty form. It asks the server nothing: clearing a
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

  it('refuses a shelf and --none together', async () => {
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
    expect(after.shelf).toBe('backtrack/backtrack');
    if (process.platform !== 'win32') {
      expect((await stat(join(dir, 'config.json'))).mode & 0o777).toBe(0o600);
    }
  });
});

/** The same pin `org` holds: this verb signs, so a `--base-url` an agent chose
 *  must not decide where the delegation goes. */
describe('the configured deployment is the only one shelf use signs for', () => {
  it('refuses a base URL the config does not name, and writes nothing', async () => {
    const s = stub(ORGS);
    const err = await runShelfUse(
      { slug: 'bench' },
      makeCtx('https://attacker.example'),
      deps(s.fetch),
    ).catch((e: unknown) => e as Error);
    expect(err).toMatchObject({ code: 'REFUSED' });
    expect(s.calls).toEqual([]);
    expect(await storedShelf()).toBeUndefined();
  });
});
