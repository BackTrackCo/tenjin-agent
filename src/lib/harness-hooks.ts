import { chmod, lstat, readFile, realpath, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { adapterFor } from '../adapters/registry';
import { HARNESSES, type HarnessAdapter } from '../adapters/types';
import { startDaemon, type DaemonDeps, type DaemonStart } from '../daemon/control';
import { HARNESS_MS } from '../hooks/constants';
import { readPid, readToken } from '../hooks/shim';
import { writeFileAtomic } from './atomic-json';
import { hooksDir, shimBundlePath } from './paths';

/**
 * Where `tenjin install` writes a harness's hook entries, and the only place
 * that decides which entry in someone else's hooks file is ours.
 *
 * ONE MECHANISM FOR EVERY HARNESS. Claude Code and Codex both keep their hooks
 * as `{ "hooks": { "<Event>": [ { matcher?, hooks: [handler] } ] } }`, so the
 * read, the ownership test, the additive merge and the removal are written
 * once here; an adapter's {@link HarnessAdapter.registrar} supplies the file,
 * the entries and any activation step, and nothing else about it is special.
 *
 * ONE WRITE, WHOLE. There is nothing to merge entry by entry: the plan is the
 * registrar's, so this module drops every entry that is ours and appends that
 * plan. A second run therefore produces a byte-identical file, which is the
 * whole of "idempotent".
 *
 * ORDER IS THE ONE THING TO GET RIGHT. Claude Code re-reads settings.json
 * through a file watcher, so an entry naming a daemon that is not up yet turns
 * every live session's next tool call into an `HTTP hook error`. Hence:
 * bundles, token, a healthy daemon, and ONLY THEN the hooks file, with the
 * port read out of `daemon.pid` after `/health` answered, never derived.
 *
 * OWNERSHIP IS ONE PREDICATE, {@link ownsHookEntry}, used by the writer, by
 * `uninstall` and by `doctor`. A handler is ours when its `command` names a
 * file under our hooks dir, or when its `url` is the loopback hook route.
 */

/** Every basename this CLI puts in the hooks dir. */
const OUR_HOOK_FILES: readonly string[] = ['tenjin-daemon.mjs', 'tenjin-shim.mjs'];

/** `http://127.0.0.1:<port>/hook/<harness>`, the only URL we ever register. */
const LOOP_URL_RE = new RegExp(`^http://127\\.0\\.0\\.1:\\d+/hook/(?:${HARNESSES.join('|')})$`);

/** The harness's own kill budget, in the seconds a hooks entry states. */
export const HOOK_TIMEOUT_SECONDS = HARNESS_MS / 1000;

export type HooksSkipReason =
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
  /** The harness this outcome is about. */
  harness: string;
  /** Its hooks file, absent when the harness has none. */
  path?: string;
  /** Where the daemon bundles live (or would). */
  hooksDir: string;
  /** Hook entries of ours registered after this run, or 0 on a skip. */
  entries: number;
  /** True when this run changed the file; false when it already matched. */
  wrote: boolean;
  /** The daemon the entries point at. */
  daemon?: { pid: number; port: number; version: string };
  /** The loopback URL the `http` entries carry, when the harness has any. */
  url?: string;
  /** What the operator still has to do before the harness runs the entries. */
  activation?: string;
  skipped?: HooksSkipReason;
  /** Human-readable detail for a skip that is a problem rather than a choice. */
  warning?: string;
  /** The exact command that changes this outcome, mirroring the CliError contract. */
  fix?: string;
}

