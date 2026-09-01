import { lstat, readFile, realpath, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { writeFileAtomic } from './atomic-json';
import { claudeSettingsPath } from './harness-permissions';
import { hooksDir } from './paths';
import {
  DISPATCH_HOOK_FILE,
  HOOK_SCRIPT_MARKER,
  HOOK_TIMEOUT_SECONDS,
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
  PUSH_VITEST_REPORTER_FILE,
  pushContextHookScript,
  pushFailureHookScript,
  pushPromptHookScript,
  pushSubagentHookScript,
  pushVitestReporterScript,
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
 *  - No hook can block, deny, or modify a tool call. Every PreToolUse entry
 *    emits `additionalContext` and never `permissionDecision`, so the tool
 *    always proceeds; the SessionStart hook only ever adds a line. Two entries
 *    can hold a TURN END open instead, each once and each behind its own gate:
 *    the Stop hook's capture ask under `hooks.capture block`, and the
 *    SubagentStop arm's finding ask, which returns to the CHILD that is
 *    stopping and costs it one more turn.
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
 * five (UserPromptSubmit, PostToolUse, PostToolUseFailure, SubagentStart,
 * SubagentStop) exist
 * only for the push experiment's arms (docs/command-reference.md#push-experimental) and carry no entry at all
 * unless `push: true` is passed to {@link wireSearchHooks}.
 *
 * `SubagentStop` is a SECOND entry on the subagent script, not a script of its
 * own: one child-lifecycle arm owns both ends of a child (tenjin-agent#228).
 * Registering a new EVENT is the one kind of change `install --refresh`
 * (tenjin-agent#224) does not converge, so its release note says to run
 * `tenjin install` once and doctor names the machine that has not.
 */
export const HOOK_EVENTS = [
  'PreToolUse',
  'SessionStart',
  'Stop',
  'UserPromptSubmit',
  'PostToolUse',
  'PostToolUseFailure',
  'SubagentStart',
  'SubagentStop',
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

/** The push context arm's churn half: the Nth edit to one file in one session.
 *  Also carries Bash (tenjin-agent#278 round 3): the same PreToolUse entry
 *  stamps a per-agent timing mark before each Bash call, which the failure
 *  arm reads back to decide whether a test-report artifact could be about
 *  THIS command rather than an earlier one — no new event, no new entry,
 *  just a wider matcher on the one already wired. */
export const PUSH_CONTEXT_EDIT_MATCHER = 'Edit|Write|MultiEdit|Bash';

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

/**
 * Is this entry ours AND already pointed at `dataDir`? The second half is what
 * {@link refreshHooks} needs and {@link wireSearchHooks} must not have.
 *
 * The filename match above is deliberately blind to which directory an entry
 * names, so the writer recognizes a moved data dir and rewrites it rather than
 * duplicating it. A refresh runs ONCE PER DETECTED PROFILE over the same
 * settings file, so that blindness there means every pass claims every other
 * pass's entries: two profiles leave the last one in map order owning every
 * event, and a shelf profile with `push: on` would widen the default profile's
 * WebSearch matcher. Matching on the entry's OWN data dir keeps each pass to the
 * entries it wrote; a profile whose entry names a dir nobody detected simply has
 * no pass to converge it, which is the same answer a refresh gives any surface
 * that is not there.
 */
function ownsEntryUnder(entry: unknown, scriptFile: string, dataDir: string): boolean {
  if (!ownsEntry(entry, scriptFile)) return false;
  const handlers = (entry as { hooks: unknown[] }).hooks;
  const want = resolve(dataDir);
  return handlers.some((h) => {
    if (!isPlainObject(h) || typeof h.command !== 'string') return false;
    const owner = hookOwnerOf(h.command);
    return (
      owner !== null && basename(owner.script) === scriptFile && resolve(owner.dataDir) === want
    );
  });
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
 * The base four search-hook entries, always planned. `opts.push` adds the seven
 * push-experiment entries (docs/command-reference.md#push-experimental) on top, across FOUR scripts: the prompt
 * arm carries one entry, and the failure, subagent and context arms carry
 * two apiece because each fires on two different events (a Bash failure surfaces
 * as either PostToolUse or PostToolUseFailure depending on harness version; the
 * subagent arm owns both ends of a child's life; the
 * context arm's read and churn halves are different events entirely) — so push,
 * when on, plans seven entries across four scripts and SIX events
 * (UserPromptSubmit, PostToolUse, PostToolUseFailure, SubagentStart,
 * SubagentStop, PreToolUse;
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
      // The same script under a second event, exactly as the failure arm rides
      // two: the body branches on `hook_event_name`, and one entry per (script,
      // event) is what keeps a re-install idempotent.
      event: 'SubagentStop',
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
  /** Also plan the seven push-experiment entries (docs/command-reference.md#push-experimental). Defaults to
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

  const found = await inspectSettings(homeDir);
  if ('refusal' in found) {
    const { path, reason, message } = found.refusal;
    return refuse(path, scriptsDir, mode, reason, message);
  }
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
    // NOT FOLDED INTO `scripts`: the vitest reporter is never a settings.json
    // entry, and several callers assert `scripts` exactly (`toEqual([])` on a
    // clean re-run) — a shared array would make this write, alone, fail those
    // on its very first run.
    await writeVitestReporter(scriptsDir);
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
  await writeVitestReporter(scriptsDir);

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
 * `tenjin push off` unwires nothing: the seven entries stay registered and keep
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

/**
 * The vitest reporter asset (tenjin-agent#278 round 3), brought up to date
 * alongside the push scripts but NOT through {@link writeScripts}: it is not a
 * {@link HookSpec} because it is never a settings.json entry — vitest imports
 * it directly from a repo's own config, by the stable absolute path this
 * write gives it. Bodies never gate on `push` here either, for the same
 * reason {@link scriptPlan} says the push bodies do not: a repo's config can
 * reference this file before `push on` is ever run, and it does nothing
 * whatever `push`'s state is — the failure hook is what reads its output, and
 * that gates on the config key at run time like every other push arm.
 * READ-ONLY, NOT EXECUTABLE (`0o644`): unlike a hook script, this file is
 * never spawned as a process, only `import()`ed by vitest itself.
 */
async function writeVitestReporter(scriptsDir: string): Promise<string | null> {
  const target = join(scriptsDir, PUSH_VITEST_REPORTER_FILE);
  const script = pushVitestReporterScript();
  const onDisk = await readFile(target, 'utf8').catch(() => null);
  if (onDisk === script) return null;
  await writeFileAtomic(target, script, { mode: 0o644, dirMode: 0o700 });
  return target;
}

/**
 * {@link writeScripts} for the UNATTENDED writer: rewrite only the scripts that
 * are already on disk AND already ours.
 *
 * `install` is a command a human ran, and it writes to paths this CLI chose. A
 * refresh is spawned by `update` and rewrites paths it read back out of the
 * harness's settings.json, which anything on the machine can have written. A
 * command of the right SHAPE (`node <dir>/hooks/tenjin-stop.mjs`) is therefore
 * not evidence that the file at the other end is a Tenjin hook, so ownership is
 * proved from the BYTES instead: an unreadable file, or one without the
 * generated header, is left exactly as it is.
 *
 * `lstat` rather than `stat`, so a symlink standing where a script should be is
 * skipped rather than written through.
 *
 * WHAT BOUNDS THIS IS THE MARKER, NOT THE PATH, and the distinction is worth
 * stating because a path check cannot do the job. `<dataDir>/hooks` may resolve
 * through symlinks well above it — `/var` is one on macOS, and a home directory
 * on another volume is another — so "the resolved leaf sits under the resolved
 * hooks dir" is true even when the whole directory is a link, and demanding the
 * resolved path EQUAL the literal one would refuse the ordinary machines above.
 * The marker is what actually holds: the destination must already contain a
 * header this CLI wrote, so the worst a redirected path reaches is a Tenjin hook
 * script, which is the file a refresh exists to rewrite.
 *
 * The one component this writer does own is `hooks` itself; see
 * {@link refreshHooks}, which refuses when that is not a real directory.
 */
async function writeOwnedScripts(plan: HookSpec[], scriptsDir: string): Promise<string[]> {
  const owned: HookSpec[] = [];
  for (const spec of plan) {
    const target = join(scriptsDir, spec.scriptFile);
    const entry = await lstat(target).catch(() => null);
    if (entry === null || !entry.isFile()) continue;
    const onDisk = await readFile(target, 'utf8').catch(() => null);
    if (onDisk === null || !onDisk.includes(HOOK_SCRIPT_MARKER)) continue;
    owned.push(spec);
  }
  return writeScripts(owned, scriptsDir);
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
 *  and what `push on` adds is the seven settings entries. This is also what
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
  /** Entries a `push on` would plan: seven, across six events. Derived from
   *  {@link specs}, never a literal — the two must not be able to disagree. */
  planned: number;
  /**
   * The events a planned entry is missing from, in plan order.
   *
   * NAMED, NOT JUST COUNTED, because the ways to be half-wired are not alike:
   * an install that predates an event is missing exactly that one entry while
   * every other arm runs, and `install --refresh` (tenjin-agent#224) converges
   * bodies without ever adding it. Doctor says which one, so the fix is a
   * command rather than a hunt.
   */
  missing: HookEvent[];
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
  const allMissing = plan.map((spec) => spec.event);
  const declaredPath = claudeSettingsPath(homeDir);
  let raw: string;
  try {
    raw = await readFile(declaredPath, 'utf8');
  } catch {
    return { planned: plan.length, missing: allMissing, present: 0, path: null };
  }
  let hooks: unknown;
  try {
    const parsed: unknown = JSON.parse(raw);
    hooks = isPlainObject(parsed) ? parsed.hooks : undefined;
  } catch {
    return { planned: plan.length, missing: allMissing, present: 0, path: declaredPath };
  }
  if (!isPlainObject(hooks)) {
    return { planned: plan.length, missing: allMissing, present: 0, path: declaredPath };
  }
  let present = 0;
  const missing: HookEvent[] = [];
  for (const spec of plan) {
    const list = hooks[spec.event];
    if (Array.isArray(list) && list.some((entry) => ownsEntry(entry, spec.scriptFile))) {
      present += 1;
      continue;
    }
    missing.push(spec.event);
  }
  return { planned: plan.length, missing, present, path: declaredPath };
}

interface SettingsInspection {
  path: string;
  /** The exact bytes read, so the commit can prove nothing changed underneath it. */
  raw: string | null;
  settings: Record<string, unknown>;
  hooks: Record<string, unknown>;
}

/** Why the settings file cannot be written, in the terms {@link refuse} renders. */
interface SettingsRefusal {
  reason: HooksSkipReason;
  message: string;
  path: string;
}

/**
 * Resolve and read the settings file. Every refusal lives here, so the shape
 * checks and the write agree by construction. Symlinks are resolved before the
 * write for the same reason lib/harness-permissions.ts resolves them: committing
 * with a rename over a dotfiles-managed link would sever it.
 *
 * Returns the refusal as DATA rather than as a rendered `HooksResult`, because
 * two writers now share it and they report differently: `wireSearchHooks` owes
 * the operator a mode and a scripts dir, `refreshHooks` owes a warning line.
 */
async function inspectSettings(
  homeDir: string,
): Promise<SettingsInspection | { refusal: SettingsRefusal }> {
  const declaredPath = claudeSettingsPath(homeDir);
  const entry = await lstat(declaredPath).catch(() => null);

  let path = declaredPath;
  if (entry !== null) {
    try {
      path = await realpath(declaredPath);
    } catch (err) {
      return {
        refusal: {
          reason: 'unresolvable',
          path: declaredPath,
          message: `${declaredPath} could not be resolved (${(err as Error).message}); it was left exactly as it is.`,
        },
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
        refusal: {
          reason: 'unreadable',
          path,
          message: `${path} could not be read (${(err as Error).message}); no hooks were registered.`,
        },
      };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      return {
        refusal: {
          reason: 'unparsable',
          path,
          message: `${path} is not valid JSON (${(err as Error).message}); it was left exactly as it is.`,
        },
      };
    }
    if (!isPlainObject(parsed)) {
      return {
        refusal: {
          reason: 'unexpected-shape',
          path,
          message: `${path} is not a JSON object; it was left exactly as it is.`,
        },
      };
    }
    settings = parsed;
  }

  const hooksValue = settings.hooks;
  if (hooksValue !== undefined && !isPlainObject(hooksValue)) {
    return {
      refusal: {
        reason: 'unexpected-shape',
        path,
        message: `${path} has a "hooks" key that is not an object; it was left exactly as it is.`,
      },
    };
  }
  return { path, raw, settings, hooks: hooksValue ?? {} };
}

/**
 * A Tenjin data dir whose generated hook scripts this machine's harness is
 * registered to run.
 *
 * There can be more than one. `install` bakes its data dir into the scripts it
 * generates and into the entry that names them, so a machine that ran
 * `TENJIN_DATA_DIR=~/.tenjin-shelf tenjin install` has hooks belonging to the
 * shelf profile while a bare `tenjin` still resolves `~/.tenjin`. That split is
 * a deliberate, supported setup, and it is invisible until something reads the
 * entries back.
 */
export interface HookOwner {
  /** The data dir the scripts live under: two levels up from the script path. */
  dataDir: string;
  /** The registered script paths under it, deduped, in the order first seen. */
  scripts: string[];
}

/** Our generated hook scripts are all `tenjin-<something>.mjs`, under `hooks/`. */
const TENJIN_HOOK_SCRIPT = /^tenjin-[A-Za-z0-9._-]+\.mjs$/;

/**
 * Undo {@link quoteForShell}. A settings entry's command is written by this
 * module and nowhere else, so the two forms it can take are the two that
 * function emits; anything else is read as a bare token and then rejected by the
 * shape checks in {@link hookOwnerOf}.
 */
function unquoteFromShell(token: string): string {
  if (token.length >= 2 && token.startsWith(`'`) && token.endsWith(`'`)) {
    return token.slice(1, -1).replaceAll(`'\\''`, `'`);
  }
  if (token.length >= 2 && token.startsWith('"') && token.endsWith('"')) {
    return token.slice(1, -1);
  }
  return token;
}

/**
 * The data dir behind one settings command, or null when the command is not one
 * of ours.
 *
 * FOUR shape checks, all required, because this answer decides which profile an
 * unattended `update` re-materializes: the command must be `node <path>`, the
 * path must be ABSOLUTE, the basename must be one of our generated script names,
 * and the parent directory must be `hooks`. The last is what makes
 * `dirname(dirname(path))` the data dir rather than a guess — {@link hooksDir} is
 * `join(dataDir, 'hooks')`, so any other parent means the path did not come from
 * this CLI and its grandparent is nothing in particular.
 *
 * Absoluteness is its own check because this writer never emits a relative
 * command, while a hand-edited `node hooks/tenjin-stop.mjs` would answer with the
 * data dir `.` and be resolved against whatever cwd the reader happens to have —
 * `homedir()` in the refresh child, which is not a profile anybody registered.
 */
function hookOwnerOf(command: string): { dataDir: string; script: string } | null {
  if (!command.startsWith('node ')) return null;
  const script = unquoteFromShell(command.slice('node '.length).trim());
  if (!isAbsolute(script)) return null;
  if (!TENJIN_HOOK_SCRIPT.test(basename(script))) return null;
  const dir = dirname(script);
  if (basename(dir) !== 'hooks') return null;
  return { dataDir: dirname(dir), script };
}

/**
 * Every profile whose hooks this machine's harness actually fires.
 *
 * Read-only and best-effort, like {@link countPushHookEntries}: a settings file
 * that is missing, unreadable, not JSON, or shaped unexpectedly answers "none",
 * never an error. `update` calls this to decide what to re-materialize, and a
 * detector that threw would turn a stray edit in someone's settings.json into a
 * failed upgrade.
 */
export async function detectHookOwners(homeDir: string): Promise<HookOwner[]> {
  let hooks: unknown;
  try {
    const parsed: unknown = JSON.parse(await readFile(claudeSettingsPath(homeDir), 'utf8'));
    hooks = isPlainObject(parsed) ? parsed.hooks : undefined;
  } catch {
    return [];
  }
  if (!isPlainObject(hooks)) return [];
  const owners = new Map<string, HookOwner>();
  for (const list of Object.values(hooks)) {
    if (!Array.isArray(list)) continue;
    for (const entry of list) {
      if (!isPlainObject(entry) || !Array.isArray(entry.hooks)) continue;
      for (const handler of entry.hooks) {
        if (!isPlainObject(handler) || typeof handler.command !== 'string') continue;
        const owner = hookOwnerOf(handler.command);
        if (owner === null) continue;
        // Keyed on the RESOLVED dir, and the resolved dir is what a caller gets
        // back. `ownsEntryUnder` compares resolved paths, so `/x/.tenjin`,
        // `/x/./.tenjin` and `/x/foo/../.tenjin` are one profile there; deduping
        // the raw strings here would make them three, each costing a spawn and a
        // slot under `update`'s refresh cap and so able to crowd out a real one.
        const dataDir = resolve(owner.dataDir);
        const script = resolve(owner.script);
        const found = owners.get(dataDir) ?? { dataDir, scripts: [] };
        if (!found.scripts.includes(script)) found.scripts.push(script);
        owners.set(dataDir, found);
      }
    }
  }
  return [...owners.values()];
}

/** What one {@link refreshHooks} pass did. Nothing here can be an addition. */
export interface HookRefreshResult {
  /** The settings file consulted; null when there is none on this machine. */
  path: string | null;
  scriptsDir: string;
  /** Script bodies this run rewrote. Empty when every one was already current. */
  scripts: string[];
  /** Events whose entry of ours this run rewrote in place. */
  updated: HookEvent[];
  /** Events carrying an entry of ours that already matched. */
  alreadyPresent: HookEvent[];
  /** Why the settings file was left alone, when it was. */
  warning?: string;
}

/**
 * Bring the hook surfaces this machine ALREADY has up to this build, and add
 * none.
 *
 * The difference from {@link wireSearchHooks} is the whole point: that one
 * materializes the plan, this one converges what exists. A script the plan names
 * but disk does not carry is left absent, and an event with no entry of ours
 * gets none. So an unattended caller (`tenjin update`) can run it on any machine
 * without turning an upgrade into an install.
 *
 * ONE PROFILE'S ENTRIES, NEVER ANOTHER'S. `update` runs this once per detected
 * profile against the SAME settings file, so entries are matched on their own
 * data dir as well as the script filename (see {@link ownsEntryUnder}). Without
 * that each pass would claim every pass's entries and the last one would own
 * every event.
 *
 * `push` is read from the machine's own config by the caller rather than
 * defaulted here, because it decides the WebSearch entry's matcher: planning
 * `push: true` on a machine with the experiment off would rewrite the existing
 * entry to the widened `WebSearch|WebFetch` matcher and start firing the hook on
 * a tool the operator never armed it for.
 *
 * `<dataDir>/hooks` must be a REAL DIRECTORY. The data dir arrives from
 * `detectHookOwners`, which read it out of a settings file this CLI does not
 * own, and `hooks` is the one component of that path this writer puts there
 * itself — so a link standing in its place is the one redirection that is never
 * a machine's own layout, as opposed to the symlinks above it that routinely
 * are (see {@link writeOwnedScripts}). Refused rather than followed, and
 * reported: the operator's own `tenjin install` still writes through it.
 */
export async function refreshHooks(opts: {
  homeDir: string;
  dataDir: string;
  push: boolean;
  platform?: string;
}): Promise<HookRefreshResult> {
  const { homeDir, dataDir, push, platform } = opts;
  const scriptsDir = hooksDir(dataDir);

  // Bodies first, and only for files already on disk that are OURS BY CONTENT.
  // `scriptPlan` is the full writer set (see its own note on why bodies ignore
  // `push`); this filter is what keeps the refresh from materializing a script
  // the machine lacks, and from overwriting one it did not write. An absent
  // `hooks` is nothing to refresh; one that exists but is not a directory is a
  // redirection this writer refuses to follow (see the header).
  const dirEntry = await lstat(scriptsDir).catch(() => null);
  const redirected = dirEntry !== null && !dirEntry.isDirectory();
  const scriptWarning = redirected
    ? `${scriptsDir} is not a directory, so no hook script was rewritten. Re-run \`tenjin install\` if that path is yours.`
    : undefined;
  const scripts = redirected ? [] : await writeOwnedScripts(scriptPlan(dataDir), scriptsDir);
  /** The settings half's warning wins the line; the script half's is appended. */
  const warn = (settingsWarning?: string): { warning?: string } => {
    const joined = [scriptWarning, settingsWarning].filter((w) => w !== undefined).join(' ');
    return joined.length > 0 ? { warning: joined } : {};
  };

  const found = await inspectSettings(homeDir);
  if ('refusal' in found) {
    return {
      path: found.refusal.path,
      scriptsDir,
      scripts,
      updated: [],
      alreadyPresent: [],
      ...warn(found.refusal.message),
    };
  }
  const { path, raw, settings, hooks } = found;

  const nextHooks: Record<string, unknown> = { ...hooks };
  const updatedEvents = new Set<HookEvent>();
  const currentEvents = new Set<HookEvent>();
  for (const spec of specs(dataDir, { push })) {
    const list = nextHooks[spec.event];
    if (!Array.isArray(list)) continue;
    // Scoped to entries already under THIS pass's data dir (see
    // {@link ownsEntryUnder}); the writer's filename-only match would let one
    // profile's pass repoint another profile's entries at its own hooks dir.
    const idx = list.findIndex((e) => ownsEntryUnder(e, spec.scriptFile, dataDir));
    // The one branch that separates this from the writer: no entry means no
    // entry. An install adds it; a refresh has nothing to converge.
    if (idx === -1) continue;
    // ONE HANDLER, deliberately, and inherited from the writer. An entry whose
    // handlers named two data dirs would satisfy `ownsEntryUnder` for both
    // passes and be collapsed to a single handler by whichever ran last. Nothing
    // in this module or `wireSearchHooks` ever emits that shape, so reaching it
    // takes a hand-merged settings file, and the answer would be the same
    // question the declined duplicate-entry thread asked: which of the two is
    // the entry of ours. Kept identical to the writer rather than diverged.
    const desired = {
      ...(spec.matcher !== undefined ? { matcher: spec.matcher } : {}),
      hooks: [handlerFor(join(scriptsDir, spec.scriptFile), platform, spec.timeoutSeconds)],
    };
    if (JSON.stringify(list[idx]) === JSON.stringify(desired)) {
      currentEvents.add(spec.event);
      continue;
    }
    nextHooks[spec.event] = list.map((e, i) => (i === idx ? desired : e));
    updatedEvents.add(spec.event);
  }
  const updated = HOOK_EVENTS.filter((e) => updatedEvents.has(e));
  // An event whose other entry was rewritten reports as `updated`, matching how
  // the writer collapses a multi-entry event by its strongest outcome.
  const alreadyPresent = HOOK_EVENTS.filter((e) => currentEvents.has(e) && !updatedEvents.has(e));
  if (updated.length === 0) {
    return { path, scriptsDir, scripts, updated, alreadyPresent, ...warn() };
  }

  // ONE compare, where the writer makes two, and it covers both windows only
  // because of an ordering this function depends on: `writeOwnedScripts` ran
  // BEFORE `inspectSettings` read `raw`, so `raw` is already post-script-pass and
  // a harness that wrote settings.json during that pass shows up here. Move the
  // script write below the read and this needs the writer's second compare back.
  const changed = async (): Promise<boolean> =>
    (await readFile(path, 'utf8').catch(() => null)) !== raw;
  if (await changed()) {
    return {
      path,
      scriptsDir,
      scripts,
      updated: [],
      alreadyPresent,
      ...warn(
        `${path} changed while it was being refreshed, so its hook entries were left alone. Re-run \`tenjin install\`.`,
      ),
    };
  }
  await writeFileAtomic(path, `${JSON.stringify({ ...settings, hooks: nextHooks }, null, 2)}\n`);
  return { path, scriptsDir, scripts, updated, alreadyPresent, ...warn() };
}
