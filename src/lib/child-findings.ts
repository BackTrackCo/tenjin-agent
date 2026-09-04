import { CliError } from './errors';
import { openStore, STORE_SQL, type Store } from './state-store';

/**
 * Reading the child-finding queue the `SubagentStop` harvest writes
 * (tenjin-agent#228).
 *
 * A finding is one `events` row under `hook = 'finding'` whose JSON `data`
 * carries the child's own words, the agent that produced them and the search the
 * ask was signalled by. The hook side reads it through the generated store
 * source; this is the same queue read from a CLI process, and it lives here
 * rather than in a command module because `publish --finding` is not the only
 * caller that will ever want it.
 *
 * READ-ONLY AND LOCAL: it opens no wallet, contacts no shelf and writes nothing.
 * What it hands back is a CHILD'S WORDS, which is data every caller has to frame
 * as a record rather than as instructions.
 */

/** The window a not-found error reports over, matching the capture ask's own so
 *  a finding and the ask that named it age out together. */
const FINDING_WINDOW_MS = 8 * 60 * 60 * 1000;

/** How many ids the not-found error names. Enough to recognise the one you
 *  meant, short enough to stay one line of a `fix`. */
const RECENT_ID_MAX = 10;

/** One queued finding, whole. `body` is bounded at capture
 *  (`PUSH_FINDING_MAX_CHARS`), not here: a body cut on the way out of the store
 *  would be a different finding from the one that was stored. */
export interface ChildFinding {
  id: string;
  /** When the harvest filed it, ISO-8601. */
  at: string;
  /** The harness session whose child wrote it. */
  session: string;
  /**
   * The project the child ran in (`events.project`), or null for a row written
   * with no cwd on the payload or by a build that did not carry it.
   *
   * WHY A PUBLISH PATH NEEDS IT. `publish.mode` resolves from the CURRENT
   * directory and this queue is machine-wide, so without it a finding harvested
   * in a private repo under `review` is publishable from an unrelated
   * `full-auto` checkout with nobody deciding to. Null reads as unknown, which
   * the publish gate treats as "not this project".
   */
  project: string | null;
  /** The subagent type, or null when the harness did not report one. */
  agentType: string | null;
  /** The harness's own id for the child. */
  agentId: string | null;
  /** The search whose open loop signalled the ask this finding answers. */
  searchId: string | null;
  /**
   * The child's own `# ` title line, split off the block at capture BEFORE the
   * body was flattened to one line (`splitFinding` in lib/push-scripts.ts).
   *
   * Null for a row a build older than tenjin-agent#228 PR 1 wrote, and for a
   * block whose first line was no title: {@link findingDocument} derives one
   * there without taking anything out of the body.
   */
  title: string | null;
  body: string;
}

async function withStore<T>(dataDir: string, fallback: T, fn: (store: Store) => T): Promise<T> {
  const store = await openStore(dataDir);
  if (store === null) return fallback;
  try {
    return fn(store);
  } finally {
    store.close();
  }
}

/**
 * A stored row read back defensively, field by field.
 *
 * The `data` column is JSON this build wrote, but an older build wrote some of
 * these rows and a newer one will write the next: a missing field reads as
 * absent rather than failing the caller, which is the same contract
 * `readLedgerTallies` holds to over the same tables.
 */
function rowToFinding(row: Record<string, unknown>): ChildFinding | null {
  if (typeof row.uid !== 'string' || row.uid === '') return null;
  let data: unknown;
  try {
    data = typeof row.data === 'string' ? JSON.parse(row.data) : null;
  } catch {
    return null;
  }
  if (data === null || typeof data !== 'object') return null;
  const fields = data as Record<string, unknown>;
  const at = typeof row.at === 'number' ? row.at : 0;
  return {
    id: row.uid,
    at: new Date(at).toISOString(),
    session: typeof row.session === 'string' ? row.session : '',
    project: typeof row.project === 'string' && row.project !== '' ? row.project : null,
    agentType:
      typeof fields.agentType === 'string' && fields.agentType !== '' ? fields.agentType : null,
    // THE COLUMN (tenjin-agent#247's store v2), not a `data` field. A row a
    // pre-v2 build wrote carries NULL here, which is the same "no agent named"
    // this parse has always reported.
    agentId: typeof row.agent_id === 'string' ? row.agent_id : null,
    searchId: typeof fields.searchId === 'string' ? fields.searchId : null,
    title: typeof fields.title === 'string' && fields.title !== '' ? fields.title : null,
    body: typeof fields.body === 'string' ? fields.body : '',
  };
}

