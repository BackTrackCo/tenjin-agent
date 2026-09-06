import { randomUUID } from 'node:crypto';
import { hostname, userInfo } from 'node:os';
import { basename, isAbsolute, relative, resolve, sep } from 'node:path';
import { mask } from '../../lib/redact';
import { projectId, shortHash } from '../../lib/state-store';
import { EDITED_PREFIX } from '../arms/context';
import { getFact, setFact } from '../facts';
import { getMark, setMark } from '../gates';
import { PAIRING_FIXED, PAIRING_ONCE, PAIRING_PASSED, PAIRING_SIMILAR } from '../prose';
import type { LoopDb } from '../store';
import type { Actor, Answer } from '../types';

/**
 * This machine's error-to-fix record (13-pr-d-local-arms.md, "failure"):
 * `pairings` and `pairing_closes` on `loop.db`, in `state-store.ts`'s shape
 * verbatim so E moves readers and not rows. A failure OPENS a row keyed on
 * its signature; the same agent's later pass CLOSES it under the #269 rule;
 * a second, independent session's close promotes it to `verified`; a later
 * failure with the same key is answered by the row, rendered as an `Answer`
 * through the one formatter.
 */

export interface Pairing {
  id: number;
  at: number;
  session: string;
  project: string | null;
  kind: string;
  key: string;
  coarseKey: string | null;
  cmdHead: string | null;
  cmd: string | null;
  errorLine: string | null;
  errorFiles: string[];
  fixCmd: string | null;
  fixFiles: string[];
  scope: string;
  status: string;
  closes: number;
}

export interface OpenPairing {
  session: string;
  cwd: string;
  kind: 'sig_v1' | 'sig_v1_test';
  key: string;
  coarseKey: string | null;
  cmdHead: string | null;
  cmd: string;
  errorLine: string;
  errorFiles: string[];
}

/** The `machine` column, as `state-store.ts` stamped it: host and user, so
 *  two containers sharing a hostname stay apart. */
function machineId(): string {
  let host = '';
  let user: string;
  try {
    host = hostname();
  } catch {
    // No hostname is a machine id of '', not a dead hook.
  }
  try {
    user = userInfo().username;
  } catch {
    const uid = typeof process.getuid === 'function' ? process.getuid() : null;
    user = uid === null ? '' : 'uid:' + uid;
  }
  return shortHash(host + ' ' + user);
}

function parseList(v: unknown): string[] {
  if (typeof v !== 'string') return [];
  try {
    const parsed: unknown = JSON.parse(v);
    return Array.isArray(parsed) ? parsed.filter((f): f is string => typeof f === 'string') : [];
  } catch {
    return [];
  }
}

function pairingRow(row: Record<string, unknown>): Pairing {
  const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
  return {
    id: Number(row.id),
    at: Number(row.at),
    session: str(row.session) ?? '',
    project: str(row.project),
    kind: str(row.kind) ?? 'sig_v1',
    key: str(row.key) ?? '',
    coarseKey: str(row.coarse_key),
    cmdHead: str(row.cmd_head),
    cmd: str(row.cmd),
    errorLine: str(row.error_line),
    errorFiles: parseList(row.error_files),
    fixCmd: str(row.fix_cmd),
    fixFiles: parseList(row.fix_files),
    scope: str(row.scope) ?? 'ambiguous',
    status: str(row.status) ?? 'open',
    closes: Number(row.closes ?? 0),
  };
}

/** Returns the row id, which the `replayed:` mark and the `pairing_post:`
 *  fact key on. */
export function openPairing(db: LoopDb, row: OpenPairing, now: number): number {
  const result = db
    .prepare(
      `INSERT INTO pairings (
         uid, at, session, project, machine, kind, key, coarse_key,
         cmd_head, cmd, error_line, error_files, pkg_versions, scope, status
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'ambiguous', 'open')`,
    )
    .run(
      randomUUID(),
      now,
      row.session,
      projectId(row.cwd),
      machineId(),
      row.kind,
      row.key,
      row.coarseKey,
      row.cmdHead,
      row.cmd,
      row.errorLine,
      JSON.stringify(row.errorFiles),
    );
  return Number(result.lastInsertRowid);
}

/**
 * The best closed match for a signature, scoped to the project: an EXACT key
 * match outranks a coarse-only one (a verified fix for a different test is
 * not stronger evidence about this one), then verified over unverified, then
 * most closed, then most recent. `IS` on the project so a payload with no cwd
 * matches the rows written without one and nothing else.
 */
