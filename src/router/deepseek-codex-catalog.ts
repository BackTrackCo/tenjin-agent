import catalog from './deepseek-codex-models.json';
import { readFile, lstat, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { writePrivate } from './store-files';

/** Flash metadata attribution and source/serialized hashes are in NOTICE.md. */
export async function nativeFlashCatalog(dataDir: string) {
  const bytes = JSON.stringify(catalog);
  const hash = createHash('sha256').update(bytes).digest('hex');
  const dir = join(dataDir, 'model-worker-catalogs');
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, `${hash}.json`);
  const state = await lstat(path).catch(() => null);
  if (state?.isSymbolicLink()) throw new Error('Native model catalog is not an owned file');
  if (state && (await readFile(path, 'utf8')) !== bytes)
    throw new Error('Native model catalog changed');
  if (!state) await writePrivate(path, bytes);
  return { path, hash };
}
