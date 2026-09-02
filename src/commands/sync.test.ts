import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSync } from './sync';
import {
  openStore,
  projectId,
  repoSlug,
  shortHash,
  teamCoarseKey,
  STORE_SQL,
} from '../lib/state-store';
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
  // EVERY TEST THAT PUBLISHES NEEDS A REMOTE (tenjin-agent#249). A checkout
  // with no `origin` is local-only — it publishes nothing and stamps nothing —
  // so the default fixture is a checkout that HAS one, and the tests that mean
  // to exercise the no-remote path run in a directory of their own.
  await writeGitOrigin(dir, 'https://github.com/acme/api.git');
});

/** A `.git/config` naming `origin`, in the two shapes git writes. */
async function writeGitOrigin(at: string, url: string): Promise<void> {
  await mkdir(join(at, '.git'), { recursive: true });
  await writeFile(
    join(at, '.git', 'config'),
    `[core]\n\tbare = false\n[remote "origin"]\n\turl = ${url}\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n`,
  );
}
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
  /** `'sig_v2'` (default, the error lane) or `'test'`. */
  kind?: string;
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
    opts.kind ?? 'sig_v2',
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

const FIX_ID = '11111111-1111-4111-8111-111111111111';

/** The shelf's fix store. By default every upsert CREATES (201) and every
 *  attest lands (201); a case that wants the holder rule, a 404 or a refusal
 *  passes its own responder. */
