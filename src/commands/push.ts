import { homedir } from 'node:os';
import { loadRawConfig, resolveSettings } from '../lib/config';
import { persistPushMode } from './config';
import { hooksDisclosure } from './install';
import { hookFallthroughAsked, hookFallthroughHost, hookRecipientHost } from '../lib/settings';
import { CliError } from '../lib/errors';
import { countPushHookEntries, pushScriptsPresent, wireSearchHooks } from '../lib/harness-hooks';
import type { HooksResult, PushHookEntryCount } from '../lib/harness-hooks';
import { openStore, STORE_SQL } from '../lib/state-store';
import type { CommandContext, CommandResult } from '../context';

/**
 * `tenjin push on|off|status` (docs/command-reference.md#push-experimental): the runtime toggle for the push
 * experiment, the sidecar half of the marketplace that surfaces a finding beside
 * a failing command, a stuck edit loop, or a subagent dispatch, without being
 * asked for it first.
 *
 * `on` and `off` write the SAME key `tenjin install` already reads
 * (`hooks.push`), through the same locked read-modify-write every `config set`
 * uses (see `persistPushMode` in commands/config.ts) — this command is a
 * convenience front end over that key plus the wiring step, not a second
 * mechanism. `on` additionally wires the four push hook scripts immediately
 * (idempotent, like every `wireSearchHooks` call: a second run registers nothing
 * new), so an operator does not have to separately remember to re-run `tenjin
 * install`. `off` writes the key and stops: every push arm reads `hooks.push` at
 * the top of its own run (see readConfig() in hook-scripts.ts), so an already
 * wired script goes inert on its NEXT invocation with no unwiring step at all.
 */

const LEDGER_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const LEDGER_WINDOW_DAYS = 7;

export interface PushOnDeps {
  /** Home whose `.claude/settings.json` gets the push entries; defaults to os.homedir(). */
  homeDir?: string;
  /** Seam for the wiring call itself; defaults to the real `wireSearchHooks`. */
  wire?: typeof wireSearchHooks;
}

/**
 * Turn the push experiment on: persist `hooks.push=on`, then wire the four push
 * hook scripts (prompt, failure, subagent, context) alongside whatever search
 * hooks are already configured. Typing `tenjin push on` IS the operator's
 * consent to wire Claude Code hooks, the only harness the push arms target
 * today, the same way `tenjin config set hooks.webSearch auto` is consent
 * enough for the search hooks it governs.
 *
 * IT IS NOT CONSENT TO OVERRIDE THE TWO GATES `install` APPLIES, and this
 * command used to call `wireSearchHooks` straight past both of them:
 *
 *  - `hooks.webSearch: off` is the kill switch for this whole bundle, and
 *    `install` on that setting writes NOTHING into settings.json. Wiring six
 *    more entries there because a different verb was typed would make `off` mean
 *    something different depending on which command you reached for, so this
 *    refuses and names the command that lifts it. Refused BEFORE the config
 *    write: a command that declines to act must not leave the key flipped.
 *  - A recorded `--harness` set that does not include Claude Code says the
 *    operator's harness is not the one these arms hook. `install` skips there
 *    (`harness-not-claude`) and so does this, out loud. An EMPTY record is not
 *    that statement: it only means no past install passed `--harness`, which is
 *    the common case and wires as before.
 *
 * And a run that does wire six entries into the operator's home has to disclose
 * what they do, in the same words `install` uses.
 */
export async function runPushOn(
  ctx: CommandContext,
  deps: PushOnDeps = {},
): Promise<CommandResult> {
  const raw = await loadRawConfig(ctx.dataDir);
  const settings = resolveSettings({
    config: raw,
    flags: { baseUrl: ctx.flags.baseUrl },
    env: process.env,
  });
  if (settings.hooksWebSearch.value === 'off') {
    throw new CliError(
      'USAGE',
      // NOT "the kill switch for every hook this CLI writes", which this used to
      // say and which is false about push arms that are already wired: those read
      // `hooks.push` at run time and nothing else. What `webSearch off` is, is
      // the decision not to REGISTER anything — which is why there is no wiring
      // path for these arms to join.
      'hooks.webSearch is off, which is the decision not to register any hook entries at all, so the push arms were not wired and hooks.push was left as it was. (Once wired, the push arms are switched by `tenjin push off`; this key does not reach them.)',
      { fix: 'tenjin config set hooks.webSearch auto, then tenjin push on' },
    );
  }
  // The set a past `--harness` install recorded; empty means nothing was ever
  // recorded, NOT that Claude Code is absent.
  const recorded = raw.install?.harness ?? [];
  if (recorded.length > 0 && !recorded.includes('claude')) {
    // The mode is still persisted: it is a durable preference, it costs nothing
    // without scripts, and it is what makes a later `tenjin install` on a
    // machine that does have Claude Code wire the arms with no second command.
    await persistPushMode(ctx.dataDir, 'on');
    return {
      data: { mode: 'on', hooks: null, skipped: 'harness-not-claude' },
      humanLines: [
        `hooks.push is on, but nothing was wired (harness-not-claude): your recorded install harness is ${recorded.join(', ')}, and the push arms are Claude Code hooks.`,
        'Wire them: tenjin install --harness claude, then tenjin push on',
      ],
    };
  }
  await persistPushMode(ctx.dataDir, 'on');
  const result = await (deps.wire ?? wireSearchHooks)({
    homeDir: deps.homeDir ?? homedir(),
    dataDir: ctx.dataDir,
    mode: settings.hooksWebSearch.value,
    push: true,
  });
  return {
    data: { mode: 'on', hooks: result },
    humanLines: renderWireLines(
      result,
      hookRecipientHost(raw),
      hookFallthroughHost(raw),
      hookFallthroughAsked(raw),
    ),
  };
}

