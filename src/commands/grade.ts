import { homedir } from 'node:os';
import { readFile } from 'node:fs/promises';
import { resolveContextSettings } from '../lib/settings';
import { CliError } from '../lib/errors';
import { buildOutcomeItem, postOutcomes } from '../lib/agent-api';
import { UUID_RE } from '../lib/ids';
import {
  ENDED_AFTER_MS,
  errorReason,
  findAnchor,
  findTranscript,
  firstToolCall,
  gradeInjection,
  gradeRelayed,
  parseSince,
  parseTranscript,
  transcriptIdle,
  type GradeTarget,
  type TranscriptRow,
  type Verdict,
} from '../lib/grade';
import { openLoopDbForCli } from '../lib/loop-db';
import { clean } from '../hooks/text';
import type { LoopDb, Row } from '../hooks/store';
import type { CommandContext, CommandResult } from '../context';

/**
 * `tenjin grade`: the report on what the hook arms delivered, and the only
 * thing that tells a shelf whether its answer was worth serving.
 *
 * It is a REPORT, not a switch: which arms run is `tenjin hooks`, and the rows
 * it grades are the `fires`/`legs` the daemon wrote to `loop.db`. Opens the
 * ledger once (`lib/loop-db.ts`), grades, posts, closes.
 */

/** The prefix `fires.delivered` carries when the fire actually showed a piece;
 *  the rest of the value is the resource id, empty for an answer that names no
 *  marketplace resource (a parked handoff a dispatch wrote itself). */
const INJECTED = 'inject:';

function all(db: LoopDb, sql: string, params: Array<number | string>): Row[] {
  return db.prepare(sql).all(...params) as Row[];
}

/** A non-empty string column, or null for everything else. */
function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** The piece behind a delivered fire. Only a bare `inject:` names nothing, and
 *  only a uuid is a marketplace resource the shelf will take — an id in any
 *  other spelling is this machine's own and goes no further. */
function resourceIdOf(delivered: unknown): string | null {
  if (typeof delivered !== 'string' || !delivered.startsWith(INJECTED)) return null;
  return str(delivered.slice(INJECTED.length));
}

/** `legs.graded` is `<outcome>:<by>`, written as one string so a verdict and
 *  the tier behind it can never disagree. */
function verdictOf(graded: unknown): { outcome: string; by: string } | null {
  const value = str(graded);
  if (value === null) return null;
  const at = value.indexOf(':');
  return at === -1
    ? { outcome: value, by: 'none' }
    : {
        outcome: value.slice(0, at),
        by: value.slice(at + 1),
      };
}

/**
 * `tenjin grade`: read each session's transcript, decide whether the agent used
 * what the arms showed it, and tell the shelf that served the row.
 *
 * `loop.db` already holds every fire and the shelf already holds every lookup;
 * what neither has is the one fact the loop is judged on, which is
 * whether any of it was worth delivering. `lib/grade.ts` owns the reading and
 * the rule; this owns the store, the shelf routing and the report.
 *
 * IDEMPOTENT BY CONSTRUCTION, in two independent places. A leg with a `graded`
 * verdict is never re-graded (the query asks for `graded IS NULL`), and a leg
 * with a `posted_at` is never re-posted, because `posted_at` IS the posted
 * stamp rather than the graded one. So a post that failed keeps a NULL and is
 * retried on the next run, and a post that landed is never sent twice — which
 * matters because the server keeps the FIRST verdict per (lookup, post) and a
 * second one would be silently dropped rather than corrected.
 */
export interface GradeArgs {
  since?: string;
  session?: string;
  explain?: boolean;
  /** `--label <fire id> <status>`: a hand verdict, for a row the transcript
   *  cannot answer for. Statuses `used` and `rejected` only — the other wire
   *  statuses describe a search, not a delivery. */
  label?: string[];
}

