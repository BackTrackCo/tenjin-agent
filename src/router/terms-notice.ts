import { mkdir, open } from 'node:fs/promises';
import { join } from 'node:path';
import { hasCode } from '../lib/errno';
import { PRIVATE } from './store-files';

/**
 * THE ROUTING TERMS, TOLD ONCE AFTER THEY CHANGE. An install that approved
 * the $0.003 routing-fee ceiling hears the per-answer terms once, on its first
 * routing call after the update, in the hook's `systemMessage` or request
 * tool's summary. It is told, not asked: no stored or default spend limit
 * changes. An install whose person
 * approved limits on these terms is recorded as told, so it hears nothing.
 *
 * One file per terms id under `<dataDir>/router/terms`, made with an exclusive
 * create, so two legs at once tell it once between them.
 *
 * Hook-safe: node, `lib/errno` and `./store-files`.
 */

/** The terms this build states; new terms get a new id. */
const TERMS_ID = 'per-answer-quote';

/** What the person is told once. It names no rate and no command. */
export const TERMS_CHANGED_SENTENCE = `Tenjin's routing fee is now quoted for each answer, and offers show no fee. Your spend limits have not changed.`;

function marker(dataDir: string): string {
  return join(dataDir, 'router', 'terms', TERMS_ID);
}

/** Record the terms as told; true only for the caller that recorded them first. */
async function record(dataDir: string): Promise<boolean> {
  const path = marker(dataDir);
  await mkdir(join(dataDir, 'router', 'terms'), { recursive: true, mode: PRIVATE.dirMode });
  try {
    const file = await open(path, 'wx', PRIVATE.mode);
    await file.close();
    return true;
  } catch (err) {
    if (hasCode(err, 'EEXIST')) return false;
    throw err;
  }
}

/** The sentence for the first routing call that has not told it, else null.
 *  A store that cannot be written tells nothing. */
export async function termsNotice(dataDir: string): Promise<string | null> {
  return (await record(dataDir).catch(() => false)) ? TERMS_CHANGED_SENTENCE : null;
}

/** Install, once the person approved limits on these terms. Never throws. */
export async function recordTermsTold(dataDir: string): Promise<void> {
  await record(dataDir).catch(() => undefined);
}
