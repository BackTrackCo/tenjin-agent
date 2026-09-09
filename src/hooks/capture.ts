import { randomUUID } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Emit } from '../adapters/types';
import { AGENT_ID_RE } from '../lib/grade';
import { mask } from '../lib/redact';
import { failureKeyFingerprints, projectId } from './failure/keys';
import { STARTED_MARK } from './actor';
import { EDITED_PREFIX } from './arms/context';
import { factsWithPrefix, setFact } from './facts';
import { getMark, setMark } from './gates';
import { teamOrigin } from './legs/shelf';
import {
  captureAsk,
  CHILD_PUBLISHED_LINE,
  FAILURE_LINE,
  FINDING_TAG,
  MISS_LINE,
  type QueuedLine,
} from './prose';
import type { LoopDb } from './store';
import { clean } from './text';
import type { Actor, FireContext } from './types';

/**
 * Capture: one module for the child and the lead (13-pr-d-local-arms.md,
 * proposal B). A child that did work is asked once, at its stop, to publish
 * while it still holds the evidence; the lead is asked once at its turn end
 * and told what its children queued. The second stop after an ask harvests
 * the fenced fallback out of the last message into `facts`.
 *
 * EVIDENCE IS LOOSE (decision 2): one Read is a row, so nearly every child
 * gets one ask. The kind that earned it is the `capture:asked` mark's value,
 * so the rule can be tightened later from the ledger rather than from a guess.
 *
 * NO TIMER, NO BUDGET, NO TRANSCRIPT (decision 14): every gate below is a
 * query over rows that already exist.
 */

const ASKED = 'capture:asked';
const HARVESTED = 'capture:harvested';
/** Written by subagent-start on a claimed miss, valued with the search id. */
export const HANDOFF_MISS = 'handoff:miss';
const ACTIVITY_PREFIX = 'activity:';
const FINDING_PREFIX = 'finding:';
/** One row per child publish, keyed `agent_published:<agent>@<at>`
 *  (`lib/publish-dedup.ts`, the CLI's writer). */
const PUBLISHED_AGENT_PREFIX = 'agent_published:';

/** The harness's type for a child stopped once its structured output is
 *  written: it has no turn left to answer an ask in (pr298, probed). */
const WORKFLOW_AGENT_TYPE = 'workflow-subagent';

type Evidence =
  'edited' | 'research' | 'handoff-miss' | 'lookup' | 'activity' | 'finding' | 'failure';

/** Any WebSearch, WebFetch or Read row by the child counts (decision 2). The
 *  context arm's other row, a Bash call on `tool.before`, is not evidence. */
const CHILD_RESEARCH_SQL =
  "(arm IN ('research', 'fetch') OR (arm = 'context' AND event = 'tool.after'))";
/** The lead's own lookups that actually ran, as opposed to being skipped. */
const LEAD_LOOKUP_SQL =
  "arm IN ('prompt', 'research', 'fetch') AND reason IN ('hit', 'no-hit', 'cached', 'seen', 'no-answer', 'rate-server')";
/** A failure fire whose shelves had nothing: the two reasons that mean "asked,
 *  and came back empty". `no-hit` is a definite miss, `no-answer` a leg that
 *  never landed. `asked`, `cached` and `seen` are the same failure a second
 *  time and are not a second thing to write up. Its own constant rather than
 *  another arm in {@link LEAD_LOOKUP_SQL}, which would widen the ask to failure
 *  `hit` rows too and give the ASKED mark a value that no longer says which
 *  rule bit. */
const FAILURE_MISS_SQL = "arm = 'failure' AND reason IN ('no-hit', 'no-answer')";

function hasMark(db: LoopDb, actor: Actor, prefix: string): boolean {
  return (
    db
      .prepare(
        'SELECT 1 FROM marks WHERE session = ? AND agent = ? AND substr(key, 1, ?) = ? LIMIT 1',
      )
      .get(actor.session, actor.agent, prefix.length, prefix) !== undefined
  );
}

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