export interface GradeDeps {
  homeDir?: string;
  now?: () => number;
  fetchImpl?: typeof fetch;
  /** Seam for reading one transcript, so tests hand in fixture JSONL rather than
   *  a home directory. */
  transcriptText?: (path: string) => Promise<string>;
  /** Seam for locating one, paired with the above. */
  findTranscript?: typeof findTranscript;
  /** Seam for "has this transcript gone quiet". */
  transcriptIdle?: typeof transcriptIdle;
}

/** The winning leg of one fire, as the grader addresses it. */
interface LegKey {
  fire: string;
  stage: number;
  shelf: string;
}

/** What one graded row reports. `anchorLine` is where in the transcript the
 *  delivery landed, which is the first thing to check when a verdict looks
 *  wrong. */
interface GradedRow extends LegKey {
  arm: string;
  resourceId: string | null;
  /** The subagent the fire belongs to, or null for the lead's own turn. It is
   *  what decided WHICH transcript answered for the row. */
  agentId: string | null;
  outcome: string;
  by: string;
  anchorLine: number | null;
  /** The file this run actually read, for `--explain`; null when none was. */
  transcript?: string | null;
  evidence?: string[];
  /** Why a row was left ungraded, for `--explain`. A verdict explains itself
   *  through its evidence; "nothing was written" does not. */
  note?: string;
}

const HALTING_FAILURES = new Set(['RATE_LIMITED', 'NETWORK_ERROR']);

/** Every ungraded winning leg of a delivered fire in the window, newest last so
 *  a session's rows are read in the order they happened. */
const POPULATION_SQL = `
  SELECT f.id AS id, f.at AS at, f.arm AS arm, f.session AS session, f.agent AS agent,
         f.delivered AS delivered, l.stage AS stage, l.shelf AS shelf,
         l.title AS title, l.url AS url
    FROM fires f JOIN legs l ON l.fire_id = f.id
   WHERE f.at >= ? AND f.delivered LIKE 'inject:%'
     AND l.outcome = 'hit' AND l.graded IS NULL
     AND (? = '' OR f.session = ?)
   ORDER BY f.at`;

export async function runGrade(
  ctx: CommandContext,
  args: GradeArgs = {},
  deps: GradeDeps = {},
): Promise<CommandResult> {
  const since = args.since ?? '7d';
  const sinceMs = parseSince(since);
  const now = (deps.now ?? Date.now)();
  // ONE OPEN for the whole run: `grade` reads a population, writes a verdict
  // per row and stamps what it posted, and re-opening between those would race
  // the daemon for the write lock three times over.
  const db = openLoopDbForCli(ctx.dataDir);
  try {
    const graded =
      args.label !== undefined
        ? [labelOne(db, args.label)]
        : await gradeSessions(db, ctx, args, deps, { sinceMs, now });
    const posted = await postGraded(db, ctx, deps, now);
    return {
      data: buildGradeData(since, graded, posted),
      humanLines: gradeLines(since, graded, posted, args.explain === true),
    };
  } finally {
    db.close();
  }
}

/** `--label <fire id> <status>`, as commander's variadic hands it over. */
function labelOne(db: LoopDb, label: string[]): GradedRow {
  const [fire, status] = label;
  if (label.length !== 2 || fire === undefined || status === undefined) {
    throw new CliError('USAGE', '--label takes a fire id and a status.', {
      fix: 'tenjin grade --label <fire id> used|rejected',
    });
  }
  if (status !== 'used' && status !== 'rejected') {
    throw new CliError(
      'USAGE',
      `A hand verdict is used or rejected (got ${JSON.stringify(status)}).`,
      {
        fix: 'tenjin grade --label <fire id> used|rejected',
      },
    );
  }
  // The query asks for a DELIVERED fire, so an unknown id and an id naming a
  // fire that showed nothing fail the same way — and neither can be labelled. A
  // verdict is a report about a piece the agent was shown; a `seen` or
  // `no-answer` fire was shown to nobody, and posting "used" for one would tell
  // the shelf a story about a piece it never served.
  const row = all(
    db,
    `SELECT f.arm AS arm, f.agent AS agent, f.delivered AS delivered,
            l.stage AS stage, l.shelf AS shelf
       FROM fires f JOIN legs l ON l.fire_id = f.id
      WHERE f.id = ? AND f.delivered LIKE 'inject:%' AND l.outcome = 'hit'`,
    [fire],
  )[0];
  if (row === undefined) {
    throw new CliError('USAGE', `No delivered fire ${fire} in this machine's loop.db.`, {
      fix: 'Take the id from `tenjin grade --explain`; only a fire that actually delivered a piece can be labelled.',
    });
  }
  const key: LegKey = { fire, stage: Number(row.stage ?? 0), shelf: str(row.shelf) ?? 'unknown' };
  // The verdict clears `posted_at` with it, so a re-labelled leg is owed to the
  // shelf again. The post step below selects on that stamp alone, with no time
  // bound, so a fire older than `--since` is still posted on this same run.
  setVerdict(db, key, { outcome: status, by: 'hand' });
  return {
    ...key,
    arm: str(row.arm) ?? 'unknown',
    resourceId: resourceIdOf(row.delivered),
    agentId: str(row.agent),
    outcome: status,
    by: 'hand',
    anchorLine: null,
    transcript: null,
  };
}

