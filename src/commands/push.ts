import { homedir } from 'node:os';
import { readFile } from 'node:fs/promises';
import { loadRawConfig, resolveSettings } from '../lib/config';
import { persistPushMode } from './config';
import { hooksDisclosure } from './install';
import {
  hookFallthroughAsked,
  hookFallthroughHost,
  hookRecipientHost,
  resolveContextSettings,
  type ResolvedSettings,
} from '../lib/settings';
import { CliError } from '../lib/errors';
import { sanitizeForTerminal } from '../lib/output';
import { countPushHookEntries, pushScriptsPresent, wireSearchHooks } from '../lib/harness-hooks';
import type { HooksResult, PushHookEntryCount } from '../lib/harness-hooks';
import { buildOutcomeItem, getLookupStats, postOutcomes, type LookupStats } from '../lib/agent-api';
import { UUID_RE } from '../lib/ids';
import {
  ENDED_AFTER_MS,
  errorReason,
  findAnchor,
  findTranscript,
  gradeInjection,
  parseSince,
  parseTranscript,
  transcriptIdle,
  type GradeTarget,
  type TranscriptRow,
  type Verdict,
} from '../lib/grade';
import { openStore, STORE_SQL, type Store } from '../lib/state-store';
import type { ShelfBypass } from '../lib/http';
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
  now?: () => number;
  /** Seam for the per-shelf server rollup; defaults to the real GET. */
  lookupStats?: typeof getLookupStats;
  fetchImpl?: typeof fetch;
}

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
  /**
   * What `tenjin push grade` made of the injected rows, per hook x shelf.
   *
   * SPLIT BY SHELF as well as by arm, because the two answer different
   * questions: the arm is what fired, and the shelf is whose piece it was. An
   * arm that only ever lands `rejected` on the public marketplace while its team
   * hits stick is a routing story, not a precision one, and one number per hook
   * cannot tell them apart.
   */
  graded: Record<string, Record<string, GradeCounts>>;
}

export interface GradeCounts {
  used: number;
  rejected: number;
  unobserved: number;
  /** Shown, never judged: either still open, or `grade` has not run. */
  ungraded: number;
  /** Verdicts that reached the shelf. `outcome_at` is the posted stamp. */
  posted: number;
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
  graded: {},
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
      // A second query over the same open store: `statusRows` counts every
      // decision, and this one only the rows that were actually shown, which is
      // the only population a verdict can describe.
      graded: tallyGraded(store.all(STORE_SQL.gradeRows, [nowMs - LEDGER_WINDOW_MS])),
    };
  } catch {
    return EMPTY_TALLIES;
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
  const data = {
    mode: settings.hooksPush.value,
    captureMode: settings.hooksCapture.value,
    scriptsWired: wired,
    hookEntries: entries,
    ledger,
    server: await readShelfStats(ctx, deps),
  };
  return { data, humanLines: renderStatusLines(data) };
}

/**
 * The same window as the local ledger, from each shelf's own side.
 *
 * ONE ENTRY PER CONFIGURED SHELF, and `null` for one that could not be reached
 * — never a zero. A shelf that is down and a shelf with no demand are different
 * facts, and rendering the first as the second is how an operator concludes the
 * experiment is dead when it is the network that is. Nothing here can fail the
 * command: `status` is what an operator runs when something is already wrong.
 */
async function readShelfStats(
  ctx: CommandContext,
  deps: PushStatusDeps,
): Promise<Record<string, LookupStats | null>> {
  const settings = await resolveContextSettings(ctx);
  const stats = deps.lookupStats ?? getLookupStats;
  const out: Record<string, LookupStats | null> = {};
  for (const shelf of configuredShelves(settings)) {
    try {
      out[shelf.label] = await stats(LEDGER_WINDOW_DAYS, {
        baseUrl: shelf.baseUrl,
        timeoutMs: ctx.flags.timeout,
        ...(shelf.bypass !== undefined ? { bypass: shelf.bypass } : {}),
        ...(deps.fetchImpl !== undefined ? { fetchImpl: deps.fetchImpl } : {}),
      });
    } catch {
      out[shelf.label] = null;
    }
  }
  return out;
}

/** The shelf label a row's `injections.shelf` names, and where to reach it. In
 *  public mode there is one shelf and it is the public one; in team mode the
 *  configured base is the team shelf and the marketplace is the fallthrough. */
interface Shelf {
  label: string;
  baseUrl: string;
  bypass?: ShelfBypass;
}

