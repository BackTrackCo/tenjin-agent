import { renderProgress } from './progress';
import type { Io } from '../lib/output';

/**
 * `tenjin status-line`: the live footer Claude Code runs on its own refresh.
 *
 * CHEAP AND READ-ONLY. One JSON event on stdin for the session identity, one
 * read of that session's progress directory, one line out. No network call, no
 * wallet, no config read, no write: it runs once a second for as long as a
 * session is open, so anything it touched would be touched 3,600 times an hour.
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
 * one-second timer: commander, zod and the command tree cost about 120 ms of
 * parse per tick over this path. `dist-chunks.test.ts` pins what it may load.
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
    const raw = await (deps.readEvent ?? readStdin)();
    const event: unknown = JSON.parse(raw);
    const sessionId = sessionIdOf(event);
    if (sessionId === null) return;
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

/**
 * The session identity, and nothing else off the event. A footer that showed
 * the wrong session's lookups would be a leak between two terminals, so an
 * event without a plain, bounded `session_id` renders nothing at all.
 */
function sessionIdOf(event: unknown): string | null {
  if (event === null || typeof event !== 'object' || Array.isArray(event)) return null;
  const value = (event as { session_id?: unknown }).session_id;
  if (typeof value !== 'string' || value.length === 0 || value.length > 200) return null;
  return value;
}

async function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const timer = setTimeout(() => reject(new Error('no harness event')), STDIN_TIMEOUT_MS);
    process.stdin.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_EVENT_BYTES) {
        clearTimeout(timer);
        reject(new Error('harness event too large'));
        return;
      }
      chunks.push(chunk);
    });
    process.stdin.once('end', () => {
      clearTimeout(timer);
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    process.stdin.once('error', () => {
      clearTimeout(timer);
      reject(new Error('harness event unreadable'));
    });
  });
}