/** Write the verdict as `<outcome>:<by>` and re-open the post. */
function setVerdict(db: LoopDb, key: LegKey, verdict: { outcome: string; by: string }): void {
  db.prepare(
    `UPDATE legs SET graded = ?, posted_at = NULL
      WHERE fire_id = ? AND stage = ? AND shelf = ?`,
  ).run(`${verdict.outcome}:${verdict.by}`, key.fire, key.stage, key.shelf);
}

/**
 * Every ungraded delivery in the window, judged against the transcript it
 * actually landed in.
 *
 * The transcript is parsed ONCE PER (SESSION, AGENT), not once per row: a busy
 * session has several deliveries and the file is the same file — but a fire
 * that ran inside a subagent belongs to that CHILD's file, and the parent's
 * holds no word of what the child did, so the two are different reads under one
 * session id.
 *
 * A `subagent-start` fire is a finding RELAYED to a child, which has no anchor
 * row in any transcript; it is judged from the child's first tool call onward.
 * Only a relayed fire with no agent recorded has nothing to open, and those
 * settle as `unobserved`.
 */
async function gradeSessions(
  db: LoopDb,
  ctx: CommandContext,
  args: GradeArgs,
  deps: GradeDeps,
  window: { sinceMs: number; now: number },
): Promise<GradedRow[]> {
  const scope = args.session ?? '';
  const rows = all(db, POPULATION_SQL, [window.now - window.sinceMs, scope, scope]);
  const homeDir = deps.homeDir ?? homedir();
  const locate = deps.findTranscript ?? findTranscript;
  const readText = deps.transcriptText ?? ((path: string) => readFile(path, 'utf8'));
  const idle = deps.transcriptIdle ?? transcriptIdle;
  const parsed = new Map<string, SessionState>();
  const out: GradedRow[] = [];

  for (const row of rows) {
    const key: LegKey = {
      fire: String(row.id ?? ''),
      stage: Number(row.stage ?? 0),
      shelf: str(row.shelf) ?? 'unknown',
    };
    const arm = str(row.arm) ?? 'unknown';
    const session = str(row.session) ?? '';
    const agentId = str(row.agent);
    // Through `clean` on the way out, the same bounds `deliver.ts` drew them
    // with: the title and url are shelf text, and this is where they are matched
    // against a transcript rather than shown to anyone.
    const target: GradeTarget = {
      resourceId: resourceIdOf(row.delivered),
      url: str(clean(str(row.url) ?? '', 200)),
      title: str(clean(str(row.title) ?? '', 160)),
    };
    const relayed = arm === 'subagent-start';
    // Nothing names a file to open, and nothing ever will, so the row is closed
    // rather than left open forever: a fire with no session at all, and a
    // relayed finding whose child was not recorded.
    if (session === '' || (relayed && agentId === null)) {
      out.push(
        record(db, {
          key,
          arm,
          target,
          agentId,
          verdict: { outcome: 'unobserved', by: 'none' },
          anchorLine: null,
          note:
            session === ''
              ? undefined
              : 'relayed to a subagent whose id was not recorded, so no transcript names it',
        }),
      );
      continue;
    }
    // Keyed by BOTH, because one session id covers the parent's file and one
    // file per child, and they answer for different rows.
    const parsedKey = `${session} ${agentId ?? ''}`;
    let state = parsed.get(parsedKey);
    if (state === undefined) {
      state = await readSession(session, agentId, {
        homeDir,
        locate,
        readText,
        idle,
        now: window.now,
      });
      parsed.set(parsedKey, state);
    }
    // NOT A FACT ABOUT THE SESSION. A projects directory that is missing or
    // unreadable says nothing about whether this row was ever shown, and
    // `unobserved` is permanent — one run under a home that could not be read
    // would close every open row on the machine as never-seen.
    if (state.kind === 'unreadable') {
      out.push(
        ungraded({ key, arm, target, agentId, note: `transcript unreadable (${state.reason})` }),
      );
      continue;
    }
    if (state.kind === 'absent') {
      // The transcript IS absent — the projects directory was read and holds no
      // file for this session (or for this child of it). That is only
      // `unobserved` once a transcript would have appeared by now: the harness
      // writes the file as the session runs, so a fire minted seconds ago whose
      // session is still starting up has simply not been written yet.
      const at = typeof row.at === 'number' ? row.at : window.now;
      if (at > window.now - ENDED_AFTER_MS) {
        out.push(
          ungraded({ key, arm, target, agentId, note: 'no transcript for this session yet' }),
        );
        continue;
      }
      out.push(
        record(db, {
          key,
          arm,
          target,
          agentId,
          verdict: { outcome: 'unobserved', by: 'none' },
          anchorLine: null,
        }),
      );
      continue;
    }
    // A relayed finding has no anchor row anywhere — it was handed to the child
    // as its opening context — so the child's first tool call is where its
    // evidence starts. Everything else is anchored on the context row that
    // carried it.
    const anchor = relayed ? firstToolCall(state.rows) : findAnchor(state.rows, target);
    const verdict = relayed
      ? gradeRelayed(state.rows, target, { ended: state.ended })
      : gradeInjection(state.rows, anchor, target, { ended: state.ended });
    out.push(
      record(db, {
        key,
        arm,
        target,
        agentId,
        verdict,
        anchorLine: anchor === -1 ? null : (state.rows[anchor]?.line ?? null),
        transcript: state.path,
      }),
    );
  }
  return out;
}