function configuredShelves(settings: ResolvedSettings): Shelf[] {
  const team: Shelf = {
    label: settings.teamMode ? 'team' : 'public',
    baseUrl: settings.baseUrl,
    ...(settings.bypass !== undefined ? { bypass: settings.bypass } : {}),
  };
  // The key rides the origin, so the public leg never carries the team secret.
  return settings.teamMode ? [team, { label: 'public', baseUrl: settings.publicShelfUrl }] : [team];
}

function renderStatusLines(data: {
  mode: string;
  captureMode: string;
  scriptsWired: boolean;
  hookEntries: PushHookEntryCount;
  ledger: PushLedgerTallies;
  server: Record<string, LookupStats | null>;
}): string[] {
  const { mode, captureMode, scriptsWired, hookEntries, ledger, server } = data;
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
  const gradedEntries = Object.entries(ledger.graded);
  if (gradedEntries.length > 0) {
    lines.push('graded (`tenjin push grade`):');
    for (const [hook, shelves] of gradedEntries) {
      const perShelf = Object.entries(shelves)
        .map(
          ([shelf, c]) =>
            `${shelf} used=${c.used} rejected=${c.rejected} unobserved=${c.unobserved} ungraded=${c.ungraded} posted=${c.posted}`,
        )
        .join('; ');
      lines.push(`  ${hook}: ${perShelf}`);
    }
  }
  for (const [label, stats] of Object.entries(server)) {
    if (stats === null) {
      // NOT zeros: an unreachable shelf and a shelf with no demand are different
      // facts, and the local counts above still stand either way.
      lines.push(`server ${label}: unavailable`);
      continue;
    }
    lines.push(`server ${label} (${stats.windowDays}d):`);
    for (const t of stats.triggers) {
      const rate = t.useRate === null ? 'n/a' : t.useRate.toFixed(2);
      // The one string in this block the shelf chose. Bounded by the response
      // schema and stripped here as well: the numbers beside it are this CLI's
      // own formatting, and the label is not.
      lines.push(
        `  ${sanitizeForTerminal(t.trigger)}: lookups=${t.lookups} hits=${t.hits} candidates=${t.candidates} used=${t.used} wrong=${t.wrong} useRate=${rate}`,
      );
    }
  }
  return lines;
}

function emptyGradeCounts(): GradeCounts {
  return { used: 0, rejected: 0, unobserved: 0, ungraded: 0, posted: 0 };
}

/** One pass over the injected rows in the window. Defensive about the values
 *  like every other tally here: an outcome word this build does not know is
 *  counted nowhere rather than failing the read. */
