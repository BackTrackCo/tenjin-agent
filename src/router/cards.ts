import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, opendir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { writeFileAtomic } from '../lib/atomic-json';
import { OfferCardSchema, type OfferCard } from './decision';
import { EXPIRY_MS } from './progress';

/**
 * THE TOOL CARDS AN OFFER CARRIED, kept on this machine by the offer's id. The
 * hook that shows a line stores the card of every service the line names; the
 * `request` tool, which runs in the MCP server's own process and never sees
 * the hook, reads one back by the id the agent passes. One file per id, named
 * by the id's SHA-256, so a read is one open and needs no session.
 *
 * Best effort on the write, like every record the hooks keep: a card that
 * could not be stored is a `request({id})` that goes to the server the old
 * way. A card is the server's own answer, re-parsed on the way back in, and it
 * lives as long as an offer's footer record does.
 */

const CARDS_DIR = join('progress', 'cards');
/** A card holds a service's whole input schema; far larger than any record. */
const MAX_CARD_BYTES = 128 * 1024;
/** Above this many files the directory is not scanned for pruning. */
const MAX_CARDS = 512;

const digest = (value: string): string => createHash('sha256').update(value).digest('hex');

function cardPath(dataDir: string, id: string): string {
  return join(dataDir, CARDS_DIR, `${digest(id)}.json`);
}

/**
 * Store each card under its id, and drop expired ones. Never throws. Ages are
 * file mtimes, so they are read against the real clock, never a caller's.
 */
export async function storeCards(
  dataDir: string,
  cards: readonly OfferCard[] | undefined,
): Promise<void> {
  if (cards === undefined || cards.length === 0) return;
  for (const card of cards) {
    try {
      await writeFileAtomic(cardPath(dataDir, card.id), JSON.stringify(card), {
        mode: 0o600,
        dirMode: 0o700,
      });
    } catch {
      // The tool falls back to the server for this id.
    }
  }
  await pruneCards(dataDir, Date.now());
}

/** The card stored for this id, or null: none, expired, damaged or not ours. */
export async function readCard(dataDir: string, id: string): Promise<OfferCard | null> {
  const path = cardPath(dataDir, id);
  // O_NOFOLLOW: the directory is the user's, and a planted symlink must not
  // turn this read into a read of something else.
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => undefined);
  if (file === undefined) return null;
  try {
    const stat = await file.stat();
    if (Date.now() - stat.mtimeMs > EXPIRY_MS || stat.size > MAX_CARD_BYTES) return null;
    const parsed = OfferCardSchema.safeParse(JSON.parse(await file.readFile('utf8')));
    return parsed.success && parsed.data.id === id ? parsed.data : null;
  } catch {
    return null;
  } finally {
    await file.close().catch(() => undefined);
  }
}

async function pruneCards(dataDir: string, now: number): Promise<void> {
  try {
    const directory = await opendir(join(dataDir, CARDS_DIR));
    let count = 0;
    for await (const entry of directory) {
      if (++count > MAX_CARDS) return;
      if (!entry.isFile()) continue;
      const path = join(dataDir, CARDS_DIR, entry.name);
      const stat = await lstat(path).catch(() => undefined);
      if (stat === undefined || now - stat.mtimeMs > EXPIRY_MS) {
        await rm(path, { force: true }).catch(() => undefined);
      }
    }
  } catch {
    // Housekeeping only.
  }
}