/** A row this run declines to judge: nothing is written, and `--explain` says
 *  why. It stays in the queue for the next run. */
function ungraded(input: {
  key: LegKey;
  arm: string;
  target: GradeTarget;
  agentId: string | null;
  note: string;
}): GradedRow {
  return {
    ...input.key,
    arm: input.arm,
    resourceId: input.target.resourceId,
    agentId: input.agentId,
    outcome: 'open',
    by: 'none',
    anchorLine: null,
    transcript: null,
    evidence: [],
    note: input.note,
  };
}

/**
 * What this machine can say about one session right now.
 *
 * Three answers, because the two ways of having no transcript lead to opposite
 * writes: `absent` is a fact about the session and can settle into a verdict,
 * `unreadable` is a fact about this run and must not.
 *
 * "Over" is the FILE going quiet, and only that. `loop.db` keeps no session
 * table — the daemon serves many sessions and one ending is not an event it
 * records — so the transcript's own idleness is the whole signal, and an absent
 * file settles on the fire's age instead.
 */
type SessionState =
  | { kind: 'read'; rows: TranscriptRow[]; ended: boolean; path: string }
  | { kind: 'absent' }
  | { kind: 'unreadable'; reason: string };

async function readSession(
  session: string,
  agentId: string | null,
  ctx: {
    homeDir: string;
    locate: typeof findTranscript;
    readText: (path: string) => Promise<string>;
    idle: typeof transcriptIdle;
    now: number;
  },
): Promise<SessionState> {
  // With an agent id this is the CHILD's own file; the parent's is never
  // consulted for it, because it holds none of the child's tool calls.
  const found = await ctx.locate(ctx.homeDir, session, agentId);
  if (found.kind === 'unreadable') return { kind: 'unreadable', reason: found.reason };
  if (found.kind === 'absent') return { kind: 'absent' };
  let text: string;
  try {
    text = await ctx.readText(found.path);
  } catch (err) {
    // The file is THERE and this run could not read it: a fault of the moment,
    // and the row is owed another look rather than a verdict.
    return { kind: 'unreadable', reason: errorReason(err) };
  }
  const ended = await ctx.idle(found.path, ctx.now);
  return { kind: 'read', rows: parseTranscript(text), ended, path: found.path };
}

