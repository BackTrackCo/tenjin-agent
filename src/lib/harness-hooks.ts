import { chmod, lstat, readFile, realpath, rm, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { claudeAdapter } from '../adapters/claude';
import { HARNESSES } from '../adapters/types';
import { startDaemon, type DaemonDeps, type DaemonStart } from '../daemon/control';
import { HARNESS_MS } from '../hooks/constants';
import { readPid, readToken } from '../hooks/shim';
import { writeFileAtomic } from './atomic-json';
import type { WebSearchMode } from './config';
import { claudeSettingsPath } from './harness-permissions';
import { hooksDir, shimBundlePath } from './paths';
import { PUSH_VITEST_REPORTER_FILE, pushVitestReporterScript } from './push-scripts';

/**
 * Where `tenjin install` writes Claude Code's hook entries, and the only place
 * that decides which entry in someone else's settings.json is ours.
 *
 * ONE WRITE, WHOLE (02-redesign.md §4a, 09-pr-c-lookup-arms.md "The install
 * cutover"). The generated-script era merged entries in place, one per script
 * per event, and every upgrade had to converge eight bodies and eleven
 * matchers. There is nothing to merge now: the plan is the adapter's
 * {@link claudeAdapter.registrar.plan}, so this module drops every entry that
 * is ours and appends that plan. A second run therefore produces a
 * byte-identical file, which is the whole of "idempotent".
 *
 * ORDER IS THE ONE THING TO GET RIGHT. Claude Code re-reads settings.json
 * through a file watcher, so an entry naming a daemon that is not up yet turns
 * every live session's next tool call into an `HTTP hook error`. Hence:
 * bundles, token, a healthy daemon, and ONLY THEN the settings file — and the
 * port comes out of `daemon.pid` after `/health` answered, never derived, because
 * `loop.port` may be pinned and a daemon that lost the bind race serves on
 * whatever it actually bound.
 *
 * OWNERSHIP IS ONE PREDICATE, {@link ownsHookEntry}, used by the writer, by
 * `uninstall` and by `doctor`. A handler is ours when its `command` names a
 * file under our hooks dir, or when its `url` is the loopback hook route. The
 * first half is what recognizes an install from before the daemon and drops it
 * rather than duplicating it; there is no migration beyond that.
 */

/**
 * The generated hook scripts install USED to write, kept only so the cutover can
 * delete them by name. Nothing writes these files any more; the template sources
 * they came from are dead until PR E removes them with their tests.
 *
 * A literal list rather than an import of those templates' constants: this is the
 * one place that still has to know the old names, and it must outlive the modules
 * that produced them.
 */
export const RETIRED_HOOK_FILES = [
  'tenjin-websearch-hook.mjs',
  'tenjin-dispatch-hook.mjs',
  'tenjin-sessionstart-hook.mjs',
  'tenjin-stop-hook.mjs',
  'tenjin-push-prompt.mjs',
  'tenjin-push-failure.mjs',
  'tenjin-push-subagent.mjs',
  'tenjin-push-context.mjs',
] as const;

/** Every basename this CLI has ever put in the hooks dir, retired or current. */
const OUR_HOOK_FILES: readonly string[] = [
  ...RETIRED_HOOK_FILES,
  'tenjin-daemon.mjs',
  'tenjin-shim.mjs',
];

/** `http://127.0.0.1:<port>/hook/<harness>`, the only URL we ever register. */
const LOOP_URL_RE = new RegExp(`^http://127\\.0\\.0\\.1:\\d+/hook/(?:${HARNESSES.join('|')})$`);

/** The harness's own kill budget, in the seconds a settings entry states. */
export const HOOK_TIMEOUT_SECONDS = HARNESS_MS / 1000;

export type HooksSkipReason =
  | 'harness-not-claude'
  | 'declined'
  | 'dry-run'
  | 'daemon-down'
  | 'unresolvable'
  | 'unreadable'
  | 'unparsable'
  | 'unexpected-shape'
  | 'changed-since-read'
  | 'unwritable';

export interface HooksResult {
  /** The harness this outcome is about; only `claude` has a settings file we write. */
  harness: string;
  /** The settings file, absent when the harness has no such file. */
  path?: string;
  /** Where the daemon bundles live (or would). */
  hooksDir: string;
  /** The behavior the arms will follow (config `hooks.webSearch`). */
  mode: WebSearchMode;
  /** Hook entries of ours registered after this run. Eleven, or 0 on a skip. */
  entries: number;
  /** True when this run changed settings.json; false when it already matched. */
  wrote: boolean;
  /** The daemon the entries point at. */
  daemon?: { pid: number; port: number; version: string };
  /** The loopback URL the nine `http` entries carry. */
  url?: string;
  /** Retired generated scripts this run deleted from the hooks dir. */
  removed: string[];
  /**
   * Retired scripts this run could NOT delete, each with why. Absent when they
   * all went. A leftover of ours that will not unlink is a warning and never a
   * failure: the entries are written and no session points at it any more.
   */
  kept?: string[];
  skipped?: HooksSkipReason;
  /** Human-readable detail for a skip that is a problem rather than a choice. */
  warning?: string;
  /** The exact command that changes this outcome, mirroring the CliError contract. */
  fix?: string;
}

/** The undo, stated the same way everywhere it is shown. */
export function hooksUndo(settingsPath: string, dir: string): string {
  return `Undo anytime: \`tenjin uninstall\` removes the entries from ${settingsPath} and the daemon from ${dir}; \`tenjin config set hooks.push off\` silences the arms without unwiring anything.`;
}

function skip(
  reason: HooksSkipReason,
  args: {
    harness: string;
    path?: string;
    hooksDir: string;
    mode: WebSearchMode;
    warning?: string;
    fix?: string;
  },
): HooksResult {
  return {
    harness: args.harness,
    ...(args.path !== undefined ? { path: args.path } : {}),
    hooksDir: args.hooksDir,
    mode: args.mode,
    entries: 0,
    wrote: false,
    removed: [],
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
    hooksDir: hooksDir(dataDir),
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
    case 'declined':
    case 'dry-run':
      return 'Wire them with `tenjin install --search-hooks auto`.';
    case 'daemon-down':
      return 'Run `tenjin daemon start`, then re-run `tenjin install`.';
    case 'changed-since-read':
      return 'Another process changed the file mid-run; re-run `tenjin install`.';
    case 'unwritable':
      return "The daemon, its bundles and the skills are already in place; only settings.json could not be written. Fix its permissions (or its directory's), then re-run `tenjin install`.";
    default:
      return 'Fix the reported file, then re-run `tenjin install`.';
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Is this settings.json handler ours?
 *
 * TWO SHAPES, because the cutover left two. A `command` handler is ours when it
 * names one of our filenames, or any path under this profile's hooks dir — the
 * filename half is what recognizes an install whose data dir has since moved,
 * and the directory half is what recognizes a file we no longer have a name for.
 * An `http` handler is ours when its URL is the loopback hook route, whatever
 * port it happens to carry: the port moves with every bind, so matching on it
 * would strand yesterday's entry in the file.
 */
function ownsHandler(handler: unknown, dataDir: string): boolean {
  if (!isPlainObject(handler)) return false;
  const url = handler.url;
  if (typeof url === 'string' && LOOP_URL_RE.test(url)) return true;
  const command = handler.command;
  if (typeof command !== 'string') return false;
  if (OUR_HOOK_FILES.some((file) => command.includes(file))) return true;
  return command.includes(hooksDir(resolve(dataDir)));
}

/** Does this entry hold a handler of ours? The question `doctor` and
 *  `hasClaudeHooks` ask; the writers ask {@link pruneOurHandlers} instead. */
export function ownsHookEntry(entry: unknown, dataDir: string): boolean {
  if (!isPlainObject(entry)) return false;
  const handlers = entry.hooks;
  if (!Array.isArray(handlers)) return false;
  return handlers.some((h) => ownsHandler(h, dataDir));
}

/**
 * The entry with every handler of OURS removed, or null when nothing is left of
 * it.
 *
 * OWNERSHIP IS A PROPERTY OF THE HANDLER, so removal has to be too. We only ever
 * write one handler per entry, but a person who hand-merged ours into an entry
 * beside their own would otherwise have their handler deleted along with it by
 * both the install writer and `uninstall` — silently, in a file they edited on
 * purpose.
 */
export function pruneOurHandlers(entry: unknown, dataDir: string): unknown | null {
  if (!isPlainObject(entry)) return entry;
  const handlers = entry.hooks;
  if (!Array.isArray(handlers)) return entry;
  const kept = handlers.filter((h) => !ownsHandler(h, dataDir));
  if (kept.length === handlers.length) return entry;
  return kept.length === 0 ? null : { ...entry, hooks: kept };
}

interface SettingsInspection {
  path: string;
  /** The exact bytes read, so the commit can prove nothing changed underneath it. */
  raw: string | null;
  settings: Record<string, unknown>;
  /** Every event's entries, already known to be a list: {@link inspectSettings}
   *  refuses the file rather than hand the writer a shape it would skip. */
  hooks: Record<string, unknown[]>;
}

/** Why the settings file cannot be written, in the terms {@link skip} renders. */
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
          message: `${declaredPath} could not be resolved (${(err as Error).message}); its "hooks" key was left exactly as it is.`,
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
          message: `${path} is not valid JSON (${(err as Error).message}); its "hooks" key was left exactly as it is.`,
        },
      };
    }
    if (!isPlainObject(parsed)) {
      return {
        refusal: {
          reason: 'unexpected-shape',
          path,
          message: `${path} is not a JSON object; its "hooks" key was left exactly as it is.`,
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
        message: `${path} has a "hooks" key that is not an object; its "hooks" key was left exactly as it is.`,
      },
    };
  }
  // An event whose value is not a list is refused for the same reason a
  // non-object `hooks` is: the writer would copy it through untouched and
  // silently drop this event's share of the plan, while the receipt still said
  // eleven. A file we do not understand is left alone and reported.
  const hooks: Record<string, unknown[]> = {};
  for (const [event, list] of Object.entries(hooksValue ?? {})) {
    if (!Array.isArray(list)) {
      return {
        refusal: {
          reason: 'unexpected-shape',
          path,
          message: `${path} has a "hooks.${event}" that is not an array of entries; its "hooks" key was left exactly as it is.`,
        },
      };
    }
    hooks[event] = list;
  }
  return { path, raw, settings, hooks };
}

