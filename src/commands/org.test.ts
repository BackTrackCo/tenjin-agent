import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runOrgAdd, runOrgList, runOrgRemove, runOrgSetPublicSearch } from './org';
import { testSigner } from '../lib/read-test-utils';
import type { WalletProvider } from '../lib/wallet';
import type { CommandContext } from '../context';

/**
 * `tenjin org` against a stub server. What is pinned is the WIRE: the method,
 * the path, the signed headers and the body — `{ member }` on both sides, which
 * `src/contract.test.ts` pins against the OpenAPI document so the two repos
 * cannot drift on it again.
 */

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tenjin-org-'));
  await writeFile(join(dir, 'config.json'), JSON.stringify({ baseUrl: BASE, shelf: 'backtrack' }));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const BASE = 'https://tenjin.blog';

const ORGS = {
  orgs: [
    {
      slug: 'backtrack',
      name: 'BackTrack',
      role: 'admin',
      publicSearch: true,
      shelves: [{ slug: 'backtrack', name: 'BackTrack' }],
    },
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

interface Call {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: Record<string, unknown>;
}

function stub(respond: (call: Call) => Response): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchFn = (async (url: string | URL, init?: RequestInit) => {
    const call: Call = {
      method: init?.method ?? 'GET',
      url: String(url),
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      ...(typeof init?.body === 'string'
        ? { body: JSON.parse(init.body) as Record<string, unknown> }
        : {}),
    };
    calls.push(call);
    return respond(call);
  }) as unknown as typeof fetch;
  return { fetch: fetchFn, calls };
}

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const deps = (fetchImpl: typeof fetch) => ({
  fetchImpl,
  provider: provider(),
  env: {} as NodeJS.ProcessEnv,
});

function signed(call: Call | undefined): boolean {
  return (
    call?.headers['tenjin-session-delegation'] !== undefined &&
    call?.headers['signature-input'] !== undefined
  );
}

describe('tenjin org list', () => {
  it('signs GET /api/orgs and names each org, its shelves and its policy', async () => {
    const s = stub(() => json(200, ORGS));
    const res = await runOrgList(makeCtx(), deps(s.fetch));

    expect(s.calls).toHaveLength(1);
    expect(s.calls[0]?.method).toBe('GET');
    expect(s.calls[0]?.url).toBe(`${BASE}/api/orgs`);
    expect(signed(s.calls[0])).toBe(true);

    expect(res.data).toMatchObject({ activeShelf: 'backtrack' });
    const lines = res.humanLines?.join('\n') ?? '';
    expect(lines).toContain('backtrack (admin)');
    expect(lines).toContain('public-search: on');
    expect(lines).toContain('<- active');
  });

  it('says so plainly when the wallet is in no org at all', async () => {
    const s = stub(() => json(200, { orgs: [] }));
    const res = await runOrgList(makeCtx(), deps(s.fetch));
    expect(res.humanLines?.join('\n')).toContain('in no org');
  });

  it('reports an org whose policy is off', async () => {
    const s = stub(() => json(200, { orgs: [{ ...ORGS.orgs[0], publicSearch: false }] }));
    const res = await runOrgList(makeCtx(), deps(s.fetch));
    expect(res.humanLines?.join('\n')).toContain('public-search: off');
  });
});

describe('tenjin org add and remove', () => {
  it('POSTs { member } to the org owning the active shelf', async () => {
    const s = stub((c) => (c.url.endsWith('/members') ? json(200, { ok: true }) : json(200, ORGS)));
    await runOrgAdd({ member: 'ali' }, makeCtx(), deps(s.fetch));

    const write = s.calls.find((c) => c.url.endsWith('/members'));
    expect(write?.method).toBe('POST');
    expect(write?.url).toBe(`${BASE}/api/orgs/backtrack/members`);
    expect(write?.body).toEqual({ member: 'ali' });
    expect(signed(write)).toBe(true);
  });

  it('takes a 0x address as the same one tagged string', async () => {
    const ADDR = '0x' + 'a'.repeat(40);
    const s = stub((c) => (c.url.endsWith('/members') ? json(200, { ok: true }) : json(200, ORGS)));
    await runOrgAdd({ member: ADDR }, makeCtx(), deps(s.fetch));
    expect(s.calls.find((c) => c.url.endsWith('/members'))?.body).toEqual({ member: ADDR });
  });

  it('DELETEs the same body to remove', async () => {
    const s = stub((c) => (c.url.endsWith('/members') ? json(200, { ok: true }) : json(200, ORGS)));
    await runOrgRemove({ member: 'ali' }, makeCtx(), deps(s.fetch));
    const write = s.calls.find((c) => c.url.endsWith('/members'));
    expect(write?.method).toBe('DELETE');
    expect(write?.body).toEqual({ member: 'ali' });
  });

  it('--org overrides the default without listing at all', async () => {
    const s = stub(() => json(200, { ok: true }));
    await runOrgAdd({ member: 'ali', org: 'other' }, makeCtx(), deps(s.fetch));
    expect(s.calls).toHaveLength(1);
    expect(s.calls[0]?.url).toBe(`${BASE}/api/orgs/other/members`);
  });

  it('refuses a member that is neither a handle nor an address, before any signature', async () => {
    const s = stub(() => json(200, { ok: true }));
    await expect(
      runOrgAdd({ member: 'Not A Handle' }, makeCtx(), deps(s.fetch)),
    ).rejects.toMatchObject({ code: 'USAGE' });
    expect(s.calls).toHaveLength(0);
  });

  /** Exit 4, the class every other server-refused write in this CLI uses. */
  it('is exit 4 on a 403, carrying the server’s own message', async () => {
    const s = stub((c) =>
      c.url.endsWith('/members') ? json(403, { error: 'not an admin' }) : json(200, ORGS),
    );
    const err = await runOrgAdd({ member: 'ali' }, makeCtx(), deps(s.fetch)).catch(
      (e: unknown) => e,
    );
    expect(err).toMatchObject({ code: 'PUBLISH_FAILED', exitCode: 4 });
    expect(String((err as Error).message)).toContain('not an admin');
  });

  it('points a 404 at `tenjin org list`, which is what can answer it', async () => {
    const s = stub((c) =>
      c.url.endsWith('/members') ? json(404, { error: 'no such org' }) : json(200, ORGS),
    );
    const err = await runOrgAdd({ member: 'ali', org: 'nope' }, makeCtx(), deps(s.fetch)).catch(
      (e: unknown) => e,
    );
    expect(String((err as { fix?: string }).fix)).toContain('tenjin org list');
  });
});

describe('tenjin org set public-search', () => {
  it('PATCHes { publicSearch } and signs the PATCH as a PATCH', async () => {
    const s = stub((c) => (c.method === 'PATCH' ? json(200, { ok: true }) : json(200, ORGS)));
    const res = await runOrgSetPublicSearch({ on: false }, makeCtx(), deps(s.fetch));

    const patch = s.calls.find((c) => c.method === 'PATCH');
    expect(patch?.url).toBe(`${BASE}/api/orgs/backtrack`);
    expect(patch?.body).toEqual({ publicSearch: false });
    expect(signed(patch)).toBe(true);
    // RFC 9421 covers `@method`, so signing a PATCH as a PUT would produce a
    // signature the server cannot verify.
    expect(patch?.headers['signature-input']).toBeDefined();

    expect(res.data).toEqual({ org: 'backtrack', publicSearch: false });
    // The receipt says out loud which setting this is, because the other one is
    // spelled almost the same and lives on this machine.
    expect(res.humanLines?.join('\n')).toContain('team.publicFallback');
  });

  it('turns it back on', async () => {
    const s = stub((c) => (c.method === 'PATCH' ? json(200, { ok: true }) : json(200, ORGS)));
    await runOrgSetPublicSearch({ on: true }, makeCtx(), deps(s.fetch));
    expect(s.calls.find((c) => c.method === 'PATCH')?.body).toEqual({ publicSearch: true });
  });

  it('is exit 4 when the server says this wallet is not an admin', async () => {
    const s = stub((c) =>
      c.method === 'PATCH' ? json(403, { error: 'admin only' }) : json(200, ORGS),
    );
    await expect(
      runOrgSetPublicSearch({ on: false }, makeCtx(), deps(s.fetch)),
    ).rejects.toMatchObject({ code: 'PUBLISH_FAILED', exitCode: 4 });
  });
});

/**
 * THE FLAG MUST NOT MOVE THE PIN. Every verb here wallet-signs, and the
 * delegation it mints is written to disk: a `--base-url` an agent chose would
 * otherwise sign for that host and clobber the machine's session on the way
 * out. There is no public route for membership to degrade to, so this refuses
 * before the keystore is even opened.
 */
describe('the configured deployment is the only one these verbs sign for', () => {
  it.each([
    ['org list', (c: CommandContext, d: ReturnType<typeof deps>) => runOrgList(c, d)],
    [
      'org add',
      (c: CommandContext, d: ReturnType<typeof deps>) => runOrgAdd({ member: 'ali' }, c, d),
    ],
    [
      'org set public-search',
      (c: CommandContext, d: ReturnType<typeof deps>) => runOrgSetPublicSearch({ on: false }, c, d),
    ],
  ])('%s refuses a base URL the config does not name', async (_label, run) => {
    const s = stub(() => json(200, ORGS));
    const err = await run(makeCtx('https://attacker.example'), deps(s.fetch)).catch(
      (e: unknown) => e as Error,
    );
    expect(err).toMatchObject({ code: 'REFUSED' });
    expect(s.calls).toHaveLength(0);
  });
});