/** Write the verdict, unless there is none yet: a leg the session may still
 *  answer stays NULL, and `grade` reports it as open. */
function record(
  db: LoopDb,
  input: {
    key: LegKey;
    arm: string;
    target: GradeTarget;
    agentId: string | null;
    verdict: Verdict;
    anchorLine: number | null;
    transcript?: string | null;
    note?: string;
  },
): GradedRow {
  const { verdict } = input;
  if (verdict.outcome !== null) setVerdict(db, input.key, verdict);
  const evidence =
    verdict.outcome === 'used'
      ? [verdict.evidence]
      : verdict.outcome === 'unobserved'
        ? []
        : verdict.evidence;
  return {
    ...input.key,
    arm: input.arm,
    resourceId: input.target.resourceId,
    agentId: input.agentId,
    outcome: verdict.outcome ?? 'open',
    by: verdict.outcome === null ? 'none' : verdict.by,
    anchorLine: input.anchorLine,
    transcript: input.transcript ?? null,
    evidence,
    ...(input.note === undefined ? {} : { note: input.note }),
  };
}

interface PostTally {
  posted: number;
  failed: number;
  /** Rows this run would not route, and why. One `--explain` line each, and
   *  never a posted stamp: a skipped row is still owed to its shelf. */
  skipped: string[];
}

/**
 * Send every graded, unposted verdict to the shelf that served it.
 *
 * ROUTED BY THE LEG'S OWN URL, not by today's config. A search id is minted by
 * one shelf and means nothing on another, and the two ways of picking a shelf
 * here are not equivalent: the leg's `shelf` is a LABEL (`team`, `public`)
 * whose meaning depends on the config in force when the arm ran, and config
 * changes — a team base URL that moved, team mode switched on or off. Resolving
 * the label against the current config then sends the verdict somewhere that
 * never served the row, where it lands as a 202 (there is no existence oracle
 * on that endpoint, by design) and the leg is stamped posted. The verdict is
 * lost, and nothing anywhere says so. Every delivered leg carries the read url
 * it was shown with, on the shelf that served it, so that origin is the address.
 *
 * THE BYPASS SECRET RIDES THE LEG'S SHELF LABEL: the secret belongs to the team
 * — it is what gets a request past the team shelf's protection — so a `team` leg
 * carries it and a `public` one never does. The origin it is authorized at is
 * this machine's configured team base, never the leg's url: that url is a
 * candidate url the shelf chose, so authorizing the key there would hand the
 * team's shelf key to any origin a search response cared to name. The transport
 * does the final compare against the request URL ({@link ShelfBypass}), so a leg
 * whose candidate url wandered off that shelf posts unauthenticated rather than
 * leaking the key.
 *
 * A failure never fails the command — the verdicts are already recorded locally,
 * and the leg keeps its NULL stamp so the next run retries it. A rate limit or a
 * dead network halts the rest of the batch for the same reason a verdict does:
 * the next id fails the same way, and an unposted row is a recoverable state.
 */