function skip(
  reason: HooksSkipReason,
  args: { harness: string; path?: string; hooksDir: string; warning?: string; fix?: string },
): HooksResult {
  return {
    harness: args.harness,
    ...(args.path !== undefined ? { path: args.path } : {}),
    hooksDir: args.hooksDir,
    entries: 0,
    wrote: false,
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
  reason: HooksSkipReason,
  env: NodeJS.ProcessEnv = process.env,
): HooksResult {
  const adapter = adapterFor(harness);
  return skip(reason, {
    harness,
    ...(adapter !== undefined ? { path: adapter.registrar.configPath(homeDir, env) } : {}),
    hooksDir: hooksDir(dataDir),
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
    case 'declined':
    case 'dry-run':
      return 'Wire them with `tenjin install`.';
    case 'daemon-down':
      return 'Run `tenjin daemon start`, then re-run `tenjin install`.';
    case 'changed-since-read':
      return 'Another process changed the file mid-run; re-run `tenjin install`.';
    case 'unwritable':
      return 'The daemon, its bundles and the skills are already in place; only the hooks file could not be written. Fix its permissions (or its directory’s), then re-run `tenjin install`.';
    default:
      return 'Fix the reported file, then re-run `tenjin install`.';
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Is this handler ours?
 *
 * TWO SHAPES, because there are two transports. A `command` handler is ours
 * when it names one of our filenames, or any path under this profile's hooks
 * dir: the filename half recognizes an install whose data dir has since moved,
 * the directory half a file we no longer have a name for. An `http` handler is
 * ours when its URL is the loopback hook route on any port: the port moves with
 * every bind, so matching on it would strand yesterday's entry in the file.
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
 *  {@link hasHooks} ask; the writers ask {@link pruneOurHandlers} instead. */
export function ownsHookEntry(entry: unknown, dataDir: string): boolean {
  if (!isPlainObject(entry)) return false;
  const handlers = entry.hooks;
  if (!Array.isArray(handlers)) return false;
  return handlers.some((h) => ownsHandler(h, dataDir));
}

/**
 * The entry with every handler of OURS removed, or null when nothing is left of
 * it. Ownership is a property of the handler, so removal has to be too: a
 * person who hand-merged ours into an entry beside their own must keep theirs.
 */
export function pruneOurHandlers(entry: unknown, dataDir: string): unknown | null {
  if (!isPlainObject(entry)) return entry;
  const handlers = entry.hooks;
  if (!Array.isArray(handlers)) return entry;
  const kept = handlers.filter((h) => !ownsHandler(h, dataDir));
  if (kept.length === handlers.length) return entry;
  return kept.length === 0 ? null : { ...entry, hooks: kept };
}

/**
 * A `hooks` object with every handler of ours pruned, and the events that lost
 * one. An event WE emptied loses its key; one that still holds someone else's
 * entry keeps it, and an array that was already empty is left as found. The
 * one prune both `install` (before it appends its plan) and `uninstall` run.
 */
export function pruneHooks(
  hooks: Record<string, unknown>,
  dataDir: string,
): { next: Record<string, unknown>; removed: string[] } {
  const next: Record<string, unknown> = {};
  const removed: string[] = [];
  for (const [event, value] of Object.entries(hooks)) {
    if (!Array.isArray(value)) {
      next[event] = value;
      continue;
    }
    const kept = value.map((e) => pruneOurHandlers(e, dataDir)).filter((e) => e !== null);
    if (kept.length !== value.length) removed.push(event);
    const emptiedByUs = kept.length === 0 && value.length > 0;
    if (!emptiedByUs) next[event] = kept;
  }
  return { next, removed };
}

export interface HooksInspection {
  path: string;
  /** The exact bytes read, so a commit can prove nothing changed underneath it. */
  raw: string | null;
  settings: Record<string, unknown>;
  /** Every event's entries, already known to be a list: {@link inspectHooksFile}
   *  refuses the file rather than hand a writer a shape it would skip. */
  hooks: Record<string, unknown[]>;
}

/** Why a hooks file cannot be written, in the terms {@link skip} renders. */
export interface HooksRefusal {
  reason: HooksSkipReason;
  message: string;
  path: string;
}

/**
 * Resolve and read a hooks file. Every refusal lives here, so the shape checks
 * and the write agree by construction. Symlinks are resolved before the write
 * for the same reason lib/harness-permissions.ts resolves them: committing with
 * a rename over a dotfiles-managed link would sever it.
 */
export async function inspectHooksFile(
  declaredPath: string,
): Promise<HooksInspection | { refusal: HooksRefusal }> {
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
  // non-object `hooks` is: a writer would copy it through untouched and
  // silently drop this event's share of the plan while the receipt still
  // counted it. A file we do not understand is left alone and reported.
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

/** Best-effort read of a hooks file's `hooks` object; null for anything unreadable. */
async function readHooksObject(path: string): Promise<Record<string, unknown> | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
    const hooks = isPlainObject(parsed) ? parsed.hooks : undefined;
    return isPlainObject(hooks) ? hooks : null;
  } catch {
    return null;
  }
}

/**
 * Does this machine already carry hook entries of ours for `adapter`?
 *
 * Read-only and best-effort: an absent, unreadable or unparseable file answers
 * "no", never an error. `install --refresh` asks before it converges, because a
 * refresh may re-materialize what is there and must never install onto a
 * machine that never asked for it.
 */
export async function hasHooks(
  adapter: HarnessAdapter,
  homeDir: string,
  dataDir: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  const hooks = await readHooksObject(adapter.registrar.configPath(homeDir, env));
  if (hooks === null) return false;
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

export interface RegisteredHooks {
  path: string;
  /** How many entries of ours the file carries. */
  entries: number;
  /** The port our `http` entries name, or null when none does: a `command`
   *  entry carries no port, and neither does an absent file. */
  port: number | null;
}

/**
 * What this machine has registered for `adapter`. An absent or unreadable
 * file answers zero entries, which is the same thing to every caller: nothing
 * of ours is wired here.
 */
export async function registeredHooks(
  adapter: HarnessAdapter,
  homeDir: string,
  dataDir: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<RegisteredHooks> {
  const path = adapter.registrar.configPath(homeDir, env);
  const hooks = await readHooksObject(path);
  const out: RegisteredHooks = { path, entries: 0, port: null };
  if (hooks === null) return out;
  for (const list of Object.values(hooks)) {
    if (!Array.isArray(list)) continue;
    list.forEach((entry) => {
      if (!ownsHookEntry(entry, dataDir)) return;
      out.entries += 1;
      for (const handler of (entry as { hooks: unknown[] }).hooks) {
        // OURS ONLY, and parsed defensively even then: a handler someone
        // hand-merged beside ours may carry a relative `url` that would
        // otherwise throw ERR_INVALID_URL out of doctor.
        if (!ownsHandler(handler, dataDir)) continue;
        if (!isPlainObject(handler) || typeof handler.url !== 'string') continue;
        out.port ??= urlPort(handler.url);
      }
    });
  }
  return out;
}

export interface WriteHooksOptions {
  adapter: HarnessAdapter;
  homeDir: string;
  dataDir: string;
  env?: NodeJS.ProcessEnv;
  /** Where the built bundles are copied from; the CLI's own dist by default. */
  bundleDir?: string;
  /** Seam for step 1-3: bundles, token, a healthy daemon. Tests inject it. */
  start?: (dataDir: string, deps: DaemonDeps) => Promise<DaemonStart>;
}

/**
 * Write one harness's hook entries, whole.
 *
 *  1. copy the built files into `<dataDir>/hooks`;
 *  2. mint `daemon.token` (0600) if absent — both inside {@link startDaemon};
 *  3. stop a daemon from an older build, then ensure a healthy one;
 *  4. only then rewrite the hooks file, mode 0600, with the port read back out
 *     of `daemon.pid` and the token as a literal where the plan carries one.
 *
 * Every entry of ours is dropped before the plan is appended, so a second run
 * writes nothing at all.
 */
export async function writeHooks(opts: WriteHooksOptions): Promise<HooksResult> {
  const { adapter, homeDir, dataDir } = opts;
  const env = opts.env ?? process.env;
  const harness = adapter.id;
  const dir = hooksDir(dataDir);
  const declaredPath = adapter.registrar.configPath(homeDir, env);
  const activation =
    adapter.registrar.activation !== undefined ? { activation: adapter.registrar.activation } : {};

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
      harness,
      path: declaredPath,
      hooksDir: dir,
      warning: `${err instanceof Error ? err.message : String(err)}; no hook entry was written, so nothing points at a daemon that is not there.`,
      fix: fixFor('daemon-down'),
    });
  }

  // Step 4's inputs, read back rather than remembered: the pid file is what the
  // daemon itself wrote after its bind, and the token file is what every
  // transport reads.
  const pid = readPid(dataDir);
  const token = readToken(dataDir);
  if (pid === null || token === null) {
    return skip('daemon-down', {
      harness,
      path: declaredPath,
      hooksDir: dir,
      warning: `The daemon answered but left no ${pid === null ? 'daemon.pid' : 'daemon.token'} under ${dataDir}, so no hook entry could name it.`,
      fix: fixFor('daemon-down'),
    });
  }
  const url = `http://127.0.0.1:${pid.port}/hook/${harness}`;

  const found = await inspectHooksFile(declaredPath);
  if ('refusal' in found) {
    return skip(found.refusal.reason, {
      harness,
      path: found.refusal.path,
      hooksDir: dir,
      warning: found.refusal.message,
      fix: fixFor(found.refusal.reason),
    });
  }
  const { path, raw, settings, hooks } = found;

  const plan = adapter.registrar.plan({
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
  const nextHooks = pruneHooks(hooks, dataDir).next;
  for (const [event, mine] of planned) {
    const kept = nextHooks[event];
    nextHooks[event] = Array.isArray(kept) ? [...kept, ...mine] : mine;
  }

  const next = `${JSON.stringify({ ...settings, hooks: nextHooks }, null, 2)}\n`;
  const carriesUrl = JSON.stringify(plan).includes(url);
  const result: HooksResult = {
    harness,
    path,
    hooksDir: dir,
    entries: plan.length,
    wrote: next !== raw,
    daemon: { pid: started.health.pid, port: pid.port, version: started.health.version },
    ...(carriesUrl ? { url } : {}),
    ...activation,
  };
  // Byte-identical means untouched: a re-install that would write the same file
  // does not write it at all, so nothing downstream sees an mtime move. The MODE
  // still converges, because it is the only thing guarding a daemon token this
  // file may carry as a literal and a dotfiles sync or a stray chmod can widen
  // it long after the bytes settled.
  if (next === raw) {
    await tightenFile(path);
    return result;
  }

  // Optimistic concurrency, as lib/harness-permissions.ts holds it: a whole-file
  // replacement built from a snapshot, over a file the harness writes too, so a
  // change that landed underneath is refused rather than erased.
  if ((await readFile(path, 'utf8').catch(() => null)) !== raw) {
    return skip('changed-since-read', {
      harness,
      path,
      hooksDir: dir,
      warning: `${path} changed while it was being updated, so no hooks were registered. Re-run \`tenjin install\`.`,
      fix: fixFor('changed-since-read'),
    });
  }
  // 0600 because the file may carry the daemon token as a literal. A write
  // that cannot land is this module's outcome to report, not an exception for
  // the CLI to render as an internal error: everything above it succeeded.
  try {
    await writeFileAtomic(path, next, { mode: 0o600 });
  } catch (err) {
    return skip('unwritable', {
      harness,
      path,
      hooksDir: dir,
      warning: `${path} could not be written (${err instanceof Error ? err.message : String(err)}); no hook entry was registered.`,
      fix: fixFor('unwritable'),
    });
  }
  return result;
}

/** Bring an already-correct hooks file back to 0600 if something widened it. */
async function tightenFile(path: string): Promise<void> {
  const found = await stat(path).catch(() => null);
  if (found === null || (found.mode & 0o077) === 0) return;
  await chmod(path, 0o600).catch(() => undefined);
}

/** Is the shim bundle on disk? Half of "installed"; the entries are the other. */
export async function hookBundlesPresent(dataDir: string): Promise<boolean> {
  return await stat(shimBundlePath(dataDir)).then(
    () => true,
    () => false,
  );
}