function shelfServer(
  respond: (sent: Sent) => { status: number; json: unknown } = (req) =>
    req.url.endsWith('/attest')
      ? { status: 201, json: { attestations: 2 } }
      : { status: 201, json: { fix: { id: FIX_ID }, created: true } },
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

describe('tenjin sync: upserting a fix record', () => {
  it('POSTs the fix payload — keys, files, head, versions — and stamps synced_at + the fix id', async () => {
    await writeTeamConfig();
    const id = await seedPairing({
      cwd: dir,
      key: 'fine-hash-abc',
      coarseKey: 'coarse-hash-def',
      cmdHead: 'pnpm',
      cmd: 'pnpm db:migrate',
      errorLine: 'Error: ENOENT: no such file or directory',
      errorFiles: ['widget.ts'],
      fixCmd: 'pnpm db:migrate',
      fixFiles: ['src/widget.ts'],
      pkgVersions: { zod: '4.1.0' },
      status: 'unverified',
    });
    const { provider, getSignerCount } = spyProvider();
    const { fetch, sent } = shelfServer();

    const result = await runSync(ctx(), { cwd: dir, provider, fetchImpl: fetch });

    expect(result.data).toMatchObject({ synced: 1, attested: 0, skipped: 0 });
    expect(sent).toHaveLength(1);
    const req = sent[0]!;
    expect(req.method).toBe('POST');
    expect(req.url).toBe(`${TEAM}/api/fixes`);
    const body = req.body!;

    // NO TITLE, NO BODY, NO PRICE, NO STATUS. A fix is a fact, not a piece:
    // the whole record is keys, files, the head that passed, and versions.
    expect(body).not.toHaveProperty('title');
    expect(body).not.toHaveProperty('bodyMd');
    expect(body).not.toHaveProperty('price');
    expect(body).not.toHaveProperty('status');
    expect(body.primary).toEqual({ kind: 'error', key: 'fine-hash-abc' });
    // THE SCOPE IS HASHED, never the cleartext `host/full/path`. The server
    // treats it as an opaque string and caps it at 64 characters; which forge,
    // org and repository a team's fixes come from is not its business.
    expect(body.repo).toBe(shortHash('github.com/acme/api'));
    expect(body.repo).not.toContain('acme');
    expect(body.repo).not.toContain('github');
    expect(body.cmdHead).toBe('pnpm');
    expect(body.fixFiles).toEqual(['src/widget.ts']);
    expect(body.passedOnHead).toBe('pnpm');
    expect(body.pkgVersions).toEqual({ zod: '4.1.0' });

    // THE COARSE KEY GOES OUT SALTED, beside the fine one, and the command head
    // rides along as metadata that is never itself a lookup key.
    expect(body.keys).toEqual([
      { kind: 'error', key: 'fine-hash-abc', tier: 'fine' },
      {
        kind: 'error',
        key: teamCoarseKey('coarse-hash-def', 'github.com/acme/api'),
        tier: 'coarse',
      },
      { kind: 'command_head', key: 'pnpm', tier: 'coarse' },
    ]);

    // The wallet's signer is only touched once the write actually needs to sign.
    expect(getSignerCount()).toBeGreaterThan(0);
    expect((await pairingRow(id)).synced_at).not.toBeNull();
  });

  /**
   * A `test`-lane row keys on the runner's own identity, and its coarse key —
   * file+suite — is LOCAL ONLY. Every failing test in a busy file shares it, so
   * on a shared shelf it would answer "somebody fixed something in this file"
   * to all of them; the resolve leg does not ask for it either, so the two
   * sides agree.
   */
  it('sends kind test and NO coarse key for a row the test lane opened', async () => {
    await writeTeamConfig();
    await seedPairing({
      cwd: dir,
      kind: 'test',
      key: 'test-fine-hash',
      coarseKey: 'test-coarse-hash',
      errorFiles: ['a.test.ts'],
      fixFiles: ['src/a.ts'],
      status: 'unverified',
    });
    const { provider } = spyProvider();
    const { fetch, sent } = shelfServer();

    const result = await runSync(ctx(), { cwd: dir, provider, fetchImpl: fetch });

    expect(result.data).toMatchObject({ synced: 1 });
    const body = sent[0]!.body!;
    expect(body.primary).toEqual({ kind: 'test', key: 'test-fine-hash' });
    expect(body.keys).toEqual([
      { kind: 'test', key: 'test-fine-hash', tier: 'fine' },
      { kind: 'command_head', key: 'pnpm', tier: 'coarse' },
    ]);
    expect(JSON.stringify(body.keys)).not.toContain('test-coarse-hash');
  });

  it('derives passedOnHead from the head of the fix command, never the whole line', async () => {
    await writeTeamConfig();
    await seedPairing({
      cwd: dir,
      key: 'fine-hash-head',
      fixCmd: 'cd / && pnpm vitest run src/x.test.ts | grep -B2 Error',
      status: 'unverified',
    });
    const { provider } = spyProvider();
    const { fetch, sent } = shelfServer();
    await runSync(ctx(), { cwd: dir, provider, fetchImpl: fetch });
    expect(sent[0]!.body!.passedOnHead).toBe('pnpm');
  });

  it('stamps the fix id onto the pairing_fix link as our own', async () => {
    await writeTeamConfig();
    const id = await seedPairing({ cwd: dir, key: 'fine-hash-url', status: 'unverified' });
    const { provider } = spyProvider();
    const { fetch } = shelfServer();

    await runSync(ctx(), { cwd: dir, provider, fetchImpl: fetch });

    const store = await openStore(dir);
    if (store === null) throw new Error('no store');
    const link = store.get(STORE_SQL.getState, ['', 'pairing_fix:' + id]) as { value: string };
    store.close();
    expect(JSON.parse(link.value)).toMatchObject({ fixId: FIX_ID, own: true });
  });

  /**
   * `created: false` is the server's holder rule answering: this machine
   * ALREADY holds this fix for this (kind, key, repo), and nothing changed. The
   * row is stamped either way — there is nothing left to do with it — and the
   * counter says what actually happened rather than claiming a new record.
   */
  it('counts a 200 created:false as skipped, not as newly recorded', async () => {
    await writeTeamConfig();
    const id = await seedPairing({ cwd: dir, key: 'fine-already-held', status: 'unverified' });
    const { provider } = spyProvider();
    const { fetch, sent } = shelfServer(() => ({
      status: 200,
      json: { fix: { id: FIX_ID }, created: false },
    }));

    const result = await runSync(ctx(), { cwd: dir, provider, fetchImpl: fetch });

    expect(sent).toHaveLength(1);
    expect(result.data).toMatchObject({ synced: 0, attested: 0, skipped: 1 });
    expect((await pairingRow(id)).synced_at).not.toBeNull();
  });

  it('never sends a pairing outside code scope, local-only rows included', async () => {
    await writeTeamConfig();
    await seedPairing({ cwd: dir, key: 'user-scoped', scope: 'user', status: 'unverified' });
    await seedPairing({ cwd: dir, key: 'amb-scoped', scope: 'ambiguous', status: 'unverified' });
    // The row a runner that named no test opens: it has no durable key at all,
    // so it must never reach the shelf.
    await seedPairing({
      cwd: dir,
      kind: 'test',
      key: 'local-only',
      scope: 'local',
      status: 'unverified',
    });
    const { provider } = spyProvider();
    const { fetch, sent } = shelfServer();

    const result = await runSync(ctx(), { cwd: dir, provider, fetchImpl: fetch });

    expect(sent).toHaveLength(0);
    expect(result.data).toMatchObject({ synced: 0, attested: 0 });
  });

  /** A fix record's whole payload is "these files changed"; one with an empty
   *  list asserts nothing a teammate could act on. */
  it('skips a row with no fix files rather than recording an empty payload', async () => {
    await writeTeamConfig();
    const id = await seedPairing({
      cwd: dir,
      key: 'fine-no-files',
      fixFiles: [],
      status: 'unverified',
    });
    const { provider } = spyProvider();
    const { fetch, sent } = shelfServer();

    const result = await runSync(ctx(), { cwd: dir, provider, fetchImpl: fetch });

    expect(sent).toHaveLength(0);
    expect(result.data).toMatchObject({ synced: 0, skipped: 1 });
    expect((await pairingRow(id)).synced_at).not.toBeNull();
  });
});

/**
 * A PAIRING THIS MACHINE CLOSED BESIDE A TEAMMATE'S FIX. That close is the
 * second, independent confirmation, and the shelf has no close endpoint — so
 * this machine ATTESTS to their record with its own fix files rather than
 * publishing a near-duplicate under its own name. Their fix is theirs: every
 * write route is owner-scoped.
 */
describe("tenjin sync: a pairing closed beside a teammate's fix", () => {
  async function seedTeammateLink(pairingId: number, over: Record<string, unknown> = {}) {
    const store = await openStore(dir);
    if (store === null) throw new Error('no store');
    store.run(STORE_SQL.setState, [
      '',
      'pairing_fix:' + pairingId,
      JSON.stringify({
        fixId: '99999999-9999-4999-8999-999999999999',
        origin: TEAM,
        at: Date.now(),
        closedAt: Date.now(),
        status: 'unverified',
        fixFiles: ['src/ours.ts'],
        ...over,
      }),
      Date.now(),
    ]);
    store.close();
  }

  it('POSTs an attestation with THIS machine’s fix files and never upserts', async () => {
    await writeTeamConfig();
    const id = await seedPairing({
      cwd: dir,
      key: 'fine-teammate',
      fixFiles: ['src/ours.ts'],
      status: 'unverified',
    });
    await seedTeammateLink(id);
    const { provider } = spyProvider();
    const { fetch, sent } = shelfServer();

    const result = await runSync(ctx(), { cwd: dir, provider, fetchImpl: fetch });

    expect(result.data).toMatchObject({ synced: 0, attested: 1, skipped: 0 });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.method).toBe('POST');
    expect(sent[0]!.url).toBe(`${TEAM}/api/fixes/99999999-9999-4999-8999-999999999999/attest`);
    expect(sent[0]!.body).toEqual({ fixFiles: ['src/ours.ts'] });
    expect((await pairingRow(id)).synced_at).not.toBeNull();
  });

  /** A 400 `self_attest` means the link is stale and the fix is in fact ours:
   *  nothing to do, and nothing to retry forever. */
  it('stamps and skips when the server says the fix is already ours', async () => {
    await writeTeamConfig();
    const id = await seedPairing({ cwd: dir, key: 'fine-self', status: 'unverified' });
    await seedTeammateLink(id);
    const { provider } = spyProvider();
    const { fetch, sent } = shelfServer(() => ({
      status: 400,
      json: { error: { code: 'self_attest' } },
    }));

    const result = await runSync(ctx(), { cwd: dir, provider, fetchImpl: fetch });

    expect(sent).toHaveLength(1);
    expect(result.data).toMatchObject({ synced: 0, attested: 0, skipped: 1 });
    expect((await pairingRow(id)).synced_at).not.toBeNull();
  });

  /** The fix is gone from the shelf (deleted, or the link is stale): attesting
   *  will 404 on every future run too, so one dead link must not block the
   *  queue behind it. */
  it('stamps and skips a 404, and reaches the rows behind it', async () => {
    await writeTeamConfig();
    const dead = await seedPairing({ cwd: dir, key: 'fine-dead', status: 'unverified' });
    await seedTeammateLink(dead);
    await seedPairing({ cwd: dir, key: 'fine-behind', status: 'unverified' });
    const { provider } = spyProvider();
    const { fetch, sent } = shelfServer((req) =>
      req.url.endsWith('/attest')
        ? { status: 404, json: { error: 'not_found' } }
        : { status: 201, json: { fix: { id: FIX_ID }, created: true } },
    );

    const result = await runSync(ctx(), { cwd: dir, provider, fetchImpl: fetch });

    expect(result.data).toMatchObject({ synced: 1, attested: 0, skipped: 1 });
    expect(sent.map((r) => r.url)).toEqual([
      `${TEAM}/api/fixes/99999999-9999-4999-8999-999999999999/attest`,
      `${TEAM}/api/fixes`,
    ]);
    expect((await pairingRow(dead)).synced_at).not.toBeNull();
  });
});