export function findPairing(
  db: LoopDb,
  project: string | null,
  key: string,
  coarseKey: string | null,
): Pairing | null {
  const row = db
    .prepare(
      `SELECT * FROM pairings
       WHERE project IS ?
         AND (key = ? OR (coarse_key IS NOT NULL AND coarse_key = ?))
         AND status IN ('unverified', 'verified')
       ORDER BY CASE WHEN key = ? THEN 0 ELSE 1 END,
                CASE status WHEN 'verified' THEN 0 ELSE 1 END,
                closes DESC, at DESC
       LIMIT 1`,
    )
    .get(project, key, coarseKey ?? '', key) as Record<string, unknown> | undefined;
  return row === undefined ? null : pairingRow(row);
}

function openPairingsForHead(
  db: LoopDb,
  project: string | null,
  head: string,
  beforeMs: number,
): Pairing[] {
  return (
    db
      .prepare(
        `SELECT * FROM pairings
         WHERE status = 'open' AND project IS ? AND cmd_head = ? AND at <= ?
         ORDER BY at DESC`,
      )
      .all(project, head, beforeMs) as Record<string, unknown>[]
  ).map(pairingRow);
}

/** Project-scoped like every other read: this is the branch that reaches
 *  `verified`, and a session shown a pairing in one repo and passing in
 *  another must not manufacture the confident wording. */
function pairingById(db: LoopDb, project: string | null, id: number): Pairing | null {
  const row = db
    .prepare('SELECT * FROM pairings WHERE id = ? AND project IS ?')
    .get(id, project) as Record<string, unknown> | undefined;
  return row === undefined ? null : pairingRow(row);
}

/** Signals that a failure was about the MACHINE rather than the repo: an env
 *  var, a port, a missing tool. A pairing carrying one stays local however it
 *  was closed, because the fix is somebody's laptop and not the codebase. */
const USER_SCOPE_RE =
  /\b(?:EADDRINUSE|EACCES|EPERM)\b|address already in use|command not found|not recognized as|permission denied|\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b[^\n]{0,24}\b(?:is not set|not set|is required|is undefined|is missing)\b/;

/** `user`: replays locally, never syncs. `code`: a tracked file changed, the
 *  team shelf can hold it. `ambiguous`: it passed and nothing tracked changed. */
function pairingScope(errorLine: string | null, fixFiles: string[]): string {
  if (USER_SCOPE_RE.test(errorLine ?? '')) return 'user';
  return fixFiles.length === 0 ? 'ambiguous' : 'code';
}

/**
 * Record that this session closed the pairing, then recompute it from all of
 * its closers. TWO CLOSES ARE CORROBORATION ONLY IF THEY AGREE: a session
 * shown "someone once fixed this by touching foo.ts" re-runs the failing
 * command by definition, so a closer counts toward `verified` only if its fix
 * overlaps the first closer's. `fix_files` ends up as what the agreeing
 * closers have in common; `scope` belongs to the first closer. The agent is
 * recorded and counts for nothing: independence is per SESSION.
 */
