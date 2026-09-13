import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Emit } from '../adapters/types';
import { AGENT_ID_RE } from '../lib/grade';
import { failureKeyFingerprints } from './failure/keys';
import { STARTED_MARK } from './actor';
import { EDITED_PREFIX } from './arms/context';
import { factsWithPrefix } from './facts';
import { getMark, setMark } from './gates';
import { teamOrigin } from './legs/shelf';
import { captureAsk, CHILD_PUBLISHED_LINE, FAILURE_LINE, MISS_LINE } from './prose';
import type { LoopDb } from './store';
import { clean } from './text';
import type { Actor, FireContext } from './types';

/**
 * Capture: one module for the child and the lead (13-pr-d-local-arms.md,
 * proposal B). A child that did work is asked once, at its stop, to publish
 * while it still holds the evidence; the lead is asked once at its turn end
 * and told what its children published.
 *
 * ONCE PER AGENT, FULL STOP. The ask names a command and the agent runs it or
 * does not; there is nothing left for a later stop to collect, so every stop
 * after the ask writes its row and says nothing (`stop` below).
 *
 * EVIDENCE IS WORK THE AGENT DID, not work it read (owner, 2026-09-12). A Read
 * on its own no longer earns a child an ask: it is the cheapest row in the
 * ledger and it asked nearly every child, whatever it had been doing. The kind
 * that earned it is the `capture:asked` mark's value, so the rule can move
 * again from the ledger rather than from a guess.
 *
 * NO TIMER, NO BUDGET, NO TRANSCRIPT (decision 14): every gate below is a
 * query over rows that already exist.
 */

const ASKED = 'capture:asked';
/** Written by subagent-start on a claimed miss, valued with the search id. */
export const HANDOFF_MISS = 'handoff:miss';
const ACTIVITY_PREFIX = 'activity:';
/** One row per child publish, keyed `agent_published:<agent>@<at>`
 *  (`lib/publish-dedup.ts`, the CLI's writer). */
const PUBLISHED_AGENT_PREFIX = 'agent_published:';

/** The harness's type for a child stopped once its structured output is
 *  written: it has no turn left to answer an ask in (pr298, probed). */
const WORKFLOW_AGENT_TYPE = 'workflow-subagent';

type Evidence = 'edited' | 'research' | 'handoff-miss' | 'lookup' | 'activity' | 'miss' | 'failure';

/** Any WebSearch or WebFetch row by the child counts. A READ DOES NOT: decision
 *  2's "one Read is a row" is withdrawn (owner, 2026-09-12), because a Read is
 *  the cheapest row an agent can produce and counting it asked nearly every
 *  child regardless of what it had done. The context arm's other rows — a Read
 *  on `tool.after`, a Bash call on `tool.before` — are not evidence. */
const CHILD_RESEARCH_SQL = "arm IN ('research', 'fetch')";
/** The lead's own lookups that actually ran, as opposed to being skipped. */
const LEAD_LOOKUP_SQL =
  "arm IN ('prompt', 'research', 'fetch') AND reason IN ('hit', 'no-hit', 'cached', 'seen', 'no-answer', 'rate-server')";
/**
 * Every failure fire this actor left. NO LOOKUP OUTCOME DISQUALIFIES ONE, and
 * that is the point: what the shelf did or did not return is a fact about the
 * shelf, and the ask is about what the agent walked into.
 *
 * A DELIVERED PIECE IS NOT AN ANSWER EITHER. `hit` says a note was injected,
 * not that it was right: it may need a correction this repo alone knows, or
 * miss the problem entirely, and none of that is legible from the row. Even a
 * note that solved it outright carries no fingerprint of its own unless someone
 * files one, so the key still has to reach the agent for the next teammate to
 * resolve it. `seen` is weaker still — `fire.ts` decides it on the ANSWER'S
 * resource id rather than on the failure, so it can mean nothing more than that
 * a note about a NEIGHBOURING failure had already been read.
 *
 * The three reasons excluded are the rows that are not a sighting at all:
 * `no-question` never had one, and `asked`/`cached` are the same failure a
 * second time, answered from the claim gate's own cache without a leg running.
 * A key known only by those is not named, and none of them can stand in for a
 * first sighting — the one thing a row's reason still decides.
 */
