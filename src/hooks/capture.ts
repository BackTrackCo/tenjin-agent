import { randomUUID } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Emit } from '../adapters/types';
import { AGENT_ID_RE } from '../lib/grade';
import { mask } from '../lib/redact';
import { factsWithPrefix, setFact } from './facts';
import { projectOf } from './failure/pairings';
import { getMark, setMark } from './gates';
import { teamOrigin } from './legs/shelf';
import { captureAsk, FINDING_TAG, type QueuedLine } from './prose';
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
const HANDOFF_MISS = 'handoff:miss';
const STARTED = 'started';
const EDITED_PREFIX = 'edited:';
const ACTIVITY_PREFIX = 'activity:';
const FINDING_PREFIX = 'finding:';

/** The harness's type for a child stopped once its structured output is
 *  written: it has no turn left to answer an ask in (pr298, probed). */
const WORKFLOW_AGENT_TYPE = 'workflow-subagent';

export type Evidence = 'edited' | 'research' | 'handoff-miss' | 'lookup' | 'activity' | 'finding';

/** Any WebSearch, WebFetch, edit, Read or Bash fire by the child counts. */
const CHILD_ARMS = ['research', 'fetch', 'context'];
const LEAD_ARMS = ['prompt', 'research', 'fetch'];
/** The reasons that mean a lookup actually ran, as opposed to being skipped. */
const LOOKUP_RAN = ['hit', 'no-hit', 'cached', 'seen', 'no-answer', 'rate-server'];

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

function fired(db: LoopDb, actor: Actor, arms: string[], reasons: string[] | null): boolean {
  const marks = (list: string[]) => list.map(() => '?').join(', ');
  const where = reasons === null ? '' : ` AND reason IN (${marks(reasons)})`;
  return (
    db
      .prepare(
        `SELECT 1 FROM fires WHERE session = ? AND agent = ? AND arm IN (${marks(arms)})${where} LIMIT 1`,
      )
      .get(actor.session, actor.agent, ...arms, ...(reasons ?? [])) !== undefined
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

/** The kind of evidence that earns this actor an ask, or null. */
export function evidence(ctx: FireContext): Evidence | null {
  const { db } = ctx.deps;
  const actor = ctx.actor;
  if (actor.agent !== '') {
    if (hasMark(db, actor, EDITED_PREFIX)) return 'edited';
    if (fired(db, actor, CHILD_ARMS, null)) return 'research';
    if (getMark(db, actor, HANDOFF_MISS) !== null) return 'handoff-miss';
    return null;
  }
  if (fired(db, actor, LEAD_ARMS, LOOKUP_RAN)) return 'lookup';
  if (teamOrigin(ctx.deps.config()) !== null && hasMark(db, actor, ACTIVITY_PREFIX))
    return 'activity';
  if (childFindings(db, actor.session).length > 0) return 'finding';
  return null;
}

/**
 * The project's own `publish.mode`, walking up from `start` to the first
 * `.tenjin.json`, the checkout root or home (ported from `hook-scripts.ts`,
 * minimal). A project file may narrow, never widen, so `full-auto` reads as
 * `auto`. A file owned by someone else is skipped, as the CLI skips it. Every
 * failure is null and the global mode answers.
 */
export function projectPublishMode(start: string): string | null {
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
  return ctx.input.agentType ?? getMark(ctx.deps.db, ctx.actor, STARTED) ?? '';
}

/**
 * The ask, or null. Once per actor (`capture:asked`, valued with the kind);
 * the lead is re-armed only by a child's finding newer than its ask, never by
 * a publish (#294). A child is asked only under `block` — a `SubagentStop`
 * hook has no non-blocking channel to the child, so asking IS blocking — and
 * never when it is a workflow child with no turn left.
 */
export function ask(ctx: FireContext, audience: 'child' | 'lead'): Emit | null {
  const cfg = ctx.deps.config();
  const { db, clock } = ctx.deps;
  const { actor, input } = ctx;
  if (cfg.hooks.capture === 'off') return null;
  const askedAt = markAt(db, actor, ASKED);
  const queued = audience === 'lead' ? childFindings(db, actor.session) : [];
  if (askedAt !== null && !queued.some((q) => q.finding.at > askedAt)) return null;
  if (
    audience === 'child' &&
    (cfg.hooks.capture !== 'block' || agentTypeOf(ctx) === WORKFLOW_AGENT_TYPE)
  )
    return null;
  const kind = evidence(ctx);
  if (kind === null) return null;
  setMark(db, actor, ASKED, kind, clock());

  const searchId = getMark(db, actor, HANDOFF_MISS) ?? '';
  const flags =
    (audience === 'child' && AGENT_ID_RE.test(actor.agent) ? ` --agent ${actor.agent}` : '') +
    (searchId.length > 0 ? ` --search-id ${searchId}` : '');
  const text = captureAsk({
    team: teamOrigin(cfg) !== null,
    mode: projectPublishMode(input.cwd) ?? cfg.publish.mode,
    flags,
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
  return cfg.hooks.capture === 'block' && input.stopFuse === false
    ? { block: { reason: text } }
    : { context: text };
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
 * stop is a no-op rather than a re-parse.
 */
export function harvest(ctx: FireContext): void {
  const { db, clock } = ctx.deps;
  const { actor, input } = ctx;
  if (getMark(db, actor, HARVESTED) !== null) return;
  const block = findingBlock(input.lastMessage ?? '');
  let value = 'none';
  if (block !== null) {
    const id = randomUUID();
    const finding: Finding = {
      ...block,
      session: actor.session,
      agent: actor.agent,
      agentType: actor.agent === '' ? '' : agentTypeOf(ctx),
      project: projectOf(input.cwd),
      searchId: getMark(db, actor, HANDOFF_MISS) ?? '',
      at: clock(),
    };
    setFact(db, FINDING_PREFIX + id, JSON.stringify(finding), clock());
    value = id;
  }
  setMark(db, actor, HARVESTED, value, clock());
}
