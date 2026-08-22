import { homedir } from 'node:os';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { loadRawConfig, resolveSettings } from '../lib/config';
import { persistPushMode } from './config';
import { hooksDisclosure } from './install';
import { CliError } from '../lib/errors';
import { wireSearchHooks } from '../lib/harness-hooks';
import type { HooksResult } from '../lib/harness-hooks';
import { hooksDir, pushLedgerPath } from '../lib/paths';
import {
  PUSH_CONTEXT_HOOK_FILE,
  PUSH_FAILURE_HOOK_FILE,
  PUSH_PROMPT_HOOK_FILE,
  PUSH_SUBAGENT_HOOK_FILE,
} from '../lib/push-scripts';
import type { CommandContext, CommandResult } from '../context';

/**
 * `tenjin push on|off|status` (docs/push.md): the runtime toggle for the push
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

const PUSH_SCRIPT_FILES = [
  PUSH_PROMPT_HOOK_FILE,
  PUSH_FAILURE_HOOK_FILE,
  PUSH_SUBAGENT_HOOK_FILE,
  PUSH_CONTEXT_HOOK_FILE,
] as const;

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
 * today, the same way `tenjin config set hooks.searchMode auto` is consent
 * enough for the search hooks it governs.
 *
 * IT IS NOT CONSENT TO OVERRIDE THE TWO GATES `install` APPLIES, and this
 * command used to call `wireSearchHooks` straight past both of them:
 *
 *  - `hooks.searchMode: off` is the kill switch for this whole bundle, and
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
 * what they do, in the same words `install` uses, including the one arm that can
 * deny a tool call.
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
  if (settings.hooksSearchMode.value === 'off') {
    throw new CliError(
      'USAGE',
      'hooks.searchMode is off, which is the kill switch for every hook this CLI writes, so the push arms were not wired and hooks.push was left as it was.',
      { fix: 'tenjin config set hooks.searchMode auto, then tenjin push on' },
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
    mode: settings.hooksSearchMode.value,
    push: true,
  });
  return {
    data: { mode: 'on', hooks: result },
    humanLines: renderWireLines(result),
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
  /** Seam for the ledger read; defaults to the real file read. */
  ledgerTallies?: (dataDir: string, nowMs: number) => Promise<PushLedgerTallies>;
  now?: () => number;
}

/** One decision row's shape, as far as `status` reads it. Every field is
 *  optional: a row from an older or newer script build is tolerated, never
 *  fatal — see {@link readLedgerTallies}. */
interface LedgerRow {
  at?: unknown;
  trigger?: unknown;
  shelf?: unknown;
  action?: unknown;
  reason?: unknown;
  /**
   * TWO SHAPES, ONE FIELD. The team shelf writes `{id, title}` (a note has no
   * resource id and no searchId behind it); the public shelf writes
   * `{resourceId, title, price, url}`. Reading only one of the two keys would
   * make every note the sidecar surfaced invisible here, which is the half of
   * the experiment that costs nothing to run and is therefore the half most
   * worth counting.
   */
  candidate?: unknown;
  deny?: unknown;
  tokens?: unknown;
}

export interface PushLedgerTallies {
  windowDays: number;
  rows: number;
  byTriggerAction: Record<string, Record<string, number>>;
  byShelf: Record<string, number>;
  /** Why a row did not inject: `weak`, `miss`, `already-injected`, `inject-cap`,
   *  `lookup-cap`, `no-answer`, and whatever a later build adds — the values are
   *  taken from the rows, never from a list here, so a new reason shows up in
   *  `status` the day the script starts writing it. */
  byReason: Record<string, number>;
  /** Distinct findings surfaced in the window, counted across BOTH candidate
   *  shapes (team `{id}` and public `{resourceId}`) — see {@link LedgerRow}. */
  candidates: number;
  denies: number;
  injectedTokens: number;
}

const EMPTY_TALLIES: PushLedgerTallies = {
  windowDays: LEDGER_WINDOW_DAYS,
  rows: 0,
  byTriggerAction: {},
  byShelf: {},
  byReason: {},
  candidates: 0,
  denies: 0,
  injectedTokens: 0,
};

/**
 * Tally the last {@link LEDGER_WINDOW_DAYS} days of push-ledger rows: total rows,
 * a trigger x action breakdown, a shelf breakdown, how many rows denied a tool
 * call, and the injected-token total. Read from the whole file (the ledger is
 * append-only JSON lines, one status call is not on any tool call's critical
 * path the way the hook scripts' own tail-only read is), and every line is
 * parsed defensively: a torn or foreign line, or one missing a field, is
 * skipped rather than failing the command.
 */