describe('tenjin sync: the repo salt', () => {
  /**
   * NO REMOTE, NO SHELF (tenjin-agent#249, owner decision). '' is what stands in
   * for a repo scope this checkout does not have, and it is not a salt.
   */
  it('records nothing and stamps nothing from a checkout with no origin', async () => {
    await writeTeamConfig();
    const bare = join(dir, 'bare');
    await mkdir(join(bare, '.git'), { recursive: true });
    await writeFile(join(bare, '.git', 'config'), '[core]\n\tbare = false\n');
    const id = await seedPairing({ cwd: bare, key: 'fine-hash-abc', status: 'unverified' });
    const { provider, getSignerCount } = spyProvider();
    const { fetch, sent } = shelfServer();

    const result = await runSync(ctx(), { cwd: bare, provider, fetchImpl: fetch });

    expect(sent).toHaveLength(0);
    expect(getSignerCount()).toBe(0);
    expect(result.data).toMatchObject({ synced: 0, attested: 0, skipped: 0, local: 1, pending: 0 });
    expect((await pairingRow(id)).synced_at).toBeNull();
  });

  it('salts the coarse key with the repo slug, never with the url', async () => {
    await writeTeamConfig();
    const repoDir = join(dir, 'repo');
    await writeGitOrigin(repoDir, 'https://github.com/acme/widgets.git');
    await seedPairing({
      cwd: repoDir,
      key: 'fine-hash-xyz',
      coarseKey: 'coarse-hash-xyz',
      status: 'unverified',
    });
    const { provider } = spyProvider();
    const { fetch, sent } = shelfServer();

    await runSync(ctx(), { cwd: repoDir, provider, fetchImpl: fetch });

    const keys = sent[0]!.body!.keys as Array<{ kind: string; key: string; tier: string }>;
    const coarse = keys.find((k) => k.kind === 'error' && k.tier === 'coarse')!.key;
    expect(coarse).toBe(teamCoarseKey('coarse-hash-xyz', 'github.com/acme/widgets'));
    expect(coarse).toBe(
      teamCoarseKey('coarse-hash-xyz', repoSlug('https://github.com/acme/widgets.git')),
    );
    expect(coarse).not.toBe(
      teamCoarseKey('coarse-hash-xyz', 'https://github.com/acme/widgets.git'),
    );
  });

  /** ⚠ THE SAME BOUND THE FAILURE ARM WALKS (`GIT_WALK_MAX`): two bounds meant
   *  a deep checkout read "no remote" in the hook and published here. */
  it('records from a checkout twenty directories below the repo root', async () => {
    await writeTeamConfig();
    const repoDir = join(dir, 'deep');
    await writeGitOrigin(repoDir, 'https://github.com/acme/deep.git');
    const deep = join(repoDir, ...Array.from({ length: 20 }, (_, i) => `d${i}`));
    await mkdir(deep, { recursive: true });
    await seedPairing({
      cwd: deep,
      key: 'fine-hash-deep',
      coarseKey: 'coarse-hash-deep',
      status: 'unverified',
    });
    const { provider } = spyProvider();
    const { fetch, sent } = shelfServer();

    const result = await runSync(ctx(), { cwd: deep, provider, fetchImpl: fetch });

    expect(result.data).toMatchObject({ synced: 1, local: 0 });
    const keys = sent[0]!.body!.keys as Array<{ key: string; tier: string }>;
    expect(
      keys.some((k) => k.key === teamCoarseKey('coarse-hash-deep', 'github.com/acme/deep')),
    ).toBe(true);
  });

  /** ⚠ THE SALT ITSELF STAYS CLEARTEXT. `teamCoarseKey` is mirrored in the
   *  generated hook, which salts with `originSlug(cwd)`; hashing one side and
   *  not the other would make every resolve query miss every fix, silently. */
  it('salts the coarse key with the cleartext slug even though the scope field is hashed', async () => {
    await writeTeamConfig();
    const repoDir = join(dir, 'salt-vs-scope');
    await writeGitOrigin(repoDir, 'https://github.com/acme/widgets.git');
    await seedPairing({
      cwd: repoDir,
      key: 'fine-scope',
      coarseKey: 'coarse-scope',
      status: 'unverified',
    });
    const { provider } = spyProvider();
    const { fetch, sent } = shelfServer();
    await runSync(ctx(), { cwd: repoDir, provider, fetchImpl: fetch });
    const body = sent[0]!.body!;
    const keys = body.keys as Array<{ kind: string; key: string; tier: string }>;
    const coarse = keys.find((k) => k.kind === 'error' && k.tier === 'coarse')!.key;
    expect(coarse).toBe(teamCoarseKey('coarse-scope', 'github.com/acme/widgets'));
    expect(coarse).not.toBe(teamCoarseKey('coarse-scope', shortHash('github.com/acme/widgets')));
    expect(body.repo).toBe(shortHash('github.com/acme/widgets'));
  });

  it('records the same coarse key from an ssh clone and an https clone', async () => {
    await writeTeamConfig();
    const keyFor = async (origin: string, key: string): Promise<string> => {
      const repoDir = join(dir, `clone-${key}`);
      await writeGitOrigin(repoDir, origin);
      await seedPairing({ cwd: repoDir, key, coarseKey: 'coarse-shared', status: 'unverified' });
      const { provider } = spyProvider();
      const { fetch, sent } = shelfServer();
      await runSync(ctx(), { cwd: repoDir, provider, fetchImpl: fetch });
      const keys = sent[0]!.body!.keys as Array<{ kind: string; key: string; tier: string }>;
      return keys.find((k) => k.kind === 'error' && k.tier === 'coarse')!.key;
    };
    const ssh = await keyFor('git@github.com:acme/widgets.git', 'fine-ssh');
    const https = await keyFor('https://github.com/acme/widgets', 'fine-https');
    const fork = await keyFor('git@github.com:fork/widgets.git', 'fine-fork');
    expect(ssh).toBe(https);
    expect(fork).not.toBe(ssh);
  });

  it('reads the rows of the checkout --cwd names, not the process working directory', async () => {
    await writeTeamConfig();
    const elsewhere = join(dir, 'elsewhere');
    await mkdir(elsewhere, { recursive: true });
    await seedPairing({ cwd: elsewhere, key: 'fine-elsewhere', status: 'unverified' });
    await seedPairing({ cwd: process.cwd(), key: 'fine-process-cwd', status: 'unverified' });
    const { provider } = spyProvider();
    const { fetch, sent } = shelfServer();

    const result = await runSync(ctx(), { cwd: elsewhere, provider, fetchImpl: fetch });

    expect(result.data).toMatchObject({ synced: 1 });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.body!.primary).toEqual({ kind: 'error', key: 'fine-elsewhere' });
  });

  it('scopes by the symlinked path it was given, not by the path it resolves to', async () => {
    await writeTeamConfig();
    const real = join(dir, 'real-checkout');
    const link = join(dir, 'linked-checkout');
    await mkdir(real, { recursive: true });
    await symlink(real, link);
    expect(await realpath(link)).toBe(await realpath(real));
    expect(projectId(link)).not.toBe(projectId(await realpath(link)));

    await seedPairing({ cwd: link, key: 'fine-symlinked', status: 'unverified' });
    const { provider } = spyProvider();
    const { fetch, sent } = shelfServer();

    const result = await runSync(ctx(), { cwd: link, provider, fetchImpl: fetch });

    expect(result.data).toMatchObject({ synced: 1 });
    expect(sent[0]!.body!.primary).toEqual({ kind: 'error', key: 'fine-symlinked' });
  });
});

