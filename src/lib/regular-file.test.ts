import { execFile } from 'node:child_process';
import { constants, existsSync, fstatSync, realpathSync } from 'node:fs';
import { mkdtemp, mkdir, open, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NotRegularFileError, readRegularUtf8File } from './regular-file';

const execFileAsync = promisify(execFile);

describe('readRegularUtf8File', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'tenjin-regular-file-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('reads ordinary files and symlinks that still resolve to ordinary files', async () => {
    const file = join(dir, 'finding.md');
    const link = join(dir, 'finding-link.md');
    await writeFile(file, '# Finding\n\nEvidence.\n');
    await symlink(file, link);

    await expect(readRegularUtf8File(file)).resolves.toBe('# Finding\n\nEvidence.\n');
    await expect(readRegularUtf8File(link)).resolves.toBe('# Finding\n\nEvidence.\n');
  });

  it('rejects directories and character devices without reading them', async () => {
    const directory = join(dir, 'directory.md');
    await mkdir(directory);

    await expect(readRegularUtf8File(directory)).rejects.toBeInstanceOf(NotRegularFileError);
    if (process.platform !== 'win32' && existsSync('/dev/null')) {
      await expect(readRegularUtf8File('/dev/null')).rejects.toBeInstanceOf(NotRegularFileError);

      const link = join(dir, 'device-link.md');
      await symlink('/dev/null', link);
      await expect(readRegularUtf8File(link)).rejects.toBeInstanceOf(NotRegularFileError);
    }
  });

  /**
   * PLATFORM-DEPENDENT, and the guard says so rather than pretending otherwise.
   * `readRegularUtf8File` calls `realpath` first. On macOS `/dev/fd/0` resolves
   * to itself, so the stat sees a non-regular file and raises the error below.
   * On Linux the same alias resolves to `pipe:[N]`, which is not a pathname, so
   * realpath throws ENOENT and this assertion never gets its turn.
   *
   * The refusal is safe on both: nothing is consumed either way. Only the error
   * TYPE differs, so the case is skipped where realpath cannot resolve the alias
   * instead of asserting a class that platform cannot produce. This ran green in
   * CI for months only because the worker's fd 0 was a regular file and the
   * `isFile()` guard returned early; a new test file changed that and the case
   * started failing on its Linux behaviour.
   */
  it.skipIf(process.platform === 'win32')(
    'rejects an fd alias to non-regular stdin without consuming it',
    async () => {
      if (fstatSync(0).isFile()) return;
      const alias = existsSync('/dev/fd/0')
        ? '/dev/fd/0'
        : existsSync('/proc/self/fd/0')
          ? '/proc/self/fd/0'
          : null;
      if (alias === null) return;
      // Linux: realpath gives `pipe:[N]`, so the refusal arrives as ENOENT.
      try {
        realpathSync(alias);
      } catch {
        return;
      }

      await expect(readRegularUtf8File(alias)).rejects.toBeInstanceOf(NotRegularFileError);
    },
  );

  it.skipIf(process.platform === 'win32')(
    'rejects a FIFO without waiting for a writer',
    async () => {
      const fifo = join(dir, 'finding.fifo');
      await execFileAsync('mkfifo', [fifo]);

      // Keep a non-blocking peer open so even a regression to a pathname read can
      // be released and fail this assertion instead of wedging the test worker.
      const peer = await open(fifo, constants.O_RDWR | (constants.O_NONBLOCK ?? 0));
      const release = setTimeout(() => void peer.close().catch(() => undefined), 50);
      try {
        await expect(readRegularUtf8File(fifo)).rejects.toBeInstanceOf(NotRegularFileError);
      } finally {
        clearTimeout(release);
        await peer.close().catch(() => undefined);
      }
    },
  );
});