/**
 * Turn the push experiment off: persist `hooks.push=off` and stop. Nothing is
 * unwired — every push arm's first line reads this config key and exits in
 * milliseconds when it is not `on` — so this returns without touching
 * settings.json or the hook scripts at all.
 */
export async function runPushOff(ctx: CommandContext): Promise<CommandResult> {
  await persistPushMode(ctx.dataDir, 'off');
  return {
    data: { mode: 'off' },
    humanLines: [
      'hooks.push is off. The wired scripts (if any) stay on disk but exit instantly on their next invocation — no re-install, no unwiring step.',
    ],
  };
}

export interface PushStatusDeps {
  /** Seam for "are the push scripts on disk"; defaults to a real stat of hooksDir. */
  scriptsWired?: (dataDir: string) => Promise<boolean>;
  /** Seam for "are the push arms registered in settings.json". */
  hookEntries?: (homeDir: string, dataDir: string) => Promise<PushHookEntryCount>;
  /** Home whose `.claude/settings.json` is read; defaults to os.homedir(). */
  homeDir?: string;
  /** Seam for the store read; defaults to the real query. */
  ledgerTallies?: (dataDir: string, nowMs: number) => Promise<PushLedgerTallies>;
  /** Seam for the `--sessions` report; defaults to the real query. */
  sessionScores?: (dataDir: string, nowMs: number) => Promise<PushSessionScore[]>;
  now?: () => number;
}

export interface PushStatusOptions {
  /** `--sessions`: append the importance-score report, one line per session. */
  sessions?: boolean;
}

/**
 * The importance score of one session, as a REPORT (tenjin-agent#212): what the
 * Stop hook's capture gate WOULD have done had it been scored, printed beside
 * what actually happened, so a week of rows says whether the score skips the
 * asks nothing came of and never the session that published. No hook reads it.
 *
 * Five patterns, CommonTrace `detection.py` / `scoring.py`, each counted once
 * per session and weighted; then a bonus of up to 30% when the session's last
 * error resolution or reversal was within 300 s of its end.
 */
export interface PushSessionScore {
  session: string;
  /**
   * The agent these rows belong to, or null for the lead's own turn. One
   * scored line per (session, agent): parallel subagents share their parent's
   * session id, so a session is not a worker and scoring it whole credited one
   * agent's failure to another's fix.
   */
  agent: string | null;
  /** The weighted sum, bonus applied, to one decimal. */
  score: number;
  /** The patterns that fired, by name, in the order of {@link SCORE_WEIGHTS}. */
  patterns: string[];
  /** The recency multiplier actually applied (1.0 = none, up to 1.3). */
  bonus: number;
  events: number;
  /** The Stop hook's capture ask fired in this session (`capture_asked`).
   *  PER SESSION, so it is reported on the parent row only — the ask happens
   *  once at the end of the turn, not once per subagent, and repeating it on
   *  every child line would read as several asks. */
  captureAsked: boolean;
  /** `published:<hash>` and `agent_published:<...>` rows stamped between the
   *  session's start and end (machine-wide rows, attributed by time, so a
   *  concurrent session's publish can be counted here too: read it as "a
   *  publish happened while this session was open"). Same count on every agent
   *  row of one session, for that reason: the window is the session's. */
  published: number;
}

