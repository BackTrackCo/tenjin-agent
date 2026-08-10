import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readClawRouterSpendPolicy } from './clawrouter-policy';

let dir: string;
let path: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tenjin-claw-policy-'));
  path = join(dir, 'spending.json');
});
afterEach(async () => rm(dir, { recursive: true, force: true }));

describe('readClawRouterSpendPolicy', () => {
  it('imports all standard limits as USDC atomic values without returning history', async () => {
    await writeFile(
      path,
      JSON.stringify({
        limits: { perRequest: 0.25, hourly: 1, daily: 5.5, session: 2 },
        history: [{ timestamp: 1, amount: 999, secret: 'do-not-copy' }],
      }),
      { mode: 0o600 },
    );
    expect(await readClawRouterSpendPolicy({ path })).toEqual({
      status: 'configured',
      path,
      limits: {
        perRequestAtomic: 250_000n,
        hourlyAtomic: 1_000_000n,
        dailyAtomic: 5_500_000n,
        sessionAtomic: 2_000_000n,
      },
    });
  });

  it('is strictly read-only, preserving bytes, inode, mode, size, and mtime', async () => {
    const bytes = '{"limits":{"daily":5},"history":[{"amount":1}]}\n';
    await writeFile(path, bytes, { mode: 0o640 });
    const before = await stat(path);
    await readClawRouterSpendPolicy({ path });
    const after = await stat(path);
    expect(await readFile(path, 'utf8')).toBe(bytes);
    expect(after.ino).toBe(before.ino);
    expect(after.mode).toBe(before.mode);
    expect(after.size).toBe(before.size);
    expect(after.mtimeMs).toBe(before.mtimeMs);
  });

  it('returns confirmation-only-safe states for absent, empty, malformed, and tiny limits', async () => {
    expect((await readClawRouterSpendPolicy({ path })).status).toBe('absent');
    await writeFile(path, JSON.stringify({ limits: {}, history: [] }));
    expect((await readClawRouterSpendPolicy({ path })).status).toBe('unconfigured');
    await writeFile(path, '{private-key-looking-but-never-echoed');
    const malformed = await readClawRouterSpendPolicy({ path });
    expect(malformed.status).toBe('invalid');
    expect(JSON.stringify(malformed)).not.toContain('private-key-looking');
    await writeFile(path, JSON.stringify({ limits: { daily: 0.0000001 } }));
    expect((await readClawRouterSpendPolicy({ path })).status).toBe('invalid');
  });
});