/** What `finding:<uid>` holds. `publish --finding` reads it from E on. */
interface Finding {
  title: string;
  body: string;
  session: string;
  agent: string;
  agentType: string;
  project: string | null;
  searchId: string;
  at: number;
}

/** This session's children's findings, oldest first. The lead's own harvest
 *  is a fact too, but nothing lists it back to the lead that wrote it. */
function childFindings(db: LoopDb, session: string): Array<{ id: string; finding: Finding }> {
  const out: Array<{ id: string; finding: Finding }> = [];
  for (const fact of factsWithPrefix(db, FINDING_PREFIX)) {
    let finding: Finding;
    try {
      finding = JSON.parse(fact.value) as Finding;
    } catch {
      continue;
    }
    if (finding.session !== session || finding.agent === '') continue;
    out.push({ id: fact.key.slice(FINDING_PREFIX.length), finding });
  }
  return out;
}

/**
 * This session's deliberate `tenjin search` misses that nothing has closed,
 * oldest first, one line each. THE LEAD'S ASK ONLY: an open search is the
 * lead's loop to close, and a child cannot resolve one it never opened.
 *
 * THE CLI'S ROWS ONLY. `searches` is written by `tenjin search`, so every row is
 * a question the agent decided was worth asking; a null `source` is a row an
 * older CLI wrote before the column existed and is the same kind of question.
 * The hooks' own lookups live in `fires`/`legs` and are nobody's open loop.
 */
function missLines(db: LoopDb, session: string): string[] {
  const rows = db
    .prepare(
      `SELECT search_id, question FROM searches
       WHERE session = ? AND decision = 'MISS' AND resolved_at IS NULL
         AND (source = 'cli' OR source IS NULL)
       ORDER BY at, rowid`,
    )
    .all(session) as unknown as Array<{ search_id?: unknown; question?: unknown }>;
  const out: string[] = [];
  for (const row of rows) {
    const id = typeof row.search_id === 'string' ? row.search_id : '';
    const question = clean(typeof row.question === 'string' ? row.question : '', 200);
    if (id !== '' && question !== '') out.push(MISS_LINE(question, id));
  }
  return out;
}

/**
 * The failures this actor hit that the shelves had nothing for, oldest first,
 * one line each. THE `fires` ROW IS THE RECORD: `fire.ts` sets the plan's
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
function failureLines(db: LoopDb, actor: Actor, since: number | null): string[] {
  const rows = db
    .prepare(
      `SELECT question_key, question, at FROM fires
       WHERE session = ? AND agent = ? AND ${FAILURE_MISS_SQL}
         AND question_key IS NOT NULL AND question_key != ''
       ORDER BY at, rowid`,
    )
    .all(actor.session, actor.agent) as unknown as Array<{
    question_key?: unknown;
    question?: unknown;
    at?: unknown;
  }>;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const row of rows) {
    const key = typeof row.question_key === 'string' ? row.question_key : '';
    if (key === '' || seen.has(key)) continue;
    seen.add(key);
    if (since !== null && (typeof row.at === 'number' ? row.at : 0) <= since) continue;
    // Already masked and cut at the shelf's bound on the way into the row; the
    // second cut here is for the line's own width and nothing else.
    const line = clean(typeof row.question === 'string' ? row.question : '', 200);
    out.push(FAILURE_LINE(line, failureKeyFingerprints(key)));
  }
  return out;
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
 * `failure` needs no team-origin guard of its own, unlike `activity`: the
 * failure arm plans nothing at all without one (`arms/failure.ts`), so a
 * machine with no team shelf writes no failure fire to find here.
 */
