import { readFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { writeFileAtomicExclusive } from '../../lib/atomic-json';
import { CliError } from '../../lib/errors';

export function reviewDir(dataDir: string): string {
  return join(dataDir, 'providers', 'rentahuman');
}
export async function privateDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
}
export async function readPrivate<T>(path: string, schema: z.ZodType<T>): Promise<T | undefined> {
  try {
    return schema.parse(JSON.parse(await readFile(path, 'utf8')));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new CliError(
      'REFUSED',
      'The saved human-review state cannot be read. Preserve it for recovery; no new payment was attempted.',
    );
  }
}
export async function savePrivate(path: string, value: unknown): Promise<void> {
  await writeFileAtomicExclusive(path, JSON.stringify(value), { mode: 0o600, dirMode: 0o700 });
}
