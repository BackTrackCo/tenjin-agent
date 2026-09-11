import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { codexHome } from '../adapters/codex';

/**
 * What Codex says about the hook handlers this CLI registered, and the one
 * write that makes them run: `doctor` needs to tell "the file exists" from
 * "the harness will run it", and `install` needs to move it from the first to
 * the second.
 *
 * Codex gates a handler on `[hooks.state]` in `$CODEX_HOME/config.toml`: a row keyed
 * `"<source path>:<event_snake>:<group>:<handler>"` carrying `enabled` and a
 * `trusted_hash`, and the handler runs only when it is enabled and that hash
 * still matches the one Codex recomputes from the file.
 *
 * TRUSTING IS PART OF INSTALLING, and it goes through Codex's own supported
 * path: read the rows and their `currentHash` from `hooks/list`, upsert those
 * keys through `config/batchWrite`, then list again and require them back
 * trusted. That is the same call the `/hooks` browser makes, and it matches
 * Claude Code's contract that installing a hook activates it, rather than
 * reporting success over a loop that cannot run (tenjin-agent#342/#343).
 *
 * WHAT STAYS FORBIDDEN, and the distinction is the whole of the boundary:
 *
 *  - COMPUTING a `trusted_hash`. The value is a normalized, TOML-projected,
 *    canonical-JSON form private to Codex's build. We only ever echo back the
 *    `currentHash` Codex itself just reported, so trust cannot outlive the
 *    bytes Codex hashed. A hash of our own would be an assertion about a file
 *    Codex has not read.
 *  - Trusting a row we did not generate. Every key is matched against the
 *    complete handler identity this install wrote: our source file, our
 *    command, our event and index. Another tool's entry in the same file is
 *    never touched.
 *  - Reporting success on a partial result. Listing, writing and verifying all
 *    have to land, or the install fails and says which step did not.
 */

/** Codex's snake-case event labels, in the order its `hooks.state` keys use. */
const EVENT_LABEL: Readonly<Record<string, string>> = {
  PreToolUse: 'pre_tool_use',
  PermissionRequest: 'permission_request',
  PostToolUse: 'post_tool_use',
  PreCompact: 'pre_compact',
  PostCompact: 'post_compact',
  SessionStart: 'session_start',
  SessionEnd: 'session_end',
  UserPromptSubmit: 'user_prompt_submit',
  SubagentStart: 'subagent_start',
  SubagentStop: 'subagent_stop',
  Stop: 'stop',
  Interrupt: 'interrupt',
};

/** `$CODEX_HOME/config.toml`, the file that carries `[hooks.state]`. */
export function codexConfigPath(home: string, env: NodeJS.ProcessEnv = process.env): string {
  return join(codexHome(home, env), 'config.toml');
}

/**
 * The trust state of the handlers we registered.
 *
 *  - `trusted`: Codex will run them, all enabled and trusted or managed.
 *  - `modified`: trusted once, file changed since, so Codex refuses them. The
 *    state a "is there a row for it" reader gets wrong, which is why this
 *    module asks Codex rather than the file.
 *  - `untrusted` / `partial`: none, or only some, reviewed.
 *  - `disabled`: reviewed and turned off.
 *  - `unknown`: could not be asked. Never good news, never bad news.
 */
export type CodexTrust = 'trusted' | 'modified' | 'untrusted' | 'partial' | 'disabled' | 'unknown';

export interface CodexTrustReport {
  state: CodexTrust;
  /** How the answer was obtained, because they are not equally strong. */
  source: 'app-server' | 'config-file' | 'none';
  /** The file the state lives in, named whatever the answer is. */
  configPath: string;
  /** Handlers of ours Codex will actually run. */
  trusted: number;
  /** Handlers of ours we asked about. */
  expected: number;
}

/**
 * The `[hooks.state]` key for one handler: source file, the event's snake
 * label, and its position in that event's list (`hooks/src/lib.rs`). The
 * indices have to come from the file as written, not from the plan, because a
 * hand-merged entry ahead of ours shifts them.
 */
