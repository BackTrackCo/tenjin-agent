import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Emit } from '../adapters/types';
import { AGENT_ID_RE } from '../lib/grade';
import { STARTED_MARK } from './actor';
import { EDITED_PREFIX } from './arms/context';
import { factsWithPrefix } from './facts';
import { getMark, setMark } from './gates';
import { teamOrigin } from './legs/shelf';
import { captureAsk, CHILD_PUBLISHED_LINE, FIX_LINE, MISS_LINE } from './prose';
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

type Evidence = 'edited' | 'research' | 'handoff-miss' | 'lookup' | 'activity' | 'miss';

/** Any WebSearch or WebFetch row by the child counts. A READ DOES NOT: decision
 *  2's "one Read is a row" is withdrawn (owner, 2026-09-12), because a Read is
 *  the cheapest row an agent can produce and counting it asked nearly every
 *  child regardless of what it had done. The context arm's other rows — a Read
 *  on `tool.after`, a Bash call on `tool.before` — are not evidence. */
const CHILD_RESEARCH_SQL = "arm IN ('research', 'fetch')";
/** The lead's own lookups that actually ran, as opposed to being skipped. */
const LEAD_LOOKUP_SQL =
  "arm IN ('prompt', 'research', 'fetch') AND reason IN ('hit', 'no-hit', 'cached', 'seen', 'no-answer', 'rate-server')";

function hasMark(db: LoopDb, actor: Actor, prefix: string): boolean {
  return (
    db
      .prepare(
        'SELECT 1 FROM marks WHERE session = ? AND agent = ? AND substr(key, 1, ?) = ? LIMIT 1',
      )
      .get(actor.session, actor.agent, prefix.length, prefix) !== undefined
  );
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

/**
 * The errors this session closed that no piece explains yet, oldest first.
 * THE LEAD'S ASK ONLY, like the misses: the session's closed pairings are not
 * a child's to write up.
 *
 * CODE SCOPE ONLY: a `user`-scope pairing is a typo in a command, and its fix
 * teaches nobody. A row with a `post_id` has already been written up, so it is
 * named once and never again — that stamp is what `publish --key` writes.
 */
function fixLines(db: LoopDb, session: string): string[] {
  const rows = db
    .prepare(
      `SELECT p.kind, p.key, p.error_line FROM pairings p
       JOIN pairing_closes c ON c.pairing_id = p.id
       WHERE c.session = ? AND p.post_id IS NULL AND p.scope = 'code'
         AND p.closed_at IS NOT NULL AND p.error_line IS NOT NULL
       ORDER BY p.closed_at, p.id`,
    )
    .all(session) as unknown as Array<{ kind?: unknown; key?: unknown; error_line?: unknown }>;
  const out: string[] = [];
  for (const row of rows) {
    const kind = typeof row.kind === 'string' ? row.kind : '';
    const key = typeof row.key === 'string' ? row.key : '';
    const line = clean(typeof row.error_line === 'string' ? row.error_line : '', 200);
    if (kind !== '' && key !== '' && line !== '') out.push(FIX_LINE(line, kind, key));
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

/** The kind of evidence that earns this actor an ask, or null. An open CLI
 *  miss of this actor's own is evidence for a child and a lead alike: the
 *  agent chose to ask, and the ask is what closes that loop. */
function evidence(ctx: FireContext, misses: string[]): Evidence | null {
  const { db } = ctx.deps;
  const actor = ctx.actor;
  if (actor.agent !== '') {
    if (hasMark(db, actor, EDITED_PREFIX)) return 'edited';
    if (fired(db, actor, CHILD_RESEARCH_SQL)) return 'research';
    if (getMark(db, actor, HANDOFF_MISS) !== null) return 'handoff-miss';
    if (misses.length > 0) return 'miss';
    return null;
  }
  if (fired(db, actor, LEAD_LOOKUP_SQL)) return 'lookup';
  if (teamOrigin(ctx.deps.config()) !== null && hasMark(db, actor, ACTIVITY_PREFIX))
    return 'activity';
  if (misses.length > 0) return 'miss';
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
 * The ask, or null. ONCE PER ACTOR, and {@link stop} owns that guard: nothing
 * re-arms an agent that has already been asked, not a publish (#294) and no
 * longer a child's stored finding either, because there is no store. A child is
 * asked too — the ask is context beside its stop, not a decision it has to
 * answer — but never when it is a workflow child with no turn left to answer in.
 */
function ask(ctx: FireContext, audience: 'child' | 'lead'): Emit | null {
  const cfg = ctx.deps.config();
  const { db, clock } = ctx.deps;
  const { actor, input } = ctx;
  if (!cfg.hooks.publish) return null;
  if (audience === 'child' && agentTypeOf(ctx) === WORKFLOW_AGENT_TYPE) return null;
  const misses = missLines(db, actor);
  const kind = evidence(ctx, misses);
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
    fixes: audience === 'lead' ? fixLines(db, actor.session) : [],
    published: audience === 'lead' ? publishedLines(db, actor.session) : [],
  });
  return { context: text };
}

/**
 * The one stop entry for both arms: an actor not yet asked is asked, and one
 * that has been is left alone.
 *
 * SAYING NOTHING IS NOT SKIPPING. The fire still writes its row — this decides
 * what the agent reads, not whether the daemon records the stop — and it is
 * what keeps the turn that ANSWERS an ask from being asked again: `capture:asked`
 * is already set by then, on the lead's `stopFuse` turn as on a child's.
 */
export function stop(ctx: FireContext, audience: 'child' | 'lead'): Emit | null {
  if (getMark(ctx.deps.db, ctx.actor, ASKED) !== null) return null;
  return ask(ctx, audience);
}
