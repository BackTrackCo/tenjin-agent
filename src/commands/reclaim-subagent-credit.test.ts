import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { testCtx } from '../context-test-utils';
import { forgetSqlite } from '../lib/held-lock-sqlite';
import { runReclaimSubagentCredit } from './reclaim-subagent-credit';

let dir: string;
afterEach(async () => {
  vi.restoreAllMocks();
  forgetSqlite();
  if (dir) await rm(dir, { recursive: true, force: true });
});

// Issue 577: on a Linux Node without node:sqlite every channel was reported as pending, and the
// person was told only to run the command again.
it('says the Node is too old for the lock, not that a refund is pending', async () => {
  dir = await mkdtemp(join(tmpdir(), 'reclaim-'));
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  const builtin = process.getBuiltinModule;
  Object.defineProperty(process, 'platform', { ...platform, value: 'linux' });
  process.getBuiltinModule = (() => undefined) as typeof process.getBuiltinModule;
  forgetSqlite();
  try {
    await expect(runReclaimSubagentCredit(testCtx(dir))).rejects.toMatchObject({
      message: expect.stringContaining('Node 22.13 or later'),
    });
  } finally {
    process.getBuiltinModule = builtin;
    Object.defineProperty(process, 'platform', platform);
  }
});
