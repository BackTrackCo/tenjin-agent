import { lstat, readFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { writeFileAtomic } from './atomic-json';
import { claudeSettingsPath } from './harness-permissions';
import { hooksDir } from './paths';
import {
  STOP_HOOK_FILE,
  WEBSEARCH_HOOK_FILE,
  stopHookScript,
  websearchHookScript,
} from './hook-scripts';
import type { SearchHookMode } from './config';

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
 *  - Neither hook can block, deny, or modify a tool call. The WebSearch hook emits
 *    `additionalContext` and never `permissionDecision`, so a WebSearch always
 *    proceeds; the Stop hook only ever adds a line at the end of a turn.
 *
 * OWNERSHIP IS BY PATH. An entry is ours when its command mentions one of our two
 * script filenames. That is what makes a re-install idempotent, lets a drifted
 * command (an older install's path, a moved data dir) be rewritten in place
 * instead of duplicated, and keeps every entry someone else wrote untouched.
 */

/** The hook events this module writes, in the order they are reported. */
export const HOOK_EVENTS = ['PreToolUse', 'Stop'] as const;
export type HookEvent = (typeof HOOK_EVENTS)[number];

/** The tool the WebSearch hook fires on. Never `WebFetch`, never a wildcard. */
export const WEBSEARCH_MATCHER = 'WebSearch';

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
  /** The behavior the installed scripts will follow (config `hooks.searchMode`). */
  mode: SearchHookMode;
  /** Events whose entry this run appended. */
  added: HookEvent[];
  /** Events whose entry was already there, byte-identical. */
  alreadyPresent: HookEvent[];
  /** Events whose existing entry pointed somewhere else and was rewritten in place. */
  updated: HookEvent[];
  /** Script files this run wrote or refreshed. */
  scripts: string[];
  skipped?: HooksSkipReason;
  /** Human-readable detail for a skip that is a problem rather than a choice. */
  warning?: string;
  /** The exact command that changes this outcome, mirroring the CliError contract. */
  fix?: string;
}

/** The undo, stated the same way everywhere it is shown. */
export function hooksUndo(settingsPath: string, scriptsDir: string): string {
  return `Undo anytime: \`tenjin config set hooks.searchMode off\` disarms them, or delete the tenjin hook entries from ${settingsPath} and the scripts in ${scriptsDir}.`;
}

function skip(
  reason: HooksSkipReason,
  args: {
    harness: string;
    path?: string;
    scriptsDir: string;
    mode: SearchHookMode;
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
  mode: SearchHookMode,
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
    case 'mode-off':
      return 'Enable them with `tenjin config set hooks.searchMode auto`, then re-run `tenjin install`.';
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

/** One hook handler, exactly as it is written into settings.json. */
function handlerFor(scriptPath: string, platform?: string): Record<string, unknown> {
  return {
    type: 'command',
    command: commandFor(scriptPath, platform),
    timeout: HOOK_TIMEOUT_SECONDS,
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
  /** Absent for Stop, which the harness fires on every occurrence with no matcher. */
  matcher?: string;
}

function specs(dataDir: string): HookSpec[] {
  return [
    {
      event: 'PreToolUse',
      scriptFile: WEBSEARCH_HOOK_FILE,
      script: websearchHookScript(dataDir),
      matcher: WEBSEARCH_MATCHER,
    },
    { event: 'Stop', scriptFile: STOP_HOOK_FILE, script: stopHookScript(dataDir) },
  ];
}

export interface WireHooksOptions {
  homeDir: string;
  dataDir: string;
  mode: SearchHookMode;
  /** Shell-quoting target; injected so both branches are testable on one machine. */
  platform?: string;
}

/**
 * Write the hook scripts and merge their entries into ~/.claude/settings.json.
 *
 * The SCRIPTS are written whatever the mode, including `off`: the mode is read by
 * the script at run time, so an operator who later flips `hooks.searchMode` back
 * to `auto` gets working hooks without re-installing. Only `mode: 'off'` is
 * refused at the caller (see `hooksSkipped`), which leaves settings.json alone
 * entirely.
 *
 * Idempotent: a second run rewrites no script whose bytes match, appends no entry
 * that is already there, and does not touch settings.json at all when nothing
 * changed.
 */
export async function wireSearchHooks(opts: WireHooksOptions): Promise<HooksResult> {
  const { homeDir, dataDir, mode, platform } = opts;
  const scriptsDir = hooksDir(dataDir);
  const plan = specs(dataDir);

  const found = await inspectSettings(homeDir, scriptsDir, mode);
  if ('result' in found) return found.result;
  const { path, raw, settings, hooks } = found;

  const added: HookEvent[] = [];
  const alreadyPresent: HookEvent[] = [];
  const updated: HookEvent[] = [];
  const nextHooks: Record<string, unknown> = { ...hooks };

  for (const spec of plan) {
    const existing = hooks[spec.event];
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
      hooks: [handlerFor(join(scriptsDir, spec.scriptFile), platform)],
    };
    const idx = list.findIndex((e) => ownsEntry(e, spec.scriptFile));
    if (idx === -1) {
      nextHooks[spec.event] = [...list, desired];
      added.push(spec.event);
      continue;
    }
    if (JSON.stringify(list[idx]) === JSON.stringify(desired)) {
      alreadyPresent.push(spec.event);
      continue;
    }
    // Ours, but stale: an older install's path, or a data dir that moved. Rewritten
    // IN PLACE so the entry keeps its position among whatever else is registered.
    nextHooks[spec.event] = list.map((e, i) => (i === idx ? desired : e));
    updated.push(spec.event);
  }

  // Nothing to register: no guard is involved, so the scripts are simply brought
  // up to date. This is the path a re-run takes after an upgrade changed a body.
  if (added.length === 0 && updated.length === 0) {
    const scripts = await writeScripts(plan, scriptsDir);
    return { harness: 'claude', path, scriptsDir, mode, added, alreadyPresent, updated, scripts };
  }

  const next = { ...settings, hooks: nextHooks };
  // Same read-modify-write guard the permission writer takes, and for the same
  // reason: Claude Code writes this file too, so an interleaved change would be
  // erased in full rather than merged.
  const current = await readFile(path, 'utf8').catch(() => null);
  if (current !== raw) {
    return refuse(
      path,
      scriptsDir,
      mode,
      'changed-since-read',
      `${path} changed while it was being updated, so no hooks were registered. Re-run \`tenjin install\`.`,
    );
  }
  // PAST the guard, and still before the entry that points at them. Writing the
  // scripts earlier meant a refusal had already replaced live script bodies that
  // existing entries were running, while the result said nothing was registered.
  // Here a refusal has changed nothing at all, and a harness still never reads an
  // entry naming a file that is not on disk yet.
  const scripts = await writeScripts(plan, scriptsDir);
  await writeFileAtomic(path, `${JSON.stringify(next, null, 2)}\n`);
  return { harness: 'claude', path, scriptsDir, mode, added, alreadyPresent, updated, scripts };
}

/** Bring each script up to date, returning the ones this run actually wrote. A
 *  body that already matches is left alone, so a re-run rewrites nothing. */
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
  mode: SearchHookMode,
  reason: HooksSkipReason,
  warning: string,
): HooksResult {
  return skip(reason, { harness: 'claude', path, scriptsDir, mode, warning, fix: fixFor(reason) });
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
  mode: SearchHookMode,
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