/** The five patterns and their weights, CommonTrace `scoring.py`. */
export const SCORE_WEIGHTS: Readonly<Record<ScorePattern, number>> = {
  'error-edit-resolved': 3.0,
  'edit-across-prompt': 2.5,
  'write-over-edited': 2.5,
  'fail-edit-pass': 2.0,
  'research-then-edit': 2.0,
};
export type ScorePattern =
  | 'error-edit-resolved'
  | 'edit-across-prompt'
  | 'write-over-edited'
  | 'fail-edit-pass'
  | 'research-then-edit';
/** A resolution or reversal this close to the session's end earns the bonus,
 *  scaled linearly from +30% at 0 s to nothing at the edge. */
export const SCORE_RECENCY_MS = 300_000;
export const SCORE_RECENCY_BONUS = 0.3;
/** Write over a file that has this many earlier edits in the session. */
export const SCORE_WRITE_PRIOR_EDITS = 3;

export interface PushLedgerTallies {
  windowDays: number;
  rows: number;
  byTriggerAction: Record<string, Record<string, number>>;
  byShelf: Record<string, number>;
  /** Why a row did not inject. The nine the shipped core writes are
   *  `lookup-cap`, `quiet`, `no-time`, `no-answer`, `miss`, `weak`,
   *  `already-injected`, `already-claimed` (a second agent in the session hit
   *  the same failure signature and the first holds the claim) and `watchdog`
   *  (docs/command-reference.md#push-experimental),
   *  and the team leg by fingerprint adds `keys-off` (the shelf has
   *  KNOWLEDGE_KEYS off; #212 PR B) — but the values are taken from the rows,
   *  never from a list here, so a new reason shows up in `status` the day the
   *  script starts writing it, and a retired one keeps counting out of the rows
   *  that still hold it. */
  byReason: Record<string, number>;
  /** The local error→fix pairings opened in the window (plan 05 rows 9 and
   *  11): how many, how many a later pass closed, how many two independent
   *  passes verified, what scope the closed ones landed in, and which command
   *  heads opened them — the last being what says whether the allowlist is
   *  still letting one head dominate. */
  pairings: PushPairingTallies;
  /** Distinct findings surfaced in the window. A marketplace piece is keyed by
   *  its resourceId and a local pairing by `pairing:<id>`; both land in
   *  `injections.resource_id`. */
  candidates: number;
  injectedTokens: number;
}

export interface PushPairingTallies {
  opened: number;
  /** Rows a later pass closed: `unverified` plus `verified`. */
  closed: number;
  verified: number;
  /** Of the closed rows: `code` may sync to the team shelf, `user` never
   *  leaves the machine, `ambiguous` is counted for the day-14 revisit. */
  scope: Record<string, number>;
  /** Opened rows by the command head they key on. */
  byHead: Record<string, number>;
}

const EMPTY_PAIRINGS: PushPairingTallies = {
  opened: 0,
  closed: 0,
  verified: 0,
  scope: {},
  byHead: {},
};

const EMPTY_TALLIES: PushLedgerTallies = {
  windowDays: LEDGER_WINDOW_DAYS,
  rows: 0,
  byTriggerAction: {},
  byShelf: {},
  byReason: {},
  candidates: 0,
  injectedTokens: 0,
  pairings: EMPTY_PAIRINGS,
};

/**
 * Tally the last {@link LEDGER_WINDOW_DAYS} days of decision rows: total rows, a
 * trigger x action breakdown, a shelf breakdown, and the injected-token total.
 *
 * COMPLETE, NOT A FLOOR. This used to read the last 256 KB of an append-only
 * `push-ledger.jsonl` and say so — `tail: true`, and a human line explaining
 * that the numbers an operator was reading as totals were not — because nothing
 * rotated the file and parsing months of it whole was not an option. The rows
 * are indexed now, so the window is the window and the field is gone with the
 * caveat it carried.
 *
 * Still defensive about the values: a row missing a field is counted under
 * `unknown` rather than failing the command.
 */