/**
 * Does this machine already carry hook entries of ours?
 *
 * Read-only and best-effort: an absent, unreadable or unparseable settings file
 * answers "no", never an error. `install --refresh` asks before it converges,
 * because a refresh may re-materialize what is there and must never install onto
 * a machine that never asked for it.
 */
export async function hasClaudeHooks(homeDir: string, dataDir: string): Promise<boolean> {
  let hooks: unknown;
  try {
    const parsed: unknown = JSON.parse(await readFile(claudeSettingsPath(homeDir), 'utf8'));
    hooks = isPlainObject(parsed) ? parsed.hooks : undefined;
  } catch {
    return false;
  }
  if (!isPlainObject(hooks)) return false;
  for (const list of Object.values(hooks)) {
    if (!Array.isArray(list)) continue;
    if (list.some((entry) => ownsHookEntry(entry, dataDir))) return true;
  }
  return false;
}

/** A url's port, or null for anything this build cannot parse as one. */
function urlPort(url: string): number | null {
  try {
    const port = Number(new URL(url).port);
    return Number.isFinite(port) && port > 0 ? port : null;
  } catch {
    return null;
  }
}

/** The port a settings entry of ours currently names, or null when none does. */
export async function registeredHookPort(homeDir: string, dataDir: string): Promise<number | null> {
  let hooks: unknown;
  try {
    const parsed: unknown = JSON.parse(await readFile(claudeSettingsPath(homeDir), 'utf8'));
    hooks = isPlainObject(parsed) ? parsed.hooks : undefined;
  } catch {
    return null;
  }
  if (!isPlainObject(hooks)) return null;
  for (const list of Object.values(hooks)) {
    if (!Array.isArray(list)) continue;
    for (const entry of list) {
      if (!ownsHookEntry(entry, dataDir)) continue;
      for (const handler of (entry as { hooks: unknown[] }).hooks) {
        // OURS ONLY, and parsed defensively even then: an entry someone
        // hand-merged their own handler into sits beside ours, and a relative
        // `url` in theirs would otherwise throw ERR_INVALID_URL out of doctor.
        if (!ownsHandler(handler, dataDir)) continue;
        if (!isPlainObject(handler) || typeof handler.url !== 'string') continue;
        const port = urlPort(handler.url);
        if (port !== null) return port;
      }
    }
  }
  return null;
}

