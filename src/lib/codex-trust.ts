import { withAppServer } from './codex-app-server';

/**
 * The one write that makes the hook handlers this CLI registered run: `install`
 * needs to move them from "the file exists" to "the harness will run it".
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
export const EVENT_LABEL: Readonly<Record<string, string>> = {
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

/** One handler as `hooks/list` reports it; every field optional, since this is
 *  another program's wire format and a missing one means "cannot tell". */
export interface ListedHook {
  [field: string]: unknown;
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

export interface TrustProbeOptions {
  env?: NodeJS.ProcessEnv;
  /** How long to wait for the app server. Past it the attempt fails at `list`. */
  timeoutMs?: number;
  /** Seam for tests: answer requests directly instead of spawning an app
   *  server. `undefined` from it means the same as no reply. */
  connect?: (method: string, params: unknown) => Promise<unknown>;
}

/**
 * An install has a person waiting, so the app server gets a few seconds and no
 * more. A slow answer reads as "could not ask", never as a verdict.
 */
const PROBE_MS = 8_000;

/** The handler rows out of a `hooks/list` result, flattened across its cwds. */
export function rowsOf(result: unknown): ListedHook[] {
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
  ownedBy: (row: ListedHook) => boolean,
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
