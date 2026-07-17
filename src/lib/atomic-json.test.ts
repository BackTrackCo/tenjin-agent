import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFileAtomic, writeFileAtomicExclusive } from './atomic-json';

const isWindows = process.platform === 'win32';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tenjin-aj-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('writeFileAtomic', () => {
  it('writes the complete file, creating parent dirs', async () => {
    const target = join(dir, 'nested', 'config.json');
    await writeFileAtomic(target, '{"a":1}\n');
    expect(await readFile(target, 'utf8')).toBe('{"a":1}\n');
  });

  it('leaves no temp file behind in the target dir', async () => {
    const target = join(dir, 'config.json');
    await writeFileAtomic(target, 'x');
    expect(await readdir(dir)).toEqual(['config.json']);
  });

  it('overwrites an existing file atomically', async () => {
    const target = join(dir, 'config.json');
    await writeFileAtomic(target, 'first');
    await writeFileAtomic(target, 'second');
    expect(await readFile(target, 'utf8')).toBe('second');
    expect(await readdir(dir)).toEqual(['config.json']);
  });

  it.skipIf(isWindows)('applies the requested 0600 file mode (wallet)', async () => {
    const target = join(dir, 'wallet.json');
    await writeFileAtomic(target, 'secret', { mode: 0o600 });
    expect((await stat(target)).mode & 0o777).toBe(0o600);
  });

  it.skipIf(isWindows)('defaults the file mode to 0644 (config)', async () => {
    const target = join(dir, 'config.json');
    await writeFileAtomic(target, 'x');
    expect((await stat(target)).mode & 0o777).toBe(0o644);
  });
});

describe('writeFileAtomicExclusive', () => {
  it('writes the complete file, creating parent dirs', async () => {
    const target = join(dir, 'nested', 'wallet.json');
    await writeFileAtomicExclusive(target, '{"a":1}\n');
    expect(await readFile(target, 'utf8')).toBe('{"a":1}\n');
  });

  it('refuses to clobber: second write EEXISTs, first content intact, no temp left', async () => {
    const target = join(dir, 'wallet.json');
    await writeFileAtomicExclusive(target, 'first', { mode: 0o600 });
    const err = (await writeFileAtomicExclusive(target, 'second').catch(
      (e) => e,
    )) as NodeJS.ErrnoException;
    expect(err.code).toBe('EEXIST');
    expect(await readFile(target, 'utf8')).toBe('first');
    // The clobber attempt leaves its temp behind neither on success nor on EEXIST.
    expect(await readdir(dir)).toEqual(['wallet.json']);
  });

  it.skipIf(isWindows)('applies the requested 0600 file mode (wallet)', async () => {
    const target = join(dir, 'wallet.json');
    await writeFileAtomicExclusive(target, 'secret', { mode: 0o600 });
    expect((await stat(target)).mode & 0o777).toBe(0o600);
    expect(await readdir(dir)).toEqual(['wallet.json']);
  });
});
