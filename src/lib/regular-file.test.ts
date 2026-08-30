import { execFile } from 'node:child_process';
import { constants, existsSync, fstatSync } from 'node:fs';
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
