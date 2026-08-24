import { homedir } from 'node:os';
import { open, readFile, stat } from 'node:fs/promises';
import { loadRawConfig, resolveSettings } from '../lib/config';
import { persistPushMode } from './config';
import { hooksDisclosure } from './install';
import { hookFallthroughAsked, hookFallthroughHost, hookRecipientHost } from '../lib/settings';
import { CliError } from '../lib/errors';
import { countPushHookEntries, pushScriptsPresent, wireSearchHooks } from '../lib/harness-hooks';
import type { HooksResult, PushHookEntryCount } from '../lib/harness-hooks';
import { pushLedgerPath } from '../lib/paths';
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
/** ⚠ MIRRORS `LEDGER_TAIL_BYTES` in lib/push-scripts.ts, and for the same
 *  reason: the ledger is append-only and never rotated, so a machine that has
 *  had the experiment on for months has a file no reader should parse whole. */
const LEDGER_TAIL_BYTES = 262144;

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
      // NOT "the kill switch for every hook this CLI writes", which this used to
      // say and which is false about push arms that are already wired: those read
      // `hooks.push` at run time and nothing else. What `searchMode off` is, is
      // the decision not to REGISTER anything — which is why there is no wiring
      // path for these arms to join.
      'hooks.searchMode is off, which is the decision not to register any hook entries at all, so the push arms were not wired and hooks.push was left as it was. (Once wired, the push arms are switched by `tenjin push off`; this key does not reach them.)',
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
   * Both shelves write `{resourceId, title, price, url}` now that the team shelf
   * is a Tenjin deployment. `{id, title}` is what the retired git-backed shelf
   * wrote, and a ledger written before this release still holds those rows — the
   * file is append-only and nothing rewrites it, so reading only the current
   * spelling would silently zero the team half of the first week's numbers.
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
  /** Why a row did not inject. The eight the shipped core writes are
   *  `lookup-cap`, `quiet`, `no-time`, `no-answer`, `miss`, `weak`,
   *  `already-injected` and `watchdog` (docs/command-reference.md#push-experimental),
   *  but the values are taken from the rows, never from a list here, so a new
   *  reason shows up in `status` the day the script starts writing it — and a
   *  retired one keeps counting out of the append-only rows that still hold it. */
  byReason: Record<string, number>;
  /** Distinct findings surfaced in the window, counted across both candidate
   *  shapes (current `{resourceId}` and the retired `{id}`) — see
   *  {@link LedgerRow}. */
  candidates: number;
  denies: number;
  injectedTokens: number;
  /**
   * True when the ledger was larger than the retained tail, so these numbers
   * cover the last {@link LEDGER_TAIL_BYTES} of it rather than the whole
   * window. A floor, not a total — and said out loud, because the alternative
   * is a count an operator reads as complete when it is not.
   */
  tail: boolean;
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
  tail: false,
};

/**
 * Tally the last {@link LEDGER_WINDOW_DAYS} days of push-ledger rows: total rows,
 * a trigger x action breakdown, a shelf breakdown, how many rows denied a tool
 * call, and the injected-token total. Every line is parsed defensively: a torn
 * or foreign line, or one missing a field, is skipped rather than failing the
 * command.
 *
 * READ FROM THE TAIL, the same 256 KB the hook scripts read (see
 * `sessionRows` in lib/push-scripts.ts). Nothing rotates this file: every arm
 * of every session appends to it forever, so "one status call is not on a tool
 * call's critical path" was an argument about latency that ignored the size.
 * The tail is also where the 7-day window's rows are, by construction.
 *
 * The cost is that on a large ledger the tally covers the retained tail rather
 * than the whole window, so it reports {@link PushLedgerTallies.tail} and the
 * human line says so — a number an operator might read as "the experiment fired
 * this many times" must not quietly be a floor with no sign of it.
 */
export async function readLedgerTallies(
  dataDir: string,
  nowMs: number,
): Promise<PushLedgerTallies> {
  let text: string;
  let tail = false;
  try {
    const path = pushLedgerPath(dataDir);
    const size = (await stat(path)).size;
    if (size <= LEDGER_TAIL_BYTES) {
      text = await readFile(path, 'utf8');
    } else {
      const fd = await open(path, 'r');
      try {
        const buf = Buffer.alloc(LEDGER_TAIL_BYTES);
        await fd.read(buf, 0, LEDGER_TAIL_BYTES, size - LEDGER_TAIL_BYTES);
        text = buf.toString('utf8');
      } finally {
        await fd.close();
      }
      // The first line is a fragment of whatever row straddles the cut. It would
      // parse as nothing, but dropping it keeps "lines that failed to parse" a
      // signal about the ledger rather than about where we started reading.
      text = text.slice(text.indexOf('\n') + 1);
      tail = true;
    }
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
    tail,
  };
}

/**
 * The identity of the finding a row is about: `candidate.resourceId` for a piece
 * on either shelf, `candidate.id` for a row the retired git-backed shelf wrote.
 * Null for a row that reached no candidate at all (a `miss`, a capped lookup),
 * which is a row to count in `rows` and not in `candidates`.
 */
function candidateKey(candidate: unknown): string | null {
  if (!isRecord(candidate)) return null;
  if (typeof candidate.resourceId === 'string' && candidate.resourceId !== '') {
    return candidate.resourceId;
  }
  if (typeof candidate.id === 'string' && candidate.id !== '') return candidate.id;
  return null;
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
  };
  return { data, humanLines: renderStatusLines(data) };
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
    `ledger, last ${ledger.windowDays}d${ledger.tail ? ' (retained tail only; the ledger is larger than the 256 KB read, so these are floors)' : ''}: ${ledger.rows} row(s), ${ledger.candidates} finding(s), ${ledger.denies} deny(s), ~${ledger.injectedTokens} injected token(s)`,
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
  return lines;
}

/** What `runPushOn` prints: what {@link wireSearchHooks} actually did, plus the
 *  undo. Not {@link hooksUndo} from lib/harness-hooks.ts — that line names
 *  `hooks.searchMode off`, the search hooks' own off switch, and would tell an
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
