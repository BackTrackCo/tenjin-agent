import { factsWithPrefix, getFact } from '../hooks/facts';
import { CliError } from './errors';
import { withLoopDb } from './loop-db';

/**
 * Reading the child-finding queue the `SubagentStop` harvest writes
 * (tenjin-agent#228).
 *
 * A finding is one `facts` row on `loop.db` under `finding:<uid>`, whose JSON
 * value carries the child's own words, the title it gave them, the agent that
 * produced them and the search the ask was signalled by. The harvest writes it
 * from inside the daemon; this is the same queue read from a CLI process, and it
 * lives here rather than in a command module because `publish --finding` is not
 * the only caller that will ever want it.
 *
 * READ-ONLY AND LOCAL: it opens no wallet, contacts no shelf and writes nothing.
 * What it hands back is a CHILD'S WORDS, which is data every caller has to frame
 * as a record rather than as instructions.
 */

const FINDING_PREFIX = 'finding:';

/** One queued finding, whole. Nothing is cut on the way out: a body trimmed
 *  here would be a different finding from the one that was stored. */
export interface ChildFinding {
  id: string;
  /** When the harvest filed it, ISO-8601. */
  at: string;
  /** The harness session whose child wrote it. */
  session: string;
  /**
   * The project the child ran in, or null for a row written with no cwd.
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
  /** The `# ` heading the child gave it, or '' when it gave none. The title a
   *  `--finding` publish falls back to when the body carries no heading. */
  title: string;
  body: string;
}

/** A stored fact read back defensively, field by field: the row was written by
 *  whichever build was installed when the child stopped, so a field that build
 *  did not write reads as absent rather than failing the caller. */
function toFinding(id: string, value: string): ChildFinding | null {
  if (id === '') return null;
  let data: unknown;
  try {
    data = JSON.parse(value);
  } catch {
    return null;
  }
  if (data === null || typeof data !== 'object') return null;
  const f = data as Record<string, unknown>;
  const at = typeof f.at === 'number' ? f.at : 0;
  const str = (v: unknown): string => (typeof v === 'string' ? v : '');
  const orNull = (v: unknown): string | null => {
    const s = str(v);
    return s === '' ? null : s;
  };
  return {
    id,
    at: new Date(at).toISOString(),
    session: str(f.session),
    project: orNull(f.project),
    agentType: orNull(f.agentType),
    agentId: orNull(f.agent),
    searchId: orNull(f.searchId),
    title: str(f.title),
    body: str(f.body),
  };
}

/**
 * One finding by the id the turn-end ask printed, or a not-found error naming
 * the ids this machine actually holds.
 *
 * The ids are in the ERROR rather than behind a listing verb because that is the
 * only moment a caller needs them: it typed an id and was wrong, and the ask it
 * copied from is one paragraph back in a context that may already be gone.
 */
export async function readChildFinding(
  dataDir: string,
  id: string,
  project: string | null = null,
): Promise<ChildFinding> {
  const value = withLoopDb(dataDir, (db) => getFact(db, FINDING_PREFIX + id));
  const finding = value === null ? null : toFinding(id, value);
  if (finding !== null) return finding;
  const known = await recentFindingIds(dataDir, project);
  throw new CliError('RESOURCE_NOT_FOUND', `No stored finding with id ${JSON.stringify(id)}`, {
    fix:
      known.length === 0
        ? 'No findings are held for this project. They are harvested from a subagent at its own end and need `hooks.publish` on (`tenjin config get hooks.publish`).'
        : `Captured in this project: ${known.join(', ')}. A finding is never rewritten and stays publishable by its own id, so an id that does not resolve is one this project never captured.`,
    details: { id, known },
  });
}

/**
 * The ids THIS PROJECT holds, newest first. No window and no cap: a finding is
 * publishable by its own id forever, so a listing that aged rows out named
 * fewer ids than the queue actually held and made a real id look like a typo.
 *
 * DELIBERATELY IDS ONLY. Bodies are what a finding costs to carry, and the only
 * caller is an error line; handing back a body here would rebuild the listing
 * this queue deliberately does not have.
 *
 * AND DELIBERATELY NOT MACHINE-WIDE (round-3 item 5). The queue is machine-wide
 * and the ask marks which of its rows came from elsewhere, but this is an error
 * path reached by typing an id wrong: enumerating every checkout's findings
 * there hands one project a listing of another's work for the price of a typo.
 * A null project matches the rows that carry none.
 */
export async function recentFindingIds(
  dataDir: string,
  project: string | null = null,
): Promise<string[]> {
  const facts = withLoopDb(dataDir, (db) => factsWithPrefix(db, FINDING_PREFIX));
  return facts
    .map((fact) => toFinding(fact.key.slice(FINDING_PREFIX.length), fact.value))
    .filter((f): f is ChildFinding => f !== null && f.project === project)
    .reverse()
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
