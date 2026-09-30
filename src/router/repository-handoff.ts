import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { z } from 'zod';
import { writeFileAtomicExclusive } from '../lib/atomic-json';
import {
  bindJevgrepOffer,
  readJevgrepBinding,
  type JevgrepBinding,
  type JevgrepGrant,
} from './jevgrep/grants';

export const REPOSITORY_HANDOFF_PENDING_MS = 120_000;
export const REPOSITORY_HANDOFF_RUNNING_MS = 20 * 60_000;
const PRIVATE = { mode: 0o600, dirMode: 0o700 };
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const Id = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/);
const Time = z.number().int().nonnegative();
const ScopeSchema = z.strictObject({
  sessionId: z.string().min(1).max(200),
  repositoryTurn: z.string().regex(/^[a-f0-9]{64}$/),
  snapshotCommit: z.string().regex(/^[a-f0-9]{40}$/),
  root: z.string().min(1).max(4096).refine(isAbsolute),
  grantId: z.string().uuid(),
});
type SavedScope = z.infer<typeof ScopeSchema>;
const OfferSchema = ScopeSchema.extend({
  version: z.literal(2),
  id: Id,
  createdAt: Time,
  expiresAt: Time,
}).refine((value) => value.expiresAt - value.createdAt === REPOSITORY_HANDOFF_PENDING_MS);
type Offer = z.infer<typeof OfferSchema>;
const StartedSchema = z
  .strictObject({
    version: z.literal(1),
    id: Id,
    owner: z.uuid(),
    startedAt: Time,
    expiresAt: Time,
  })
  .refine((value) => value.expiresAt - value.startedAt === REPOSITORY_HANDOFF_RUNNING_MS);
const FinishedSchema = z.strictObject({
  version: z.literal(1),
  id: Id,
  owner: z.uuid(),
  finishedAt: Time,
});

export interface RepositoryHandoffScope {
  sessionId: string;
  repositoryTurn: string;
  snapshotCommit: string;
  grant: JevgrepGrant;
}
export interface RepositoryHandoffState {
  status: 'none' | 'pending' | 'running' | 'finished' | 'expired' | 'unavailable';
  id?: string;
}

function savedScope(scope: RepositoryHandoffScope): SavedScope {
  return ScopeSchema.parse({
    sessionId: scope.sessionId,
    repositoryTurn: scope.repositoryTurn,
    snapshotCommit: scope.snapshotCommit,
    root: scope.grant.root,
    grantId: scope.grant.id,
  });
}
function paths(dataDir: string, scope: SavedScope) {
  const dir = join(dataDir, 'jevgrep', 'repository-hooks', hash(scope.sessionId));
  return {
    offer: join(dir, `offer-${scope.repositoryTurn}.json`),
    started: join(dir, `started-${scope.repositoryTurn}.json`),
    finished: join(dir, `finished-${scope.repositoryTurn}.json`),
  };
}
function sameScope(a: SavedScope, b: SavedScope): boolean {
  return (
    a.sessionId === b.sessionId &&
    a.repositoryTurn === b.repositoryTurn &&
    a.snapshotCommit === b.snapshotCommit &&
    a.root === b.root &&
    a.grantId === b.grantId
  );
}
function bindingMatches(binding: JevgrepBinding | null, offer: Offer): boolean {
  return binding !== null && binding.id === offer.id && sameScope(binding as SavedScope, offer);
}

/** Read only bounded, private, owned regular files; never follow a marker symlink. */
async function readPrivate(path: string): Promise<unknown | null> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const info = await handle.stat();
    if (
      !info.isFile() ||
      info.size > 8192 ||
      (info.mode & 0o077) !== 0 ||
      (process.getuid && info.uid !== process.getuid())
    )
      throw new Error('Invalid handoff state');
    const buffer = Buffer.alloc(8193);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > 8192) throw new Error('Invalid handoff state');
    return JSON.parse(buffer.subarray(0, bytesRead).toString('utf8')) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  } finally {
    await handle?.close();
  }
}

async function readState(dataDir: string, scope: SavedScope): Promise<RepositoryHandoffState> {
  const file = paths(dataDir, scope);
  const raw = await readPrivate(file.offer);
  if (raw === null) return { status: 'none' };
  // Legacy markers deliberately remain native fallback; never replace them.
  const offer = OfferSchema.parse(raw);
  if (!sameScope(offer, scope)) return { status: 'unavailable' };
  const binding = await readJevgrepBinding(dataDir, offer.id);
  if (!bindingMatches(binding, offer)) return { status: 'unavailable' };
  const startedRaw = await readPrivate(file.started);
  const finishedRaw = await readPrivate(file.finished);
  if (startedRaw !== null) {
    const started = StartedSchema.parse(startedRaw);
    if (started.id !== offer.id) return { status: 'unavailable' };
    if (finishedRaw !== null) {
      const finished = FinishedSchema.parse(finishedRaw);
      if (finished.id !== offer.id || finished.owner !== started.owner)
        return { status: 'unavailable' };
      return { status: 'finished', id: offer.id };
    }
    return { status: started.expiresAt <= Date.now() ? 'expired' : 'running', id: offer.id };
  }
  if (finishedRaw !== null) return { status: 'unavailable' };
  return {
    status:
      offer.expiresAt <= Date.now() || binding!.expiresAt <= Date.now() ? 'expired' : 'pending',
    id: offer.id,
  };
}