/**
 * A 4xx THE SHELF MEANT. A refusal about the CONTENT of a row — a malformed
 * key, a payload the server will not take — refuses identically on every
 * future run, so leaving `synced_at` NULL blocks the rows behind it in
 * `ORDER BY at` AND keeps `countUnsyncedPairings` non-zero, which re-spawns a
 * sync at the end of every session for the life of the checkout. 429 is the one
 * 4xx that is about timing rather than about the row.
 */
describe('tenjin sync: a terminal refusal', () => {
  it('stamps a 400 as skipped, records it, and reaches the rows behind it', async () => {
    await writeTeamConfig();
    const bad = await seedPairing({ cwd: dir, key: 'fine-bad', status: 'unverified' });
    const good = await seedPairing({ cwd: dir, key: 'fine-good', status: 'unverified' });
    const { provider } = spyProvider();
    const { fetch, sent } = shelfServer((req) =>
      (req.body as { primary?: { key?: string } } | undefined)?.primary?.key === 'fine-bad'
        ? { status: 400, json: { error: { code: 'invalid_key' } } }
        : { status: 201, json: { fix: { id: FIX_ID }, created: true } },
    );

    const result = await runSync(ctx(), { cwd: dir, provider, fetchImpl: fetch });

    expect(sent).toHaveLength(2);
    expect(result.data).toMatchObject({ synced: 1, skipped: 1 });
    expect((await pairingRow(bad)).synced_at).not.toBeNull();
    expect((await pairingRow(good)).synced_at).not.toBeNull();

    const store = await openStore(dir);
    const row = store!.get(STORE_SQL.lastSyncEvent, []) as { data: string };
    store!.close();
    const data = JSON.parse(row.data) as { refused?: Array<{ id: number; status: number }> };
    expect(data.refused).toEqual([{ id: bad, status: 400 }]);
  });

  /** A 401 is the wallet or the session, not the row: every row behind it
   *  would be stamped synced without ever reaching the shelf. */
  it('does NOT stamp a 401, and aborts the run instead', async () => {
    await writeTeamConfig();
    const first = await seedPairing({ cwd: dir, key: 'fine-401-a', status: 'unverified' });
    const second = await seedPairing({ cwd: dir, key: 'fine-401-b', status: 'unverified' });
    const { provider } = spyProvider();
    const { fetch } = shelfServer(() => ({ status: 401, json: { error: 'unauthorized' } }));

    await expect(runSync(ctx(), { cwd: dir, provider, fetchImpl: fetch })).rejects.toMatchObject({
      code: 'PUBLISH_FAILED',
    });
    expect((await pairingRow(first)).synced_at).toBeNull();
    expect((await pairingRow(second)).synced_at).toBeNull();
  });

  it('does NOT stamp a 429, which is about timing and not about the row', async () => {
    await writeTeamConfig();
    const id = await seedPairing({ cwd: dir, key: 'fine-429', status: 'unverified' });
    const { provider } = spyProvider();
    const { fetch } = shelfServer(() => ({ status: 429, json: { error: 'rate_limited' } }));

    await expect(runSync(ctx(), { cwd: dir, provider, fetchImpl: fetch })).rejects.toMatchObject({
      code: 'RATE_LIMITED',
    });
    expect((await pairingRow(id)).synced_at).toBeNull();
  });
});

