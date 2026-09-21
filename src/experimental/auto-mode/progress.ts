import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, opendir } from 'node:fs/promises';
import { join } from 'node:path';
import { writeFileAtomic } from '../../lib/atomic-json';
import { mask } from '../../lib/redact';

type Identity = { session_id: string; tool_use_id: string; tool_name: string };
type Store = { stateDir: string };
export interface Progress {
  phase: 'routing' | 'calling' | 'finished';
  status?: string;
  provider?: string;
  args?: Record<string, unknown>;
  cached?: boolean;
  fixture?: boolean;
}
interface SavedProgress {
  version: 1;
  at: number;
  phase: Progress['phase'];
  operation: string;
  status?: string;
  provider?: string;
  parameters?: string;
  cached?: boolean;
  fixture?: boolean;
}
const key = (value: string) => createHash('sha256').update(value).digest('hex');
const bounded = (value: string, length: number) => {
  const chars = Array.from(value);
  return chars.length <= length ? value : `${chars.slice(0, length - 1).join('')}…`;
};
// Provider text is untrusted even in a terminal. Never emit terminal control
// sequences, line breaks or directional overrides from a URL or argument.
const clean = (value: string, length: number) =>
  bounded(
    mask(value)
      .replace(/[\p{Cc}\p{Cf}]/gu, ' ')
      .replace(/\s+/g, ' '),
    length,
  );

function providerLabel(value: string): string {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password) return 'invalid provider';
    return clean(`${url.hostname}${url.pathname === '/' ? '' : url.pathname}`, 110);
  } catch {
    return 'invalid provider';
  }
}

/** Display evidence only: separate from authorization, ledger and provider I/O. */
export async function writeProgress(
  config: Store,
  event: Identity,
  progress: Progress,
  now = Date.now(),
): Promise<void> {
  try {
    const saved: SavedProgress = {
      version: 1,
      at: now,
      phase: progress.phase,
      operation:
        event.tool_name === 'Request'
          ? 'request'
          : event.tool_name === 'WebFetch'
            ? 'fetch'
            : 'search',
      status: progress.status && clean(progress.status, 60),
      provider: progress.provider && providerLabel(progress.provider),
      parameters: progress.args && clean(JSON.stringify(progress.args), 180),
      cached: progress.cached,
      fixture: progress.fixture,
    };
    await writeFileAtomic(
      join(config.stateDir, 'progress', key(event.session_id), `${key(event.tool_use_id)}.json`),
      JSON.stringify(saved),
      { mode: 0o600, dirMode: 0o700 },
    );
  } catch {
    // A broken status display must not change payment/execution decisions.
  }
}

/** Session-scoped, bounded read. The footer makes no network calls. */
export async function renderProgress(
  config: Store,
  sessionId: string,
  options: { now?: number; columns?: number } = {},
): Promise<string> {
  const now = options.now ?? Date.now();
  const columns = Math.max(45, Math.min(180, options.columns || 120));
  const records: SavedProgress[] = [];
  try {
    const directory = await opendir(join(config.stateDir, 'progress', key(sessionId)));
    let count = 0;
    for await (const entry of directory) {
      if (++count > 256) return 'x402 · activity exceeds display limit';
      if (!entry.isFile() || !/^[a-f0-9]{64}\.json$/.test(entry.name)) continue;
      const file = await open(
        join(directory.path, entry.name),
        constants.O_RDONLY | constants.O_NOFOLLOW,
      ).catch(() => undefined);
      if (!file) continue;
      try {
        if ((await file.stat()).size > 4096) continue;
        const buffer = Buffer.alloc(4097);
        const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
        if (bytesRead > 4096) continue;
        const row = JSON.parse(buffer.subarray(0, bytesRead).toString('utf8')) as SavedProgress;
        if (
          row.version !== 1 ||
          !Number.isFinite(row.at) ||
          row.at > now ||
          !['routing', 'calling', 'finished'].includes(row.phase) ||
          !['request', 'search', 'fetch'].includes(row.operation) ||
          [row.provider, row.parameters, row.status].some(
            (value) => value !== undefined && typeof value !== 'string',
          )
        )
          continue;
        records.push(row);
      } catch {
        // Ignore a damaged display record without hiding other active calls.
      } finally {
        await file.close();
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'x402 · ready';
    return 'x402 · activity unavailable';
  }
  const active = records
    .filter((row) => row.phase !== 'finished' && now - row.at <= 85_000)
    .sort((a, b) => b.at - a.at);
  const stale = records
    .filter((row) => row.phase !== 'finished' && now - row.at > 85_000)
    .sort((a, b) => b.at - a.at);
  const recent = records
    .filter((row) => row.phase === 'finished' && now - row.at < 20_000)
    .sort((a, b) => b.at - a.at);
  const shown = [...active, ...recent, ...stale].slice(0, 2);
  if (!shown.length) return 'x402 · ready';
  const lines = shown.map((row) => {
    if (row.phase !== 'finished' && now - row.at > 85_000)
      return `x402 · ${row.operation}: status stale; inspect saved attempt`;
    const stage =
      row.phase === 'routing'
        ? 'selecting service'
        : row.phase === 'calling'
          ? 'calling'
          : row.cached
            ? 'cached'
            : row.status;
    return bounded(
      `x402 · ${row.fixture ? 'fixture · ' : ''}${row.operation}: ${clean(stage ?? 'unknown', 60)}` +
        (row.provider ? ` ${clean(row.provider, 110)}` : '') +
        (row.parameters ? ` · ${clean(row.parameters, 180)}` : ''),
      columns,
    );
  });
  if (active.length > 2) lines.push(`x402 · +${active.length - 2} other active calls`);
  const hiddenStale = stale.filter((row) => !shown.includes(row)).length;
  if (hiddenStale) lines.push(`x402 · ${hiddenStale} stale calls; inspect saved attempts`);
  return lines.join('\n');
}