export interface WriteClaudeHooksOptions {
  homeDir: string;
  dataDir: string;
  mode: WebSearchMode;
  /** Where the built bundles are copied from; the CLI's own dist by default. */
  bundleDir?: string;
  /** Seam for step 1-3: bundles, token, a healthy daemon. Tests inject it. */
  start?: (dataDir: string, deps: DaemonDeps) => Promise<DaemonStart>;
}

/**
 * Write Claude Code's eleven hook entries, whole.
 *
 * The five steps are the order §4a fixes and nothing here may reorder:
 *
 *  1. copy the two bundles into `<dataDir>/hooks`;
 *  2. mint `daemon.token` (0600) if absent — both inside {@link startDaemon};
 *  3. stop a daemon from an older build, then ensure a healthy one;
 *  4. only then rewrite `~/.claude/settings.json`, mode 0600, with the port read
 *     back out of `daemon.pid` and the token as a literal;
 *  5. and only once that file no longer names them, delete the retired scripts.
 *
 * Step 5 is last because a refused settings write leaves the old entries in
 * place: deleting the scripts first would strand a live session pointing at
 * files that are gone.
 *
 * Every entry of ours is dropped before the plan is appended, so a machine
 * carrying the pre-daemon `command` entries is converged rather than doubled and
 * a second run writes nothing at all.
 */