const FAILURE_ANY_SQL = "arm = 'failure' AND reason NOT IN ('no-question', 'asked', 'cached')";

function hasMark(db: LoopDb, actor: Actor, prefix: string): boolean {
  return (
    db
      .prepare(
        'SELECT 1 FROM marks WHERE session = ? AND agent = ? AND substr(key, 1, ?) = ? LIMIT 1',
      )
      .get(actor.session, actor.agent, prefix.length, prefix) !== undefined
  );
}

/** When this mark was last written, or null. The ask reads its own
 *  `capture:asked` time to decide what a failure row is newer than. */
function markAt(db: LoopDb, actor: Actor, key: string): number | null {
  const row = db
    .prepare('SELECT at FROM marks WHERE session = ? AND agent = ? AND key = ?')
    .get(actor.session, actor.agent, key) as { at?: unknown } | undefined;
  return typeof row?.at === 'number' ? row.at : null;
}

function fired(db: LoopDb, actor: Actor, where: string): boolean {
  return (
    db
      .prepare(`SELECT 1 FROM fires WHERE session = ? AND agent = ? AND ${where} LIMIT 1`)
      .get(actor.session, actor.agent) !== undefined
  );
}

/**
 * THIS ACTOR'S deliberate `tenjin search` misses that nothing has closed,
 * oldest first, one line each. Exact actor, never the session: `search` stamps
 * the thread it ran inside as `agent_id` (`lib/session.ts`), so a child is
 * handed the misses it opened and the lead only its own, and neither a
 * sibling nor a parent is asked to publish another actor's loop.
 *
 * THE CLI'S ROWS ONLY. `searches` is written by `tenjin search`, so every row is
 * a question the agent decided was worth asking; a null `source` is a row an
 * older CLI wrote before the column existed and is the same kind of question.
 * The hooks' own lookups live in `fires`/`legs` and are nobody's open loop.
 */
function missLines(db: LoopDb, actor: Actor): string[] {
  const rows = db
    .prepare(
      `SELECT search_id, question FROM searches
       WHERE session = ? AND decision = 'MISS' AND resolved_at IS NULL
         AND (source = 'cli' OR source IS NULL)
         AND ((? = '' AND agent_id IS NULL) OR agent_id = ?)
       ORDER BY at, rowid`,
    )
    .all(actor.session, actor.agent, actor.agent) as unknown as Array<{
    search_id?: unknown;
    question?: unknown;
  }>;
  const out: string[] = [];
  for (const row of rows) {
    const id = typeof row.search_id === 'string' ? row.search_id : '';
    const question = clean(typeof row.question === 'string' ? row.question : '', 200);
    if (id !== '' && question !== '') out.push(MISS_LINE(question, id));
  }
  return out;
}

/** One failure this actor hit, as the ask reads it back off the `fires`
 *  row: what to say about it, and what it can be filed under. */
interface FailureHit {
  /** The masked error line, empty for a failure known only by a test identity. */
  line: string;
  /** The `<kind>:<hash>` fingerprints it is filed under; empty below the floor. */
  keys: string[];
}