export function trustKey(
  hooksPath: string,
  event: string,
  groupIndex: number,
  handlerIndex: number,
): string | null {
  const label = EVENT_LABEL[event];
  return label === undefined ? null : `${hooksPath}:${label}:${groupIndex}:${handlerIndex}`;
}

/** One handler as `hooks/list` reports it; every field optional, since this is
 *  another program's wire format and a missing one means "cannot tell". */
interface ListedHook {
  key?: unknown;
  enabled?: unknown;
  trustStatus?: unknown;
  sourcePath?: unknown;
  currentHash?: unknown;
  command?: unknown;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Fold `hooks/list` rows for OUR keys into one verdict.
 *
 * Exported for its own tests: this is the whole of the trust judgment, and it
 * is worth pinning against recorded rows rather than only against a live
 * binary that a contributor may not have.
 */
export function foldTrust(rows: readonly ListedHook[], keys: readonly string[]): CodexTrust {
  const wanted = new Set(keys);
  const mine = rows.filter((r) => typeof r.key === 'string' && wanted.has(r.key));
  if (mine.length === 0) return 'untrusted';
  const status = (r: ListedHook): string =>
    typeof r.trustStatus === 'string' ? r.trustStatus : 'unknown';
  // Worst news first: each of these is a different remedy, and reporting the
  // cheerful aggregate over any one of them is how an inert install reads as
  // finished.
  if (mine.some((r) => r.enabled === false)) return 'disabled';
  if (mine.some((r) => status(r) === 'modified')) return 'modified';
  const good = mine.filter((r) => status(r) === 'trusted' || status(r) === 'managed');
  if (good.length === 0) return 'untrusted';
  if (good.length < keys.length) return 'partial';
  return 'trusted';
}

export interface TrustProbeOptions {
  env?: NodeJS.ProcessEnv;
  /** How long to wait for the app server. Past it the answer is `unknown`. */
  timeoutMs?: number;
  /** Seam for tests: what `hooks/list` returned, without spawning anything. */
  listHooks?: (home: string, env: NodeJS.ProcessEnv) => Promise<ListedHook[] | null>;
  /** Seam for tests: answer requests directly instead of spawning an app
   *  server. `undefined` from it means the same as no reply. */
  connect?: (method: string, params: unknown) => Promise<unknown>;
}

/**
 * A doctor probe has a person waiting and a daemon it has not yet checked, so
 * the app server gets a few seconds and no more. A slow answer is `unknown`,
 * which reads as "could not ask" and never as a verdict.
 */
const PROBE_MS = 8_000;

/**
 * One app-server connection, for the length of `fn`.
 *
 * NEVER LEAVES A SERVER BEHIND: the handshake goes in, `fn` issues whatever
 * requests it needs on the same connection, and the process has its stdin
 * closed and is killed on every exit path including a throw. Trusting needs
 * three round trips (list, write, list again) and they must see the same
 * process, so a one-shot helper per request would not do.
 *
 * Resolves null when the connection cannot be had at all: no `codex`, a build
 * without the method, a handshake that timed out. Null is "could not ask", and
 * no caller may read it as an answer.
 */
async function withAppServer<T>(
  home: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
  fn: (request: (method: string, params: unknown) => Promise<unknown>) => Promise<T>,
): Promise<T | null> {
  let child: ReturnType<typeof spawn>;
  try {
    child = spawn('codex', ['app-server'], {
      env: { ...env, CODEX_HOME: codexHome(home, env) },
      stdio: ['pipe', 'pipe', 'ignore'],
    });
  } catch {
    return null;
  }

  let dead = false;
  const pending = new Map<number, (value: unknown) => void>();
  const fail = (): void => {
    dead = true;
    for (const resolve of pending.values()) resolve(undefined);
    pending.clear();
  };
  child.on('error', fail);
  child.on('exit', fail);

  let buffered = '';
  child.stdout?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => {
    buffered += chunk;
    let cut = buffered.indexOf('\n');
    while (cut !== -1) {
      const line = buffered.slice(0, cut);
      buffered = buffered.slice(cut + 1);
      cut = buffered.indexOf('\n');
      let msg: unknown;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (!isRecord(msg) || typeof msg.id !== 'number') continue;
      const waiting = pending.get(msg.id);
      if (waiting === undefined) continue;
      pending.delete(msg.id);
      waiting(msg.error !== undefined ? undefined : msg.result);
    }
  });

