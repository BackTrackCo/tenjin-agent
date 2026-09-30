import { createHash } from 'node:crypto';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bindJevgrepOffer, readJevgrepBinding } from './jevgrep/grants';
import * as atomic from '../lib/atomic-json';
import {
  beginRepositoryHandoffRequest,
  publishRepositoryHandoff,
  readRepositoryHandoff,
  REPOSITORY_HANDOFF_PENDING_MS,
  REPOSITORY_HANDOFF_RUNNING_MS,
  type RepositoryHandoffScope,
} from './repository-handoff';

let dir: string;
let scope: RepositoryHandoffScope;
const ID = 'selected-offer';
const other = 'another-offer';
beforeEach(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), 'repository-handoff-')));
  const root = join(dir, 'repo');
  await mkdir(root);
  scope = {
    sessionId: 'fixture-session',
    repositoryTurn: 'a'.repeat(64),
    snapshotCommit: 'b'.repeat(40),
    grant: {
      version: 1,
      id: 'ac3cc90d-e45d-4c29-b39b-0b0579901278',
      enabled: true,
      root,
      source: 'committed-tracked',
      supplier: 'maple-jev',
      shareSource: true,
      maxRunAtomic: '1000000',
      runtime: { kind: 'release', version: '0.7.0' },
    },
  };
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});
function directory() {
  return join(
    dir,
    'jevgrep',
    'repository-hooks',
    createHash('sha256').update(JSON.stringify(scope.sessionId)).digest('hex'),
  );
}
function path(kind: string) {
  return join(directory(), `${kind}-${scope.repositoryTurn}.json`);
}
async function begin(id = ID, cwd = scope.grant.root) {
  return beginRepositoryHandoffRequest(dir, cwd, id);
}