/**
 * The failures this actor hit and does not already have an answer to, oldest
 * first.
 *
 * THE FACT, AND ONLY THE FACT. This is what the ask is ARMED by — an agent that
 * walked into a wall did real work (principle 5) whether or not the wall could
 * be fingerprinted. What is SAID about them is {@link failureLines}, which may
 * drop some; keep the two apart, or an editorial choice about prose decides
 * whether the ask happens.
 *
 * SELECTED BY WHAT HAPPENED, NOT BY WHAT THE LOOKUP RETURNED ({@link
 * FAILURE_ANY_SQL}). The cost of naming one failure too many is a line the
 * agent ignores; the cost of dropping one is a fingerprint nobody can ever
 * publish under, so the asymmetry decides the default.
 *
 * DEDUPED AND BOUNDED, WHICH IS WHAT KEEPS IT QUIET. One line per key however
 * many times the command ran, and `since` drops the keys a previous ask already
 * named, so a failure is offered once per actor and never re-offered.
 *
 * THE `fires` ROW IS THE RECORD: `fire.ts` sets the plan's
 * question key and its masked, cut text before the gates run, and `ledger.ts`
 * writes both on every outcome, so a failure that asked has already left
 * everything this needs. Nothing else is stored and nothing else is joined.
 *
 * PER ACTOR, NOT PER SESSION (principle 5). A child's failures belong in the
 * child's own ask: it is the one that can explain what it hit, and a lead shown
 * a wall it never walked into cannot write the piece.
 *
 * DEDUPED BY `question_key`, oldest kept: a command re-run after a failed edit
 * is one problem, not four. Deduped here rather than with a `GROUP BY` — the
 * bare column beside a `MIN(at)` is a SQLite-only rule, the row set is a
 * handful, and this way the `ORDER BY at, rowid` tiebreak stays explicit.
 *
 * A NULL `question` IS NOT A FILTER. A failure with a test identity and no
 * error line stores the empty string, and that row is exactly the one whose
 * fingerprint is worth publishing under; only the key is required.
 *
 * NOTHING OLDER THAN THE LAST ASK, which is also what re-arms one. The line
 * says a failure came up this turn, and on a re-armed ask the rows from before
 * the previous ask did not: naming them again repeats a `--key fingerprint=`
 * the agent may already have published under. The dedupe runs over the actor's
 * whole history and `since` filters after it, so a failure that keeps
 * recurring is still one named failure — a `no-answer` releases its
 * once-per-question claim, so a shelf that cannot be reached re-asks and
 * re-writes the row behind every run of the same failing command, and matching
 * on the key's FIRST row is what keeps that from re-arming the ask every turn.
 */

function failuresHit(db: LoopDb, actor: Actor, since: number | null): FailureHit[] {
  const rows = db
    .prepare(
      `SELECT question_key, question, at FROM fires
       WHERE session = ? AND agent = ? AND ${FAILURE_ANY_SQL}
         AND question_key IS NOT NULL AND question_key != ''
       ORDER BY at, rowid`,
    )
    .all(actor.session, actor.agent) as unknown as Array<{
    question_key?: unknown;
    question?: unknown;
    at?: unknown;
  }>;
  const seen = new Set<string>();
  const out: FailureHit[] = [];
  for (const row of rows) {
    const key = typeof row.question_key === 'string' ? row.question_key : '';
    if (key === '' || seen.has(key)) continue;
    seen.add(key);
    if (since !== null && (typeof row.at === 'number' ? row.at : 0) <= since) continue;
    // Already masked and cut at the shelf's bound on the way into the row; the
    // second cut here is for the line's own width and nothing else.
    const line = clean(typeof row.question === 'string' ? row.question : '', 200);
    out.push({ line, keys: failureKeyFingerprints(key) });
  }
  return out;
}

/**
 * Those of them worth a line of their own: the ones with a fingerprint to name.
 *
 * A FILTER ON THE PROSE, NEVER ON THE ASK. A key that is nothing but the line
 * hash belongs to a failure below `sigV1`'s specificity floor, and the line it
 * would render says only "this failed, and publish if it was worth it" — which
 * `CAPTURE_ASK` says two lines above, and which the agent can read off its own
 * context anyway. The fingerprint is the one thing it cannot derive itself, so
 * the fingerprint is what earns the line. On a machine where most failures are
 * too generic to key, the ask grew one such line per failure and said nothing
 * new each time.
 *
 * NOT WHAT ARMS THE ASK — that reads {@link failuresHit}. A failure with no
 * fingerprint is still worth publishing about: the failure arm asks the shelf
 * about exactly these IN WORDS (`arms/failure.ts`, the text stage), and a piece
 * published with no `--key` is found by that same text.
 */
function failureLines(hit: readonly FailureHit[]): string[] {
  return hit.filter((f) => f.keys.length > 0).map((f) => FAILURE_LINE(f.line, f.keys));
}