  let nextId = 1;
  const send = (payload: unknown): boolean => {
    try {
      child.stdin?.write(`${JSON.stringify(payload)}\n`);
      return true;
    } catch {
      return false;
    }
  };
  const request = async (method: string, params: unknown): Promise<unknown> => {
    if (dead) return undefined;
    const id = ++nextId;
    return await new Promise<unknown>((resolve) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        resolve(undefined);
      }, timeoutMs);
      pending.set(id, (value) => {
        clearTimeout(timer);
        resolve(value);
      });
      if (!send({ jsonrpc: '2.0', id, method, params })) {
        pending.delete(id);
        clearTimeout(timer);
        resolve(undefined);
      }
    });
  };

  try {
    // Load-bearing in this order: a request sent before the `initialized`
    // notification is dropped with no reply and no error.
    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { clientInfo: { name: 'tenjin', title: 'tenjin', version: '1' } },
    });
    send({ jsonrpc: '2.0', method: 'initialized', params: {} });
    return await fn(request);
  } catch {
    return null;
  } finally {
    try {
      child.stdin?.end();
    } catch {
      // Already closed.
    }
    child.kill('SIGTERM');
  }
}

/** `hooks/list`, or null when the connection could not be had. */
async function listHooksViaAppServer(
  home: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<ListedHook[] | null> {
  return await withAppServer(home, env, timeoutMs, async (request) => {
    const result = await request('hooks/list', { cwds: [] });
    return result === undefined ? null : rowsOf(result);
  });
}

/** The handler rows out of a `hooks/list` result, flattened across its cwds. */
function rowsOf(result: unknown): ListedHook[] {
  if (!isRecord(result) || !Array.isArray(result.data)) return [];
  const out: ListedHook[] = [];
  for (const group of result.data) {
    if (!isRecord(group) || !Array.isArray(group.hooks)) continue;
    for (const hook of group.hooks) if (isRecord(hook)) out.push(hook as ListedHook);
  }
  return out;
}

/** What one trust attempt did, in the terms `install` reports it. */
export interface TrustResult {
  ok: boolean;
  /** Keys Codex confirmed enabled and trusted on the verifying read. */
  trusted: string[];
  /** Which step did not complete, on a failure. */
  failedAt?: 'list' | 'write' | 'verify';
  /** One line naming what went wrong, for the operator. */
  reason?: string;
}

/**
 * Trust exactly the handlers this install wrote, and prove it.
 *
 * THREE ROUND TRIPS, ALL REQUIRED. List to learn the hashes Codex computed for
 * OUR rows; upsert only those keys; list again and require the same keys back
 * with the same hashes, enabled and trusted. The verifying read is the point:
 * a write that returned without error still has not been shown to have taken
 * effect, and an install that skipped this could report success over a loop
 * that will not run, which is the failure this whole change exists to end.
 *
 * `ownedBy` is the second half of "only our rows". The keys already come from
 * the file we wrote, but a key is a path and two indices; this also requires
 * the listed handler's command to be the one we generated, so a row that moved
 * under our key is left alone rather than trusted on its position.
 */
export async function trustCodexHooks(
  home: string,
  keys: readonly string[],
  ownedBy: (row: { command?: unknown; sourcePath?: unknown }) => boolean,
  opts: TrustProbeOptions = {},
): Promise<TrustResult> {
  const env = opts.env ?? process.env;
  const timeoutMs = opts.timeoutMs ?? PROBE_MS;
  if (keys.length === 0) return { ok: true, trusted: [] };

  const run = async (
    request: (method: string, params: unknown) => Promise<unknown>,
  ): Promise<TrustResult> => {
    const before = await request('hooks/list', { cwds: [] });
    if (before === undefined) {
      return {
        ok: false,
        trusted: [],
        failedAt: 'list' as const,
        reason: 'hooks/list did not answer',
      };
    }
    const wanted = new Set(keys);
    const mine = rowsOf(before).filter(
      (r) => typeof r.key === 'string' && wanted.has(r.key) && ownedBy(r),
    );
    if (mine.length !== keys.length) {
      return {
        ok: false,
        trusted: [],
        failedAt: 'list' as const,
        reason: `Codex listed ${mine.length} of the ${keys.length} entries this install wrote`,
      };
    }
    // Only the rows we generated, each carrying the hash Codex just reported
    // for it. `upsert` leaves every other row in `hooks.state` untouched.
    const value: Record<string, { trusted_hash: string; enabled: true }> = {};
    for (const row of mine) {
      const hash = typeof row.currentHash === 'string' ? row.currentHash : null;
      if (hash === null) {
        return {
          ok: false,
          trusted: [],
          failedAt: 'list' as const,
          reason: 'Codex reported an entry with no currentHash',
        };
      }
      value[row.key as string] = { trusted_hash: hash, enabled: true };
    }
    const wrote = await request('config/batchWrite', {
      edits: [{ keyPath: 'hooks.state', value, mergeStrategy: 'upsert' }],
      reloadUserConfig: true,
    });
    if (wrote === undefined) {
      return {
        ok: false,
        trusted: [],
        failedAt: 'write' as const,
        reason: 'config/batchWrite was refused',
      };
    }

    // VERIFY. Same keys, same hashes, enabled and trusted, read back from the
    // binary rather than inferred from a write that did not error.
    const after = await request('hooks/list', { cwds: [] });
    if (after === undefined) {
      return {
        ok: false,
        trusted: [],
        failedAt: 'verify' as const,
        reason: 'the verifying hooks/list did not answer',
      };
    }
    const confirmed = rowsOf(after).filter(
      (r) =>
        typeof r.key === 'string' &&
        wanted.has(r.key) &&
        ownedBy(r) &&
        r.enabled !== false &&
        (r.trustStatus === 'trusted' || r.trustStatus === 'managed') &&
        r.currentHash === value[r.key]?.trusted_hash,
    );
    if (confirmed.length !== keys.length) {
      return {
        ok: false,
        trusted: confirmed.map((r) => r.key as string),
        failedAt: 'verify' as const,
        reason: `Codex confirmed ${confirmed.length} of ${keys.length} entries as trusted after the write`,
      };
    }
    return { ok: true, trusted: confirmed.map((r) => r.key as string) };
  };

  const outcome =
    opts.connect !== undefined
      ? await run(opts.connect)
      : await withAppServer(home, env, timeoutMs, run);

  return (
    outcome ?? {
      ok: false,
      trusted: [],
      failedAt: 'list',
      reason: 'the codex app server could not be reached',
    }
  );
}

/**
 * The `[hooks.state]` keys present in `toml`, or null when the shape is not one
 * this reader follows.
 *
 * THE FALLBACK, not the answer: it sees whether a row exists and whether it is
 * switched off, never whether the recorded hash still matches, so a `modified`
 * hook reads here as fine. Hence `hooks/list` first, and `partial` at best.
 *
 * A narrow scan rather than a TOML parser: two facts from a file this CLI must
 * never write, in both forms Codex writes (an inline table under
 * `[hooks.state]`, and a `[hooks.state."<key>"]` sub-table). Anything else
 * answers null, which surfaces as `unknown` rather than as a guess.
 */
export function parseHooksState(toml: string): Map<string, { enabled: boolean }> | null {
  const rows = new Map<string, { enabled: boolean }>();
  let inState = false;
  let subTableKey: string | null = null;
  for (const line of toml.split('\n')) {
    const text = line.trim();
    if (text.length === 0 || text.startsWith('#')) continue;
    if (text.startsWith('[')) {
      const sub = /^\[hooks\.state\."((?:[^"\\]|\\.)*)"\]$/.exec(text);
      if (sub !== null) {
        subTableKey = unquote(sub[1] ?? '');
        rows.set(subTableKey, { enabled: true });
        inState = false;
        continue;
      }
      inState = text === '[hooks.state]';
      subTableKey = null;
      continue;
    }
    if (subTableKey !== null) {
      if (/^enabled\s*=\s*false\b/.test(text)) rows.set(subTableKey, { enabled: false });
      continue;
    }
    if (!inState) continue;
    const row = /^"((?:[^"\\]|\\.)*)"\s*=\s*(.*)$/.exec(text);
    if (row === null) return null;
    rows.set(unquote(row[1] ?? ''), { enabled: !/\benabled\s*=\s*false\b/.test(row[2] ?? '') });
  }
  return rows;
}