export async function readLedgerTallies(
  dataDir: string,
  nowMs: number,
): Promise<PushLedgerTallies> {
  const store = await openStore(dataDir);
  if (store === null) return EMPTY_TALLIES;
  try {
    const rows = store.all(STORE_SQL.statusRows, [nowMs - LEDGER_WINDOW_MS]);
    const byTriggerAction: Record<string, Record<string, number>> = {};
    const byShelf: Record<string, number> = {};
    const byReason: Record<string, number> = {};
    const candidates = new Set<string>();
    let injectedTokens = 0;
    for (const row of rows) {
      const trigger = typeof row.hook === 'string' ? row.hook : 'unknown';
      const action = typeof row.action === 'string' ? row.action : 'unknown';
      const byAction = (byTriggerAction[trigger] ??= {});
      byAction[action] = (byAction[action] ?? 0) + 1;
      const shelf = typeof row.shelf === 'string' ? row.shelf : 'unknown';
      byShelf[shelf] = (byShelf[shelf] ?? 0) + 1;
      if (typeof row.reason === 'string' && row.reason !== '') {
        byReason[row.reason] = (byReason[row.reason] ?? 0) + 1;
      }
      if (typeof row.resource_id === 'string' && row.resource_id !== '') {
        candidates.add(`${shelf}:${row.resource_id}`);
      }
      if (action === 'injected' && typeof row.tokens === 'number' && Number.isFinite(row.tokens)) {
        injectedTokens += row.tokens;
      }
    }
    const pairings: PushPairingTallies = { ...EMPTY_PAIRINGS, scope: {}, byHead: {} };
    for (const row of store.all(STORE_SQL.pairingsStatus, [nowMs - LEDGER_WINDOW_MS])) {
      const n = typeof row.n === 'number' ? row.n : 0;
      const status = typeof row.status === 'string' ? row.status : 'unknown';
      pairings.opened += n;
      if (status === 'unverified' || status === 'verified') {
        pairings.closed += n;
        if (status === 'verified') pairings.verified += n;
        const scope = typeof row.scope === 'string' ? row.scope : 'unknown';
        pairings.scope[scope] = (pairings.scope[scope] ?? 0) + n;
      }
      const head =
        typeof row.cmd_head === 'string' && row.cmd_head !== '' ? row.cmd_head : '(none)';
      pairings.byHead[head] = (pairings.byHead[head] ?? 0) + n;
    }
    return {
      windowDays: LEDGER_WINDOW_DAYS,
      rows: rows.length,
      byTriggerAction,
      byShelf,
      byReason,
      candidates: candidates.size,
      injectedTokens,
      pairings,
    };
  } catch {
    return EMPTY_TALLIES;
  } finally {
    store.close();
  }
}

/** One event row as the score reads it. */
export interface ScoreEvent {
  at: number;
  hook: string;
  tool: string | null;
  /** The agent that fired it (`data.agentId`), or null for the lead's own
   *  turn. The unit the score is scanned over: see {@link ScoreInput}. */
  agentId: string | null;
  /** The basenames the row names (`files`), or none. */
  files: string[];
  /** The failure row's `command` / the pass row's `head` / the prompt row's
   *  `skipped`, whichever the hook wrote. */
  command: string | null;
  head: string | null;
}

export interface ScoreInput {
  /**
   * ONE AGENT'S ROWS, not one session's. Parallel subagents share their
   * parent's `session_id` and are told apart only by `data.agentId`, so a
   * session-wide scan stitched one agent's failure to another's edit and a
   * third's pass and called the result a fix. {@link readSessionScores}
   * partitions before it calls this, and every pattern below is therefore
   * "did ONE worker do this".
   */
  events: ScoreEvent[];
  /**
   * When this SESSION closed a pairing (`pairing_closes.at`).
   *
   * SESSION-WIDE, AND THE PARTITION DOES NOT REACH IT: `pairing_closes` has no
   * agent column, so every agent in the session sees every close. The one
   * pattern this feeds — `error-edit-resolved`, whose resolution may be a close
   * — can still be completed by a sibling's close. Narrowing it needs a column
   * on that table, which is DDL and not this change.
   */
  closes: number[];
  /** When this SESSION ran a search (`searches.at`): the research signal the
   *  `research` event under-reports, since that row is written on a hit only.
   *  Session-wide for the same reason `closes` is, and feeding
   *  `research-then-edit` with the same caveat. */
  searches: number[];
  /** The session's end, or the last thing on record when it has none. */
  endedAt: number | null;
}

const MARKDOWN_RE = /\.(?:md|mdx|markdown)$/i;
/** A test file by name: `x.test.ts`, `x.spec.ts`, `test_x.py`, `x_test.go`, a
 *  `__tests__` member. The fail→edit→pass pattern wants the FIX, not the test
 *  edited until it passes. */
const TEST_FILE_RE = /(?:^|[._-])(?:test|spec)s?(?:[._-]|$)|^test_|_test\./i;