/**
 * What this session's children published, oldest first (principle 5).
 *
 * The queue is machine-wide, so the `started` marks are the filter: an agent
 * with no start in this session is another session's child, and its publish is
 * not this lead's to be told about. One line per PUBLISH, not per agent — the
 * `@<at>` suffix is what keeps a child's second publish from hiding its first.
 */
function publishedLines(db: LoopDb, session: string): string[] {
  const types = new Map<string, string>();
  const marks = db
    .prepare('SELECT agent, value FROM marks WHERE session = ? AND key = ?')
    .all(session, STARTED_MARK) as unknown as Array<{ agent?: unknown; value?: unknown }>;
  for (const mark of marks) {
    if (typeof mark.agent === 'string' && mark.agent !== '') {
      types.set(mark.agent, typeof mark.value === 'string' ? mark.value : '');
    }
  }
  const out: string[] = [];
  for (const fact of factsWithPrefix(db, PUBLISHED_AGENT_PREFIX)) {
    const rest = fact.key.slice(PUBLISHED_AGENT_PREFIX.length);
    const agent = rest.slice(0, rest.lastIndexOf('@'));
    const agentType = types.get(agent);
    if (agentType === undefined) continue;
    let url: unknown;
    try {
      url = (JSON.parse(fact.value) as { url?: unknown }).url;
    } catch {
      continue;
    }
    if (typeof url === 'string' && url !== '') {
      out.push(CHILD_PUBLISHED_LINE(clean(agentType, 64), agent, clean(url, 300)));
    }
  }
  return out;
}

/**
 * The kind of evidence that earns this actor an ask, or null. Each new kind is
 * appended, never inserted, so no ASKED value a ledger already holds changes
 * meaning.
 *
 * An open CLI miss of this actor's own is evidence for a child and a lead
 * alike: the agent chose to ask, and the ask is what closes that loop.
 *
 * `failure` needs no team-origin guard of its own, unlike `activity`: the
 * failure arm plans nothing at all without one (`arms/failure.ts`), so a
 * machine with no team shelf writes no failure fire to find here.
 */
function evidence(ctx: FireContext, misses: string[], hasFailures: boolean): Evidence | null {
  const { db } = ctx.deps;
  const actor = ctx.actor;
  if (actor.agent !== '') {
    if (hasMark(db, actor, EDITED_PREFIX)) return 'edited';
    if (fired(db, actor, CHILD_RESEARCH_SQL)) return 'research';
    if (getMark(db, actor, HANDOFF_MISS) !== null) return 'handoff-miss';
    if (misses.length > 0) return 'miss';
    if (hasFailures) return 'failure';
    return null;
  }
  if (fired(db, actor, LEAD_LOOKUP_SQL)) return 'lookup';
  if (teamOrigin(ctx.deps.config()) !== null && hasMark(db, actor, ACTIVITY_PREFIX))
    return 'activity';
  if (misses.length > 0) return 'miss';
  if (hasFailures) return 'failure';
  return null;
}

/**
 * The project's own `publish.mode`, walking up from `start` to the first
 * `.tenjin.json`, the checkout root or home. A project file may narrow, never
 * widen, so `full-auto` reads as
 * `auto`. A file owned by someone else is skipped, as the CLI skips it. Every
 * failure is null and the global mode answers.
 */
function projectPublishMode(start: string): string | null {
  if (start.length === 0) return null;
  try {
    const home = homedir();
    const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
    const stat = (path: string) => {
      try {
        return statSync(path);
      } catch {
        return null;
      }
    };
    let dir = start;
    for (;;) {
      const candidate = stat(join(dir, '.tenjin.json'));
      if (candidate !== null && (uid === undefined || candidate.uid === uid)) {
        const found = JSON.parse(readFileSync(join(dir, '.tenjin.json'), 'utf8')) as unknown;
        const publish =
          typeof found === 'object' && found !== null
            ? (found as { publish?: { mode?: unknown } }).publish
            : undefined;
        const mode = publish?.mode;
        if (mode === 'review' || mode === 'auto') return mode;
        if (mode === 'full-auto') return 'auto';
        return null;
      }
      if (stat(join(dir, '.git')) !== null || dir === home) return null;
      const parent = dirname(dir);
      if (parent === dir) return null;
      dir = parent;
    }
  } catch {
    return null;
  }
}

