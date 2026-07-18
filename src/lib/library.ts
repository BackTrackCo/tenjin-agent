import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { writeFileAtomic } from './atomic-json';

/**
 * Local library delivery (spec 10): purchased or freely-read bodies are saved
 * under `<dataDir>/library/<resourceId>/<slug>.md` with a sidecar `receipt.json`
 * carrying the entitlement + payment identity. A `buy` on already-delivered
 * content re-delivers FROM DISK — the receipt is the local entitlement record, so
 * a repeat buy never re-pays and never re-fetches. `contentHash` is the sha256 the
 * outcome endpoint expects, computed over the exact saved bytes.
 */

export type Entitlement = 'free' | 'entitled' | 'purchased';

export const ReceiptSchema = z.object({
  schemaVersion: z.literal(1),
  resourceId: z.string(),
  slug: z.string(),
  title: z.string(),
  handle: z.string(),
  url: z.string(),
  priceAtomic: z.string(),
  entitlement: z.enum(['free', 'entitled', 'purchased']),
  contentHash: z.string(),
  settlementTxHash: z.string().optional(),
  savedAt: z.string(),
});
export type Receipt = z.infer<typeof ReceiptSchema>;

export function libraryDir(dataDir: string): string {
  return join(dataDir, 'library');
}

export function resourceDir(dataDir: string, resourceId: string): string {
  return join(libraryDir(dataDir), resourceId);
}

export function bodyPath(dataDir: string, resourceId: string, slug: string): string {
  return join(resourceDir(dataDir, resourceId), `${slug}.md`);
}

export function receiptPath(dataDir: string, resourceId: string): string {
  return join(resourceDir(dataDir, resourceId), 'receipt.json');
}

/** sha256 over the UTF-8 bytes of `bodyMd`, "sha256:<64 hex>" (server contract). */
export function contentHash(bodyMd: string): string {
  return `sha256:${createHash('sha256').update(bodyMd, 'utf8').digest('hex')}`;
}

export interface DeliveredResource {
  receipt: Receipt;
  bodyMd: string;
  bodyPath: string;
}

/** Return the on-disk delivery for a resource, or null when nothing is saved yet
 *  (or the sidecar is unreadable/corrupt — treated as absent, never a hard error). */
export async function findDelivered(
  dataDir: string,
  resourceId: string,
): Promise<DeliveredResource | null> {
  let receiptRaw: string;
  try {
    receiptRaw = await readFile(receiptPath(dataDir, resourceId), 'utf8');
  } catch {
    return null;
  }
  const parsed = ReceiptSchema.safeParse(safeJson(receiptRaw));
  if (!parsed.success) return null;
  const path = bodyPath(dataDir, resourceId, parsed.data.slug);
  let bodyMd: string;
  try {
    bodyMd = await readFile(path, 'utf8');
  } catch {
    return null;
  }
  return { receipt: parsed.data, bodyMd, bodyPath: path };
}

export interface SaveDeliveryInput {
  resourceId: string;
  slug: string;
  title: string;
  handle: string;
  url: string;
  priceAtomic: string;
  entitlement: Entitlement;
  bodyMd: string;
  settlementTxHash?: string;
}

export interface SavedDelivery {
  receipt: Receipt;
  bodyPath: string;
}

/** Persist the body + receipt atomically. Idempotent by path: re-saving the same
 *  resource overwrites the sidecar (e.g. a free read later becomes a purchase). */
export async function saveDelivery(
  dataDir: string,
  input: SaveDeliveryInput,
): Promise<SavedDelivery> {
  const path = bodyPath(dataDir, input.resourceId, input.slug);
  const receipt: Receipt = {
    schemaVersion: 1,
    resourceId: input.resourceId,
    slug: input.slug,
    title: input.title,
    handle: input.handle,
    url: input.url,
    priceAtomic: input.priceAtomic,
    entitlement: input.entitlement,
    contentHash: contentHash(input.bodyMd),
    ...(input.settlementTxHash !== undefined ? { settlementTxHash: input.settlementTxHash } : {}),
    savedAt: new Date().toISOString(),
  };
  await writeFileAtomic(path, input.bodyMd, { mode: 0o644, dirMode: 0o700 });
  await writeFileAtomic(
    receiptPath(dataDir, input.resourceId),
    `${JSON.stringify(receipt, null, 2)}\n`,
    { mode: 0o644, dirMode: 0o700 },
  );
  return { receipt, bodyPath: path };
}

export interface Heading {
  level: number;
  text: string;
}

/**
 * Deterministic ATX-heading outline for the stdout summary — never the body, so
 * agent transcripts stay small (spec 10). Skips fenced code blocks so a `#`
 * comment inside a code sample is not mistaken for a heading.
 */
export function headingOutline(bodyMd: string): Heading[] {
  const headings: Heading[] = [];
  let inFence = false;
  for (const line of bodyMd.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const m = /^(#{1,6})\s+(.*\S)\s*$/.exec(line);
    if (m && m[1] !== undefined && m[2] !== undefined) {
      headings.push({ level: m[1].length, text: m[2] });
    }
  }
  return headings;
}

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