/**
 * Score ONE AGENT's rows within a session. Pure, so the patterns are testable
 * on fixtures without a store; {@link readSessionScores} partitions and feeds
 * it, once per (session, agent).
 *
 * Every pattern is "did this sequence happen at least once", scanned in time
 * order over that agent's own rows — never across siblings, which is the whole
 * reason the caller partitions (see {@link ScoreInput.events}):
 *  - error-edit-resolved: a `failure`, then an `edit`, then a `pass` (any head)
 *    or a pairing close by this session. 3.0.
 *  - edit-across-prompt: the same non-markdown basename edited before and after
 *    a `prompt` row. 2.5.
 *  - write-over-edited: a `Write` over a basename with ≥ 3 earlier edits. 2.5.
 *    Also a REVERSAL for the bonus.
 *  - fail-edit-pass: a `failure` whose command names head H, then an edit of a
 *    non-test file, then a `pass` whose head is H. 2.0. (The failure row
 *    carries the command, not the head, so H is matched as a word of it.)
 *  - research-then-edit: a `research` event or a search, then an `edit`, with
 *    no `failure` between. 2.0.
 * A resolution (the pass or close that completed the first pattern) or a
 * reversal within {@link SCORE_RECENCY_MS} of the session's end multiplies the
 * sum by up to 1 + {@link SCORE_RECENCY_BONUS}, linearly by how close.
 */
export function scoreSession(input: ScoreInput): {
  score: number;
  patterns: ScorePattern[];
  bonus: number;
} {
  const events = [...input.events].sort((a, b) => a.at - b.at);
  const closes = [...input.closes].sort((a, b) => a - b);
  const searches = [...input.searches].sort((a, b) => a - b);
  const fired = new Set<ScorePattern>();
  /** Moments a resolution or reversal happened, for the bonus. */
  const moments: number[] = [];

  // error-edit-resolved and fail-edit-pass: walk failures forward.
  for (let i = 0; i < events.length; i += 1) {
    const failure = events[i]!;
    if (failure.hook !== 'failure') continue;
    let editAt: number | null = null;
    let nonTestEditAt: number | null = null;
    for (let j = i + 1; j < events.length; j += 1) {
      const e = events[j]!;
      if (e.hook === 'edit') {
        editAt ??= e.at;
        if (nonTestEditAt === null && !e.files.some((f) => TEST_FILE_RE.test(f))) {
          nonTestEditAt = e.at;
        }
        continue;
      }
      if (e.hook !== 'pass') continue;
      if (editAt !== null) {
        fired.add('error-edit-resolved');
        moments.push(e.at);
      }
      if (
        nonTestEditAt !== null &&
        e.head !== null &&
        failure.command !== null &&
        commandNamesHead(failure.command, e.head)
      ) {
        fired.add('fail-edit-pass');
      }
      // The first pass after the failure is the one that resolved it; a later
      // pass belongs to a later story.
      break;
    }
    // A close by this session is a resolution too, whether or not the pass
    // event that made it was recorded (the close rule ran before the row did).
    if (editAt !== null) {
      const close = closes.find((at) => at >= editAt);
      if (close !== undefined) {
        fired.add('error-edit-resolved');
        moments.push(close);
      }
    }
  }

  // edit-across-prompt: per basename, an edit before and after some prompt.
  const prompts = events.filter((e) => e.hook === 'prompt').map((e) => e.at);
  if (prompts.length > 0) {
    const byFile = new Map<string, number[]>();
    for (const e of events) {
      if (e.hook !== 'edit') continue;
      for (const f of e.files) {
        if (MARKDOWN_RE.test(f)) continue;
        (byFile.get(f) ?? byFile.set(f, []).get(f)!).push(e.at);
      }
    }
    for (const ats of byFile.values()) {
      const first = ats[0]!;
      const last = ats[ats.length - 1]!;
      if (prompts.some((p) => p > first && p < last)) {
        fired.add('edit-across-prompt');
        break;
      }
    }
  }

  // write-over-edited: a Write over a file with ≥ N earlier edits.
  const priorEdits = new Map<string, number>();
  for (const e of events) {
    if (e.hook !== 'edit') continue;
    for (const f of e.files) {
      const n = priorEdits.get(f) ?? 0;
      if (e.tool === 'Write' && n >= SCORE_WRITE_PRIOR_EDITS) {
        fired.add('write-over-edited');
        moments.push(e.at);
      }
      priorEdits.set(f, n + 1);
    }
  }

  // research-then-edit: a research signal, then an edit, no failure between.
  const research = [
    ...events.filter((e) => e.hook === 'research').map((e) => e.at),
    ...searches,
  ].sort((a, b) => a - b);
  for (const at of research) {
    let broken = false;
    for (const e of events) {
      if (e.at < at) continue;
      if (e.hook === 'failure') {
        broken = true;
        break;
      }
      if (e.hook === 'edit') {
        fired.add('research-then-edit');
        break;
      }
    }
    if (fired.has('research-then-edit') || !broken) break;
  }

  const patterns = (Object.keys(SCORE_WEIGHTS) as ScorePattern[]).filter((p) => fired.has(p));
  const base = patterns.reduce((sum, p) => sum + SCORE_WEIGHTS[p], 0);
  const end =
    input.endedAt ??
    (events.length > 0 ? events[events.length - 1]!.at : (moments[moments.length - 1] ?? null));
  let bonus = 1;
  if (end !== null && moments.length > 0) {
    const latest = Math.max(...moments);
    const gap = end - latest;
    if (gap >= 0 && gap < SCORE_RECENCY_MS) {
      bonus = 1 + SCORE_RECENCY_BONUS * (1 - gap / SCORE_RECENCY_MS);
    }
  }
  return {
    score: Math.round(base * bonus * 10) / 10,
    patterns,
    bonus: Math.round(bonus * 100) / 100,
  };
}

