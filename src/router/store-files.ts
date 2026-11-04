import { constants } from 'node:fs';
import { open, opendir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { writeFileAtomic } from '../lib/atomic-json';

/**
 * The file mechanics the router's state stores share (`progress`,
 * `notice-markers`, `alive`, `router-memo`, `job-store`): each keeps one
 * directory under the data dir, names files by a hashed key, and ages them out
 * on its own lifetime. The write, read and sweep live here; contents, names
 * and lifetimes stay in each store.
 *
 * Hook-safe: node and `lib/atomic-json` only, since most of the stores load on
 * every prompt (`dist-chunks.test.ts` pins that graph).
 */

/** A store file is the user's alone: 0600, in a directory made 0700. */
export const PRIVATE = { mode: 0o600, dirMode: 0o700 } as const;

/**
 * Write `data` to `path` at {@link PRIVATE} through an atomic rename, which
 * replaces a planted symlink rather than writing through it: a reader sees the
 * old file or the whole new one, never a torn one. Throws.
 */
export async function writePrivate(path: string, data: string): Promise<void> {
  await writeFileAtomic(path, data, PRIVATE);
}

/**
 * One bounded JSON object, or null: absent, not a regular file, over
 * `maxBytes`, damaged, or not an object. `O_NOFOLLOW` because these files live
 * under a directory the user can write: a symlink planted here must not turn a
 * read into a read of something else. Never throws.
 */
export async function readJsonFile(
  path: string,
  maxBytes: number,
): Promise<Record<string, unknown> | null> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => undefined);
  if (file === undefined) return null;
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > maxBytes) return null;
    const buffer = Buffer.alloc(maxBytes + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await file.read(buffer, length, buffer.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > maxBytes) return null;
    const parsed: unknown = JSON.parse(buffer.subarray(0, length).toString('utf8'));
    return parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)
      ? null
      : (parsed as Record<string, unknown>);
  } catch {
    return null;
  } finally {
    await file.close().catch(() => undefined);
  }
}

/**
 * Remove every entry of `dir` that `expired` says has outlived its store's
 * lifetime: its regular files, or with `directories` its subdirectories, each
 * removed whole. An `expired` that rejects keeps the entry. `limit` ends the
 * pass after that many entries of any kind, so a directory flooded past what
 * its store ever writes is never walked in full. Never throws.
 */
export async function sweep(
  dir: string,
  expired: (name: string, path: string) => Promise<boolean>,
  opts: { limit?: number; directories?: boolean } = {},
): Promise<void> {
  const directories = opts.directories === true;
  try {
    let seen = 0;
    for await (const entry of await opendir(dir)) {
      if (opts.limit !== undefined && ++seen > opts.limit) return;
      if (!(directories ? entry.isDirectory() : entry.isFile())) continue;
      const path = join(dir, entry.name);
      if (await expired(entry.name, path).catch(() => false)) {
        await rm(path, { recursive: directories, force: true }).catch(() => undefined);
      }
    }
  } catch {
    // Housekeeping only. Nothing downstream depends on it having run.
  }
}