async function postGraded(
  db: LoopDb,
  ctx: CommandContext,
  deps: GradeDeps,
  now: number,
): Promise<PostTally> {
  const tally: PostTally = { posted: 0, failed: 0, skipped: [] };
  // NO TIME WINDOW. `--since` chooses which fires this run GRADES; a verdict
  // already recorded is owed to the shelf whenever it was made, and the NULL
  // stamp is the whole debt. So a hand `--label` on a fire older than `--since`
  // is posted here, and a leg whose post failed last run is retried forever.
  // A leg with no search id (a parked handoff, read off this machine) has no
  // shelf to owe and is never selected, so it cannot pile up as "not routed".
  const rows = all(
    db,
    `SELECT f.id AS id, f.delivered AS delivered, l.stage AS stage, l.shelf AS shelf,
            l.search_id AS search_id, l.url AS url, l.graded AS graded
       FROM fires f JOIN legs l ON l.fire_id = f.id
      WHERE l.graded IS NOT NULL AND l.posted_at IS NULL AND l.search_id IS NOT NULL`,
    [],
  );
  if (rows.length === 0) return tally;
  const settings = await resolveContextSettings(ctx);
  let halted = false;
  for (const row of rows) {
    if (halted) break;
    const fire = String(row.id ?? '');
    const searchId = str(row.search_id) ?? '';
    if (!UUID_RE.test(searchId)) {
      tally.skipped.push(`${fire}: no search id to report against`);
      continue;
    }
    const origin = shelfOrigin(str(row.url) ?? '');
    if (origin === null) {
      tally.skipped.push(`${fire}: no usable url, so the shelf that served it is unknown`);
      continue;
    }
    const verdict = verdictOf(row.graded);
    if (verdict === null) continue;
    const bypass = row.shelf === 'team' ? settings.bypass : undefined;
    const resourceId = resourceIdOf(row.delivered) ?? '';
    try {
      const item = buildOutcomeItem({
        status: wireStatus(verdict.outcome, verdict.by),
        // Only a uuid: the server drops an outcome naming a non-candidate, and a
        // parked local answer has no marketplace resource at all.
        ...(UUID_RE.test(resourceId) ? { resourceId } : {}),
      });
      await postOutcomes(searchId, [item], {
        baseUrl: origin,
        timeoutMs: ctx.flags.timeout,
        ...(bypass !== undefined ? { bypass } : {}),
        ...(deps.fetchImpl !== undefined ? { fetchImpl: deps.fetchImpl } : {}),
      });
      db.prepare('UPDATE legs SET posted_at = ? WHERE fire_id = ? AND stage = ? AND shelf = ?').run(
        now,
        fire,
        Number(row.stage ?? 0),
        str(row.shelf) ?? 'unknown',
      );
      tally.posted += 1;
    } catch (err) {
      tally.failed += 1;
      if (err instanceof CliError && HALTING_FAILURES.has(err.code)) halted = true;
    }
  }
  return tally;
}

/** The origin a shelf is reachable at, or null for anything this CLI would not
 *  POST to. A stored url is server text; only http(s) is an address here. */
function shelfOrigin(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.origin : null;
  } catch {
    return null;
  }
}

/**
 * The verdict as the shelf's outcome vocabulary.
 *
 * `partially_used` for a `span` or a `likely` match, and that is the honest
 * word for either: a phrase copied out of the delivered text, or a command
 * head / file basename named in its prose, says the agent took SOMETHING from
 * the piece, not that the piece answered the question. Only a followed
 * pointer, or a human saying so, is `used`.
 */
function wireStatus(outcome: string, by: string): string {
  if (outcome === 'rejected') return 'rejected';
  return by === 'span' || by === 'likely' ? 'partially_used' : 'used';
}