/**
 * ROWS FROM BEFORE THE LANE SPLIT never travel. `sig_v1` computed its signature
 * differently, and `sig_v1_test`'s coarse key is file+suite — a key every
 * failing test in that file shares, which the fallback would have offered to
 * the whole team as an `error` fine key.
 */
describe('tenjin sync: legacy pairing kinds', () => {
  it('stamps them synced without sending anything, and syncs the current ones beside them', async () => {
    await writeTeamConfig();
    const legacyError = await seedPairing({
      cwd: dir,
      kind: 'sig_v1',
      key: 'legacy-error',
      status: 'unverified',
    });
    const legacyTest = await seedPairing({
      cwd: dir,
      kind: 'sig_v1_test',
      key: 'legacy-test',
      coarseKey: 'legacy-file-suite',
      status: 'unverified',
    });
    const current = await seedPairing({ cwd: dir, key: 'fine-current', status: 'unverified' });
    const { provider } = spyProvider();
    const { fetch, sent } = shelfServer();

    const result = await runSync(ctx(), { cwd: dir, provider, fetchImpl: fetch });

    expect(sent).toHaveLength(1);
    expect(sent[0]!.body!.primary).toEqual({ kind: 'error', key: 'fine-current' });
    expect(JSON.stringify(sent)).not.toContain('legacy');
    expect(result.data).toMatchObject({ synced: 1 });
    // Off the queue, so the Stop hook stops counting them as work to do.
    expect((await pairingRow(legacyError)).synced_at).not.toBeNull();
    expect((await pairingRow(legacyTest)).synced_at).not.toBeNull();
    expect((await pairingRow(current)).synced_at).not.toBeNull();
  });
});