export async function writeClaudeHooks(opts: WriteClaudeHooksOptions): Promise<HooksResult> {
  const { homeDir, dataDir, mode } = opts;
  const dir = hooksDir(dataDir);

  // Steps 1-3. A daemon that will not come up is reported as a skip rather than
  // thrown: install has already written skills and permissions, and the remedy
  // is one command.
  let started: DaemonStart;
  try {
    started = await (opts.start ?? startDaemon)(dataDir, {
      ...(opts.bundleDir !== undefined ? { bundleDir: opts.bundleDir } : {}),
    });
  } catch (err) {
    return skip('daemon-down', {
      harness: 'claude',
      path: claudeSettingsPath(homeDir),
      hooksDir: dir,
      mode,
      warning: `${err instanceof Error ? err.message : String(err)}; no hook entry was written, so nothing points at a daemon that is not there.`,
      fix: fixFor('daemon-down'),
    });
  }
  await writeVitestReporter(dir);

  // Step 4's inputs, read back rather than remembered: the pid file is what the
  // daemon itself wrote after its bind, and the token file is what every
  // transport reads.
  const pid = readPid(dataDir);
  const token = readToken(dataDir);
  if (pid === null || token === null) {
    return skip('daemon-down', {
      harness: 'claude',
      path: claudeSettingsPath(homeDir),
      hooksDir: dir,
      mode,
      warning: `The daemon answered but left no ${pid === null ? 'daemon.pid' : 'daemon.token'} under ${dataDir}, so no hook entry could name it.`,
      fix: fixFor('daemon-down'),
    });
  }
  const url = `http://127.0.0.1:${pid.port}/hook/${claudeAdapter.id}`;

  const found = await inspectSettings(homeDir);
  if ('refusal' in found) {
    return skip(found.refusal.reason, {
      harness: 'claude',
      path: found.refusal.path,
      hooksDir: dir,
      mode,
      warning: found.refusal.message,
      fix: fixFor(found.refusal.reason),
    });
  }
  const { path, raw, settings, hooks } = found;

  const plan = claudeAdapter.registrar.plan({
    url,
    token,
    shimPath: shimBundlePath(dataDir),
    timeoutSeconds: HOOK_TIMEOUT_SECONDS,
  });
  const planned = new Map<string, unknown[]>();
  for (const item of plan) {
    if (!isPlainObject(item) || typeof item.event !== 'string') continue;
    const { event, ...entry } = item;
    const list = planned.get(event) ?? [];
    list.push(entry);
    planned.set(event, list);
  }

  // Drop, then append. An event that held only entries of ours loses its key
  // entirely unless the plan puts one back, so a file that had eleven and now
  // needs nine does not keep two empty arrays.
  const nextHooks: Record<string, unknown> = {};
  for (const [event, list] of Object.entries(hooks)) {
    const kept = list
      .map((entry) => pruneOurHandlers(entry, dataDir))
      .filter((entry) => entry !== null);
    const mine = planned.get(event) ?? [];
    if (kept.length === 0 && mine.length === 0) continue;
    nextHooks[event] = [...kept, ...mine];
  }
  for (const [event, mine] of planned) {
    if (nextHooks[event] === undefined) nextHooks[event] = mine;
  }

  const next = `${JSON.stringify({ ...settings, hooks: nextHooks }, null, 2)}\n`;
  const result: HooksResult = {
    harness: 'claude',
    path,
    hooksDir: dir,
    mode,
    entries: plan.length,
    wrote: next !== raw,
    daemon: { pid: started.health.pid, port: pid.port, version: started.health.version },
    url,
    removed: [],
  };
  // Byte-identical means untouched: a re-install that would write the same file
  // does not write it at all, so nothing downstream sees an mtime move. The MODE
  // still converges, because it is the only thing guarding the daemon token this
  // file carries as a literal and a dotfiles sync or a stray chmod can widen it
  // long after the bytes settled.
  if (next === raw) {
    await tightenSettings(path);
    reportSweep(result, await removeRetiredScripts(dir));
    return result;
  }

  // The same optimistic-concurrency contract lib/harness-permissions.ts holds:
  // this is a whole-file replacement built from a snapshot, and Claude Code
  // writes this file too, so a change that landed underneath is refused rather
  // than erased.
  if ((await readFile(path, 'utf8').catch(() => null)) !== raw) {
    return skip('changed-since-read', {
      harness: 'claude',
      path,
      hooksDir: dir,
      mode,
      warning: `${path} changed while it was being updated, so no hooks were registered. Re-run \`tenjin install\`.`,
      fix: fixFor('changed-since-read'),
    });
  }
  // 0600 because the file now carries the daemon token as a literal. A write
  // that cannot land is this module's outcome to report, not an exception for
  // the CLI to render as an internal error: everything above it succeeded.
  try {
    await writeFileAtomic(path, next, { mode: 0o600 });
  } catch (err) {
    return skip('unwritable', {
      harness: 'claude',
      path,
      hooksDir: dir,
      mode,
      warning: `${path} could not be written (${err instanceof Error ? err.message : String(err)}); no hook entry was registered.`,
      fix: fixFor('unwritable'),
    });
  }
  reportSweep(result, await removeRetiredScripts(dir));
  return result;
}

