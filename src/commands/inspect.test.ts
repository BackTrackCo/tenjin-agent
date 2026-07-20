import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInspect } from './inspect';
import { buildPaymentRequired, makeReadServer, readBody, reply } from '../lib/read-test-utils';
import { libraryDir } from '../lib/library';
import type { CommandContext, GlobalFlags } from '../context';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tenjin-inspect-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function makeCtx(flags: Partial<GlobalFlags> = {}): CommandContext {
  const sink = () => ({ write: () => true }) as unknown as NodeJS.WritableStream;
  return {
    flags: { json: false, timeout: 5000, ...flags },
    dataDir: dir,
    io: { stdout: sink(), stderr: sink(), isTTY: false },
  };
}

const URL_ = 'https://tenjin.blog/api/read/iris/slug';

describe('runInspect', () => {
  it('shows the paid card + price from the 402 without paying and without saving', async () => {
    const pr = buildPaymentRequired();
    const { fetch, calls } = makeReadServer({ plain: () => reply.paymentRequired(pr) });
    const res = await runInspect({ ref: URL_ }, makeCtx(), { fetchImpl: fetch });
    const data = res.data as { access: string; price?: { atomic: string } };
    expect(data.access).toBe('paid');
    expect(data.price?.atomic).toBe('100000');
    expect(calls.every((c) => c.phase === 'plain')).toBe(true);
    // Nothing is written to the library on inspect.
    await expect(readdir(libraryDir(dir))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('reports a free resource as free', async () => {
    const { fetch } = makeReadServer({ plain: () => reply.entitled(readBody({ price: '0' })) });
    const res = await runInspect({ ref: URL_ }, makeCtx(), { fetchImpl: fetch });
    expect((res.data as { access: string }).access).toBe('free');
  });
});