describe('tenjin sync: the publish scan', () => {
  it('keeps a row whose payload carries a credential on the machine, marked synced and skipped', async () => {
    await writeTeamConfig();
    const id = await seedPairing({
      cwd: dir,
      key: 'fine-secret',
      // The scan reads the PAYLOAD now — files, heads, versions — because there
      // is no rendered title or body any more.
      fixFiles: ['config/AKIAIOSFODNN7EXAMPLE.ts'],
      status: 'unverified',
    });
    const { provider } = spyProvider();
    const { fetch, sent } = shelfServer();

    const result = await runSync(ctx(), { cwd: dir, provider, fetchImpl: fetch });

    expect(sent).toHaveLength(0);
    expect(result.data).toMatchObject({ synced: 0, skipped: 1 });
    expect((await pairingRow(id)).synced_at).not.toBeNull();
  });
});

describe('tenjin sync: failures that stop the run', () => {
  it('rethrows a non-signing abort, leaves synced_at NULL, and records the error on the events row', async () => {
    await writeTeamConfig();
    const id = await seedPairing({ cwd: dir, key: 'fine-abort', status: 'unverified' });
    const { provider } = spyProvider();
    const { fetch } = shelfServer(() => ({ status: 503, json: { error: 'unavailable' } }));

    await expect(runSync(ctx(), { cwd: dir, provider, fetchImpl: fetch })).rejects.toMatchObject({
      code: 'PUBLISH_FAILED',
    });
    expect((await pairingRow(id)).synced_at).toBeNull();

    const store = await openStore(dir);
    const row = store!.get(STORE_SQL.lastSyncEvent, []) as { data: string };
    store!.close();
    const data = JSON.parse(row.data) as Record<string, unknown>;
    expect(data.error).toBe('PUBLISH_FAILED');
    expect(data.code).toBeUndefined();
  });

  it('exits with the coded error on a signing failure and writes an events row hook: sync', async () => {
    await writeTeamConfig();
    const id = await seedPairing({ cwd: dir, key: 'fine-signing', status: 'unverified' });
    const { fetch, sent } = shelfServer();

    await expect(
      runSync(ctx(), { cwd: dir, provider: lockedProvider(), fetchImpl: fetch }),
    ).rejects.toMatchObject({ code: 'PUBLISH_FAILED' });

    expect(sent).toHaveLength(0);
    expect((await pairingRow(id)).synced_at).toBeNull();
    const store = await openStore(dir);
    const row = store!.get(STORE_SQL.lastSyncEvent, []) as { data: string };
    store!.close();
    expect(JSON.parse(row.data)).toMatchObject({ code: 'USAGE' });
  });
});

describe('tenjin sync: nothing to do', () => {
  it('is a no-op when there are no unsynced code-scoped pairings', async () => {
    await writeTeamConfig();
    const { provider } = spyProvider();
    const { fetch, sent } = shelfServer();
    const result = await runSync(ctx(), { cwd: dir, provider, fetchImpl: fetch });
    expect(sent).toHaveLength(0);
    expect(result.data).toMatchObject({ synced: 0, attested: 0, skipped: 0 });
    expect(result.humanLines).toEqual(['Nothing to sync.']);
  });
});