/** Bring an already-correct settings.json back to 0600 if something widened it. */
async function tightenSettings(path: string): Promise<void> {
  const found = await stat(path).catch(() => null);
  if (found === null || (found.mode & 0o077) === 0) return;
  await chmod(path, 0o600).catch(() => undefined);
}

interface Sweep {
  removed: string[];
  kept: string[];
}

/** The sweep, onto the receipt: what went, and what would not go. */
function reportSweep(result: HooksResult, sweep: Sweep): void {
  result.removed = sweep.removed;
  if (sweep.kept.length > 0) result.kept = sweep.kept;
}

/**
 * Delete the generated scripts of the pre-daemon era, by name.
 *
 * By NAME and only ours: a file someone else parked in the hooks dir is left
 * alone, and so is the directory, which now holds the two bundles.
 */
async function removeRetiredScripts(dir: string): Promise<Sweep> {
  const sweep: Sweep = { removed: [], kept: [] };
  for (const file of RETIRED_HOOK_FILES) {
    const path = join(dir, file);
    const entry = await lstat(path).catch(() => null);
    if (entry === null || !entry.isFile()) continue;
    // `force` covers the file that is already gone; it does not cover an EPERM
    // on a locked-down hooks dir or an EBUSY on Windows. By here settings.json
    // is written, so throwing would render a finished install as an internal
    // error over a leftover nobody reads.
    try {
      await rm(path, { force: true });
      sweep.removed.push(path);
    } catch (err) {
      sweep.kept.push(`${path} (${err instanceof Error ? err.message : String(err)})`);
    }
  }
  return sweep;
}

/**
 * The vitest reporter asset, brought up to date beside the bundles.
 *
 * NOT A HOOK ENTRY and never was: vitest imports it directly from a repo's own
 * config by the absolute path this write gives it, which is why `doctor` can
 * hint at that path. READ-ONLY, NOT EXECUTABLE (`0o644`): unlike the bundles it
 * is never spawned as a process.
 */
async function writeVitestReporter(dir: string): Promise<void> {
  const target = join(dir, PUSH_VITEST_REPORTER_FILE);
  const script = pushVitestReporterScript();
  const onDisk = await readFile(target, 'utf8').catch(() => null);
  if (onDisk === script) return;
  await writeFileAtomic(target, script, { mode: 0o644, dirMode: 0o700 });
}

/** Is the shim bundle on disk? Half of "installed"; the entries are the other. */
export async function hookBundlesPresent(dataDir: string): Promise<boolean> {
  return await stat(shimBundlePath(dataDir)).then(
    () => true,
    () => false,
  );
}