/** Whether `head` (`pnpm`, `pytest`) is a program the command line names: a
 *  whole word, or the basename of a path word. */
function commandNamesHead(command: string, head: string): boolean {
  return command.split(/[\s;&|()]+/).some((word) => {
    const base = word.split(/[/\\]/).pop() ?? '';
    return base === head;
  });
}

function parseFiles(raw: unknown): string[] {
  if (typeof raw !== 'string') return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((f): f is string => typeof f === 'string') : [];
  } catch {
    return [];
  }
}

function parseData(raw: unknown): Record<string, unknown> {
  if (typeof raw !== 'string') return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/**
 * The `--sessions` report: one line per (SESSION, AGENT) with an event row in
 * the last {@link LEDGER_WINDOW_DAYS} days, each scored by
 * {@link scoreSession}, with what the Stop hook actually did beside it.
 *
 * PER AGENT, because a session is not a worker. Every subagent files under its
 * parent's session id, so a session-wide scan read one child's failure, a
 * sibling's edit and the parent's pass as one fix and scored a session nobody
 * had fixed anything in. The parent's own turn is the null agent, and it is the
 * row that carries the session-wide `capture_asked`.
 *
 * Sessions with the '' (machine) id are skipped: that bucket is where a payload
 * naming no session lands, and it is not a conversation anything could have
 * been asked in.
 */
export async function readSessionScores(
  dataDir: string,
  nowMs: number,
): Promise<PushSessionScore[]> {
  const store = await openStore(dataDir);
  if (store === null) return [];
  try {
    const since = nowMs - LEDGER_WINDOW_MS;
    // KEYED BY (session, agent), not by session. `data.agentId` is null for the
    // lead's own turn and the child's id for a subagent's, and the two are
    // scored apart: a session is the conversation, an agent is the worker, and
    // fail -> edit -> pass is a claim about one worker.
    const byWorker = new Map<
      string,
      { session: string; agent: string | null; events: ScoreEvent[] }
    >();
    for (const row of store.all(STORE_SQL.scoreEvents, [since])) {
      const session = typeof row.session === 'string' ? row.session : '';
      if (session === '') continue;
      const data = parseData(row.data);
      // '' is not an agent: the arms write null for a parent fire, and a row
      // from a build that predates the field has no `agentId` at all. Both are
      // the lead's own bucket.
      const agent =
        typeof data.agentId === 'string' && data.agentId.length > 0 ? data.agentId : null;
      const key = session + '\u0000' + (agent ?? '');
      const bucket =
        byWorker.get(key) ?? byWorker.set(key, { session, agent, events: [] }).get(key)!;
      bucket.events.push({
        at: typeof row.at === 'number' ? row.at : 0,
        hook: typeof row.hook === 'string' ? row.hook : 'unknown',
        tool: typeof row.tool === 'string' ? row.tool : null,
        agentId: agent,
        files: parseFiles(row.files),
        command: typeof data.command === 'string' ? data.command : null,
        head: typeof data.head === 'string' ? data.head : null,
      });
    }
    const closes = new Map<string, number[]>();
    for (const row of store.all(STORE_SQL.scoreCloses, [since])) {
      if (typeof row.session !== 'string' || typeof row.at !== 'number') continue;
      (closes.get(row.session) ?? closes.set(row.session, []).get(row.session)!).push(row.at);
    }
    const searches = new Map<string, number[]>();
    for (const row of store.all(STORE_SQL.scoreSearches, [since])) {
      if (typeof row.session !== 'string' || typeof row.at !== 'number') continue;
      (searches.get(row.session) ?? searches.set(row.session, []).get(row.session)!).push(row.at);
    }
    const bounds = new Map<string, { started: number | null; ended: number | null }>();
    for (const row of store.all(STORE_SQL.scoreSessions, [since, since])) {
      if (typeof row.session !== 'string') continue;
      bounds.set(row.session, {
        started: typeof row.started_at === 'number' ? row.started_at : null,
        ended: typeof row.ended_at === 'number' ? row.ended_at : null,
      });
    }
    const asked = new Set<string>();
    const publishedAt: number[] = [];
    for (const row of store.all(STORE_SQL.scoreState, [since])) {
      if (row.key === 'capture_asked' && typeof row.session === 'string') asked.add(row.session);
      else if (typeof row.at === 'number') publishedAt.push(row.at);
    }
    const out: PushSessionScore[] = [];
    for (const { session, agent, events } of byWorker.values()) {
      const bound = bounds.get(session);
      const started = bound?.started ?? events[0]!.at;
      const endedAt = bound?.ended ?? null;
      const endForPublish = endedAt ?? nowMs;
      const scored = scoreSession({
        events,
        closes: closes.get(session) ?? [],
        searches: searches.get(session) ?? [],
        endedAt,
      });
      out.push({
        session,
        agent,
        score: scored.score,
        patterns: scored.patterns,
        bonus: scored.bonus,
        events: events.length,
        // The parent's row carries it; a child never asks (see the field).
        captureAsked: agent === null && asked.has(session),
        published: publishedAt.filter((at) => at >= started && at <= endForPublish).length,
      });
    }
    // Highest score first, so the top of the list is what a gate would keep;
    // then the session, then the parent ahead of its children.
    return out.sort(
      (a, b) =>
        b.score - a.score ||
        a.session.localeCompare(b.session) ||
        (a.agent ?? '').localeCompare(b.agent ?? ''),
    );
  } catch {
    return [];
  } finally {
    store.close();
  }
}

/** All four push scripts on disk under `<dataDir>/hooks`. HALF the answer, and
 *  it says so: a script can be written without an entry (a `push on` whose
 *  settings write refused) or an entry can outlive its script (a half-finished
 *  uninstall), and in both cases nothing runs. {@link countPushHookEntries} is
 *  the other half, and `status` prints both. */
export async function pushScriptsWired(dataDir: string): Promise<boolean> {
  return await pushScriptsPresent(dataDir);
}

export async function runPushStatus(
  ctx: CommandContext,
  deps: PushStatusDeps = {},
  options: PushStatusOptions = {},
): Promise<CommandResult> {
  const settings = resolveSettings({
    config: await loadRawConfig(ctx.dataDir),
    flags: { baseUrl: ctx.flags.baseUrl },
    env: process.env,
  });
  const wired = await (deps.scriptsWired ?? pushScriptsWired)(ctx.dataDir);
  const entries = await (deps.hookEntries ?? countPushHookEntries)(
    deps.homeDir ?? homedir(),
    ctx.dataDir,
  );
  const ledger = await (deps.ledgerTallies ?? readLedgerTallies)(
    ctx.dataDir,
    (deps.now ?? Date.now)(),
  );
  const sessions =
    options.sessions === true
      ? await (deps.sessionScores ?? readSessionScores)(ctx.dataDir, (deps.now ?? Date.now)())
      : undefined;
  const data = {
    mode: settings.hooksPush.value,
    captureMode: settings.hooksCapture.value,
    scriptsWired: wired,
    hookEntries: entries,
    ledger,
    ...(sessions === undefined ? {} : { sessions }),
  };
  return {
    data,
    humanLines: [
      ...renderStatusLines(data),
      ...(sessions === undefined ? [] : renderSessionLines(sessions, ledger.windowDays)),
    ],
  };
}

/**
 * One line per (session, agent): the score, the patterns behind it, and the two
 * facts it is judged against. `capture_asked` without a publish is the ask the
 * score might have saved; a publish under a low score is the session it would
 * have missed. The week's read (plan 06, "What to watch") is those two counts.
 *
 * `agent=''` IS THE LEAD'S OWN TURN, the same empty bucket the close rule's
 * state keys use for it, and a named agent is one subagent of the session above
 * it. Two lines sharing a session id are two workers in one conversation, not
 * one session counted twice.
 */
function renderSessionLines(sessions: PushSessionScore[], windowDays: number): string[] {
  const lines = [
    `sessions, last ${windowDays}d: ${sessions.length} scored, one line per session x agent (importance score vs capture_asked vs published; report only, no hook reads it)`,
  ];
  for (const s of sessions) {
    lines.push(
      `  ${s.session.slice(0, 12).padEnd(12)} agent=${(s.agent ?? "''").slice(0, 12).padEnd(12)} score=${s.score.toFixed(1)}` +
        (s.bonus > 1 ? ` (x${s.bonus.toFixed(2)} recency)` : '') +
        ` events=${s.events} capture_asked=${s.captureAsked ? 'yes' : 'no'} published=${s.published}` +
        (s.patterns.length > 0 ? ` [${s.patterns.join(', ')}]` : ''),
    );
  }
  return lines;
}

function renderStatusLines(data: {
  mode: string;
  captureMode: string;
  scriptsWired: boolean;
  hookEntries: PushHookEntryCount;
  ledger: PushLedgerTallies;
}): string[] {
  const { mode, captureMode, scriptsWired, hookEntries, ledger } = data;
  // "Wired" is both halves and nothing less: files on disk that no settings
  // entry points at never run, and entries pointing at files that are gone fail
  // silently. Either alone reporting healthy is how an operator spends an hour
  // wondering why a sidecar they can see installed says nothing.
  const armed = scriptsWired && hookEntries.present === hookEntries.planned;
  const lines = [
    // `tenjin push on` is the verb that wires them AND the one that got the
    // operator here; `tenjin install` only wires the arms when hooks.push is
    // already `on`, so naming it turns a one-command fix into a guess.
    `push: ${mode}${mode === 'on' && !armed ? ' (not fully wired yet; run `tenjin push on`)' : ''}`,
    `capture: ${captureMode}`,
    `scripts wired: ${scriptsWired ? 'yes' : 'no'}`,
    `hook entries: ${hookEntries.present}/${hookEntries.planned}${
      hookEntries.path === null ? ' (no settings.json found)' : ` in ${hookEntries.path}`
    }`,
    `ledger, last ${ledger.windowDays}d: ${ledger.rows} row(s), ${ledger.candidates} finding(s), ~${ledger.injectedTokens} injected token(s)`,
  ];
  for (const [trigger, actions] of Object.entries(ledger.byTriggerAction)) {
    const byAction = Object.entries(actions)
      .map(([action, n]) => `${action}=${n}`)
      .join(', ');
    lines.push(`  ${trigger}: ${byAction}`);
  }
  const shelfEntries = Object.entries(ledger.byShelf);
  if (shelfEntries.length > 0) {
    lines.push(`  shelf: ${shelfEntries.map(([shelf, n]) => `${shelf}=${n}`).join(', ')}`);
  }
  // Sorted by count: an operator reading this wants to know what is holding the
  // sidecar back most often, and `lookup-cap` climbing that list means the
  // per-session lookup budget is the throttle rather than the matcher.
  const reasonEntries = Object.entries(ledger.byReason).sort((a, b) => b[1] - a[1]);
  if (reasonEntries.length > 0) {
    lines.push(`  reasons: ${reasonEntries.map(([reason, n]) => `${reason}=${n}`).join(', ')}`);
  }
  // The mechanical lane's own line, always printed: zero opened after a week of
  // failing builds is the allowlist being too tight, and the head breakdown is
  // what says whether one head is still opening rows it should not.
  const p = ledger.pairings;
  const counts = (record: Record<string, number>): string =>
    Object.entries(record)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([k, n]) => `${k}=${n}`)
      .join(', ');
  lines.push(
    `pairings, last ${ledger.windowDays}d: ${p.opened} opened, ${p.closed} closed, ${p.verified} verified` +
      (p.closed > 0 ? `; scope: ${counts(p.scope)}` : '') +
      (p.opened > 0 ? `; heads: ${counts(p.byHead)}` : ''),
  );
  return lines;
}

