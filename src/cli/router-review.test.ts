import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { main } from '../cli';
let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'review-cli-'));
  vi.stubEnv('TENJIN_DATA_DIR', dir);
  vi.stubEnv('CI', '1');
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true });
});
it('lists the lifecycle commands and refuses a release without consent', async () => {
  const output: string[] = [];
  const sink = {
    write: (s: string | Uint8Array) => {
      output.push(s.toString());
      return true;
    },
  } as unknown as NodeJS.WritableStream;
  const io = { stdout: sink, stderr: sink, isTTY: false };
  await main(['jobs', '--help'], io);
  expect(output.join('')).toMatch(/submit/);
  expect(output.join('')).toMatch(/release/);
  output.length = 0;
  await main(['jobs', 'release', '00000000-0000-4000-8000-000000000001', '--json'], io);
  expect(output.join('')).toContain('--yes');
});