function evidence(ctx: FireContext): Evidence | null {
  const { db } = ctx.deps;
  const actor = ctx.actor;
  if (actor.agent !== '') {
    if (hasMark(db, actor, EDITED_PREFIX)) return 'edited';
    if (fired(db, actor, CHILD_RESEARCH_SQL)) return 'research';
    if (getMark(db, actor, HANDOFF_MISS) !== null) return 'handoff-miss';
    if (fired(db, actor, FAILURE_MISS_SQL)) return 'failure';
    return null;
  }
  if (fired(db, actor, LEAD_LOOKUP_SQL)) return 'lookup';
  if (teamOrigin(ctx.deps.config()) !== null && hasMark(db, actor, ACTIVITY_PREFIX))
    return 'activity';
  if (childFindings(db, actor.session).length > 0) return 'finding';
  if (fired(db, actor, FAILURE_MISS_SQL)) return 'failure';
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
 * The ask, or null. Once per actor (`capture:asked`, valued with the kind);
 * re-armed only by a child's finding newer than the ask or a failure the ask
 * did not already name, never by a publish (#294). A child is asked too — the
 * ask is context beside its stop, not a decision it has to answer — but never
 * when it is a workflow child with no turn left to answer in.
 */
function ask(ctx: FireContext, audience: 'child' | 'lead'): Emit | null {
  const cfg = ctx.deps.config();
  const { db, clock } = ctx.deps;
  const { actor, input } = ctx;
  if (!cfg.hooks.publish) return null;
  const askedAt = markAt(db, actor, ASKED);
  const queued = audience === 'lead' ? childFindings(db, actor.session) : [];
  // Both audiences: a failure belongs to the actor that hit it, where an open
  // search is the lead's loop to close and a child's publish is the lead's to
  // hear about.
  const failures = failureLines(db, actor, askedAt);
  // A failure hit AFTER the ask re-arms it, the same shape as the queued
  // finding beside it: an actor asked at its first stop and then sent into a
  // wall it had to climb out of has something new to say, and the first ask
  // could not have named it. In practice that is the lead's, because `stop()`
  // sends an already-asked child to `harvest` and never here. The re-arm is
  // the lines themselves rather than a second query: an ask re-armed by a
  // failure it would then have nothing to say about is an ask for nothing.
  if (askedAt !== null && !queued.some((q) => q.finding.at > askedAt) && failures.length === 0)
    return null;
  if (audience === 'child' && agentTypeOf(ctx) === WORKFLOW_AGENT_TYPE) return null;
  const kind = evidence(ctx);
  if (kind === null) return null;
  setMark(db, actor, ASKED, kind, clock());

  const searchId = getMark(db, actor, HANDOFF_MISS) ?? '';
  const flags =
    (audience === 'child' && AGENT_ID_RE.test(actor.agent) ? ` --agent ${actor.agent}` : '') +
    (searchId.length > 0 ? ` --search-id ${searchId}` : '');
  const text = captureAsk({
    mode: projectPublishMode(input.cwd) ?? cfg.publish.mode,
    flags,
    misses: audience === 'lead' ? missLines(db, actor.session) : [],
    failures,
    published: audience === 'lead' ? publishedLines(db, actor.session) : [],
    queued: queued.map((q): QueuedLine => ({
      id: q.id,
      agentType: clean(q.finding.agentType, 64),
      agent: clean(q.finding.agent, 64),
      searchId: clean(q.finding.searchId, 64),
      // Raw in `facts`, cleaned here (decision 15), at the bound the
      // delivery header line already puts on a title.
      title: clean(q.finding.title, 160),
    })),
  });
  return { context: text };
}

const FINDING_OPEN = '```' + FINDING_TAG;
const FINDING_FENCE = '```';

/** Each line of `text`, trimmed, with its [start, end) offsets. One pass, no
 *  regex: everything the fence parse does is on text an agent chose. */
function eachLine(
  text: string,
  visit: (line: string, start: number, end: number) => boolean | undefined,
): void {
  let i = 0;
  while (i <= text.length) {
    const nl = text.indexOf('\n', i);
    const end = nl === -1 ? text.length : nl;
    if (visit(text.slice(i, end).trim(), i, end) === false) return;
    if (nl === -1) return;
    i = nl + 1;
  }
}

/** Where the marked block opens, or -1: a line of its own, and the LAST one,
 *  so an agent that mentions the marker while declining does not harvest its
 *  own decline, and one that quotes it on the way to a block keeps the block. */
function findingOpen(text: string): number {
  let at = -1;
  eachLine(text, (line, _start, end) => {
    if (line === FINDING_OPEN) at = end;
    return undefined;
  });
  return at;
}

/** Where the block closes, relative to `body`, or -1 for unterminated.
 *  Fence-aware: a bare ``` closes the innermost fence, ```js nests one, so a
 *  code snippet inside the finding does not end the harvest early. */
function findingClose(body: string): number {
  let at = -1;
  let depth = 0;
  eachLine(body, (line, start) => {
    if (!line.startsWith(FINDING_FENCE)) return undefined;
    if (line !== FINDING_FENCE) {
      depth += 1;
      return undefined;
    }
    if (depth === 0) {
      at = start;
      return false;
    }
    depth -= 1;
    return undefined;
  });
  return at;
}

/**
 * The first `# ` line split off as the title, both halves masked, nothing
 * cut (decision 11) and nothing dropped: a block with no heading, or a heading
 * with nothing under it, is the whole body with an empty title.
 */
export function splitFinding(raw: string): { title: string; body: string } | null {
  const heading = /^\s*#{1,6}[ \t]+(\S[^\n]*)\n([\s\S]+)$/.exec(raw);
  if (heading !== null) {
    const title = mask(heading[1] ?? '').trim();
    const body = mask(heading[2] ?? '').trim();
    if (title !== '' && body !== '') return { title, body };
  }
  const whole = mask(raw).trim();
  return whole === '' ? null : { title: '', body: whole };
}

/** The marked block out of a final answer, or null. An unclosed fence is
 *  read to the end: an agent that forgot the close still settled the thing. */
export function findingBlock(text: string): { title: string; body: string } | null {
  const start = findingOpen(text);
  if (start === -1) return null;
  const rest = text.slice(start + 1);
  const end = findingClose(rest);
  return splitFinding(end === -1 ? rest : rest.slice(0, end));
}

/**
 * The stop after an ask: one `finding:<uid>` fact when the last message
 * carries the fence, and the `capture:harvested` mark either way, so a later
 * stop is a no-op rather than a re-parse. Once PER ASK: a lead re-armed by a
 * child's finding answers a second time, and that answer is read too.
 */
function harvest(ctx: FireContext): void {
  const { db, clock } = ctx.deps;
  const { actor, input } = ctx;
  const harvestedAt = markAt(db, actor, HARVESTED);
  if (harvestedAt !== null && harvestedAt >= (markAt(db, actor, ASKED) ?? 0)) return;
  const block = findingBlock(input.lastMessage ?? '');
  let value = 'none';
  if (block !== null) {
    const id = randomUUID();
    const finding: Finding = {
      ...block,
      session: actor.session,
      agent: actor.agent,
      agentType: actor.agent === '' ? '' : agentTypeOf(ctx),
      project: projectId(input.cwd),
      searchId: getMark(db, actor, HANDOFF_MISS) ?? '',
      at: clock(),
    };
    setFact(db, FINDING_PREFIX + id, JSON.stringify(finding), clock());
    value = id;
  }
  setMark(db, actor, HARVESTED, value, clock());
}

/**
 * The one stop entry for both arms: an actor not yet asked is asked; a child
 * already asked is on its answer turn and is harvested; a lead already asked
 * is harvested on its answer turn (`stopFuse`) and otherwise re-asked only if
 * a newer child finding or a newer failure re-arms it (`ask`).
 */
export function stop(ctx: FireContext, audience: 'child' | 'lead'): Emit | null {
  const asked = getMark(ctx.deps.db, ctx.actor, ASKED) !== null;
  if (asked && (audience === 'child' || ctx.input.stopFuse === true)) {
    harvest(ctx);
    return null;
  }
  return ask(ctx, audience);
}
