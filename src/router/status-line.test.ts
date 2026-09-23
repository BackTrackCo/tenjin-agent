import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sessionDir, writeProgress } from './progress';
import { runStatusLine } from './status-line';
import type { Io } from '../lib/output';

/**
 * `tenjin status-line`. It is a display, so the bar is: the right session's
 * activity, nothing on a bad event, and never an error the harness can see.
 */

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'router-status-line-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const NOW = 1_800_000_000_000;
const PROVIDER = 'https://api.exa.ai/search';

function io(): { io: Io; out: string[] } {
  const out: string[] = [];
  const sink = (target?: string[]) =>
    ({
      write: (chunk: string) => {
        target?.push(chunk);
        return true;
      },
    }) as unknown as NodeJS.WritableStream;
  return { io: { stdout: sink(out), stderr: sink(), isTTY: false }, out };
}

async function render(event: string): Promise<string[]> {
  const { io: stream, out } = io();
  await runStatusLine(stream, { dataDir: dir, readEvent: async () => event, now: () => NOW });
  return out;
}

describe('the status line command', () => {
  it('renders the session named by the harness event', async () => {
    await writeProgress(
      sessionDir(dir, 'session-a'),
      'call-1',
      { phase: 'calling', provider: PROVIDER },
      NOW,
    );

    expect(await render(JSON.stringify({ session_id: 'session-a' }))).toEqual([
      'x402 · request: calling api.exa.ai/search\n',
    ]);
  });

  it('shows one session nothing of another session', async () => {
    await writeProgress(
      sessionDir(dir, 'session-a'),
      'call-1',
      { phase: 'calling', provider: PROVIDER },
      NOW,
    );

    expect(await render(JSON.stringify({ session_id: 'session-b' }))).toEqual(['x402 · ready\n']);
  });

  it('prints nothing for an event with no session identity', async () => {
    for (const event of ['{}', '[]', 'not json', JSON.stringify({ session_id: 42 })]) {
      expect(await render(event)).toEqual([]);
    }
  });

  it('prints nothing when stdin never arrives, rather than failing the harness', async () => {
    const { io: stream, out } = io();
    await runStatusLine(stream, {
      dataDir: dir,
      readEvent: async () => {
        throw new Error('no harness event');
      },
    });
    expect(out).toEqual([]);
  });

  it('writes nothing at all', async () => {
    await writeProgress(sessionDir(dir, 'session-a'), 'call-1', { phase: 'routing' }, NOW);
    const before = await readdir(sessionDir(dir, 'session-a'));

    await render(JSON.stringify({ session_id: 'session-a' }));

    expect(await readdir(sessionDir(dir, 'session-a'))).toEqual(before);
  });
});