function buildGradeData(
  since: string,
  rows: GradedRow[],
  posted: PostTally,
): Record<string, unknown> {
  const counts = { used: 0, rejected: 0, unobserved: 0, open: 0 };
  // The tier behind `used`, broken out: #254 widened `used` with a whole new
  // tier (`likely`), and that tier is exactly the number an operator cannot
  // currently see without `--explain` — see tenjin-agent#276 review, minor 3.
  // `hand` (a `--label` verdict) is a tier too, not a fifth outcome: without
  // it here the breakdown silently stopped summing to `used` the moment
  // anyone hand-labeled a row — tenjin-agent#276 review round 2, minor.
  const byTier = { read: 0, span: 0, likely: 0, hand: 0 };
  for (const row of rows) {
    if (row.outcome === 'used') {
      counts.used += 1;
      if (row.by === 'read' || row.by === 'span' || row.by === 'likely' || row.by === 'hand') {
        byTier[row.by] += 1;
      }
    } else if (row.outcome === 'rejected') counts.rejected += 1;
    else if (row.outcome === 'unobserved') counts.unobserved += 1;
    else counts.open += 1;
  }
  return {
    since,
    graded: { ...counts, byTier },
    posted: posted.posted,
    postFailed: posted.failed,
    postSkipped: posted.skipped.length,
    rows: rows.map((row) => ({
      fire: row.fire,
      arm: row.arm,
      shelf: row.shelf,
      resourceId: row.resourceId,
      agentId: row.agentId,
      outcome: row.outcome,
      by: row.by,
      anchorLine: row.anchorLine,
    })),
  };
}

function gradeLines(
  since: string,
  rows: GradedRow[],
  posted: PostTally,
  explain: boolean,
): string[] {
  const data = buildGradeData(since, rows, posted) as {
    graded: {
      used: number;
      rejected: number;
      unobserved: number;
      open: number;
      byTier: { read: number; span: number; likely: number; hand: number };
    };
  };
  const g = data.graded;
  // The tier breakdown rides alongside `used=`, not behind `--explain`: it is
  // the number that will be quoted back as evidence the arm works, so it
  // should not take a flag to see. `hand` only shows up when it is nonzero —
  // it is rare enough that always printing it would be noise the common
  // (read/span/likely-only) case doesn't need.
  const hand = g.byTier.hand > 0 ? ` hand=${g.byTier.hand}` : '';
  const tiers =
    g.used > 0
      ? ` (read=${g.byTier.read} span=${g.byTier.span} likely=${g.byTier.likely}${hand})`
      : '';
  const lines = [
    `graded ${rows.length} row(s) since ${since}: used=${g.used}${tiers} rejected=${g.rejected} unobserved=${g.unobserved} open=${g.open}`,
    posted.failed > 0
      ? `posted ${posted.posted} outcome(s) (${posted.failed} failed; retried on the next run)`
      : `posted ${posted.posted} outcome(s)`,
  ];
  if (posted.skipped.length > 0) {
    lines.push(`${posted.skipped.length} verdict(s) not routed to any shelf; still unposted`);
  }
  // The shelf's own lookup stats are cached server-side for several minutes
  // (tenjin-agent#252): a verdict this run just posted routinely will not move
  // them yet. Only worth saying when something was actually posted — an
  // all-skipped or all-failed run has no fresh verdict for the cache to be
  // behind on yet.
  if (posted.posted > 0) {
    lines.push('shelf stats can take several minutes to reflect what was just posted');
  }
  if (!explain) return lines;
  for (const row of rows) {
    const anchor = row.anchorLine === null ? 'no anchor' : `anchor line ${row.anchorLine}`;
    lines.push(
      `${row.fire} ${row.arm}/${row.shelf} ${row.resourceId ?? '(no resource)'}: ${row.outcome} (${row.by}) ${anchor}`,
    );
    // Which child the row belongs to, and which file answered for it: the two
    // facts that say why a verdict was read out of the transcript it was.
    if (row.agentId !== null) lines.push(`    agent ${row.agentId}`);
    if (row.transcript !== null && row.transcript !== undefined) {
      lines.push(`    read ${row.transcript}`);
    }
    // Why nothing was written, for the rows where that is the whole story.
    if (row.note !== undefined) lines.push(`    ${row.note}`);
    for (const line of row.evidence ?? []) lines.push(`    ${line}`);
  }
  for (const skip of posted.skipped) lines.push(`not posted: ${skip}`);
  return lines;
}
