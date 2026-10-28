import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveContextSettings } from './settings';
import { PRODUCTION_ORIGIN } from './production-origin';
import type { CommandContext } from '../context';

let dataDir: string;
let prevBaseUrl: string | undefined;
beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'tenjin-settings-'));
  prevBaseUrl = process.env.TENJIN_BASE_URL;
  delete process.env.TENJIN_BASE_URL;
});
afterEach(async () => {
  if (prevBaseUrl === undefined) delete process.env.TENJIN_BASE_URL;
  else process.env.TENJIN_BASE_URL = prevBaseUrl;
  await rm(dataDir, { recursive: true, force: true });
});

function ctx(baseUrl?: string): CommandContext {
  const sink = () => ({ write: () => true }) as unknown as NodeJS.WritableStream;
  return {
    flags: { json: false, timeout: 10000, ...(baseUrl !== undefined ? { baseUrl } : {}) },
    dataDir,
    io: { stdout: sink(), stderr: sink(), isTTY: false },
  };
}

describe('resolveContextSettings', () => {
  it('takes the router base URL from the flag, then TENJIN_BASE_URL, then config, then the default', async () => {
    expect((await resolveContextSettings(ctx())).baseUrl).toBe(PRODUCTION_ORIGIN);
    await writeFile(
      join(dataDir, 'config.json'),
      JSON.stringify({ baseUrl: 'https://file.example' }),
    );
    expect((await resolveContextSettings(ctx())).baseUrl).toBe('https://file.example');
    process.env.TENJIN_BASE_URL = 'https://env.example';
    expect((await resolveContextSettings(ctx())).baseUrl).toBe('https://env.example');
    expect((await resolveContextSettings(ctx('https://flag.example'))).baseUrl).toBe(
      'https://flag.example',
    );
  });

  it('hands the spend values on as bigint, with none as no ceiling', async () => {
    await writeFile(
      join(dataDir, 'config.json'),
      JSON.stringify({ maxAutoSpend: '500000', sessionBudget: 'none', sendMaxAmount: '0' }),
    );
    const s = await resolveContextSettings(ctx());
    expect(s.policy).toEqual({
      maxAutoSpendAtomic: 500_000n,
      sessionBudgetAtomic: null,
      allowlistCreators: [],
    });
    expect(s.sendMaxAmountAtomic).toBe(0n);
  });
});
