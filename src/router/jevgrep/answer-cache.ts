import { constants } from 'node:fs';
import { lstat, mkdir, open, opendir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { writeFileAtomic } from '../../lib/atomic-json';
import { withFileLock } from '../../lib/lock';
import { canonicalHash } from '../../lib/request-schema';
import type { NpmRuntime } from '../local/npm-runtime';
import { JEV_MODEL, validateNativeRequest, validateNativeResponse } from './protocol';
import type { NativeEvaluationRequest, NativeEvaluationResponse } from './protocol';
import { jevgrepProfile, type JevgrepProfileId } from './profile';
import { JEVGREP_SUPPLIER, type JevgrepSupplier } from './supplier';

// Bump when snapshot admission or native evaluation semantics change. Runtime
// upgrades are independently isolated by their exact release/artifact identity.
const version = 1;
export const ANSWER_CACHE_LIMITS = {
  ttlMs: 7 * 24 * 60 * 60 * 1000,
  entries: 2048,
  bytes: 32 * 1024 * 1024,
  entryBytes: 64 * 1024,
} as const;
const entryName = /^[a-f0-9]{64}\.json$/;

export interface JevgrepAnswerCache {
  get(request: NativeEvaluationRequest): Promise<NativeEvaluationResponse | undefined>;
  put(request: NativeEvaluationRequest, response: NativeEvaluationResponse): Promise<void>;
}

/** A disposable answer cache, never a payment journal or a source of authority. */
export function createJevgrepAnswerCache(options: {
  dataDir: string;
  root: string;
  commit: string;
  query: string;
  runtime: NpmRuntime;
  profile?: JevgrepProfileId;
  supplier?: JevgrepSupplier;
  now?: () => number;
}): JevgrepAnswerCache {
  const policy = jevgrepProfile(options.profile);
  const directory = join(options.dataDir, 'jevgrep', 'answers');
  const now = options.now ?? Date.now;
  const namespace = {
    version,
    root: options.root,
    commit: options.commit,
    query: options.query,
    runtime:
      options.runtime.kind === 'release'
        ? { release: options.runtime.version }
        : { artifact: options.runtime.sha256 },
    snapshotLimits: policy.snapshot,
    // Keep existing standard entries readable; extended admission has its own identity.
    ...(policy.id === 'extended-v1'
      ? {
          profile: policy.id,
          limits: policy.limits,
          sourceBytes: policy.sourceBytes,
          searchTimeoutMs: policy.searchTimeoutMs,
        }
      : {}),
    supplier: options.supplier ?? JEVGREP_SUPPLIER,
  };
  const identity = (request: NativeEvaluationRequest) =>
    canonicalHash({ namespace, request: validateNativeRequest(request, policy.id) });

  async function prepare(create: boolean) {
    // The runner already validates dataDir before granting the child any source.
    // Refuse symlinks or loosened cache directories; never chmod an unknown path.
    for (const path of [join(options.dataDir, 'jevgrep'), directory]) {
      if (create)
        await mkdir(path, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== 'EEXIST') throw error;
        });
      const info = await lstat(path);
      if (
        !info.isDirectory() ||
        info.isSymbolicLink() ||
        (info.mode & 0o077) !== 0 ||
        (process.getuid && info.uid !== process.getuid())
      )
        throw new Error('Unsafe answer cache directory');
    }
  }

  async function get(request: NativeEvaluationRequest) {
    let file;
    try {
      const key = identity(request);
      await prepare(false);
      file = await open(
        join(directory, `${key}.json`),
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      const info = await file.stat();
      if (
        !info.isFile() ||
        (info.mode & 0o077) !== 0 ||
        (process.getuid && info.uid !== process.getuid()) ||
        info.size > ANSWER_CACHE_LIMITS.entryBytes
      )
        return undefined;
      const buffer = Buffer.alloc(ANSWER_CACHE_LIMITS.entryBytes + 1);
      let length = 0;
      while (length < buffer.length) {
        const part = await file.read(buffer, length, buffer.length - length, null);
        if (!part.bytesRead) break;
        length += part.bytesRead;
      }
      if (length > ANSWER_CACHE_LIMITS.entryBytes) return undefined;
      const entry = JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length)),
      ) as {
        version?: unknown;
        key?: unknown;
        createdAt?: unknown;
        scores?: unknown;
        hash?: unknown;
      };
      const ids = Object.keys(request.questions).sort();
      if (
        entry.version !== version ||
        entry.key !== key ||
        typeof entry.createdAt !== 'number' ||
        !Number.isSafeInteger(entry.createdAt) ||
        entry.createdAt > now() ||
        now() - entry.createdAt >= ANSWER_CACHE_LIMITS.ttlMs ||
        !Array.isArray(entry.scores) ||
        entry.scores.length !== ids.length ||
        !entry.scores.every((score) => Number.isFinite(score) && score >= 0 && score <= 1) ||
        entry.hash !== canonicalHash({ key, createdAt: entry.createdAt, scores: entry.scores })
      )
        return undefined;
      const scores: number[] = entry.scores;
      return validateNativeResponse(
        {
          model: JEV_MODEL,
          answers: Object.fromEntries(
            ids.map((id, index) => [id, { type: 'noul', noul: scores[index] }]),
          ),
          // No provider work occurred. Do not charge cached tokens to CLI pacing.
          usage: { input_tokens: 0, output_tokens: 0 },
        },
        request,
      );
    } catch {
      return undefined;
    } finally {
      await file?.close().catch(() => undefined);
    }
  }

  async function put(request: NativeEvaluationRequest, response: NativeEvaluationResponse) {
    try {
      const key = identity(request);
      const validated = validateNativeResponse(response, request);
      // Question IDs can contain arbitrary caller text. Store positions only;
      // sorted IDs are reconstructed from the exact, hashed request on a hit.
      const scores = Object.keys(request.questions)
        .sort()
        .map((id) => validated.answers[id]!.noul);
      const value = { key, createdAt: now(), scores };
      const encoded = JSON.stringify({ version, ...value, hash: canonicalHash(value) });
      if (Buffer.byteLength(encoded) > ANSWER_CACHE_LIMITS.entryBytes) return;
      await prepare(true);
      await withFileLock(
        join(directory, '.write.lock'),
        async () => {
          await prepare(false);
          if (await get(request)) return;
          const entries: Array<{ path: string; bytes: number; mtime: number }> = [];
          const scan = await opendir(directory);
          let seen = 0;
          for await (const item of scan) {
            // Bound scans even if someone populated this directory out of band.
            if (++seen > ANSWER_CACHE_LIMITS.entries * 2) return;
            if (!entryName.test(item.name)) continue;
            const path = join(directory, item.name);
            const info = await lstat(path);
            if (!info.isFile() || info.isSymbolicLink()) continue;
            // Keep an old target until the atomic replacement is published.
            if (item.name === `${key}.json`) continue;
            if (now() - info.mtimeMs >= ANSWER_CACHE_LIMITS.ttlMs) {
              await unlink(path);
              continue;
            }
            entries.push({ path, bytes: info.size, mtime: info.mtimeMs });
          }
          entries.sort((a, b) => a.mtime - b.mtime || a.path.localeCompare(b.path));
          let bytes = entries.reduce((total, entry) => total + entry.bytes, 0);
          while (
            entries.length >= ANSWER_CACHE_LIMITS.entries ||
            bytes + Buffer.byteLength(encoded) > ANSWER_CACHE_LIMITS.bytes
          ) {
            const oldest = entries.shift();
            if (!oldest) return;
            await unlink(oldest.path);
            bytes -= oldest.bytes;
          }
          await writeFileAtomic(join(directory, `${key}.json`), encoded, {
            mode: 0o600,
            dirMode: 0o700,
          });
        },
        { timeoutMs: 100 },
      );
    } catch {
      // Corruption, a full cache, a crashed writer's lock, or disk failure cannot
      // change the current answer or authorize a payment. A later run can miss.
    }
  }
  return { get, put };
}