export async function readLedgerTallies(
  dataDir: string,
  nowMs: number,
): Promise<PushLedgerTallies> {
  let text: string;
  try {
    text = await readFile(pushLedgerPath(dataDir), 'utf8');
  } catch {
    return EMPTY_TALLIES;
  }
  const cutoff = nowMs - LEDGER_WINDOW_MS;
  let rows = 0;
  const byTriggerAction: Record<string, Record<string, number>> = {};
  const byShelf: Record<string, number> = {};
  const byReason: Record<string, number> = {};
  const candidates = new Set<string>();
  let denies = 0;
  let injectedTokens = 0;
  for (const line of text.split('\n')) {
    if (line.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(parsed)) continue;
    const row = parsed as LedgerRow;
    const at = typeof row.at === 'string' ? Date.parse(row.at) : NaN;
    if (!Number.isFinite(at) || at < cutoff) continue;
    rows += 1;
    const trigger = typeof row.trigger === 'string' ? row.trigger : 'unknown';
    const action = typeof row.action === 'string' ? row.action : 'unknown';
    const byAction = (byTriggerAction[trigger] ??= {});
    byAction[action] = (byAction[action] ?? 0) + 1;
    const shelf = typeof row.shelf === 'string' ? row.shelf : 'unknown';
    byShelf[shelf] = (byShelf[shelf] ?? 0) + 1;
    if (typeof row.reason === 'string' && row.reason !== '') {
      byReason[row.reason] = (byReason[row.reason] ?? 0) + 1;
    }
    const key = candidateKey(row.candidate);
    if (key !== null) candidates.add(`${shelf}:${key}`);
    if (row.deny === true) denies += 1;
    if (action === 'injected' && typeof row.tokens === 'number' && Number.isFinite(row.tokens)) {
      injectedTokens += row.tokens;
    }
  }
  return {
    windowDays: LEDGER_WINDOW_DAYS,
    rows,
    byTriggerAction,
    byShelf,
    byReason,
    candidates: candidates.size,
    denies,
    injectedTokens,
  };
}

/**
 * The identity of the finding a row is about, under EITHER shelf's shape:
 * `candidate.resourceId` for a marketplace piece, `candidate.id` for a team
 * note. Null for a row that reached no candidate at all (a `miss`, a capped
 * lookup), which is a row to count in `rows` and not in `candidates`.
 */
function candidateKey(candidate: unknown): string | null {
  if (!isRecord(candidate)) return null;
  if (typeof candidate.resourceId === 'string' && candidate.resourceId !== '') {
    return candidate.resourceId;
  }
  if (typeof candidate.id === 'string' && candidate.id !== '') return candidate.id;
  return null;
}

/** All four push scripts on disk under `<dataDir>/hooks`. Not a settings.json
 *  read (a script can be written without an entry, or vice versa mid-refusal) —
 *  this answers "did `tenjin push on` (or a compatible install) actually write
 *  the scripts", which is what an operator debugging silence wants to know
 *  first. */
export async function pushScriptsWired(dataDir: string): Promise<boolean> {
  const dir = hooksDir(dataDir);
  for (const file of PUSH_SCRIPT_FILES) {
    try {
      await stat(join(dir, file));
    } catch {
      return false;
    }
  }
  return true;
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
  const ledger = await (deps.ledgerTallies ?? readLedgerTallies)(
    ctx.dataDir,
    (deps.now ?? Date.now)(),
  );
  const data = {
    mode: settings.hooksPush.value,
    captureMode: settings.hooksCapture.value,
    scriptsWired: wired,
    ledger,
  };
  return { data, humanLines: renderStatusLines(data) };
}

function renderStatusLines(data: {
  mode: string;
  captureMode: string;
  scriptsWired: boolean;
  ledger: PushLedgerTallies;
}): string[] {
  const { mode, captureMode, scriptsWired, ledger } = data;
  const lines = [
    `push: ${mode}${mode === 'on' && !scriptsWired ? ' (scripts not wired yet; run `tenjin install`)' : ''}`,
    `capture: ${captureMode}`,
    `scripts wired: ${scriptsWired ? 'yes' : 'no'}`,
    `ledger, last ${ledger.windowDays}d: ${ledger.rows} row(s), ${ledger.candidates} finding(s), ${ledger.denies} deny(s), ~${ledger.injectedTokens} injected token(s)`,
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
  // sidecar back most often, and `inject-cap` climbing that list means the cap
  // itself is the throttle rather than the matcher.
  const reasonEntries = Object.entries(ledger.byReason).sort((a, b) => b[1] - a[1]);
  if (reasonEntries.length > 0) {
    lines.push(`  reasons: ${reasonEntries.map(([reason, n]) => `${reason}=${n}`).join(', ')}`);
  }
  return lines;
}

/** What `runPushOn` prints: what {@link wireSearchHooks} actually did, plus the
 *  undo. Not {@link hooksUndo} from lib/harness-hooks.ts — that line names
 *  `hooks.searchMode off`, the search hooks' own off switch, and would tell an
 *  operator to flip the wrong key. */
function renderWireLines(result: HooksResult): string[] {
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
    hooksDisclosure(result),
    'Undo anytime: `tenjin push off` (the scripts stay, but go inert on their next run).',
  ];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