describe('durable repository handoff', () => {
  it('publishes a private ready offer with a matching binding and no query or hints', async () => {
    expect(await readRepositoryHandoff(dir, scope)).toEqual({ status: 'none' });
    expect(await publishRepositoryHandoff(dir, scope, ID)).toEqual({ status: 'pending', id: ID });
    expect(await readJevgrepBinding(dir, ID)).toMatchObject({
      id: ID,
      repositoryTurn: scope.repositoryTurn,
      snapshotCommit: scope.snapshotCommit,
    });
    const saved = JSON.parse(await readFile(path('offer'), 'utf8')) as Record<string, unknown>;
    expect(Object.keys(saved).sort()).toEqual([
      'createdAt',
      'expiresAt',
      'grantId',
      'id',
      'repositoryTurn',
      'root',
      'sessionId',
      'snapshotCommit',
      'version',
    ]);
    expect((await stat(path('offer'))).mode & 0o777).toBe(0o600);
    expect(await readdir(directory())).toEqual([`offer-${scope.repositoryTurn}.json`]);
  });

  it('keeps the same selected offer across repeated publication', async () => {
    await publishRepositoryHandoff(dir, scope, ID);
    expect(await publishRepositoryHandoff(dir, scope, other)).toEqual({
      status: 'pending',
      id: ID,
    });
    expect(await readJevgrepBinding(dir, other)).toBeNull();
  });

  it.each([false, true])('concurrent publishers reuse one winner (same id: %s)', async (same) => {
    const states = await Promise.all([
      publishRepositoryHandoff(dir, scope, ID),
      publishRepositoryHandoff(dir, scope, same ? ID : other),
    ]);
    expect(states[0]).toEqual(states[1]);
    expect(states[0]?.status).toBe('pending');
    if (!same) {
      const loser = states[0]?.id === ID ? other : ID;
      expect((await begin(loser)).status).toBe('blocked');
      expect(await readRepositoryHandoff(dir, scope)).toEqual(states[0]);
    }
  });

  it('only the exclusive visible request owner can release native fallback', async () => {
    await publishRepositoryHandoff(dir, scope, ID);
    const requests = await Promise.all([begin(), begin()]);
    expect(requests.map((r) => r.status).sort()).toEqual(['blocked', 'owned']);
    expect(await readRepositoryHandoff(dir, scope)).toEqual({ status: 'running', id: ID });
    const owner = requests.find((r) => r.status === 'owned');
    if (owner?.status !== 'owned') throw new Error('missing owner');
    await owner.finish();
    await owner.finish();
    expect(await readRepositoryHandoff(dir, scope)).toEqual({ status: 'finished', id: ID });
    expect((await begin()).status).toBe('blocked');
    expect((await readdir(directory())).some((name) => /^(paid|snapshot)-/.test(name))).toBe(false);
  });

  it('expires an unattempted offer without admitting a late request or replacing it', async () => {
    const now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    await publishRepositoryHandoff(dir, scope, ID);
    clock.mockReturnValue(now + REPOSITORY_HANDOFF_PENDING_MS);
    expect(await readRepositoryHandoff(dir, scope)).toEqual({ status: 'expired', id: ID });
    expect((await begin()).status).toBe('blocked');
    expect(await publishRepositoryHandoff(dir, scope, other)).toEqual({
      status: 'expired',
      id: ID,
    });
    expect(await readJevgrepBinding(dir, other)).toBeNull();
    expect(await readdir(directory())).toEqual([`offer-${scope.repositoryTurn}.json`]);
  });

  it('keeps an admitted run live after binding expiry, then bounds interrupted fallback', async () => {
    const now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    await publishRepositoryHandoff(dir, scope, ID);
    expect((await begin()).status).toBe('owned');
    clock.mockReturnValue(now + 16 * 60_000);
    expect(await readRepositoryHandoff(dir, scope)).toEqual({ status: 'running', id: ID });
    clock.mockReturnValue(now + REPOSITORY_HANDOFF_RUNNING_MS);
    expect(await readRepositoryHandoff(dir, scope)).toEqual({ status: 'expired', id: ID });
    expect((await begin()).status).toBe('blocked');
  });

  it('cannot revive a pending offer when admission crosses its expiry', async () => {
    const now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    await publishRepositoryHandoff(dir, scope, ID);
    const write = atomic.writeFileAtomicExclusive;
    vi.spyOn(atomic, 'writeFileAtomicExclusive').mockImplementation(async (file, ...args) => {
      await write(file, ...args);
      if (file === path('started')) clock.mockReturnValue(now + REPOSITORY_HANDOFF_PENDING_MS);
    });
    expect((await begin()).status).toBe('blocked');
    expect(await readRepositoryHandoff(dir, scope)).toEqual({ status: 'finished', id: ID });
    expect((await readdir(directory())).some((name) => /^(paid|snapshot)-/.test(name))).toBe(false);
  });

  it('blocks another repository without completing the selected offer', async () => {
    await publishRepositoryHandoff(dir, scope, ID);
    expect((await begin(ID, dir)).status).toBe('blocked');
    expect(await readRepositoryHandoff(dir, scope)).toEqual({ status: 'pending', id: ID });
  });

  it.each(['root', 'grant', 'snapshot'] as const)('rejects changed %s scope', async (changed) => {
    await publishRepositoryHandoff(dir, scope, ID);
    const mismatch = {
      ...scope,
      grant: {
        ...scope.grant,
        ...(changed === 'root' ? { root: dir } : {}),
        ...(changed === 'grant' ? { id: '2ab5be33-a7e3-49ba-9a75-af54d26f8fba' } : {}),
      },
      ...(changed === 'snapshot' ? { snapshotCommit: 'c'.repeat(40) } : {}),
    };
    expect(await readRepositoryHandoff(dir, mismatch)).toEqual({ status: 'unavailable' });
    expect(await publishRepositoryHandoff(dir, mismatch, other)).toEqual({ status: 'unavailable' });
    expect(await readJevgrepBinding(dir, other)).toBeNull();
  });

  it('skips ordinary and prompt-only request IDs without altering them', async () => {
    expect(await beginRepositoryHandoffRequest(dir, scope.grant.root, undefined)).toEqual({
      status: 'skip',
    });
    expect(await begin()).toEqual({ status: 'skip' });
    await bindJevgrepOffer(dir, ID, scope.sessionId, scope.grant);
    expect(await begin()).toEqual({ status: 'skip' });
  });

  it('blocks an orphan repository binding that never published a ready offer', async () => {
    await bindJevgrepOffer(dir, ID, scope.sessionId, scope.grant, {
      repositoryTurn: scope.repositoryTurn,
      snapshotCommit: scope.snapshotCommit,
    });
    expect((await begin()).status).toBe('blocked');
    expect(await readRepositoryHandoff(dir, scope)).toEqual({ status: 'none' });
  });

  it.each(['legacy', 'corrupt', 'oversize', 'public', 'symlink'] as const)(
    'falls back on %s state without replacing or authorizing it',
    async (kind) => {
      await publishRepositoryHandoff(dir, scope, ID);
      if (kind === 'legacy') await writeFile(path('offer'), '{"version":1}');
      if (kind === 'corrupt') await writeFile(path('offer'), '{');
      if (kind === 'oversize') await writeFile(path('offer'), ' '.repeat(8193));
      if (kind === 'public') await chmod(path('offer'), 0o644);
      if (kind === 'symlink') {
        const elsewhere = join(dir, 'elsewhere.json');
        await writeFile(elsewhere, await readFile(path('offer')), { mode: 0o600 });
        await rm(path('offer'));
        await symlink(elsewhere, path('offer'));
      }
      expect(await readRepositoryHandoff(dir, scope)).toEqual({ status: 'unavailable' });
      expect(await publishRepositoryHandoff(dir, scope, other)).toEqual({ status: 'unavailable' });
      expect((await begin()).status).toBe('blocked');
      expect(await readJevgrepBinding(dir, other)).toBeNull();
    },
  );

  it('refuses binding collisions and does not publish incomplete authority', async () => {
    await bindJevgrepOffer(dir, ID, 'another-session', scope.grant, {
      repositoryTurn: scope.repositoryTurn,
      snapshotCommit: scope.snapshotCommit,
    });
    expect(await publishRepositoryHandoff(dir, scope, ID)).toEqual({ status: 'unavailable' });
    expect(await readRepositoryHandoff(dir, scope)).toEqual({ status: 'none' });
  });

  it('does not accept completion from a different owner', async () => {
    await publishRepositoryHandoff(dir, scope, ID);
    const request = await begin();
    if (request.status !== 'owned') throw new Error('missing owner');
    await writeFile(
      path('finished'),
      JSON.stringify({
        version: 1,
        id: ID,
        owner: '2ab5be33-a7e3-49ba-9a75-af54d26f8fba',
        finishedAt: Date.now(),
      }),
      { mode: 0o600 },
    );
    expect(await readRepositoryHandoff(dir, scope)).toEqual({ status: 'unavailable' });
    await request.finish();
    expect(await readRepositoryHandoff(dir, scope)).toEqual({ status: 'unavailable' });
  });
});
