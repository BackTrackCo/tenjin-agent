import { constants } from 'node:fs';
import { open, realpath, stat, type FileHandle } from 'node:fs/promises';

/**
 * Raised when a pathname resolves to a device, pipe, directory, socket, or any
 * other non-regular filesystem object.
 */
export class NotRegularFileError extends Error {
  constructor(readonly path: string) {
    super(`${JSON.stringify(path)} is not a regular file.`);
    this.name = 'NotRegularFileError';
  }
}

/**
 * Read one UTF-8 regular file without ever streaming a device or waiting on a
 * FIFO.
 *
 * Resolve ordinary symlinks first, then stat and open that resolved target with
 * O_NOFOLLOW. The pathname check avoids opening objects already known to be
 * special; O_NOFOLLOW stops a final-component swap back to a symlink (including
 * an fd alias), and O_NONBLOCK makes the open safe if the target is swapped for
 * a FIFO instead. The descriptor check is still authoritative: reading by
 * pathname after checking it would reintroduce the race. Windows has no
 * equivalent FIFO pathname and treats the two flags as zero.
 */
export async function readRegularUtf8File(path: string): Promise<string> {
  const resolved = await realpath(path);
  if (!(await stat(resolved)).isFile()) throw new NotRegularFileError(path);

  const handle: FileHandle = await open(
    resolved,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
  );
  try {
    if (!(await handle.stat()).isFile()) throw new NotRegularFileError(path);
    return await handle.readFile({ encoding: 'utf8' });
  } finally {
    await handle.close().catch(() => undefined);
  }
}