/** TOML basic-string escapes, limited to the ones a filesystem path can carry. */
function unquote(raw: string): string {
  return raw.replace(/\\(["\\])/g, '$1');
}

/**
 * What Codex will do with our hooks. `keys` comes from the caller reading the
 * installed hooks.json, so an empty list is "nothing of ours is registered"
 * and answers `unknown` rather than inventing a verdict.
 */
export async function readCodexTrust(
  home: string,
  keys: readonly string[],
  opts: TrustProbeOptions = {},
): Promise<CodexTrustReport> {
  const env = opts.env ?? process.env;
  const configPath = codexConfigPath(home, env);
  const base = { configPath, trusted: 0, expected: keys.length };
  if (keys.length === 0) return { ...base, state: 'unknown', source: 'none' };

  const list = await (
    opts.listHooks ?? ((h, e) => listHooksViaAppServer(h, e, opts.timeoutMs ?? PROBE_MS))
  )(home, env);
  if (list !== null) {
    const state = foldTrust(list, keys);
    const wanted = new Set(keys);
    const trusted = list.filter(
      (r) =>
        typeof r.key === 'string' &&
        wanted.has(r.key) &&
        (r.trustStatus === 'trusted' || r.trustStatus === 'managed'),
    ).length;
    return { ...base, trusted, state, source: 'app-server' };
  }

  // ONLY A MISSING FILE MEANS ABSENT. A file that exists and cannot be read --
  // permissions, a directory in its place, an I/O error -- says nothing about
  // trust, and reporting it as definitely untrusted both hides the real
  // problem and recommends a fix that would not touch it (tenjin-agent#343).
  const read = await readFile(configPath, 'utf8').then(
    (text) => ({ text }),
    (err: NodeJS.ErrnoException) => ({ err }),
  );
  if ('err' in read) {
    if (read.err.code === 'ENOENT') return { ...base, state: 'untrusted', source: 'config-file' };
    return { ...base, state: 'unknown', source: 'config-file' };
  }
  const raw = read.text;
  const rows = parseHooksState(raw);
  if (rows === null) return { ...base, state: 'unknown', source: 'config-file' };
  const found = keys.map((k) => rows.get(k)).filter((r) => r !== undefined);
  if (found.some((r) => !r.enabled)) {
    return { ...base, trusted: 0, state: 'disabled', source: 'config-file' };
  }
  if (found.length === 0) return { ...base, state: 'untrusted', source: 'config-file' };
  // Never `trusted` from this path: the hash may have gone stale under it, and
  // only Codex can say. `partial` is the strongest honest word here.
  return { ...base, trusted: found.length, state: 'partial', source: 'config-file' };
}