/** What `runPushOn` prints: what {@link wireSearchHooks} actually did, plus the
 *  undo. Not {@link hooksUndo} from lib/harness-hooks.ts — that line names
 *  `hooks.webSearch off`, the search hooks' own off switch, and would tell an
 *  operator to flip the wrong key. */
function renderWireLines(
  result: HooksResult,
  shelfHost: string,
  fallthroughHost: string,
  fallthroughAsked: boolean,
): string[] {
  if (result.skipped !== undefined) {
    return [
      `hooks.push is on, but nothing was wired (${result.skipped}): ${result.warning ?? 'no harness to wire it into'}`,
      ...(result.fix !== undefined ? [result.fix] : []),
    ];
  }
  const registered = [...result.added, ...result.updated];
  return [
    `hooks.push is on. Wired ${registered.length > 0 ? registered.join(', ') : '(nothing new; already up to date)'} in ${
      result.path ?? result.scriptsDir
    }.`,
    // THE SAME WORDS `install` USES, from the same function: this command writes
    // the same entries into the same file, and an operator who reached it by a
    // different verb is owed the same disclosure — above the undo, because the
    // undo is only meaningful once you know what there is to undo.
    hooksDisclosure(result, shelfHost, fallthroughHost, fallthroughAsked),
    'Undo anytime: `tenjin push off` (the scripts stay, but go inert on their next run).',
  ];
}
