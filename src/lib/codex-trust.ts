import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { codexHome } from '../adapters/codex';

/**
 * READ-ONLY. What Codex itself says about the hook handlers this CLI
 * registered, so `doctor` and `install` can tell "the file exists" from "the
 * harness will run it".
 *
 * NOTHING HERE WRITES, AND NOTHING IN THIS REPO MAY. Codex gates a handler on
 * `[hooks.state]` in `$CODEX_HOME/config.toml`: a row keyed
 * `"<source path>:<event_snake>:<group>:<handler>"` carrying `enabled` and a
 * `trusted_hash`, and the handler runs only when it is enabled and that hash
 * still matches the one Codex recomputes from the file.
 *
 * There IS a mechanical way to write that row: the `/hooks` browser has no
 * privileged path, it sends a generic `config/batchWrite`, and anything could
 * send the same. This CLI deliberately does not. The hash is the control that
 * stops an edited hooks.json running under trust granted to an earlier version
 * of itself, and it protects the operator from us among others; echoing
 * `currentHash` back would be granting ourselves the review the browser exists
 * to obtain, on the run that wrote the file being reviewed. So the keypress
 * stays with a person (tenjin-agent#342).
 *
 * NOR IS THE HASH RECOMPUTED HERE. It comes from a normalized, TOML-projected,
 * canonical-JSON form private to Codex's build; a second copy of someone
 * else's versioned grammar would drift and make `doctor` confidently wrong
 * about a security state. `hooks/list` reports `trustStatus` as the running
 * binary computed it, which is the answer rather than a model of it.
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
}

/**
 * A doctor probe has a person waiting and a daemon it has not yet checked, so
 * the app server gets a few seconds and no more. A slow answer is `unknown`,
 * which reads as "could not ask" and never as a verdict.
 */
const PROBE_MS = 8_000;

/**
 * Ask the installed `codex` what it thinks of our hooks, over the app server's
 * read-only `hooks/list`.
 *
 * NEVER LEAVES A SERVER BEHIND: three lines in, read until the answer or the
 * deadline, then stdin closed and the process killed either way.
 *
 * Null is "could not ask" — no `codex`, no such method, a timeout — and the
 * caller falls back to the config file. It is never "nothing is trusted".
 */
async function listHooksViaAppServer(
  home: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<ListedHook[] | null> {
  return await new Promise<ListedHook[] | null>((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn('codex', ['app-server'], {
        env: { ...env, CODEX_HOME: codexHome(home, env) },
        stdio: ['pipe', 'pipe', 'ignore'],
      });
    } catch {
      resolve(null);
      return;
    }
    let settled = false;
    const finish = (value: ListedHook[] | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child.stdin?.end();
      } catch {
        // Already closed.
      }
      child.kill('SIGTERM');
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    child.on('error', () => finish(null));
    child.on('exit', () => finish(null));

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
        if (!isRecord(msg) || msg.id !== LIST_ID) continue;
        finish(rowsOf(msg.result));
        return;
      }
    });

    const send = (o: unknown): void => {
      try {
        child.stdin?.write(`${JSON.stringify(o)}\n`);
      } catch {
        finish(null);
      }
    };
    // The handshake is load-bearing in this order: a `hooks/list` sent before
    // the `initialized` notification is dropped with no reply and no error.
    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { clientInfo: { name: 'tenjin', title: 'tenjin', version: '1' } },
    });
    send({ jsonrpc: '2.0', method: 'initialized', params: {} });
    send({ jsonrpc: '2.0', id: LIST_ID, method: 'hooks/list', params: { cwds: [] } });
  });
}

const LIST_ID = 2;

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

  const raw = await readFile(configPath, 'utf8').catch(() => null);
  // No config file at all is still a definite answer: Codex has recorded no
  // trust, so the entries are inert and `/hooks` is the step.
  if (raw === null) return { ...base, state: 'untrusted', source: 'config-file' };
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
