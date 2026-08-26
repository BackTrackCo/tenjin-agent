import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runProfileSet, runProfileShow, type ProfileDeps } from './profile';
import { runStats } from './stats';
import { testSigner } from '../lib/read-test-utils';
import { CliError } from '../lib/errors';
import { SHELF_BYPASS_HEADER } from '../lib/http';
import type { WalletProvider } from '../lib/wallet';
import type { CommandContext } from '../context';

/**
 * `tenjin profile [set]` and `tenjin stats` against a stub server. Everything
 * between the flags and the wire: which flags are sent (and only those), the
 * empty-flag USAGE that costs no signature, the server's own message on a
 * rejected handle, and the team-shelf bypass header on every request.
 */

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tenjin-profile-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const ADDRESS = testSigner().address;
const CREATOR = {
  id: '0197cccc-bbbb-cccc-dddd-eeeeeeeeeeee',
  handle: 'iris',
  displayName: 'Iris',
  walletAddress: ADDRESS.toLowerCase(),
  splitAddress: null,
  avatarImageId: null,
  defaultPrice: '250000',
  bio: 'Writes about fees.',
  showHumanButton: true,
  createdAt: '2026-07-01T00:00:00Z',
};

function makeCtx(baseUrl = 'https://preview.example'): CommandContext {
  const sink = () => ({ write: () => true }) as unknown as NodeJS.WritableStream;
  return {
    flags: { json: true, timeout: 5000, baseUrl },
    dataDir: dir,
    io: { stdout: sink(), stderr: sink(), isTTY: false },
  };
}

function provider(): { provider: WalletProvider; signCount: () => number } {
  const inner = testSigner();
  let n = 0;
  return {
    signCount: () => n,
    provider: {
      id: 'local',
      describe: async () => ({
        address: inner.address,
        provider: 'local',
        credentialSource: 'file',
        policyEnforcement: 'client-only',
      }),
      getSigner: async () => ({
        address: inner.address,
        signMessage: (a) => {
          n++;
          return inner.signMessage(a);
        },
        signTypedData: (a) => inner.signTypedData(a),
        signTransaction: (tx) => inner.signTransaction(tx),
      }),
      diagnostics: async () => ({ warnings: [] }),
    },
  };
}

interface Call {
  method: string;
  url: string;
  body?: Record<string, unknown>;
  headers: Record<string, string>;
}

function stub(respond: (call: Call) => Response): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchFn = (async (url: string | URL, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
      headers[k.toLowerCase()] = String(v);
    }
    const call: Call = {
      method: init?.method ?? 'GET',
      url: String(url),
      headers,
      ...(typeof init?.body === 'string'
        ? { body: JSON.parse(init.body) as Record<string, unknown> }
        : {}),
    };
    calls.push(call);
    return respond(call);
  }) as unknown as typeof fetch;
  return { fetch: fetchFn, calls };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** Plain SIWX (no session file) keeps each test to one signer and no disk state. */
function deps(fetchImpl: typeof fetch, over: ProfileDeps = {}): ProfileDeps {
  return { fetchImpl, provider: provider().provider, useSession: false, env: {}, ...over };
}

describe('tenjin profile (show)', () => {
  it('reads GET /api/me signed, and returns the profile fields', async () => {
    const s = stub(() => json(200, { address: ADDRESS, creator: CREATOR }));
    const res = await runProfileShow(makeCtx(), deps(s.fetch));
    expect(s.calls).toHaveLength(1);
    expect(s.calls[0]?.method).toBe('GET');
    expect(s.calls[0]?.url).toBe('https://preview.example/api/me');
    expect(s.calls[0]?.headers).toHaveProperty('sign-in-with-x');
    expect(res.data).toEqual({
      address: ADDRESS,
      profile: {
        handle: 'iris',
        displayName: 'Iris',
        bio: 'Writes about fees.',
        defaultPrice: '250000',
        walletAddress: ADDRESS.toLowerCase(),
      },
    });
    expect(res.humanLines?.join('\n')).toContain('handle:        iris');
    expect(res.humanLines?.join('\n')).toContain('default price: $0.25');
  });

  it('a never-seen wallet is profile: null with a pointer at `profile set`', async () => {
    const s = stub(() => json(200, { address: ADDRESS, creator: null }));
    const res = await runProfileShow(makeCtx(), deps(s.fetch));
    expect((res.data as { profile: unknown }).profile).toBeNull();
    expect(res.humanLines?.[0]).toContain('tenjin profile set --handle');
  });

  it('a contract drift is CONTRACT_MISMATCH, not a crash', async () => {
    const s = stub(() => json(200, { nope: true }));
    await expect(runProfileShow(makeCtx(), deps(s.fetch))).rejects.toMatchObject({
      code: 'CONTRACT_MISMATCH',
    });
  });
});