/** The child's type: the stop payload's, else what its start recorded. */
function agentTypeOf(ctx: FireContext): string {
  return ctx.input.agentType ?? getMark(ctx.deps.db, ctx.actor, STARTED_MARK) ?? '';
}

/**
 * The ask, or null. Once per actor (`capture:asked`, valued with the kind),
 * re-armed ONLY by a failure the ask did not already name, never by a publish
 * (#294) and no longer by a child's stored finding either, because there is no
 * store. A child is asked too — the ask is context beside its stop, not a
 * decision it has to answer — but never when it is a workflow child with no turn
 * left to answer in.
 */
function ask(ctx: FireContext, audience: 'child' | 'lead'): Emit | null {
  const cfg = ctx.deps.config();
  const { db, clock } = ctx.deps;
  const { actor, input } = ctx;
  if (!cfg.hooks.publish) return null;
  const askedAt = markAt(db, actor, ASKED);
  // Both audiences: a failure belongs to the actor that hit it, where an open
  // search is the lead's loop to close and a child's publish is the lead's to
  // hear about.
  const hit = failuresHit(db, actor, askedAt);
  const failures = failureLines(hit);
  // A failure hit AFTER the ask re-arms it, and it is the only thing that does
  // now: an actor asked at its first stop and then sent into a wall it had to
  // climb out of has something new to say, and the first ask could not have
  // named it. The re-arm is the lines themselves rather than a second query: an
  // ask re-armed by a failure it would then have nothing to say about is an ask
  // for nothing. Everything else — a publish, a child's stored text — leaves an
  // asked actor alone, and the queue the second of those read is gone.
  if (askedAt !== null && failures.length === 0) return null;
  if (audience === 'child' && agentTypeOf(ctx) === WORKFLOW_AGENT_TYPE) return null;
  const misses = missLines(db, actor);
  // `hit`, never `failures`: the fact arms the ask, the prose only fills it.
  const kind = evidence(ctx, misses, hit.length > 0);
  if (kind === null) return null;
  setMark(db, actor, ASKED, kind, clock());

  const searchId = getMark(db, actor, HANDOFF_MISS) ?? '';
  const flags =
    (audience === 'child' && AGENT_ID_RE.test(actor.agent) ? ` --agent ${actor.agent}` : '') +
    (searchId.length > 0 ? ` --search-id ${searchId}` : '');
  const text = captureAsk({
    mode: projectPublishMode(input.cwd) ?? cfg.publish.mode,
    flags,
    misses,
    failures,
    published: audience === 'lead' ? publishedLines(db, actor.session) : [],
  });
  return { context: text };
}

/**
 * The one stop entry for both arms: an actor not yet asked goes to `ask`, and
 * only the LEAD can come back.
 *
 * A CHILD IS ASKED ONCE, FULL STOP. That was true before this rule was written
 * here — `stop()` used to send an already-asked child to the harvest, which
 * never reached the ask — and it has to be said out loud now the harvest is
 * gone. A child's later turns are its answer turn and whatever follows it; it
 * has no open loop of its own for a second ask to be about, and the failure
 * re-arm below is the lead's.
 *
 * THE LEAD'S GUARD LIVES IN `ask`, because the one thing that re-arms it is a
 * failure it hit after being asked, and only `ask` has read the ledger.
 *
 * SAYING NOTHING IS NOT SKIPPING. The fire still writes its row — this decides
 * what the agent reads, not whether the daemon records the stop — and it is what
 * keeps the turn that ANSWERS an ask from being asked again: `capture:asked` is
 * already set by then, on the lead's `stopFuse` turn as on a child's.
 */
export function stop(ctx: FireContext, audience: 'child' | 'lead'): Emit | null {
  if (audience === 'child' && getMark(ctx.deps.db, ctx.actor, ASKED) !== null) return null;
  return ask(ctx, audience);
}