function tallyGraded(rows: Record<string, unknown>[]): Record<string, Record<string, GradeCounts>> {
  const out: Record<string, Record<string, GradeCounts>> = {};
  for (const row of rows) {
    const hook = typeof row.hook === 'string' ? row.hook : 'unknown';
    const shelf = typeof row.shelf === 'string' ? row.shelf : 'unknown';
    const byShelf = (out[hook] ??= {});
    const counts = (byShelf[shelf] ??= emptyGradeCounts());
    const outcome = typeof row.outcome === 'string' ? row.outcome : null;
    if (outcome === 'used') counts.used += 1;
    else if (outcome === 'rejected') counts.rejected += 1;
    else if (outcome === 'unobserved') counts.unobserved += 1;
    else if (outcome === null) counts.ungraded += 1;
    if (typeof row.outcome_at === 'number') counts.posted += 1;
  }
  return out;
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

/**
 * `tenjin push grade` (docs/command-reference.md#push-experimental): read each
 * session's transcript, decide whether the agent used what the arms showed it,
 * and tell the shelf that served the row.
 *
 * The store already holds every injection and the shelf already holds every
 * lookup; what neither has is the one fact the experiment is judged on, which is
 * whether any of it was worth injecting. `lib/grade.ts` owns the reading and the
 * rule; this owns the store, the shelf routing and the report.
 *
 * IDEMPOTENT BY CONSTRUCTION, in two independent places. A row with an
 * `outcome` is never re-graded (the query asks for `outcome IS NULL`), and a row
 * with an `outcome_at` is never re-posted, because `outcome_at` IS the posted
 * stamp rather than the graded one. So a post that failed keeps a NULL and is
 * retried on the next run, and a post that landed is never sent twice — which
 * matters because the server keeps the FIRST verdict per (lookup, post) and a
 * second one would be silently dropped rather than corrected.
 */
export interface PushGradeArgs {
  since?: string;
  session?: string;
  explain?: boolean;
  /** `--label <uid> <status>`: a hand verdict, for a row the transcript cannot
   *  answer for. Statuses `used` and `rejected` only — the other wire statuses
   *  describe a search, not an injection. */
  label?: string[];
}

export interface PushGradeDeps {
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

/** What one graded row reports. `anchorLine` is where in the transcript the
 *  injection landed, which is the first thing to check when a verdict looks
 *  wrong. */
interface GradedRow {
  uid: string;
  hook: string;
  shelf: string;
  resourceId: string | null;
  outcome: string;
  by: string;
  anchorLine: number | null;
  evidence?: string[];
  /** Why a row was left ungraded, for `--explain`. A verdict explains itself
   *  through its evidence; "nothing was written" does not. */
  note?: string;
}

const HALTING_FAILURES = new Set(['RATE_LIMITED', 'NETWORK_ERROR']);

export async function runPushGrade(
  ctx: CommandContext,
  args: PushGradeArgs = {},
  deps: PushGradeDeps = {},
): Promise<CommandResult> {
  const since = args.since ?? '7d';
  const sinceMs = parseSince(since);
  const now = (deps.now ?? Date.now)();
  const store = await openStore(ctx.dataDir);
  if (store === null) {
    throw new CliError('INTERNAL', 'The state store could not be opened, so nothing was graded.', {
      fix: 'Run `tenjin doctor` to check the data dir, then retry.',
    });
  }
  try {
    const graded =
      args.label !== undefined
        ? [labelOne(store, args.label)]
        : await gradeSessions(store, ctx, args, deps, { sinceMs, now });
    const posted = await postGraded(store, ctx, deps, now, sinceMs);
    return {
      data: buildGradeData(since, graded, posted),
      humanLines: gradeLines(since, graded, posted, args.explain === true),
    };
  } finally {
    store.close();
  }
}

/** `--label <uid> <status>`, as commander's variadic hands it over. */
function labelOne(store: Store, label: string[]): GradedRow {
  const [uid, status] = label;
  if (label.length !== 2 || uid === undefined || status === undefined) {
    throw new CliError('USAGE', '--label takes an injection uid and a status.', {
      fix: 'tenjin push grade --label <uid> used|rejected',
    });
  }
  if (status !== 'used' && status !== 'rejected') {
    throw new CliError(
      'USAGE',
      `A hand verdict is used or rejected (got ${JSON.stringify(status)}).`,
      {
        fix: 'tenjin push grade --label <uid> used|rejected',
      },
    );
  }
  // The query asks for an INJECTED row, so an unknown uid and a uid naming a
  // decision the arm did not act on fail the same way — and neither can be
  // labelled. A verdict is a report about a piece the agent was shown; a
  // `skipped` row was shown to nobody, and posting "used" for one would tell
  // the shelf a story about a piece it never served.
  const row = store.get(STORE_SQL.injectionByUid, [uid]);
  if (row === null) {
    throw new CliError('USAGE', `No injected row ${uid} in this machine's store.`, {
      fix: 'Take the uid from `tenjin push grade --explain`; only rows an arm actually injected can be labelled.',
    });
  }
  // `setOutcome` clears `outcome_at` with the verdict, so a re-labelled row is
  // owed to the shelf again and the post step below picks it up.
  store.run(STORE_SQL.setOutcome, [status, 'hand', uid]);
  return {
    uid,
    hook: String(row.hook ?? 'unknown'),
    shelf: String(row.shelf ?? 'unknown'),
    resourceId: typeof row.resource_id === 'string' ? row.resource_id : null,
    outcome: status,
    by: 'hand',
    anchorLine: null,
  };
}

/**
 * Every ungraded injection in the window, judged against its session transcript.
 *
 * The transcript is parsed ONCE PER SESSION, not once per row: a busy session
 * has several injections and the file is the same file. A `subagent` row skips
 * the read entirely — a subagent's injections are written to no transcript at
 * all, so opening one could only ever produce a false `rejected`.
 */
async function gradeSessions(
  store: Store,
  ctx: CommandContext,
  args: PushGradeArgs,
  deps: PushGradeDeps,
  window: { sinceMs: number; now: number },
): Promise<GradedRow[]> {
  const scope = args.session ?? '';
  const rows = store.all(STORE_SQL.ungradedInjections, [window.now - window.sinceMs, scope, scope]);
  const homeDir = deps.homeDir ?? homedir();
  const locate = deps.findTranscript ?? findTranscript;
  const readText = deps.transcriptText ?? ((path: string) => readFile(path, 'utf8'));
  const idle = deps.transcriptIdle ?? transcriptIdle;
  const parsed = new Map<string, SessionState>();
  const out: GradedRow[] = [];

  for (const row of rows) {
    const uid = String(row.uid ?? '');
    const hook = String(row.hook ?? 'unknown');
    const shelf = String(row.shelf ?? 'unknown');
    const session = typeof row.session === 'string' ? row.session : '';
    const target: GradeTarget = {
      resourceId: typeof row.resource_id === 'string' ? row.resource_id : null,
      url: typeof row.url === 'string' ? row.url : null,
      title: typeof row.title === 'string' ? row.title : null,
    };
    // A subagent injection reaches no transcript, so there is nothing to read
    // and never will be; the row is closed rather than left open forever.
    if (hook === 'subagent' || session === '') {
      out.push(
        record(store, {
          uid,
          hook,
          shelf,
          target,
          verdict: { outcome: 'unobserved', by: 'none' },
          anchorLine: null,
        }),
      );
      continue;
    }
    let state = parsed.get(session);
    if (state === undefined) {
      state = await readSession(session, {
        homeDir,
        locate,
        readText,
        idle,
        store,
        now: window.now,
      });
      parsed.set(session, state);
    }
    // NOT A FACT ABOUT THE SESSION. A projects directory that is missing or
    // unreadable says nothing about whether this row was ever shown, and
    // `unobserved` is permanent — one run under a home that could not be read
    // would close every open row on the machine as never-seen.
    if (state.kind === 'unreadable') {
      out.push(
        ungraded({ uid, hook, shelf, target, note: `transcript unreadable (${state.reason})` }),
      );
      continue;
    }
    if (state.kind === 'absent') {
      // The transcript IS absent — the projects directory was read and holds no
      // file for this session. That is only `unobserved` once a transcript
      // would have appeared by now: the harness writes the file as the session
      // runs, so a row minted seconds ago whose session is still starting up
      // has simply not been written yet.
      const at = typeof row.at === 'number' ? row.at : window.now;
      if (!state.ended && at > window.now - ENDED_AFTER_MS) {
        out.push(
          ungraded({ uid, hook, shelf, target, note: 'no transcript for this session yet' }),
        );
        continue;
      }
      out.push(
        record(store, {
          uid,
          hook,
          shelf,
          target,
          verdict: { outcome: 'unobserved', by: 'none' },
          anchorLine: null,
        }),
      );
      continue;
    }
    const anchor = findAnchor(state.rows, target);
    const verdict = gradeInjection(state.rows, anchor, target, { ended: state.ended });
    out.push(
      record(store, {
        uid,
        hook,
        shelf,
        target,
        verdict,
        anchorLine: anchor === -1 ? null : (state.rows[anchor]?.line ?? null),
      }),
    );
  }
  return out;
}

/** A row this run declines to judge: nothing is written, and `--explain` says
 *  why. It stays in the queue for the next run. */
function ungraded(input: {
  uid: string;
  hook: string;
  shelf: string;
  target: GradeTarget;
  note: string;
}): GradedRow {
  return {
    uid: input.uid,
    hook: input.hook,
    shelf: input.shelf,
    resourceId: input.target.resourceId,
    outcome: 'open',
    by: 'none',
    anchorLine: null,
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
 */
type SessionState =
  | { kind: 'read'; rows: TranscriptRow[]; ended: boolean }
  | { kind: 'absent'; ended: boolean }
  | { kind: 'unreadable'; reason: string };

async function readSession(
  session: string,
  ctx: {
    homeDir: string;
    locate: typeof findTranscript;
    readText: (path: string) => Promise<string>;
    idle: typeof transcriptIdle;
    store: Store;
    now: number;
  },
): Promise<SessionState> {
  const found = await ctx.locate(ctx.homeDir, session);
  const stamped = ctx.store.get(STORE_SQL.sessionEnded, [session]);
  const endedAt = stamped !== null && typeof stamped.ended_at === 'number';
  if (found.kind === 'unreadable') return { kind: 'unreadable', reason: found.reason };
  // With no file there is no mtime to go idle, so the store's stamp is the only
  // half of "this session is over" that can answer.
  if (found.kind === 'absent') return { kind: 'absent', ended: endedAt };
  let text: string;
  try {
    text = await ctx.readText(found.path);
  } catch (err) {
    // The file is THERE and this run could not read it: a fault of the moment,
    // and the row is owed another look rather than a verdict.
    return { kind: 'unreadable', reason: errorReason(err) };
  }
  // Either half is enough. `ended_at` is the clean stop; a transcript nothing
  // has touched for half an hour is the harness that was killed and never
  // stamped one.
  const ended = endedAt || (await ctx.idle(found.path, ctx.now));
  return { kind: 'read', rows: parseTranscript(text), ended };
}

/** Write the verdict, unless there is none yet: a row the session may still
 *  answer stays NULL, and `grade` reports it as open. */
function record(
  store: Store,
  input: {
    uid: string;
    hook: string;
    shelf: string;
    target: GradeTarget;
    verdict: Verdict;
    anchorLine: number | null;
  },
): GradedRow {
  const { verdict } = input;
  if (verdict.outcome !== null) {
    store.run(STORE_SQL.setOutcome, [verdict.outcome, verdict.by, input.uid]);
  }
  const evidence =
    verdict.outcome === 'used'
      ? [verdict.evidence]
      : verdict.outcome === 'unobserved'
        ? []
        : verdict.evidence;
  return {
    uid: input.uid,
    hook: input.hook,
    shelf: input.shelf,
    resourceId: input.target.resourceId,
    outcome: verdict.outcome ?? 'open',
    by: verdict.outcome === null ? 'none' : verdict.by,
    anchorLine: input.anchorLine,
    evidence,
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
 * ROUTED BY THE ROW'S OWN URL, not by today's config. A search id is minted by
 * one shelf and means nothing on another, and the two ways of picking a shelf
 * here are not equivalent: the row's `shelf` is a LABEL (`team`, `public`) whose
 * meaning depends on the config in force when the arm ran, and config changes —
 * a team base URL that moved, team mode switched on or off. Resolving the label
 * against the current config then sends the verdict somewhere that never served
 * the row, where it lands as a 202 (there is no existence oracle on that
 * endpoint, by design) and the row is stamped posted. The verdict is lost, and
 * nothing anywhere says so. Every injected row carries the read url it was shown
 * with, on the shelf that served it, so that origin is the address.
 *
 * THE BYPASS SECRET RIDES THE ROW'S SHELF LABEL, not today's config. The secret
 * belongs to the team — it is what gets a request past the team shelf's
 * protection — so a `team` row carries it and a `public` row never does.
 * Requiring the row's origin to equal the CONFIGURED team base URL instead tied
 * the credential to an address that moves: re-point the team shelf and every
 * unposted team verdict retries unauthenticated forever, since only a success
 * stamps the row.
 *
 * WHICH ORIGIN THE SECRET IS AUTHORIZED AT is a separate question, and the
 * answer is never the row's url — that is a candidate url the shelf chose (see
 * `injections.url`), so authorizing the key there would hand the team's shelf
 * key to any origin a search response cared to name. It is the search's
 * recorded `shelf_base_url`: the base the arm actually asked, read out of this
 * machine's own config at the time. The transport still does the final compare
 * against the request URL ({@link ShelfBypass}), so a row whose candidate url
 * wandered off that shelf posts unauthenticated rather than leaking the key.
 *
 * A failure never fails the command — the verdicts are already recorded locally,
 * and the row keeps its NULL stamp so the next run retries it. A rate limit or a
 * dead network halts the rest of the batch for the same reason `outcome` does:
 * the next id fails the same way, and an unposted row is a recoverable state.
 */
async function postGraded(
  store: Store,
  ctx: CommandContext,
  deps: PushGradeDeps,
  now: number,
  sinceMs: number,
): Promise<PostTally> {
  const tally: PostTally = { posted: 0, failed: 0, skipped: [] };
  const rows = store.all(STORE_SQL.unpostedOutcomes, [now - sinceMs]);
  if (rows.length === 0) return tally;
  const settings = await resolveContextSettings(ctx);
  let halted = false;
  for (const row of rows) {
    if (halted) break;
    const uid = String(row.uid ?? '');
    const searchId = typeof row.search_id === 'string' ? row.search_id : '';
    if (!UUID_RE.test(searchId)) {
      tally.skipped.push(`${uid}: no search id to report against`);
      continue;
    }
    const origin = shelfOrigin(typeof row.url === 'string' ? row.url : '');
    if (origin === null) {
      tally.skipped.push(`${uid}: no usable url, so the shelf that served it is unknown`);
      continue;
    }
    const bypass =
      row.shelf === 'team' ? teamBypass(row.shelf_base_url, settings.bypass) : undefined;
    const resourceId = typeof row.resource_id === 'string' ? row.resource_id : '';
    try {
      const item = buildOutcomeItem({
        status: wireStatus(String(row.outcome ?? ''), String(row.outcome_by ?? '')),
        // Only a uuid: the server drops an outcome naming a non-candidate, and a
        // local pairing id (`pairing:7`) is not a marketplace resource at all.
        ...(UUID_RE.test(resourceId) ? { resourceId } : {}),
      });
      await postOutcomes(searchId, [item], {
        baseUrl: origin,
        timeoutMs: ctx.flags.timeout,
        ...(bypass !== undefined ? { bypass } : {}),
        ...(deps.fetchImpl !== undefined ? { fetchImpl: deps.fetchImpl } : {}),
      });
      store.run(STORE_SQL.markPosted, [now, uid]);
      tally.posted += 1;
    } catch (err) {
      tally.failed += 1;
      if (err instanceof CliError && HALTING_FAILURES.has(err.code)) halted = true;
    }
  }
  return tally;
}

/**
 * The team's shelf key, authorized at the origin the search was actually asked
 * on rather than at whatever `baseUrl` says today.
 *
 * `shelfBaseUrl` is the search row's, which the arm wrote from config; a row
 * old enough not to carry one keeps the configured pairing, which is what it
 * has always had. The secret itself never changes — only the one origin it is
 * allowed to open, and only ever to a base this machine chose.
 */
function teamBypass(
  shelfBaseUrl: unknown,
  configured: ShelfBypass | undefined,
): ShelfBypass | undefined {
  if (configured === undefined) return undefined;
  const asked = typeof shelfBaseUrl === 'string' ? shelfOrigin(shelfBaseUrl) : null;
  return asked === null ? configured : { origin: asked, secret: configured.secret };
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
 * `partially_used` for a span, and that is the honest word for it: a phrase
 * copied out of the injected text says the agent took SOMETHING from the piece,
 * not that the piece answered the question. Only a followed pointer, or a human
 * saying so, is `used`.
 */
function wireStatus(outcome: string, by: string): string {
  if (outcome === 'rejected') return 'rejected';
  return by === 'span' ? 'partially_used' : 'used';
}

function buildGradeData(
  since: string,
  rows: GradedRow[],
  posted: PostTally,
): Record<string, unknown> {
  const counts = { used: 0, rejected: 0, unobserved: 0, open: 0 };
  for (const row of rows) {
    if (row.outcome === 'used') counts.used += 1;
    else if (row.outcome === 'rejected') counts.rejected += 1;
    else if (row.outcome === 'unobserved') counts.unobserved += 1;
    else counts.open += 1;
  }
  return {
    since,
    graded: counts,
    posted: posted.posted,
    postFailed: posted.failed,
    postSkipped: posted.skipped.length,
    rows: rows.map((row) => ({
      uid: row.uid,
      hook: row.hook,
      shelf: row.shelf,
      resourceId: row.resourceId,
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
    graded: { used: number; rejected: number; unobserved: number; open: number };
  };
  const g = data.graded;
  const lines = [
    `graded ${rows.length} row(s) since ${since}: used=${g.used} rejected=${g.rejected} unobserved=${g.unobserved} open=${g.open}`,
    posted.failed > 0
      ? `posted ${posted.posted} outcome(s) (${posted.failed} failed; retried on the next run)`
      : `posted ${posted.posted} outcome(s)`,
  ];
  if (posted.skipped.length > 0) {
    lines.push(`${posted.skipped.length} verdict(s) not routed to any shelf; still unposted`);
  }
  if (!explain) return lines;
  for (const row of rows) {
    const anchor = row.anchorLine === null ? 'no anchor' : `anchor line ${row.anchorLine}`;
    lines.push(
      `${row.uid} ${row.hook}/${row.shelf} ${row.resourceId ?? '(no resource)'}: ${row.outcome} (${row.by}) ${anchor}`,
    );
    // Why nothing was written, for the rows where that is the whole story.
    if (row.note !== undefined) lines.push(`    ${row.note}`);
    for (const line of row.evidence ?? []) lines.push(`    ${line}`);
  }
  for (const skip of posted.skipped) lines.push(`not posted: ${skip}`);
  return lines;
}