describe('tenjin profile set', () => {
  it('sends only the flags given, as a signed PUT /api/me', async () => {
    const s = stub((c) =>
      json(200, {
        address: ADDRESS,
        creator: { ...CREATOR, handle: (c.body as { handle: string }).handle },
      }),
    );
    const res = await runProfileSet({ handle: 'vraj' }, makeCtx(), deps(s.fetch));
    expect(s.calls).toHaveLength(1);
    expect(s.calls[0]?.method).toBe('PUT');
    expect(s.calls[0]?.body).toEqual({ handle: 'vraj' });
    expect((res.data as { profile: { handle: string } }).profile.handle).toBe('vraj');
    expect(res.humanLines?.[0]).toBe('Profile updated.');
  });

  it('maps --display-name and --bio onto the server keys', async () => {
    const s = stub(() => json(200, { address: ADDRESS, creator: CREATOR }));
    await runProfileSet({ displayName: 'V', bio: 'hi' }, makeCtx(), deps(s.fetch));
    expect(s.calls[0]?.body).toEqual({ displayName: 'V', bio: 'hi' });
  });

  it('no flags is USAGE before any wallet or network work', async () => {
    const s = stub(() => json(500, {}));
    const p = provider();
    await expect(
      runProfileSet({}, makeCtx(), deps(s.fetch, { provider: p.provider })),
    ).rejects.toMatchObject({ code: 'USAGE' });
    expect(s.calls).toHaveLength(0);
    expect(p.signCount()).toBe(0);
  });

  it('an empty value is USAGE, not a request that clears the field', async () => {
    const s = stub(() => json(200, {}));
    await expect(runProfileSet({ bio: '  ' }, makeCtx(), deps(s.fetch))).rejects.toMatchObject({
      code: 'USAGE',
      message: expect.stringContaining('--bio'),
    });
    expect(s.calls).toHaveLength(0);
  });

  it('surfaces the server warnings (unclaimed-handle nudge) on the receipt', async () => {
    const s = stub(() =>
      json(200, {
        address: ADDRESS,
        creator: { ...CREATOR, handle: null },
        warnings: ['Claim a handle so your pieces show a name.'],
      }),
    );
    const res = await runProfileSet({ bio: 'x' }, makeCtx(), deps(s.fetch));
    expect((res.data as { warnings: string[] }).warnings).toEqual([
      'Claim a handle so your pieces show a name.',
    ]);
    expect(res.humanLines?.at(-1)).toContain('Note: Claim a handle');
  });

  it('a rejected handle is PUBLISH_FAILED carrying the server message and field', async () => {
    const s = stub(() =>
      json(400, {
        error: {
          code: 'validation_failed',
          message: 'Invalid request body',
          details: { fieldErrors: { handle: ['that handle is reserved'] } },
        },
      }),
    );
    let err: unknown;
    try {
      await runProfileSet({ handle: 'tenjin' }, makeCtx(), deps(s.fetch));
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).code).toBe('PUBLISH_FAILED');
    expect((err as CliError).message).toContain('(handle)');
  });

  it('a taken handle (409) names the remedy', async () => {
    const s = stub(() =>
      json(409, { error: { code: 'handle_taken', message: 'Handle is taken' } }),
    );
    await expect(runProfileSet({ handle: 'iris' }, makeCtx(), deps(s.fetch))).rejects.toMatchObject(
      {
        code: 'PUBLISH_FAILED',
        message: 'Handle is taken',
        fix: expect.stringContaining('taken or cooling down'),
      },
    );
  });
});

describe('tenjin stats', () => {
  it('reads GET /api/me/stats signed and formats the earnings in USD', async () => {
    const s = stub(() =>
      json(200, { earningsThisMonth: '1250000', readsThisMonth: 7, glancesThisMonth: 40 }),
    );
    const res = await runStats(makeCtx(), deps(s.fetch));
    expect(s.calls[0]?.url).toBe('https://preview.example/api/me/stats');
    expect(s.calls[0]?.headers).toHaveProperty('sign-in-with-x');
    expect(res.data).toEqual({
      address: ADDRESS,
      earningsThisMonth: '1250000',
      earningsThisMonthUsd: '1.25',
      readsThisMonth: 7,
      glancesThisMonth: 40,
    });
    expect(res.humanLines?.join('\n')).toContain('earnings: $1.25');
  });

  it('a 401 the auth cannot recover is a read-class error, not exit 4', async () => {
    const s = stub(() => json(401, { error: { code: 'unauthenticated', message: 'nope' } }));
    await expect(runStats(makeCtx(), deps(s.fetch))).rejects.toMatchObject({
      code: 'API_UNREACHABLE',
    });
  });
});

describe('team shelf', () => {
  /** No --base-url flag: an override yields no bypass pair and so no team mode. */
  function teamCtx(): CommandContext {
    const sink = () => ({ write: () => true }) as unknown as NodeJS.WritableStream;
    return {
      flags: { json: true, timeout: 5000 },
      dataDir: dir,
      io: { stdout: sink(), stderr: sink(), isTTY: false },
    };
  }

  it('every account request to the shelf origin carries the bypass header', async () => {
    await writeFile(
      join(dir, 'config.json'),
      JSON.stringify({
        baseUrl: 'https://team.example',
        publicShelfUrl: 'https://public.example',
        shelfBypassSecret: 'secret-123',
      }),
    );
    const s = stub((c) =>
      c.url.endsWith('/stats')
        ? json(200, { earningsThisMonth: '0', readsThisMonth: 0, glancesThisMonth: 0 })
        : json(200, { address: ADDRESS, creator: CREATOR }),
    );
    await runProfileShow(teamCtx(), deps(s.fetch));
    await runProfileSet({ handle: 'v' }, teamCtx(), deps(s.fetch));
    await runStats(teamCtx(), deps(s.fetch));
    expect(s.calls).toHaveLength(3);
    for (const c of s.calls) {
      expect(new URL(c.url).origin).toBe('https://team.example');
      expect(c.headers[SHELF_BYPASS_HEADER]).toBe('secret-123');
    }
  });
});
