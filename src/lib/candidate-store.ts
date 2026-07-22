import { mkdir, readFile, readdir, rm } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { writeFileAtomic } from './atomic-json';
import { newId, UUID_RE } from './ids';

/**
 * The D40 candidate store: publish drafts parked locally that never touch the
 * network and never upload — only a later `tenjin publish --candidate <id>`
 * sends one, under the D38 consent scan. Each candidate is its OWN directory
 * `~/.tenjin/candidates/<id>/` holding the draft markdown plus a meta.json.
 *
 * Custody mirrors the wallet/lookup discipline: the candidates tree is 0700 and
 * every file 0600, written through writeFileAtomic so a reader sees a complete
 * file or none. Unlike lookup-store's single shared ledger, there is no shared
 * mutable file here — a fresh uuid per add means two concurrent adds land in two
 * distinct dirs and cannot contend — so no cross-process lock is needed. The
 * meta.json is written LAST and atomically, making it the commit point: `list`
 * skips any dir whose meta is absent or unreadable, so a torn or half-written
 * add reads as not-yet-there rather than a broken candidate, the same
 * best-effort posture loadLookups takes on a corrupt store.
 */

const DRAFT_FILE = 'draft.md';
const META_FILE = 'meta.json';

const CandidateMetaSchema = z.object({
  schemaVersion: z.literal(1),
  lookupId: z.string(),
  question: z.string().optional(),
  /** ISO-8601 creation time. */
  created: z.string(),
  /** The repo root the add ran in, or the cwd when not in a repo. */
  sourceProject: z.string(),
});
export type CandidateMeta = z.infer<typeof CandidateMetaSchema>;

export interface CandidateRecord {
  id: string;
  meta: CandidateMeta;
  /** Absolute path of the candidate directory. */
  dir: string;
  /** Absolute path of the draft markdown inside the directory. */
  draftPath: string;
}

export interface CreateCandidateInput {
  /** The draft markdown, copied verbatim into the candidate. */
  draft: string;
  lookupId: string;
  question?: string;
  /** ISO-8601 creation time; the command supplies it via its clock seam. */
  created: string;
  sourceProject: string;
}

function candidatesDir(dataDir: string): string {
  return join(dataDir, 'candidates');
}

function candidateDir(dataDir: string, id: string): string {
  return join(candidatesDir(dataDir), id);
}

/** Park a draft as a new candidate and return the created record. The meta.json
 *  is committed last (atomically), so the candidate is either fully present to
 *  `list`/`read` or absent, never half-there. */
export async function createCandidate(
  dataDir: string,
  input: CreateCandidateInput,
): Promise<CandidateRecord> {
  const id = newId();
  const dir = candidateDir(dataDir, id);
  await mkdir(dir, { recursive: true, mode: 0o700 });

  const draftPath = join(dir, DRAFT_FILE);
  await writeFileAtomic(draftPath, input.draft, { mode: 0o600, dirMode: 0o700 });

  const meta: CandidateMeta = {
    schemaVersion: 1,
    lookupId: input.lookupId,
    ...(input.question !== undefined ? { question: input.question } : {}),
    created: input.created,
    sourceProject: input.sourceProject,
  };
  await writeFileAtomic(join(dir, META_FILE), `${JSON.stringify(meta, null, 2)}\n`, {
    mode: 0o600,
    dirMode: 0o700,
  });

  return { id, meta, dir, draftPath };
}

/** One candidate by id, or null when it is unknown (or the id is malformed, so a
 *  stray argument can never traverse out of the store). */
export async function readCandidate(dataDir: string, id: string): Promise<CandidateRecord | null> {
  if (!UUID_RE.test(id)) return null;
  const dir = candidateDir(dataDir, id);
  const meta = await readMeta(dir);
  if (meta === null) return null;
  return { id, meta, dir, draftPath: join(dir, DRAFT_FILE) };
}

/** Every pending candidate, newest first by `created` (no auto-expiry — stale
 *  candidates stay visible, D40). Tie-broken on id so the order is total. */
export async function listCandidates(dataDir: string): Promise<CandidateRecord[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(candidatesDir(dataDir), { withFileTypes: true });
  } catch {
    return [];
  }
  const records: CandidateRecord[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !UUID_RE.test(entry.name)) continue;
    const record = await readCandidate(dataDir, entry.name);
    if (record !== null) records.push(record);
  }
  records.sort((a, b) => {
    if (a.meta.created !== b.meta.created) return a.meta.created < b.meta.created ? 1 : -1;
    return a.id < b.id ? 1 : -1;
  });
  return records;
}

/** Discard one candidate. Returns false when the id is unknown or malformed, so
 *  the command can surface a clean not-found; nothing is ever auto-deleted. */
export async function dropCandidate(dataDir: string, id: string): Promise<boolean> {
  if (!UUID_RE.test(id)) return false;
  const dir = candidateDir(dataDir, id);
  if ((await readMeta(dir)) === null) return false;
  await rm(dir, { recursive: true, force: true });
  return true;
}

/** Read and validate a candidate's meta.json; null on any absence/corruption. */
async function readMeta(dir: string): Promise<CandidateMeta | null> {
  let raw: string;
  try {
    raw = await readFile(join(dir, META_FILE), 'utf8');
  } catch {
    return null;
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }
  const parsed = CandidateMetaSchema.safeParse(json);
  return parsed.success ? parsed.data : null;
}