/**
 * One finding by the id the capture ask printed, or a not-found error naming the
 * ids this machine actually holds.
 *
 * The ids are in the ERROR rather than behind a listing verb because that is the
 * only moment a caller needs them: it typed an id and was wrong, and the ask it
 * copied from is one paragraph back in a context that may already be gone.
 */
export async function readChildFinding(
  dataDir: string,
  id: string,
  now: () => number = Date.now,
  project: string | null = null,
): Promise<ChildFinding> {
  const row = await withStore<Record<string, unknown> | null>(dataDir, null, (store) =>
    store.get(STORE_SQL.findingByUid, [id]),
  );
  const finding = row === null ? null : rowToFinding(row);
  if (finding !== null) return finding;
  const known = await recentFindingIds(dataDir, now, project);
  throw new CliError('RESOURCE_NOT_FOUND', `No stored finding with id ${JSON.stringify(id)}`, {
    fix:
      known.length === 0
        ? 'No findings are held for this project. They are harvested from a subagent at its own end and need `hooks.capture` on (`tenjin push status`).'
        : `Captured in this project in the last ${FINDING_WINDOW_MS / (60 * 60 * 1000)}h: ${known.join(', ')}. That listing is what the window bounds; a finding itself is never rewritten and stays publishable by its own id, so an id that does not resolve is one this project never captured.`,
    details: { id, known },
  });
}

/**
 * The ids THIS PROJECT holds inside the capture window, newest first.
 *
 * DELIBERATELY IDS ONLY. Bodies are what a finding costs to carry, and the only
 * caller is an error line; handing back a body here would rebuild the listing
 * this queue deliberately does not have.
 *
 * AND DELIBERATELY NOT MACHINE-WIDE (round-3 item 5). The queue is machine-wide
 * and the capture ask marks which of its rows came from elsewhere, but this is
 * an error path reached by typing an id wrong: enumerating every checkout's
 * findings there hands one project a listing of another's work for the price of
 * a typo. A null project matches the rows that carry none.
 */
export async function recentFindingIds(
  dataDir: string,
  now: () => number = Date.now,
  project: string | null = null,
): Promise<string[]> {
  const since = now() - FINDING_WINDOW_MS;
  const rows = await withStore<Record<string, unknown>[]>(dataDir, [], (store) =>
    store.all(STORE_SQL.findingsRecent, [since, project, RECENT_ID_MAX]),
  );
  return rows
    .map(rowToFinding)
    .filter((f): f is ChildFinding => f !== null)
    .map((f) => f.id);
}

/** "fork subagent ad51a0bd, search 7777…" — how a finding's author is named
 *  wherever one is printed. A finding whose author is unknowable is one the
 *  reader cannot check. */
export function describeChildFinding(finding: ChildFinding): string {
  const who = finding.agentType === null ? 'a subagent' : `${finding.agentType} subagent`;
  const agent = finding.agentId === null ? '' : ` ${finding.agentId}`;
  const loop = finding.searchId === null ? '' : `, search ${finding.searchId}`;
  return `${who}${agent}${loop}`;
}

/**
 * How long a title may run, at capture and in the fallback below. Well under the
 * server's own 200, because a title cut at the limit reads as a truncation and a
 * short one reads as a title. Read by lib/push-scripts.ts, which substitutes it
 * into the generated subagent script, so the split and the fallback agree.
 */
export const FINDING_TITLE_MAX = 120;

