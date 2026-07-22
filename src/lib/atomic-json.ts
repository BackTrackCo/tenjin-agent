import { chmod, link, mkdir, open, rename, rm, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { basename, dirname, join } from 'node:path';

/** fs modes are no-ops on Windows; the 0600/0700 custody story does not apply. */
const isWindows = process.platform === 'win32';

export interface AtomicWriteOptions {
  /** Mode for the written file (ignored on win32). Default 0o644. */
  mode?: number;
  /** Mode for the parent dir when this call creates it (ignored on win32). Default 0o755. */
  dirMode?: number;
}

/**
 * Write `data` to `targetPath` atomically: a uniquely-named temp file is created
 * in the SAME directory (so the rename is atomic — a cross-filesystem rename is
 * not), given the final mode at open time, then renamed over the target. A
 * reader therefore sees either the old file or the fully-written new one, never
 * a partial write.
 *
 * The temp file is born with the caller's `mode` (0o600 for a wallet key) so the
 * bytes are never written through a world-readable descriptor; the follow-up
 * chmod only makes the mode exact under an unusual umask and only ever touches
 * the temp path, so the live target still appears atomically at its final mode.
 */
export async function writeFileAtomic(
  targetPath: string,
  data: string | Buffer,
  opts: AtomicWriteOptions = {},
): Promise<void> {
  const dir = dirname(targetPath);
  const fileMode = opts.mode ?? 0o644;
  const dirMode = opts.dirMode ?? 0o755;

  await mkdir(dir, { recursive: true, ...(isWindows ? {} : { mode: dirMode }) });

  const tmpPath = join(dir, `.${basename(targetPath)}.${randomBytes(6).toString('hex')}.tmp`);
  try {
    await writeFile(tmpPath, data, isWindows ? undefined : { mode: fileMode });
    if (!isWindows) await chmod(tmpPath, fileMode);
    await rename(tmpPath, targetPath);
  } catch (err) {
    await rm(tmpPath, { force: true }).catch(() => undefined);
    throw err;
  }
}

/**
 * Like {@link writeFileAtomic} but NO-CLOBBER and crash-durable: the commit fails
 * with `EEXIST` when `targetPath` already exists instead of replacing it, and the
 * new entry is fsynced before returning. This is what a wallet key needs — two
 * concurrent `create`/`import` runs must not both "succeed" and silently lose one
 * key; the loser gets a distinguishable EEXIST the wallet layer maps to
 * WALLET_EXISTS.
 *
 * The temp file is fsynced, then `link()` commits it — link is atomic and throws
 * EEXIST if the target already exists, so the check-then-write race is closed at
 * the filesystem, not by an earlier stat. The parent dir is then fsynced so the
 * new entry survives a crash. On win32, link semantics differ and a directory
 * cannot be fsynced, so we fall back to an exclusive `wx` open (still atomic
 * create-or-EEXIST, just not crash-durable — win32 has no 0600 custody story to
 * protect anyway).
 */
export async function writeFileAtomicExclusive(
  targetPath: string,
  data: string,
  opts: AtomicWriteOptions = {},
): Promise<void> {
  const dir = dirname(targetPath);
  const fileMode = opts.mode ?? 0o644;
  const dirMode = opts.dirMode ?? 0o755;

  await mkdir(dir, { recursive: true, ...(isWindows ? {} : { mode: dirMode }) });

  if (isWindows) {
    const handle = await open(targetPath, 'wx');
    try {
      await handle.writeFile(data);
      await handle.sync();
    } finally {
      await handle.close();
    }
    return;
  }

  const tmpPath = join(dir, `.${basename(targetPath)}.${randomBytes(6).toString('hex')}.tmp`);
  try {
    const handle = await open(tmpPath, 'wx', fileMode);
    try {
      await handle.writeFile(data);
      await handle.chmod(fileMode); // exact mode even under an unusual umask
      await handle.sync();
    } finally {
      await handle.close();
    }
    await link(tmpPath, targetPath); // atomic; throws EEXIST when the target exists
    await fsyncDir(dir);
  } finally {
    // On success the temp is now a redundant link to the target; on EEXIST it is
    // the orphaned write. Either way remove it before returning/throwing.
    await rm(tmpPath, { force: true }).catch(() => undefined);
  }
}

/** fsync a directory so a freshly linked entry is durable. Never called on win32. */
async function fsyncDir(dir: string): Promise<void> {
  const handle = await open(dir, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
