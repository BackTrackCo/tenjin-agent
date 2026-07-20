import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runOutcome } from './outcome';
import { recordLookup } from '../lib/lookup-store';
import type { CommandContext } from '../context';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tenjin-outcome-cmd-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function makeCtx(): CommandContext {
  const sink = () => ({ write: () => true }) as unknown as NodeJS.WritableStream;
  return {
    flags: { json: false, timeout: 5000, baseUrl: 'https://preview.example' },
    dataDir: dir,
    io: { stdout: sink(), stderr: sink(), isTTY: false },
  };
}

function stub(): { fetch: typeof fetch; urls: string[] } {
  const urls: string[] = [];
  const fetchFn = (async (url: string) => {
    urls.push(String(url));
    return new Response(JSON.stringify({ accepted: 1 }), {
      status: 202,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return { fetch: fetchFn, urls };
}

const LOOKUP = '0197aaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

describe('runOutcome', () => {
  it('reports against an explicit --lookup-id', async () => {
    const { fetch, urls } = stub();
    const res = await runOutcome({ lookupId: LOOKUP, status: 'used' }, makeCtx(), {
      fetchImpl: fetch,
    });
    expect((res.data as { accepted: number }).accepted).toBe(1);
    expect(urls[0]).toBe(`https://preview.example/api/agent/lookups/${LOOKUP}/outcomes`);
  });

  it('--last targets the most recent local lookup', async () => {
    await recordLookup(dir, {
      lookupId: LOOKUP,
      at: new Date().toISOString(),
      question: 'q',
      decision: 'CANDIDATES',
      candidates: [],
    });
    const { fetch, urls } = stub();
    await runOutcome({ last: true, status: 'regenerated' }, makeCtx(), { fetchImpl: fetch });
    expect(urls[0]).toContain(LOOKUP);
  });

  it('--last with no local lookup is a LOOKUP_NOT_FOUND error', async () => {
    const { fetch } = stub();
    await expect(
      runOutcome({ last: true, status: 'used' }, makeCtx(), { fetchImpl: fetch }),
    ).rejects.toMatchObject({ code: 'LOOKUP_NOT_FOUND', exitCode: 1 });
  });

  it('rejects passing neither --lookup-id nor --last', async () => {
    const { fetch, urls } = stub();
    await expect(
      runOutcome({ status: 'used' }, makeCtx(), { fetchImpl: fetch }),
    ).rejects.toMatchObject({ code: 'USAGE' });
    expect(urls).toHaveLength(0);
  });

  it('rejects passing both --lookup-id and --last', async () => {
    const { fetch } = stub();
    await expect(
      runOutcome({ lookupId: LOOKUP, last: true, status: 'used' }, makeCtx(), { fetchImpl: fetch }),
    ).rejects.toMatchObject({ code: 'USAGE' });
  });

  it('rejects an unknown status before any request', async () => {
    const { fetch, urls } = stub();
    await expect(
      runOutcome({ lookupId: LOOKUP, status: 'loved-it' }, makeCtx(), { fetchImpl: fetch }),
    ).rejects.toMatchObject({ code: 'USAGE' });
    expect(urls).toHaveLength(0);
  });
});