/**
 * A stored finding as a Markdown document: `# <title>`, then the finding.
 *
 * THE TITLE IS THE CHILD'S, VERBATIM. The harvest splits the block's `# ` first
 * line off before it flattens the rest (`splitFinding` in lib/push-scripts.ts)
 * and stores it beside the body, so the ordinary path here is a join. Publishing
 * the stored body verbatim used to send the shelf no title at all and fail with
 * `USAGE: A published post needs a title`, which is what cost the one finding the
 * measured week its attribution: the parent republished from a file and
 * discarded the held id (tenjin-agent#228).
 *
 * THE FALLBACK NEVER REWRITES THE BODY (round-2 review, major 1). A row written
 * before the split existed, or one whose first line was no title, has the whole
 * finding on one line; a title is derived from its opening words and the BODY IS
 * PASSED THROUGH WHOLE. It has to be: the publish path's scan detectors are
 * line-scoped, so cutting the derived words out and splicing a blank line in
 * split one stored line into two and stopped a credential that spanned the cut
 * from being found. The derived title repeats the body's first words instead,
 * which costs a duplicated sentence and loses nothing.
 *
 * DERIVED, NEVER INVENTED: every character comes from the child's own words, in
 * their own order. A finding with nothing to derive from comes back untouched,
 * so the publish path refuses it exactly as it did before rather than publishing
 * under a title nobody wrote.
 */
export function findingDocument(finding: ChildFinding): string {
  const stored = (finding.title ?? '').trim();
  const body = finding.body.trim();
  if (stored !== '') return joinDocument(stored, body);
  // ALREADY A DOCUMENT, so nothing to do: a heading on its own line with a body
  // under it is what this function produces, and running it twice must not add a
  // second heading.
  if (/^#{1,6}[ \t]+\S[^\n]*\n[\s\S]*\S/.test(body)) return finding.body;
  const title = cutTitle(body);
  return isTitle(title) ? joinDocument(title, body) : finding.body;
}

/** A candidate title with a word in it. Punctuation alone is not a title, and
 *  a body that yields only punctuation is one to leave exactly as it is. */
function isTitle(candidate: string): boolean {
  return /[\p{L}\p{N}]/u.test(candidate);
}

/** `# <title>` and the body under it, or the title alone when there was no body
 *  to put under it. */
function joinDocument(title: string, rest: string): string {
  return rest === '' ? `# ${title}` : `# ${title}\n\n${rest}`;
}

/**
 * A title out of a one-line finding, taking nothing away from it.
 *
 * THE FIRST SENTENCE, with a word boundary as the backstop: a child that wrote
 * no sentence end, or one 400 characters in, still gets a title that reads like
 * one. A leading `#` marker is dropped because it is markup rather than a word.
 * The trailing full stop goes because this is a title now; a `?` or a `!` stays,
 * because a question is the shape half these findings answer.
 *
 * A SENTENCE END WITH NO LETTER BEFORE IT IS NOT ONE. `# 1. Pin the resolver`
 * flattened gives its first `.` after the list number, and cutting there
 * published the finding under the title `1`. The scan walks on to the next end
 * instead of trusting the first.
 */
function cutTitle(text: string): string {
  const line = text.slice(0, text.indexOf('\n') === -1 ? text.length : text.indexOf('\n'));
  const flat = line.replace(/^#{1,6}[ \t]+/, '').trim();
  const ends = /[.!?](?=\s|$)/g;
  for (let end = ends.exec(flat); end !== null; end = ends.exec(flat)) {
    const cut = end.index + 1;
    if (cut > FINDING_TITLE_MAX) break;
    const candidate = flat.slice(0, cut);
    if (/\p{L}/u.test(candidate)) return trimTitle(candidate);
  }
  if (flat.length <= FINDING_TITLE_MAX) return trimTitle(flat);
  const space = flat.lastIndexOf(' ', FINDING_TITLE_MAX);
  return trimTitle(flat.slice(0, space > 0 ? space : FINDING_TITLE_MAX));
}

/** A title is not a sentence, so the full stop goes; nothing else does. */
function trimTitle(text: string): string {
  return text.trim().replace(/\.$/, '').trim();
}
