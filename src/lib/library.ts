import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { z } from 'zod';
import { CliError } from './errors';
import { writeFileAtomic } from './atomic-json';

/**
 * Filesystem identity is server-controlled (the read body's id + slug), so it is
 * hostile input to a path. resourceId must be a uuid and slug must match the
 * server's slug charset (lib/posts.ts slugify: lowercase a-z0-9 groups joined by
 * single hyphens, no leading/trailing hyphen, <=80 chars). This is the primary
 * guard; assertContained is the defense-in-depth backstop.
 */
const RESOURCE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Local library delivery (spec 10): purchased or freely-read bodies are saved
 * under `<dataDir>/library/<resourceId>/<slug>.md` with a sidecar `receipt.json`
 * carrying the entitlement + payment identity. A `buy` on already-delivered
 * content re-delivers FROM DISK, the receipt is the local entitlement record, so
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

/** True when `resourceId` is a uuid and `slug` matches the server's slug charset,
 *  so neither can carry a path separator or `..`. */
export function isSafeIdentity(resourceId: string, slug: string): boolean {
  return RESOURCE_ID_RE.test(resourceId) && slug.length <= 80 && SLUG_RE.test(slug);
}

/**
 * Defense-in-depth: refuse a delivery whose identity is malformed OR whose
 * resolved write path escapes the library root. A malicious server returning
 * id='../../etc' or slug='../../evil' is rejected as a contract violation before
 * any bytes (or directories) are written.
 */
function assertContained(dataDir: string, resourceId: string, slug: string): void {
  if (!isSafeIdentity(resourceId, slug)) {
    throw new CliError('CONTRACT_MISMATCH', 'The server returned an unsafe resource identity.', {
      fix: 'Update tenjin-cli or report the resource; the id/slug is not a valid identity.',
      details: { resourceId, slug },
    });
  }
  const root = resolve(libraryDir(dataDir));
  const target = resolve(bodyPath(dataDir, resourceId, slug));
  const rel = relative(root, target);
  if (rel.startsWith('..') || isAbsolute(rel) || rel.split(/[\\/]/).includes('..')) {
    throw new CliError('CONTRACT_MISMATCH', 'The delivery path escapes the library directory.', {
      fix: 'Update tenjin-cli; the resource identity is unsafe.',
    });
  }
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
 *  (or the sidecar is unreadable/corrupt, treated as absent, never a hard error). */
export async function findDelivered(
  dataDir: string,
  resourceId: string,
): Promise<DeliveredResource | null> {
  // A non-uuid resourceId can never have been a saved directory; treat it as
  // absent rather than probing an attacker-shaped path.
  if (!RESOURCE_ID_RE.test(resourceId)) return null;
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

/** The (handle, slug) a read URL points at, path-only so base-url/trailing-slash
 *  differences never matter. Null when the URL is not a read-route URL. */
export function parseReadPath(url: string): { handle: string; slug: string } | null {
  let pathname: string;
  try {
    pathname = new URL(url).pathname;
  } catch {
    return null;
  }
  const m = /\/api\/read\/([^/]+)\/([^/]+)\/?$/.exec(pathname);
  if (m === null || m[1] === undefined || m[2] === undefined) return null;
  return { handle: decodeURIComponent(m[1]), slug: decodeURIComponent(m[2]) };
}

/**
 * Find a delivered resource by its READ URL (handle/slug), for the double-pay
 * guard on a `buy <url>` where the resourceId isn't known up front. Scans the
 * library's receipts and matches on the URL's handle+slug path, so a repeat buy
 * of an owned resource re-delivers from disk before any network or payment.
 */
export async function findDeliveredByUrl(
  dataDir: string,
  url: string,
): Promise<DeliveredResource | null> {
  const target = parseReadPath(url);
  if (target === null) return null;
  let entries: string[];
  try {
    entries = await readdir(libraryDir(dataDir));
  } catch {
    return null;
  }
  for (const resourceId of entries) {
    if (!RESOURCE_ID_RE.test(resourceId)) continue;
    const delivered = await findDelivered(dataDir, resourceId);
    if (delivered === null) continue;
    const saved = parseReadPath(delivered.receipt.url);
    if (saved !== null && saved.handle === target.handle && saved.slug === target.slug) {
      return delivered;
    }
  }
  return null;
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
  assertContained(dataDir, input.resourceId, input.slug);
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
 * Deterministic ATX-heading outline for the stdout summary, never the body, so
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
