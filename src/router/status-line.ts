import { readCappedStdin, sessionIdOf } from './harness-event';
import { renderProgress } from './progress';
import { routerSettings } from './settings';
import type { Io } from '../lib/output';

/**
 * `tenjin status-line`: the live footer Claude Code runs on its own refresh.
 *
 * CHEAP AND READ-ONLY. One JSON event on stdin for the session identity, the
 * router's own switch for its directory, one read of that session's progress
 * directory, one line out. No network call, no wallet, no write: it runs once a
 * second for as long as a session is open, so anything it touched would be
 * touched 3,600 times an hour.
 *
 * IT CANNOT FAIL LOUDLY either. Every error path writes nothing and returns, so
 * the command exits 0 with empty output and the harness shows no footer.
 */

/** Claude Code's status event is small; anything larger is not one. */
const MAX_EVENT_BYTES = 64_000;
/** The harness writes the event immediately, so this is a liveness check. */
export const STDIN_TIMEOUT_MS = 1_000;

export interface StatusLineDeps {
  dataDir: string;
  /** Test seam for the harness event; production reads stdin. */
  readEvent?: () => Promise<string>;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
}

/**
 * The bin entry's fast path for a bare `tenjin status-line`, which runs on a
 * one-second timer: commander and the command tree cost about 120 ms of parse
 * per tick over this path. It does load zod, for the router's own switch
 * through the one config parser, about 17 ms a tick. `dist-chunks.test.ts`
 * pins what it may load.
 */
export async function statusLineMain(): Promise<void> {
  const { dataDir } = await import('../lib/paths');
  await runStatusLine(
    { stdout: process.stdout, stderr: process.stderr, isTTY: false },
    { dataDir: dataDir(process.env) },
  );
}

export async function runStatusLine(io: Io, deps: StatusLineDeps): Promise<void> {
  let rendered: string;
  try {
    const raw = await (
      deps.readEvent ?? (() => readCappedStdin(MAX_EVENT_BYTES, STDIN_TIMEOUT_MS))
    )();
    const event: unknown = JSON.parse(raw);
    const sessionId = sessionIdOf(event);
    if (sessionId === null) return;
    // Off here means no footer: the router is not running in this directory.
    const router = await routerSettings(
      { cwd: cwdOf(event) ?? process.cwd(), dataDir: deps.dataDir },
      { warn: () => undefined },
    );
    if (!router.enabled.value) return;
    const columns = Number((deps.env ?? process.env).COLUMNS);
    rendered = await renderProgress(deps.dataDir, sessionId, {
      ...(Number.isFinite(columns) && columns > 0 ? { columns } : {}),
      ...(deps.now !== undefined ? { now: deps.now() } : {}),
    });
  } catch {
    return;
  }
  if (rendered.length > 0) io.stdout.write(`${rendered}\n`);
}

/** The session's working directory, which `router.*` resolves from. */
function cwdOf(event: unknown): string | null {
  const value = (event as { cwd?: unknown }).cwd;
  return typeof value === 'string' && value.length > 0 ? value : null;
}
