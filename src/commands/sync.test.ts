import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSync } from './sync';
import { openStore, projectId, STORE_SQL } from '../lib/state-store';
import { teamCoarseKey } from '../lib/state-store';
import { testSigner } from '../lib/read-test-utils';
import type { WalletProvider, TenjinSigner } from '../lib/wallet';
import { CliError } from '../lib/errors';
import type { CommandContext } from '../context';

/**
 * `tenjin sync` (tenjin-agent#212 PR B, "Automatic sync"): a real HTTP stub
 * stands in for the shelf, and pairings are seeded straight into the state
 * store (as the failure arm and its close rule would have left them) rather
 * than driven through the hook scripts, which is what push-scripts.test.ts and
 * hook-scripts.test.ts already cover end to end.
 */

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tenjin-sync-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const TEAM = 'https://team.example';
const PUBLIC = 'https://public.example';
const SECRET = 'shelf-secret-abc123';

async function writeTeamConfig(): Promise<void> {
  await writeFile(
    join(dir, 'config.json'),
    JSON.stringify({ baseUrl: TEAM, publicShelfUrl: PUBLIC, shelfBypassSecret: SECRET }),
  );
}

function ctx(): CommandContext {
  const sink = () => ({ write: () => true }) as unknown as NodeJS.WritableStream;
  return {
    flags: { json: true, timeout: 5000 },
    dataDir: dir,
    io: { stdout: sink(), stderr: sink(), isTTY: false },
  };
}

/** A pairing row inserted the way `openPairing` (push-scripts.ts) would leave
 *  one, then updated to whatever status/synced_at this test wants — mirrors
 *  the raw-SQL seeding push.test.ts already uses for the same table. */
async function seedPairing(opts: {
  cwd: string;
  key: string;
  coarseKey?: string | null;
  cmdHead?: string;
  cmd?: string;
  errorLine?: string;
  errorFiles?: string[];
  fixCmd?: string;
  fixFiles?: string[];
  pkgVersions?: Record<string, string>;
  scope?: string;
  status?: string;
  syncedAt?: number | null;
  closedAt?: number | null;
}): Promise<number> {
  const store = await openStore(dir);
  if (store === null) throw new Error('no store');
  const project = projectId(opts.cwd);
  const uid = `pair-${Math.random().toString(36).slice(2)}`;
  const at = Date.now() - 60_000;
  store.run(STORE_SQL.insertPairing, [
    uid,
    at,
    'sess-a',
    project,
    'machine-a',
    'sig_v1',
    opts.key,
    opts.coarseKey ?? null,
    opts.cmdHead ?? 'pnpm',
    opts.cmd ?? 'pnpm test',
    opts.errorLine ?? 'Error: ENOENT: no such file or directory',
    JSON.stringify(opts.errorFiles ?? ['widget.ts']),
    JSON.stringify(opts.pkgVersions ?? {}),
    opts.scope ?? 'code',
  ]);
  const row = store.get('SELECT id FROM pairings WHERE uid = ?', [uid]) as { id: number };
  store.run(
    `UPDATE pairings SET status = ?, closes = 1, closed_at = ?, synced_at = ?, fix_cmd = ?, fix_files = ?
       WHERE id = ?`,
    [
      opts.status ?? 'unverified',
      opts.closedAt ?? at + 1000,
      opts.syncedAt ?? null,
      opts.fixCmd ?? 'pnpm test',
      JSON.stringify(opts.fixFiles ?? ['widget.ts']),
      row.id,
    ],
  );
  store.close();
  return row.id;
}

async function pairingRow(id: number): Promise<Record<string, unknown>> {
  const store = await openStore(dir);
  if (store === null) throw new Error('no store');
  const row = store.get('SELECT * FROM pairings WHERE id = ?', [id]) as Record<string, unknown>;
  store.close();
  return row;
}

function spyProvider(signer: TenjinSigner = testSigner()): {
  provider: WalletProvider;
  getSignerCount: () => number;
} {
  let n = 0;
  return {
    getSignerCount: () => n,
    provider: {
      id: 'local',
      describe: async () => ({
        address: signer.address,
        provider: 'local',
        credentialSource: 'file',
        policyEnforcement: 'client-only',
      }),
      getSigner: async () => {
        n += 1;
        return signer;
      },
      diagnostics: async () => ({ warnings: [] }),
    },
  };
}

/** A provider whose signer never resolves: the non-interactive "no passphrase
 *  available" shape `passphrase.ts` throws when the keychain is locked and
 *  nothing (env, cache) can supply it headlessly. */
