import { lstat, readFile, realpath, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { writeFileAtomic } from './atomic-json';
import { claudeSettingsPath } from './harness-permissions';
import { hooksDir } from './paths';
import {
  DISPATCH_HOOK_FILE,
  SESSIONSTART_HOOK_FILE,
  STOP_HOOK_FILE,
  WEBSEARCH_HOOK_FILE,
  dispatchHookScript,
  sessionPrimerHookScript,
  stopHookScript,
  websearchHookScript,
} from './hook-scripts';
import {
  PUSH_CONTEXT_HOOK_FILE,
  PUSH_FAILURE_HOOK_FILE,
  PUSH_HOOK_TIMEOUT_SECONDS,
  PUSH_PROMPT_HOOK_FILE,
  PUSH_SUBAGENT_HOOK_FILE,
  pushContextHookScript,
  pushFailureHookScript,
  pushPromptHookScript,
  pushSubagentHookScript,
} from './push-scripts';
import type { WebSearchMode } from './config';

/**
 * The second place the CLI writes into a harness's own settings file, and it
 * carries the same invariants as lib/harness-permissions.ts for the same reasons:
 * additive only, never clobbers a file it cannot understand, and refuses rather
 * than overwriting a change that landed mid-run. Read that module's header first;
 * what follows is only what is different here.
 *
 * WHAT A HOOK ENTRY IS. Unlike a permission rule, a hook entry names an
 * executable. Two properties keep that honest:
 *
 *  - The command can only ever be `node <path under the Tenjin data dir>`. There
 *    is no argument, no config key, and no call path that lets a caller point a
 *    hook at some other program, and the scripts themselves are generated from
 *    constants in lib/hook-scripts.ts rather than from anything on the wire.
 *  - Almost no hook can block, deny, or modify a tool call. Every PreToolUse
 *    entry but one emits `additionalContext` and never `permissionDecision`, so
 *    the tool always proceeds; the Stop and SessionStart hooks only ever add a
 *    line. The one exception is the push experiment's abort-and-answer arm
 *    (docs/command-reference.md#push-experimental): on a strong, free hit it may `permissionDecision: 'deny'`
 *    the WebSearch/WebFetch call it fired on and hand the model the finding in
 *    its place, and only that arm ever does.
 *
 * OWNERSHIP IS BY PATH, PER EVENT. An entry is ours when its command mentions one
 * of our script filenames, and each script owns AT MOST ONE ENTRY PER EVENT IT IS
 * PLANNED AGAINST: two entries naming one script under the SAME event would be
 * collapsed by the idempotent rewrite, which is why the dispatch hook takes a
 * single alternation matcher rather than an entry per tool. Two push scripts are
 * planned against two DIFFERENT events on purpose — push-failure covers both
 * PostToolUse and PostToolUseFailure (harness versions differ on which one a
 * failed Bash call raises), and push-context covers both PostToolUse (its read
 * arm) and PreToolUse (its churn arm) — and those pairs live in separate lists,
 * so they never collapse into each other. Per-event ownership is what makes a
 * re-install idempotent, lets a drifted command (an older install's path, a moved
 * data dir) be rewritten in place instead of duplicated, and keeps every entry
 * someone else wrote untouched.
 */

/**
 * The hook events this module writes, in the order they are reported. The last
 * four (UserPromptSubmit, PostToolUse, PostToolUseFailure, SubagentStart) exist
 * only for the push experiment's arms (docs/command-reference.md#push-experimental) and carry no entry at all
 * unless `push: true` is passed to {@link wireSearchHooks}.
 */
export const HOOK_EVENTS = [
  'PreToolUse',
  'SessionStart',
  'Stop',
  'UserPromptSubmit',
  'PostToolUse',
  'PostToolUseFailure',
  'SubagentStart',
] as const;
export type HookEvent = (typeof HOOK_EVENTS)[number];

/**
 * The tools the WebSearch hook fires on WITHOUT the push experiment. Never a
 * wildcard.
 */
export const WEBSEARCH_MATCHER = 'WebSearch';

/**
 * And with it. A fetched page is exactly as good a moment to ask Tenjin first as
 * a search is, and the hook body already treats the two identically — but only
 * when push is on: the script's own first act on a `WebFetch` is to check the
 * key and exit silently if it is not `on`. Registering the wide matcher on a
 * machine that has never opted in bought a process spawn and a config read per
 * WebFetch for a provably silent hook, so the base bundle keeps the narrow one
 * and `tenjin push on` rewrites that entry in place.
 *
 * `tenjin push off` itself narrows nothing, deliberately: it unwires nothing at
 * all (every arm gates on the config key at run time), and a command documented
 * as "no unwiring step" should not start editing settings.json. The next
 * `tenjin install` puts it back on its own — `push` comes from the config there,
 * so the base plan carries the narrow matcher and the ordinary drift rewrite
 * fixes the entry in place. No branch anywhere has to know about the widening.
 */
export const WEBSEARCH_PUSH_MATCHER = 'WebSearch|WebFetch';

/** The tools the dispatch hook fires on: one subagent dispatch under two names
 *  across Claude Code versions. */
export const DISPATCH_MATCHER = 'Agent|Task';

/** A new session, and the two ways a running one loses its context. `resume` is
 *  deliberately absent: a resumed session restores its transcript, so the primer
 *  the original SessionStart printed is already in context. */
export const SESSION_START_MATCHER = 'startup|clear|compact';

/** The push failure arm (docs/command-reference.md#push-experimental, T3) fires on a Bash tool only, on both the
 *  ordinary post-use event and the failure-specific one some harness versions
 *  raise instead. */
export const PUSH_FAILURE_MATCHER = 'Bash';

/** The push context arm's read half: packages a file imports, once it has been
 *  read. */
export const PUSH_CONTEXT_READ_MATCHER = 'Read';

/** The push context arm's churn half: the Nth edit to one file in one session. */
export const PUSH_CONTEXT_EDIT_MATCHER = 'Edit|Write|MultiEdit';

/**
 * Seconds the harness allows each hook before killing it, and the HARD bound on
 * how long either can delay anything. The scripts' own watchdogs (2s and 1.5s)
 * are the design budget and cover the ordinary case, but they are event-loop
 * timers: a synchronous read that blocks outlasts them. This kill does not, so it
 * is the number to quote when the question is "what is the worst case".
 */
const HOOK_TIMEOUT_SECONDS = 5;

export type HooksSkipReason =
  | 'harness-not-claude'
  | 'native-harness'
  | 'mode-off'
  | 'declined'
  | 'dry-run'
  | 'unresolvable'
  | 'unreadable'
  | 'unparsable'
  | 'unexpected-shape'
  | 'changed-since-read';

export interface HooksResult {
  /** The harness this outcome is about; only `claude` has a settings file we write. */
  harness: string;
  /** The settings file, absent when the harness has no such file. */
  path?: string;
  /** Where the hook scripts live (or would). */
  scriptsDir: string;
  /** The behavior the installed scripts will follow (config `hooks.webSearch`; `hooks.agentDispatch` is disjoint, same enum). */
  mode: WebSearchMode;
  /** Events whose entry this run appended. */
  added: HookEvent[];
  /** Events whose entry was already there, byte-identical. */
  alreadyPresent: HookEvent[];
  /** Events whose existing entry pointed somewhere else and was rewritten in place. */
  updated: HookEvent[];
  /** Script files this run wrote or refreshed. */
  scripts: string[];
  /**
   * Hook EVENTS this run registered (added or updated) for the BASE search
   * bundle alone, so a summary can say how many search hooks it wired without
   * counting the push experiment's events in the same number. Undefined on the
   * paths that register nothing.
   */
  searchWrote?: number;
  /**
   * Push-experiment ENTRIES now registered, whether this run wrote them or found
   * them already there. Counted as entries, not events, because `added` and the
   * lists beside it are per-EVENT and one event can carry both a search hook and
   * a push arm — PreToolUse carries three. Undefined when nothing was wired; 0
   * when the experiment is off.
   */
  pushArms?: number;
  skipped?: HooksSkipReason;
  /** Human-readable detail for a skip that is a problem rather than a choice. */
  warning?: string;
  /** The exact command that changes this outcome, mirroring the CliError contract. */
  fix?: string;
}

/**
 * The undo, stated the same way everywhere it is shown.
 *
 * ONE KEY PER BUNDLE, and this line used to claim otherwise. It said
 * `hooks.webSearch off` "disarms them" while printing directly under a
 * disclosure that includes the push arms — and it does not reach those: every
 * push arm's first act is to read `hooks.push`, and nothing in the generated
 * push core reads `webSearch` at all. So when the arms are armed, both keys are
 * named, because neither one covers the other.
 */
export function hooksUndo(settingsPath: string, scriptsDir: string, pushArmed = false): string {
  const switches = pushArmed
    ? '`tenjin config set hooks.webSearch off` (or `hooks.agentDispatch off`) silences the search hooks and `tenjin push off` silences the push arms — each is read by its own scripts, so neither covers the other'
    : '`tenjin config set hooks.webSearch off` (or `hooks.agentDispatch off`) silences them';
  return `Undo anytime: ${switches}, or delete the tenjin hook entries from ${settingsPath} and the scripts in ${scriptsDir}.`;
}

function skip(
  reason: HooksSkipReason,
  args: {
    harness: string;
    path?: string;
    scriptsDir: string;
    mode: WebSearchMode;
    warning?: string;
    fix?: string;
  },
): HooksResult {
  return {
    harness: args.harness,
    ...(args.path !== undefined ? { path: args.path } : {}),
    scriptsDir: args.scriptsDir,
    mode: args.mode,
    added: [],
    alreadyPresent: [],
    updated: [],
    scripts: [],
    skipped: reason,
    ...(args.warning !== undefined ? { warning: args.warning } : {}),
    ...(args.fix !== undefined ? { fix: args.fix } : {}),
  };
}

/** A decision NOT to wire, shaped like a write outcome so the caller has one type. */
export function hooksSkipped(
  harness: string,
  homeDir: string,
  dataDir: string,
  mode: WebSearchMode,
  reason: HooksSkipReason,
): HooksResult {
  return skip(reason, {
    harness,
    ...(harness === 'claude' ? { path: claudeSettingsPath(homeDir) } : {}),
    scriptsDir: hooksDir(dataDir),
    mode,
    fix: fixFor(reason),
  });
}

/**
 * The command that turns a skip into a write. Every skipped state names one, so a
 * machine consumer reading the envelope never has to work out the remedy from
 * prose, which is the same contract a CliError's `fix` carries.
 */
function fixFor(reason: HooksSkipReason): string {
  switch (reason) {
    case 'harness-not-claude':
      return 'Hooks are wired for Claude Code only. Re-run `tenjin install --harness claude` on a machine with Claude Code.';
    case 'native-harness':
      return "Hermes uses Tenjin's native plugin adapter; change behavior with `tenjin config set hooks.webSearch <auto|remind|off>` (or `hooks.agentDispatch`).";
    case 'mode-off':
      return 'Enable them with `tenjin config set hooks.webSearch auto` (and `hooks.agentDispatch auto`), then re-run `tenjin install`.';
    case 'declined':
    case 'dry-run':
      return 'Wire them with `tenjin install --search-hooks auto`.';
    case 'changed-since-read':
      return 'Another process changed the file mid-run; re-run `tenjin install`.';
    default:
      return 'Fix the reported file, then re-run `tenjin install --search-hooks auto`.';
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Quote a path for the shell the harness runs a `command` hook through. POSIX
 * shells take single quotes (with the standard `'\''` escape for an embedded
 * one); cmd.exe does not understand them at all and takes double quotes. Getting
 * this wrong on a home directory with a space silently installs a hook that can
 * never run, so it is a real branch rather than an assumption about paths.
 */
export function quoteForShell(path: string, platform: string = process.platform): string {
  if (platform === 'win32') return `"${path}"`;
  return `'${path.replaceAll("'", `'\\''`)}'`;
}

function commandFor(scriptPath: string, platform?: string): string {
  return `node ${quoteForShell(scriptPath, platform)}`;
}

/** One hook handler, exactly as it is written into settings.json. `timeoutSeconds`
 *  defaults to the search hooks' bound; the push arms pass their own, longer one
 *  (they may fetch a free body after the search answers). */
function handlerFor(
  scriptPath: string,
  platform?: string,
  timeoutSeconds: number = HOOK_TIMEOUT_SECONDS,
): Record<string, unknown> {
  return {
    type: 'command',
    command: commandFor(scriptPath, platform),
    timeout: timeoutSeconds,
  };
}

/** Is this settings.json entry one of ours? Keyed on the script FILENAME, so a
 *  data dir that moved is recognized as our entry and rewritten, not duplicated. */
function ownsEntry(entry: unknown, scriptFile: string): boolean {
  if (!isPlainObject(entry)) return false;
  const handlers = entry.hooks;
  if (!Array.isArray(handlers)) return false;
  return handlers.some(
    (h) => isPlainObject(h) && typeof h.command === 'string' && h.command.includes(scriptFile),
  );
}

interface HookSpec {
  event: HookEvent;
  scriptFile: string;
  script: string;
  /** Which bundle this entry belongs to; the two are counted separately so a
   *  summary never reports a push arm as a search hook. */
  arm: 'search' | 'push';
  /** Absent for Stop and the push subagent/prompt arms, which the harness fires
   *  on every occurrence of the event with no matcher. */
  matcher?: string;
  /** Defaults to {@link HOOK_TIMEOUT_SECONDS}; the push arms override it. */
  timeoutSeconds?: number;
}

/**
 * The base four search-hook entries, always planned. `opts.push` adds the six
 * push-experiment entries (docs/command-reference.md#push-experimental) on top, across FOUR scripts: the prompt
 * and subagent arms carry one entry each, and the failure and context arms carry
 * two apiece because each fires on two different events (a Bash failure surfaces
 * as either PostToolUse or PostToolUseFailure depending on harness version; the
 * context arm's read and churn halves are different events entirely) — so push,
 * when on, plans six entries across four scripts and FIVE events
 * (UserPromptSubmit, PostToolUse, PostToolUseFailure, SubagentStart, PreToolUse;
 * PostToolUse carries two of them, and PreToolUse is shared with the base
 * bundle). Callers that only ever write
 * the base bundle (`writeSharedHookScripts`, the Hermes adapter,
 * `stopHookIsCurrent`) pass no opts and get `push: false`.
 */
function specs(dataDir: string, opts: { push: boolean } = { push: false }): HookSpec[] {
  const base: HookSpec[] = [
    {
      event: 'PreToolUse',
      scriptFile: WEBSEARCH_HOOK_FILE,
      script: websearchHookScript(dataDir),
      // Widened only when push is planned; see WEBSEARCH_PUSH_MATCHER.
      matcher: opts.push ? WEBSEARCH_PUSH_MATCHER : WEBSEARCH_MATCHER,
      arm: 'search',
    },
    {
      event: 'PreToolUse',
      scriptFile: DISPATCH_HOOK_FILE,
      script: dispatchHookScript(dataDir),
      matcher: DISPATCH_MATCHER,
      arm: 'search',
    },
    {
      event: 'SessionStart',
      scriptFile: SESSIONSTART_HOOK_FILE,
      script: sessionPrimerHookScript(dataDir),
      matcher: SESSION_START_MATCHER,
      arm: 'search',
    },
    { event: 'Stop', scriptFile: STOP_HOOK_FILE, script: stopHookScript(dataDir), arm: 'search' },
  ];
  if (!opts.push) return base;
  return [
    ...base,
    {
      event: 'UserPromptSubmit',
      scriptFile: PUSH_PROMPT_HOOK_FILE,
      script: pushPromptHookScript(dataDir),
      timeoutSeconds: PUSH_HOOK_TIMEOUT_SECONDS,
      arm: 'push',
    },
    {
      event: 'PostToolUse',
      scriptFile: PUSH_FAILURE_HOOK_FILE,
      script: pushFailureHookScript(dataDir),
      matcher: PUSH_FAILURE_MATCHER,
      timeoutSeconds: PUSH_HOOK_TIMEOUT_SECONDS,
      arm: 'push',
    },
    {
      event: 'PostToolUseFailure',
      scriptFile: PUSH_FAILURE_HOOK_FILE,
      script: pushFailureHookScript(dataDir),
      matcher: PUSH_FAILURE_MATCHER,
      timeoutSeconds: PUSH_HOOK_TIMEOUT_SECONDS,
      arm: 'push',
    },
    {
      event: 'SubagentStart',
      scriptFile: PUSH_SUBAGENT_HOOK_FILE,
      script: pushSubagentHookScript(dataDir),
      timeoutSeconds: PUSH_HOOK_TIMEOUT_SECONDS,
      arm: 'push',
    },
    {
      event: 'PostToolUse',
      scriptFile: PUSH_CONTEXT_HOOK_FILE,
      script: pushContextHookScript(dataDir),
      matcher: PUSH_CONTEXT_READ_MATCHER,
      timeoutSeconds: PUSH_HOOK_TIMEOUT_SECONDS,
      arm: 'push',
    },
    {
      event: 'PreToolUse',
      scriptFile: PUSH_CONTEXT_HOOK_FILE,
      script: pushContextHookScript(dataDir),
      matcher: PUSH_CONTEXT_EDIT_MATCHER,
      timeoutSeconds: PUSH_HOOK_TIMEOUT_SECONDS,
      arm: 'push',
    },
  ];
}

/**
 * Bring the shared standalone search and publish-back scripts up to date without
 * registering Claude settings. Native harness adapters (currently Hermes) call
 * these same bodies with their own envelope, so validation and local state never
 * fork into a second implementation.
 */
export async function writeSharedHookScripts(dataDir: string): Promise<{
  scriptsDir: string;
  written: string[];
  websearchPath: string;
  stopPath: string;
}> {
  const scriptsDir = hooksDir(dataDir);
  const written = await writeScripts(specs(dataDir), scriptsDir);
  return {
    scriptsDir,
    written,
    websearchPath: join(scriptsDir, WEBSEARCH_HOOK_FILE),
    stopPath: join(scriptsDir, STOP_HOOK_FILE),
  };
}

/**
 * Does the Stop hook ON DISK match what this build would write?
 *
 * `hooks.stopNag` is read by the installed script at run time, so a `config set`
 * takes effect immediately — but only for values that script UNDERSTANDS. A
 * script written before `deliberate-only` existed maps every non-`off` value to
 * `on`, so the set succeeds, `config get` reports it effective from `file`, and
 * the batch keeps firing. Never throws: a machine with no hook installed is not
 * drifted, it is unhooked, and neither is this function's caller's problem to
 * fail on.
 */
export async function stopHookIsCurrent(dataDir: string): Promise<boolean> {
  const spec = specs(dataDir).find((h) => h.scriptFile === STOP_HOOK_FILE);
  if (spec === undefined) return true;
  const path = join(hooksDir(dataDir), STOP_HOOK_FILE);
  const onDisk = await readFile(path, 'utf8').catch(() => null);
  // Absent means nothing is running that could be stale.
  return onDisk === null || onDisk === spec.script;
}

export interface WireHooksOptions {
  homeDir: string;
  dataDir: string;
  mode: WebSearchMode;
  /** Shell-quoting target; injected so both branches are testable on one machine. */
  platform?: string;
  /** Also plan the six push-experiment entries (docs/command-reference.md#push-experimental). Defaults to
   *  false: `tenjin install` on a normal machine registers nothing new, and only
   *  `tenjin push on` (or a later install with `hooks.push` already `on`) passes
   *  true. */
  push?: boolean;
}

/**
 * Write the hook scripts and merge their entries into ~/.claude/settings.json.
 *
 * The SCRIPTS are written whatever the mode, including `off`: the mode is read by
 * the script at run time, so an operator who later flips `hooks.webSearch` back
 * to `auto` (or `hooks.agentDispatch`) gets working hooks without re-installing.
 * Only `mode: 'off'` is refused at the caller (see `hooksSkipped`), which leaves
 * settings.json alone entirely.
 *
 * Idempotent: a second run rewrites no script whose bytes match, appends no entry
 * that is already there, and does not touch settings.json at all when nothing
 * changed.
 */
export async function wireSearchHooks(opts: WireHooksOptions): Promise<HooksResult> {
  const { homeDir, dataDir, mode, platform, push = false } = opts;
  const scriptsDir = hooksDir(dataDir);
  const plan = specs(dataDir, { push });

  const found = await inspectSettings(homeDir, scriptsDir, mode);
  if ('result' in found) return found.result;
  const { path, raw, settings, hooks } = found;

  const nextHooks: Record<string, unknown> = { ...hooks };

  // One event carries several of our entries, so it is reported ONCE and by its
  // strongest outcome: two lists would say two contradictory things about it.
  // Each spec appends to the RUNNING list, not to what was read from disk.
  const outcomes = new Map<HookEvent, 'added' | 'updated' | 'alreadyPresent'>();
  // The same collapse, over the BASE bundle only. `outcomes` cannot answer "how
  // many search hooks did this run wire" once push is on, because PreToolUse
  // carries entries from both bundles and reports as one event either way.
  const searchOutcomes = new Map<HookEvent, 'added' | 'updated' | 'alreadyPresent'>();
  // ENTRIES, not events, and every outcome counts: this is "how many push arms
  // are wired now", which is what the disclosure has to be true about on a
  // re-run that found them all already present.
  let pushArms = 0;
  const rank = { added: 3, updated: 2, alreadyPresent: 1 } as const;
  const note = (
    outcome: 'added' | 'updated' | 'alreadyPresent',
    event: HookEvent,
    arm: 'search' | 'push',
  ): void => {
    const seen = outcomes.get(event);
    if (seen === undefined || rank[outcome] > rank[seen]) outcomes.set(event, outcome);
    if (arm === 'push') {
      pushArms += 1;
      return;
    }
    const seenSearch = searchOutcomes.get(event);
    if (seenSearch === undefined || rank[outcome] > rank[seenSearch]) {
      searchOutcomes.set(event, outcome);
    }
  };
  const eventsWith = (outcome: 'added' | 'updated' | 'alreadyPresent'): HookEvent[] =>
    HOOK_EVENTS.filter((event) => outcomes.get(event) === outcome);

  for (const spec of plan) {
    const existing = nextHooks[spec.event];
    if (existing !== undefined && !Array.isArray(existing)) {
      return refuse(
        path,
        scriptsDir,
        mode,
        'unexpected-shape',
        `${path} has a "hooks.${spec.event}" key that is not an array; it was left exactly as it is.`,
      );
    }
    const list: unknown[] = existing ?? [];
    const desired = {
      ...(spec.matcher !== undefined ? { matcher: spec.matcher } : {}),
      hooks: [handlerFor(join(scriptsDir, spec.scriptFile), platform, spec.timeoutSeconds)],
    };
    const idx = list.findIndex((e) => ownsEntry(e, spec.scriptFile));
    if (idx === -1) {
      nextHooks[spec.event] = [...list, desired];
      note('added', spec.event, spec.arm);
      continue;
    }
    if (JSON.stringify(list[idx]) === JSON.stringify(desired)) {
      note('alreadyPresent', spec.event, spec.arm);
      continue;
    }
    // Ours, but stale: an older install's path, or a data dir that moved. Rewritten
    // IN PLACE so the entry keeps its position among whatever else is registered.
    nextHooks[spec.event] = list.map((e, i) => (i === idx ? desired : e));
    note('updated', spec.event, spec.arm);
  }

  const added = eventsWith('added');
  const updated = eventsWith('updated');
  const alreadyPresent = eventsWith('alreadyPresent');
  const searchWrote = HOOK_EVENTS.filter((event) => {
    const outcome = searchOutcomes.get(event);
    return outcome === 'added' || outcome === 'updated';
  }).length;

  // Nothing to register: no guard is involved, so the scripts are simply brought
  // up to date. This is the path a re-run takes after an upgrade changed a body.
  if (added.length === 0 && updated.length === 0) {
    const scripts = await writeScripts(scriptPlan(dataDir), scriptsDir);
    return {
      harness: 'claude',
      path,
      scriptsDir,
      mode,
      added,
      alreadyPresent,
      updated,
      scripts,
      searchWrote,
      pushArms,
    };
  }

  const next = { ...settings, hooks: nextHooks };
  // TWO compares, and both are load-bearing.
  //
  // The FIRST is cheap and early: it refuses before a single byte is written, so
  // the ordinary contended case costs nothing and leaves nothing half-done.
  const changed = async (): Promise<boolean> =>
    (await readFile(path, 'utf8').catch(() => null)) !== raw;
  if (await changed()) return refuseChanged(path, scriptsDir, mode, []);

  // Past the first guard, and still before the entry that points at them, so a
  // harness never reads an entry naming a file that is not on disk yet.
  const scripts = await writeScripts(scriptPlan(dataDir), scriptsDir);

  // The SECOND compare sits ADJACENT to the commit, because the writes above are
  // two read/write/rename sequences wide and this is a whole-file replacement
  // built from a snapshot taken before them. Claude Code writing settings.json
  // during that window passed the first compare and would be erased here. The
  // refusal reports the scripts that WERE refreshed, so the result describes what
  // actually happened rather than claiming nothing was touched: the bodies are
  // versioned and idempotent, so a refreshed script with no new entry is inert
  // and the re-run the fix names simply registers it.
  if (await changed()) return refuseChanged(path, scriptsDir, mode, scripts);
  await writeFileAtomic(path, `${JSON.stringify(next, null, 2)}\n`);
  return {
    harness: 'claude',
    path,
    scriptsDir,
    mode,
    added,
    alreadyPresent,
    updated,
    scripts,
    searchWrote,
    pushArms,
  };
}

/**
 * The `changed-since-read` refusal, carrying whatever scripts the run had already
 * refreshed. Nothing about settings.json is written on this path.
 */
function refuseChanged(
  path: string,
  scriptsDir: string,
  mode: WebSearchMode,
  scripts: string[],
): HooksResult {
  return {
    ...refuse(
      path,
      scriptsDir,
      mode,
      'changed-since-read',
      `${path} changed while it was being updated, so no hooks were registered. Re-run \`tenjin install\`.`,
    ),
    scripts,
  };
}

/**
 * Every script body this CLI generates, for the WRITER — which is not the same
 * set as the entry plan.
 *
 * `tenjin push off` unwires nothing: the six entries stay registered and keep
 * invoking the four push scripts, which exit on the config key. Planning the
 * base four for the writer therefore froze those four bodies at whatever version
 * was on disk when push was last on, and every later upgrade left six registered
 * entries running pre-upgrade code whose inertness rested entirely on the
 * run-time gate keeping the shape it had then. A body that is never registered
 * is inert and costs a few KB; a stale body that IS registered is a liability.
 *
 * So: entries follow `opts.push`, bodies never do.
 */
function scriptPlan(dataDir: string): HookSpec[] {
  return specs(dataDir, { push: true });
}

/** Bring each script up to date, returning the ones this run actually wrote. A
 *  body that already matches is left alone, so a re-run rewrites nothing, and a
 *  script named by two specs is written once for the same reason. */
async function writeScripts(plan: HookSpec[], scriptsDir: string): Promise<string[]> {
  const written: string[] = [];
  for (const spec of plan) {
    const target = join(scriptsDir, spec.scriptFile);
    const onDisk = await readFile(target, 'utf8').catch(() => null);
    if (onDisk === spec.script) continue;
    await writeFileAtomic(target, spec.script, { mode: 0o755, dirMode: 0o700 });
    written.push(target);
  }
  return written;
}

function refuse(
  path: string,
  scriptsDir: string,
  mode: WebSearchMode,
  reason: HooksSkipReason,
  warning: string,
): HooksResult {
  return skip(reason, { harness: 'claude', path, scriptsDir, mode, warning, fix: fixFor(reason) });
}

/** The four generated push arms, by filename. Written by EVERY install, not only
 *  by `push on` — the bodies are cheap and inert until an entry points at them,
 *  and what `push on` adds is the six settings entries. This is also what
 *  `uninstall` removes. Doctor's `checkPushHooks` reads both halves for that
 *  reason: `pushScriptsPresent` is true after any install, so only its
 *  entry-count half distinguishes a wired sidecar from an unwired one. */
export const PUSH_SCRIPT_FILES = [
  PUSH_PROMPT_HOOK_FILE,
  PUSH_FAILURE_HOOK_FILE,
  PUSH_SUBAGENT_HOOK_FILE,
  PUSH_CONTEXT_HOOK_FILE,
] as const;

/** Are all four push scripts on disk under `<dataDir>/hooks`? Half of "wired";
 *  {@link countPushHookEntries} is the other half. */
export async function pushScriptsPresent(dataDir: string): Promise<boolean> {
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

/** What {@link countPushHookEntries} found in settings.json. */
export interface PushHookEntryCount {
  /** Entries a `push on` would plan: six, across five events. Derived from
   *  {@link specs}, never a literal — the two must not be able to disagree. */
  planned: number;
  /** How many of them are registered right now, matched by the SAME ownership
   *  predicate the writer uses, so "present" here and "already up to date"
   *  there can never disagree. */
  present: number;
  /** The settings file consulted. Null when there is none to read at all. */
  path: string | null;
}

/**
 * How many push arms are actually REGISTERED, as opposed to written to disk.
 *
 * The two halves come apart, and each one alone reports healthy while the
 * sidecar does nothing: scripts with no entries is a `push on` that refused the
 * settings write, entries with no scripts is a half-finished uninstall. Nothing
 * runs in either case, so both are asked and both are printed.
 *
 * Read-only and best-effort: an unreadable or unparseable settings file answers
 * "none present", never an error — this is a diagnostic, and a diagnostic that
 * throws is one an operator meets at the worst moment.
 */
export async function countPushHookEntries(
  homeDir: string,
  dataDir: string,
): Promise<PushHookEntryCount> {
  const plan = specs(dataDir, { push: true }).filter((spec) => spec.arm === 'push');
  const declaredPath = claudeSettingsPath(homeDir);
  let raw: string;
  try {
    raw = await readFile(declaredPath, 'utf8');
  } catch {
    return { planned: plan.length, present: 0, path: null };
  }
  let hooks: unknown;
  try {
    const parsed: unknown = JSON.parse(raw);
    hooks = isPlainObject(parsed) ? parsed.hooks : undefined;
  } catch {
    return { planned: plan.length, present: 0, path: declaredPath };
  }
  if (!isPlainObject(hooks)) return { planned: plan.length, present: 0, path: declaredPath };
  let present = 0;
  for (const spec of plan) {
    const list = hooks[spec.event];
    if (!Array.isArray(list)) continue;
    if (list.some((entry) => ownsEntry(entry, spec.scriptFile))) present += 1;
  }
  return { planned: plan.length, present, path: declaredPath };
}

interface SettingsInspection {
  path: string;
  /** The exact bytes read, so the commit can prove nothing changed underneath it. */
  raw: string | null;
  settings: Record<string, unknown>;
  hooks: Record<string, unknown>;
}

/**
 * Resolve and read the settings file. Every refusal lives here, so the shape
 * checks and the write agree by construction. Symlinks are resolved before the
 * write for the same reason lib/harness-permissions.ts resolves them: committing
 * with a rename over a dotfiles-managed link would sever it.
 */
async function inspectSettings(
  homeDir: string,
  scriptsDir: string,
  mode: WebSearchMode,
): Promise<SettingsInspection | { result: HooksResult }> {
  const declaredPath = claudeSettingsPath(homeDir);
  const entry = await lstat(declaredPath).catch(() => null);

  let path = declaredPath;
  if (entry !== null) {
    try {
      path = await realpath(declaredPath);
    } catch (err) {
      return {
        result: refuse(
          declaredPath,
          scriptsDir,
          mode,
          'unresolvable',
          `${declaredPath} could not be resolved (${(err as Error).message}); it was left exactly as it is.`,
        ),
      };
    }
  }

  let settings: Record<string, unknown> = {};
  let raw: string | null = null;
  if (entry !== null) {
    try {
      raw = await readFile(path, 'utf8');
    } catch (err) {
      return {
        result: refuse(
          path,
          scriptsDir,
          mode,
          'unreadable',
          `${path} could not be read (${(err as Error).message}); no hooks were registered.`,
        ),
      };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      return {
        result: refuse(
          path,
          scriptsDir,
          mode,
          'unparsable',
          `${path} is not valid JSON (${(err as Error).message}); it was left exactly as it is.`,
        ),
      };
    }
    if (!isPlainObject(parsed)) {
      return {
        result: refuse(
          path,
          scriptsDir,
          mode,
          'unexpected-shape',
          `${path} is not a JSON object; it was left exactly as it is.`,
        ),
      };
    }
    settings = parsed;
  }

  const hooksValue = settings.hooks;
  if (hooksValue !== undefined && !isPlainObject(hooksValue)) {
    return {
      result: refuse(
        path,
        scriptsDir,
        mode,
        'unexpected-shape',
        `${path} has a "hooks" key that is not an object; it was left exactly as it is.`,
      ),
    };
  }
  return { path, raw, settings, hooks: hooksValue ?? {} };
}