function closePairing(
  db: LoopDb,
  id: number,
  actor: Actor,
  fixCmd: string,
  fixFiles: string[],
  scope: string,
  now: number,
): string {
  db.prepare(
    `INSERT OR IGNORE INTO pairing_closes (pairing_id, session, agent_id, at, fix_cmd, fix_files, scope)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    actor.session,
    actor.agent === '' ? null : actor.agent,
    now,
    fixCmd,
    JSON.stringify(fixFiles),
    scope,
  );
  const closers = (
    db
      .prepare(
        'SELECT session, at, fix_cmd, fix_files, scope FROM pairing_closes WHERE pairing_id = ? ORDER BY at, session',
      )
      .all(id) as Record<string, unknown>[]
  ).map((row) => ({
    fixCmd: typeof row.fix_cmd === 'string' ? row.fix_cmd : null,
    fixFiles: parseList(row.fix_files),
    scope: typeof row.scope === 'string' ? row.scope : 'ambiguous',
  }));
  const first = closers[0];
  if (first === undefined) return 'open';
  const agreeing = [
    first,
    ...closers.slice(1).filter((c) => c.fixFiles.some((f) => first.fixFiles.includes(f))),
  ];
  const common = first.fixFiles.filter((f) => agreeing.every((c) => c.fixFiles.includes(f)));
  const status = agreeing.length >= 2 ? 'verified' : 'unverified';
  db.prepare(
    `UPDATE pairings SET closes = ?, status = ?, closed_at = ?, fix_cmd = ?, fix_files = ?, scope = ?
     WHERE id = ?`,
  ).run(
    agreeing.length,
    status,
    now,
    first.fixCmd,
    JSON.stringify(common.length > 0 ? common : first.fixFiles),
    first.scope,
    id,
  );
  return status;
}

/**
 * A path this repo owns, as opposed to one the toolchain owns or one that
 * holds machine configuration: no vendor or build directory, no `.env*`. NO
 * GIT INVOCATION; the two cases the close rule has to separate are separable
 * by name. In-repo is the caller's check (`repoPath`), which is what keeps a
 * home dotfile out (tenjin-agent#268): `~/.claude/notes.md` is never under
 * the checkout.
 */
export function isTrackedPath(path: string): boolean {
  if (
    /(?:^|[/\\])(?:node_modules|\.git|dist|build|coverage|\.next|target|out)(?:[/\\]|$)/.test(path)
  ) {
    return false;
  }
  const base = basename(path);
  return base.length > 0 && !base.startsWith('.env');
}

/** The path as the repo names it — relative to `cwd`, forward-slashed — or
 *  null when it is not under `cwd` at all: an edit that cannot be part of
 *  THIS repo's fix (tenjin-agent#269). */
export function repoPath(cwd: string, path: string): string | null {
  if (cwd.length === 0) return null;
  const rel = relative(cwd, resolve(cwd, path));
  if (rel.length === 0 || rel.startsWith('..') || isAbsolute(rel)) return null;
  return rel.split(sep).join('/');
}

/** Tracked, in-repo paths THIS AGENT edited after `sinceMs`, off the context
 *  arm's `edited:` marks (the value is the path, the time is `marks.at`).
 *  Scoped by agent because the rule's whole content is "the thing that failed
 *  here is the thing that was fixed here", and parallel subagents share a
 *  session id. */
function editedSince(db: LoopDb, actor: Actor, cwd: string, sinceMs: number): string[] {
  const rows = db
    .prepare(
      'SELECT value FROM marks WHERE session = ? AND agent = ? AND substr(key, 1, ?) = ? AND at > ? ORDER BY at',
    )
    .all(actor.session, actor.agent, EDITED_PREFIX.length, EDITED_PREFIX, sinceMs) as Array<{
    value?: unknown;
  }>;
  const out: string[] = [];
  for (const row of rows) {
    const path = typeof row.value === 'string' ? row.value : '';
    if (path.length === 0 || !isTrackedPath(path)) continue;
    const rel = repoPath(cwd, path);
    if (rel !== null) out.push(rel);
  }
  return out;
}

const REPLAYED_PREFIX = 'replayed:';

/** The pairing ids this agent was shown behind `head`, oldest first. */
export function replayedPairings(db: LoopDb, actor: Actor, head: string): number[] {
  const raw = getMark(db, actor, REPLAYED_PREFIX + head);
  if (raw === null) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((id): id is number => typeof id === 'number') : [];
  } catch {
    return [];
  }
}

/** Remember that this agent was shown pairing `id` behind `head`, so its
 *  later pass on that head can close it as the second independent closer. A
 *  LIST, uncapped: two failures behind `pnpm test` are two pairings under one
 *  key, and a single slot let the second evict the first. */
export function rememberReplay(
  db: LoopDb,
  actor: Actor,
  head: string,
  id: number,
  now: number,
): void {
  if (head.length === 0) return;
  const prior = replayedPairings(db, actor, head);
  if (prior.includes(id)) return;
  setMark(db, actor, REPLAYED_PREFIX + head, JSON.stringify([...prior, id]), now);
}

const PAIRING_POST_PREFIX = 'pairing_post:';

/** The team-shelf post a pairing was opened beside, so this machine's later
 *  close can be carried back as the second, independent confirmation (the
 *  shelf has no close endpoint). `tenjin sync` reads it in E. */
export function linkPost(
  db: LoopDb,
  id: number,
  postId: string,
  origin: string,
  now: number,
): void {
  setFact(db, PAIRING_POST_PREFIX + id, JSON.stringify({ postId, origin, at: now }), now);
}

function markLinkClosed(
  db: LoopDb,
  id: number,
  status: string,
  fixFiles: string[],
  now: number,
): void {
  const raw = getFact(db, PAIRING_POST_PREFIX + id);
  if (raw === null) return;
  let link: unknown;
  try {
    link = JSON.parse(raw);
  } catch {
    return;
  }
  if (typeof link !== 'object' || link === null) return;
  setFact(
    db,
    PAIRING_POST_PREFIX + id,
    JSON.stringify({ ...link, closedAt: now, status, fixFiles }),
    now,
  );
}

/**
 * A pass closes whatever this machine had open on the same command head, and
 * whatever this agent was SHOWN behind it (without that, the second close
 * `verified` needs is unreachable: a session shown a pairing never opens one).
 *
 * THE RULE (tenjin-agent#269): at least one tracked, in-repo edit by this
 * agent since the pairing opened, ALWAYS. A pass with no edit between is a
 * re-run, not a fix; an edit outside the checkout is not this repo's fix. The
 * files that count are the ones the error named; the same-command branch
 * widens that to every tracked edit, never to none. Being shown a pairing
 * buys no relaxation.
 */
export function closeOpenPairings(
  db: LoopDb,
  actor: Actor,
  cwd: string,
  command: string,
  heads: string[],
  now: number,
): void {
  // The command as it may be STORED and READ BACK into a later session's
  // context: an allowlisted `DATABASE_URL=postgres://app:pw@db/x pnpm
  // drizzle-kit migrate` passes the head check. The same `mask` every query
  // goes through.
  const passed = mask(command);
  const project = projectId(cwd);
  const closeIf = (pairing: Pairing | null): void => {
    if (pairing === null || pairing.project !== project) return;
    const changed = editedSince(db, actor, cwd, pairing.at);
    if (changed.length === 0) return;
    const named = changed.filter((f) => pairing.errorFiles.includes(basename(f)));
    const sameCommand = pairing.cmd !== null && pairing.cmd === passed;
    if (named.length === 0 && !sameCommand) return;
    const fixFiles = named.length > 0 ? named : changed;
    const status = closePairing(
      db,
      pairing.id,
      actor,
      passed,
      fixFiles,
      pairingScope(pairing.errorLine, fixFiles),
      now,
    );
    markLinkClosed(db, pairing.id, status, fixFiles, now);
  };
  for (const head of heads) {
    for (const pairing of openPairingsForHead(db, project, head, now)) closeIf(pairing);
    for (const id of replayedPairings(db, actor, head)) closeIf(pairingById(db, project, id));
  }
}

/** The id a pairing is delivered under, and burns `seen:` under. */
const RESOURCE_PREFIX = 'pairing:';

export function pairingIdOf(resourceId: string): number | null {
  if (!resourceId.startsWith(RESOURCE_PREFIX)) return null;
  const id = Number(resourceId.slice(RESOURCE_PREFIX.length));
  return Number.isSafeInteger(id) ? id : null;
}

/**
 * The record as an `Answer` on the `local` shelf, rendered by `deliver()`
 * like any other: the error line is the title, the sentences (`prose.ts`)
 * are the text. No url and no price: it is this machine's own row, and
 * `tenjin read` takes a post id, so a pointer under it would name a command
 * that does not exist. `fine` is whether the match was on the row's own key;
 * a coarse test-identity match says "this file/suite has been fixed before",
 * not "this exact test", which is a claim too weak for the fix body.
 */
export function pairingAnswer(pairing: Pairing, fine: boolean): Answer {
  const answer: Answer = {
    shelf: 'local',
    resourceId: RESOURCE_PREFIX + pairing.id,
    title: pairing.errorLine ?? '',
  };
  if (!fine) {
    return { ...answer, text: PAIRING_SIMILAR(pairing.errorFiles[0] ?? 'this file') };
  }
  const files = pairing.fixFiles.join(', ');
  const lines = [
    pairing.status === 'verified' ? PAIRING_FIXED(pairing.closes, files) : PAIRING_ONCE(files),
  ];
  // Masked again on the way OUT: a row written by a build whose rules were
  // weaker must not be the thing that carries a credential forward.
  if (pairing.fixCmd !== null && pairing.fixCmd.length > 0) {
    lines.push(PAIRING_PASSED(mask(pairing.fixCmd)));
  }
  return { ...answer, text: lines.join('\n') };
}