function lockedProvider(): WalletProvider {
  return {
    id: 'local',
    describe: async () => ({
      address: testSigner().address,
      provider: 'local',
      credentialSource: 'file',
      policyEnforcement: 'client-only',
    }),
    getSigner: async () => {
      throw new CliError('USAGE', 'No wallet passphrase is available.');
    },
    diagnostics: async () => ({ warnings: [] }),
  };
}

interface Sent {
  method: string | undefined;
  url: string;
  body: Record<string, unknown> | undefined;
}

function shelfServer(
  respond: (sent: Sent) => { status: number; json: unknown } = (req) => ({
    // 201 for a create, 200 for a merge-update: what the shelf's routes return.
    status: req.method === 'PUT' ? 200 : 201,
    json: {
      id: '11111111-1111-4111-8111-111111111111',
      slug: 'fix-pnpm-test',
      title: 'Fix: pnpm — ENOENT',
      status: 'published',
      price: '0',
      url: `${TEAM}/a/team/fix-pnpm-test`,
      tags: [],
    },
  }),
): { fetch: typeof fetch; sent: Sent[] } {
  const sent: Sent[] = [];
  const fetchFn = (async (url: string | URL, init?: RequestInit) => {
    const entry: Sent = {
      method: init?.method,
      url: String(url),
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    };
    sent.push(entry);
    const { status, json } = respond(entry);
    return new Response(JSON.stringify(json), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return { fetch: fetchFn, sent };
}

describe('tenjin sync: team mode gate', () => {
  it('hard-refuses outside team mode', async () => {
    await writeFile(join(dir, 'config.json'), JSON.stringify({}));
    const { provider } = spyProvider();
    await expect(
      runSync(ctx(), { cwd: dir, provider, fetchImpl: shelfServer().fetch }),
    ).rejects.toMatchObject({ code: 'REFUSED', exitCode: 3 });
  });
});

describe('tenjin sync: publishing an unsynced code-scoped pairing', () => {
  it('POSTs a keyed, card-less, price-0 post and stamps synced_at + the post id', async () => {
    await writeTeamConfig();
    const id = await seedPairing({
      cwd: dir,
      key: 'fine-hash-abc',
      coarseKey: 'coarse-hash-def',
      cmdHead: 'pnpm',
      cmd: 'pnpm test',
      errorLine: 'Error: ENOENT: no such file or directory',
      errorFiles: ['widget.ts'],
      fixCmd: 'pnpm test',
      fixFiles: ['widget.ts'],
      pkgVersions: { zod: '4.1.0' },
      status: 'unverified',
    });
    const { provider, getSignerCount } = spyProvider();
    const { fetch, sent } = shelfServer();

    const result = await runSync(ctx(), { cwd: dir, provider, fetchImpl: fetch });

    expect(result.data).toMatchObject({ synced: 1, verified: 0, held: 0 });
    expect(sent).toHaveLength(1);
    const req = sent[0]!;
    expect(req.method).toBe('POST');
    expect(req.url).toBe(`${TEAM}/api/posts`);
    const body = req.body!;
    expect(body.price).toBe('0');
    expect(body.status).toBe('published');
    expect(body.resource).toBeUndefined();
    expect(typeof body.title).toBe('string');
    expect(body.title as string).toMatch(/^Fix: pnpm — /);
    expect((body.bodyMd as string).length).toBeLessThanOrEqual(300);
    expect(body.bodyMd as string).toContain('pkg: zod@4.1.0');

    // No .git in this tmpdir, so no repo origin: fine key + command_head, no
    // salted coarse key.
    const keys = body.keys as Array<{ kind: string; key: string; verified: boolean }>;
    expect(keys).toEqual([
      { kind: 'fingerprint', key: 'sig_v1:fine-hash-abc', verified: false },
      { kind: 'command_head', key: 'pnpm', verified: false },
    ]);

    // The wallet's signer is only touched once the session key actually needs
    // to sign something — not merely to describe the address.
    expect(getSignerCount()).toBeGreaterThan(0);

    const row = await pairingRow(id);
    expect(row.synced_at).not.toBeNull();
  });

  it('salts the coarse key with the repo origin when the checkout has one', async () => {
    await writeTeamConfig();
    const repoDir = join(dir, 'repo');
    await mkdir(join(repoDir, '.git'), { recursive: true });
    await writeFile(
      join(repoDir, '.git', 'config'),
      '[core]\n\tbare = false\n[remote "origin"]\n\turl = https://github.com/acme/widgets.git\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n',
    );
    await seedPairing({
      cwd: repoDir,
      key: 'fine-hash-xyz',
      coarseKey: 'coarse-hash-xyz',
      status: 'unverified',
    });
    const { provider } = spyProvider();
    const { fetch, sent } = shelfServer();

    await runSync(ctx(), { cwd: repoDir, provider, fetchImpl: fetch });

    const keys = sent[0]!.body!.keys as Array<{ kind: string; key: string }>;
    const expected =
      'sig_v1c:' + teamCoarseKey('coarse-hash-xyz', 'https://github.com/acme/widgets.git');
    expect(keys.some((k) => k.key === expected)).toBe(true);
  });

  it('sends verified:true on the keys when the pairing closed as verified', async () => {
    await writeTeamConfig();
    await seedPairing({ cwd: dir, key: 'fine-verified', status: 'verified' });
    const { provider } = spyProvider();
    const { fetch, sent } = shelfServer();

    await runSync(ctx(), { cwd: dir, provider, fetchImpl: fetch });

    const keys = sent[0]!.body!.keys as Array<{ kind: string; verified?: boolean }>;
    const fps = keys.filter((k) => k.kind === 'fingerprint');
    expect(fps.length).toBeGreaterThan(0);
    expect(fps.every((k) => k.verified === true)).toBe(true);
  });

  it('never sends a pairing outside code scope', async () => {
    await writeTeamConfig();
    await seedPairing({ cwd: dir, key: 'user-scoped', scope: 'user', status: 'unverified' });
    await seedPairing({
      cwd: dir,
      key: 'ambiguous-scoped',
      scope: 'ambiguous',
      status: 'unverified',
    });
    const { provider } = spyProvider();
    const { fetch, sent } = shelfServer();

    const result = await runSync(ctx(), { cwd: dir, provider, fetchImpl: fetch });

    expect(sent).toHaveLength(0);
    expect(result.data).toMatchObject({ synced: 0 });
  });
});

describe('tenjin sync: verified after an earlier sync', () => {
  it('PUTs verified:true and re-stamps synced_at, without a second POST', async () => {
    await writeTeamConfig();
    const past = Date.now() - 120_000;
    const id = await seedPairing({
      cwd: dir,
      key: 'fine-promoted',
      status: 'verified',
      syncedAt: past,
      closedAt: Date.now() - 1000, // AFTER syncedAt: the promotion happened later
    });
    // Seed the post-id mapping the earlier sync would have written.
    const store = await openStore(dir);
    if (store === null) throw new Error('no store');
    store.run(STORE_SQL.setState, [
      '',
      'pairing_post:' + id,
      JSON.stringify({
        postId: '44444444-4444-4444-8444-444444444444',
        origin: TEAM,
        at: past,
        own: true,
      }),
      past,
    ]);
    store.close();

    const { provider } = spyProvider();
    const { fetch, sent } = shelfServer();

    const result = await runSync(ctx(), { cwd: dir, provider, fetchImpl: fetch });

    expect(result.data).toMatchObject({ synced: 0, verified: 1 });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.method).toBe('PUT');
    expect(sent[0]!.url).toBe(`${TEAM}/api/posts/44444444-4444-4444-8444-444444444444`);
    const keys = sent[0]!.body!.keys as Array<{ kind: string; verified?: boolean }>;
    expect(keys.filter((k) => k.kind === 'fingerprint').every((k) => k.verified === true)).toBe(
      true,
    );

    const row = await pairingRow(id);
    expect(row.synced_at).not.toBe(past);
  });
});

describe("tenjin sync: a pairing closed beside a teammate's post", () => {
  /** The link the failure arm's team leg writes on a hit (no `own`), stamped
   *  with the close the way closePairing leaves it. */
  async function seedTeamLink(id: number, closedAt: number): Promise<void> {
    const store = await openStore(dir);
    if (store === null) throw new Error('no store');
    store.run(STORE_SQL.setState, [
      '',
      'pairing_post:' + id,
      JSON.stringify({
        postId: 'teammate-post-7',
        origin: TEAM,
        at: closedAt - 5000,
        closedAt,
        status: 'unverified',
        fixFiles: ['widget.ts'],
      }),
      closedAt,
    ]);
    store.close();
  }

  it("POSTs this machine's own record with verified keys and never PUTs on the teammate's post", async () => {
    await writeTeamConfig();
    const closedAt = Date.now() - 1000;
    const id = await seedPairing({
      cwd: dir,
      key: 'fine-second-close',
      status: 'unverified',
      closedAt,
    });
    await seedTeamLink(id, closedAt);
    const { provider } = spyProvider();
    const { fetch, sent } = shelfServer();

    const result = await runSync(ctx(), { cwd: dir, provider, fetchImpl: fetch });

    expect(result.data).toMatchObject({ synced: 1, verified: 0, held: 0, skipped: 0 });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.method).toBe('POST');
    expect(sent[0]!.url).toBe(`${TEAM}/api/posts`);
    const keys = sent[0]!.body!.keys as Array<{ kind: string; verified?: boolean }>;
    expect(keys.filter((k) => k.kind === 'fingerprint').every((k) => k.verified === true)).toBe(
      true,
    );

    const row = await pairingRow(id);
    expect(row.synced_at).not.toBeNull();
    const store = await openStore(dir);
    if (store === null) throw new Error('no store');
    const link = store.get(STORE_SQL.getState, ['', 'pairing_post:' + id]) as { value: string };
    store.close();
    expect(JSON.parse(link.value)).toMatchObject({
      postId: '11111111-1111-4111-8111-111111111111',
      own: true,
    });
  });

  it("is held, and the run continues, when the teammate's post already holds the key verified", async () => {
    await writeTeamConfig();
    const closedAt = Date.now() - 1000;
    const first = await seedPairing({
      cwd: dir,
      key: 'fine-held-second',
      status: 'unverified',
      closedAt,
    });
    await seedTeamLink(first, closedAt);
    const second = await seedPairing({ cwd: dir, key: 'fine-behind-it', status: 'unverified' });
    const { provider } = spyProvider();
    const { fetch, sent } = shelfServer((req) => {
      const keys = (req.body?.keys ?? []) as Array<{ key: string }>;
      if (keys.some((k) => k.key === 'sig_v1:fine-held-second')) {
        return {
          status: 400,
          json: {
            error: {
              message: 'validation failed',
              details: {
                fieldErrors: {
                  keys: ['fingerprint key is already verified on post teammate-post-7'],
                },
              },
            },
          },
        };
      }
      return {
        status: 201,
        json: {
          id: '22222222-2222-4222-8222-222222222222',
          slug: 's',
          title: 't',
          status: 'published',
          price: '0',
          url: `${TEAM}/a/t/s`,
          tags: [],
        },
      };
    });

    const result = await runSync(ctx(), { cwd: dir, provider, fetchImpl: fetch });

    expect(result.data).toMatchObject({ synced: 1, verified: 0, held: 1 });
    expect(sent).toHaveLength(2);
    expect((await pairingRow(first)).synced_at).not.toBeNull();
    expect((await pairingRow(second)).synced_at).not.toBeNull();
  });
});

describe('tenjin sync: a 404 on the update of our own post', () => {
  it('marks the row synced and skipped, and reaches the rows behind it', async () => {
    await writeTeamConfig();
    const past = Date.now() - 120_000;
    const gone = await seedPairing({
      cwd: dir,
      key: 'fine-gone',
      status: 'verified',
      syncedAt: past,
      closedAt: Date.now() - 1000,
    });
    const store = await openStore(dir);
    if (store === null) throw new Error('no store');
    store.run(STORE_SQL.setState, [
      '',
      'pairing_post:' + gone,
      JSON.stringify({
        postId: '55555555-5555-4555-8555-555555555555',
        origin: TEAM,
        at: past,
        own: true,
      }),
      past,
    ]);
    store.close();
    const behind = await seedPairing({ cwd: dir, key: 'fine-behind-404', status: 'unverified' });
    const { provider } = spyProvider();
    const { fetch, sent } = shelfServer((req) =>
      req.method === 'PUT'
        ? { status: 404, json: { error: { code: 'post_not_found', message: 'not found' } } }
        : {
            status: 201,
            json: {
              id: '33333333-3333-4333-8333-333333333333',
              slug: 's',
              title: 't',
              status: 'published',
              price: '0',
              url: `${TEAM}/a/t/s`,
              tags: [],
            },
          },
    );

    const result = await runSync(ctx(), { cwd: dir, provider, fetchImpl: fetch });

    expect(result.data).toMatchObject({ synced: 1, verified: 0, held: 0, skipped: 1, pending: 0 });
    expect(sent.map((r) => r.method)).toEqual(['PUT', 'POST']);
    expect((await pairingRow(gone)).synced_at).not.toBe(past);
    expect((await pairingRow(behind)).synced_at).not.toBeNull();
  });
});

describe('tenjin sync: the publish scan', () => {
  it('keeps a row whose body carries a credential on the machine, marked synced and skipped', async () => {
    await writeTeamConfig();
    const leaky = await seedPairing({
      cwd: dir,
      key: 'fine-leaky',
      cmd: 'AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE pnpm test',
      status: 'unverified',
    });
    const clean = await seedPairing({ cwd: dir, key: 'fine-clean', status: 'unverified' });
    const { provider } = spyProvider();
    const { fetch, sent } = shelfServer();

    const result = await runSync(ctx(), { cwd: dir, provider, fetchImpl: fetch });

    expect(result.data).toMatchObject({ synced: 1, skipped: 1, pending: 0 });
    expect(sent).toHaveLength(1);
    expect(JSON.stringify(sent[0]!.body)).not.toContain('AKIA');
    expect((await pairingRow(leaky)).synced_at).not.toBeNull();
    expect((await pairingRow(clean)).synced_at).not.toBeNull();
  });
});

describe('tenjin sync: an abort that is not a signing failure', () => {
  it('rethrows, leaves synced_at NULL, and records the error (not a code) on the events row', async () => {
    await writeTeamConfig();
    const id = await seedPairing({ cwd: dir, key: 'fine-outage', status: 'unverified' });
    const { provider } = spyProvider();
    const { fetch } = shelfServer(() => ({ status: 503, json: { error: 'down' } }));

    await expect(runSync(ctx(), { cwd: dir, provider, fetchImpl: fetch })).rejects.toBeInstanceOf(
      CliError,
    );

    expect((await pairingRow(id)).synced_at).toBeNull();
    const store = await openStore(dir);
    if (store === null) throw new Error('no store');
    const eventRow = store.get(
      "SELECT data FROM events WHERE hook = 'sync' ORDER BY at DESC LIMIT 1",
      [],
    ) as { data: string } | null;
    store.close();
    expect(eventRow).not.toBeNull();
    const data = JSON.parse(eventRow!.data) as Record<string, unknown>;
    expect(typeof data.error).toBe('string');
    expect(data.code).toBeUndefined();
  });
});

describe('tenjin sync: a verified-holder 400', () => {
  it('marks the row synced (never retried) and records the holder, without throwing', async () => {
    await writeTeamConfig();
    const id = await seedPairing({ cwd: dir, key: 'fine-collides', status: 'verified' });
    const { provider } = spyProvider();
    const { fetch, sent } = shelfServer(() => ({
      status: 400,
      json: {
        error: {
          message: 'validation failed',
          details: {
            fieldErrors: {
              keys: ['fingerprint key is already verified on post teammate-post-99'],
            },
          },
        },
      },
    }));

    const result = await runSync(ctx(), { cwd: dir, provider, fetchImpl: fetch });

    expect(sent).toHaveLength(1);
    expect(result.data).toMatchObject({ synced: 0, verified: 0, held: 1 });
    const row = await pairingRow(id);
    expect(row.synced_at).not.toBeNull();

    const store = await openStore(dir);
    if (store === null) throw new Error('no store');
    const link = store.get(STORE_SQL.getState, ['', 'pairing_post:' + id]) as {
      value: string;
    } | null;
    store.close();
    expect(link).not.toBeNull();
    expect(JSON.parse(link!.value)).toMatchObject({ postId: 'teammate-post-99', held: true });
  });
});

describe('tenjin sync: a signing failure', () => {
  it('exits with the coded error, leaves synced_at NULL, and writes an events row hook: sync', async () => {
    await writeTeamConfig();
    const id = await seedPairing({ cwd: dir, key: 'fine-locked', status: 'unverified' });
    const { fetch, sent } = shelfServer();

    await expect(
      runSync(ctx(), { cwd: dir, provider: lockedProvider(), fetchImpl: fetch }),
    ).rejects.toMatchObject({ code: 'PUBLISH_FAILED' });

    // Never reached the network: the signer failed before headersFor could sign.
    expect(sent).toHaveLength(0);

    const row = await pairingRow(id);
    expect(row.synced_at).toBeNull();

    const store = await openStore(dir);
    if (store === null) throw new Error('no store');
    const eventRow = store.get(
      "SELECT hook, data FROM events WHERE hook = 'sync' ORDER BY at DESC LIMIT 1",
      [],
    ) as { hook: string; data: string } | null;
    store.close();
    expect(eventRow).not.toBeNull();
    const data = JSON.parse(eventRow!.data) as { code: string };
    expect(data.code).toBe('USAGE');
  });
});

describe('tenjin sync: nothing to do', () => {
  it('is a no-op when there are no unsynced code-scoped pairings', async () => {
    await writeTeamConfig();
    const { provider } = spyProvider();
    const { fetch, sent } = shelfServer();

    const result = await runSync(ctx(), { cwd: dir, provider, fetchImpl: fetch });

    expect(sent).toHaveLength(0);
    expect(result.data).toMatchObject({ synced: 0, verified: 0, held: 0 });
  });
});