export async function readRepositoryHandoff(
  dataDir: string,
  scope: RepositoryHandoffScope,
): Promise<RepositoryHandoffState> {
  try {
    return await readState(dataDir, savedScope(scope));
  } catch {
    return { status: 'unavailable' };
  }
}

/** Publish authority first, then the ready offer. Concurrent publishers reuse the winner. */
export async function publishRepositoryHandoff(
  dataDir: string,
  scope: RepositoryHandoffScope,
  id: string,
): Promise<RepositoryHandoffState> {
  try {
    const saved = savedScope(scope);
    Id.parse(id);
    const previous = await readState(dataDir, saved);
    if (previous.status !== 'none') return previous;
    try {
      await bindJevgrepOffer(dataDir, id, scope.sessionId, scope.grant, {
        repositoryTurn: scope.repositoryTurn,
        snapshotCommit: scope.snapshotCommit,
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const binding = await readJevgrepBinding(dataDir, id);
      if (!binding || !sameScope(binding as SavedScope, saved) || binding.expiresAt <= Date.now())
        return { status: 'unavailable' };
    }
    const now = Date.now();
    const offer: Offer = {
      ...saved,
      version: 2,
      id,
      createdAt: now,
      expiresAt: now + REPOSITORY_HANDOFF_PENDING_MS,
    };
    try {
      await writeFileAtomicExclusive(paths(dataDir, saved).offer, JSON.stringify(offer), PRIVATE);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    return await readState(dataDir, saved);
  } catch {
    return { status: 'unavailable' };
  }
}

export type RepositoryHandoffRequest =
  | { status: 'skip' }
  | { status: 'blocked'; reason: string }
  | { status: 'owned'; signal: AbortSignal; finish: () => Promise<void> };

/** A visible request owns completion, including refusal before the executor runs.
 * These records coordinate fallback only; existing grant and paid claims still gate spend. */
export async function beginRepositoryHandoffRequest(
  dataDir: string,
  cwd: string,
  id: string | undefined,
): Promise<RepositoryHandoffRequest> {
  const blocked = (reason: string): RepositoryHandoffRequest => ({ status: 'blocked', reason });
  try {
    const binding = await readJevgrepBinding(dataDir, id);
    if (!binding?.repositoryTurn || !binding.snapshotCommit) return { status: 'skip' };
    if ((await realpath(cwd)) !== binding.root)
      return blocked('This retrieval offer belongs to another repository. Use native tools.');
    const scope = ScopeSchema.parse({
      sessionId: binding.sessionId,
      repositoryTurn: binding.repositoryTurn,
      snapshotCommit: binding.snapshotCommit,
      root: binding.root,
      grantId: binding.grantId,
    });
    const state = await readState(dataDir, scope);
    if (state.id !== id || state.status !== 'pending')
      return blocked(
        state.status === 'running' && state.id === id
          ? 'This repository retrieval is already running. Wait for its result; do not retry it.'
          : 'This repository retrieval offer is unavailable, expired, or already attempted. Use native tools.',
      );
    const file = paths(dataDir, scope);
    const offer = OfferSchema.parse(await readPrivate(file.offer));
    if (offer.id !== id || !sameScope(offer, scope))
      return blocked('This repository retrieval offer changed. Use native tools.');
    const pendingExpiresAt = Math.min(offer.expiresAt, binding.expiresAt);
    const now = Date.now();
    const started = {
      version: 1,
      id,
      owner: randomUUID(),
      startedAt: now,
      expiresAt: now + REPOSITORY_HANDOFF_RUNNING_MS,
    };
    try {
      await writeFileAtomicExclusive(file.started, JSON.stringify(started), PRIVATE);
    } catch {
      return blocked(
        'This repository retrieval was already claimed or is unavailable. Do not retry it.',
      );
    }
    const finish = async () => {
      // Only this invocation can finish this owner. A duplicate never reaches this closure.
      try {
        const current = StartedSchema.parse(await readPrivate(file.started));
        if (current.owner !== started.owner || current.id !== id) return;
        await writeFileAtomicExclusive(
          file.finished,
          JSON.stringify({ version: 1, id, owner: started.owner, finishedAt: Date.now() }),
          PRIVATE,
        );
      } catch {
        // Never replay a request to repair state. The running lease bounds fallback delay.
      }
    };
    // A paused writer cannot revive an offer after the hook released native fallback.
    if (Date.now() >= pendingExpiresAt || Date.now() >= started.expiresAt) {
      await finish();
      return blocked('This repository retrieval offer expired before admission. Use native tools.');
    }
    return {
      status: 'owned',
      signal: AbortSignal.timeout(Math.max(0, started.expiresAt - Date.now())),
      finish,
    };
  } catch {
    return blocked('This repository retrieval state is unavailable. Use native tools.');
  }
}
