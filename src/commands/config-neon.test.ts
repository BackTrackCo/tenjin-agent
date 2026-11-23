import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import type { CommandContext } from '../context';
import { runConfigNeon } from './config-neon';

let dir: string;
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});
async function context(): Promise<CommandContext> {
  dir = await realpath(await mkdtemp(join(tmpdir(), 'config-neon-')));
  return {
    flags: { json: true, timeout: 30_000 } as CommandContext['flags'],
    dataDir: dir,
    io: { stdout: process.stdout, stderr: process.stderr, isTTY: false },
  };
}

it('turns Neon on with its own consent, naming BlockRun and Google, and leaves DeepSeek subagents alone', async () => {
  const ctx = await context();
  expect((await runConfigNeon(undefined, {}, ctx)).data).toEqual({ enabled: false });
  const on = await runConfigNeon('on', { maxJob: '0.50' }, ctx);
  expect(on.data).toMatchObject({
    enabled: true,
    scope: 'every-workspace',
    jobCapAtomic: '500000',
  });
  expect(on.humanLines?.join('\n')).toContain('BlockRun and Google');
  const saved = JSON.parse(await readFile(join(dir, 'config.json'), 'utf8')).router;
  expect(saved.neon).toBe(true);
  expect(saved.neonConsent).toMatchObject({
    version: 1,
    recipients: ['BlockRun', 'Google'],
    routerOrigin: 'https://blockrun.ai',
    maxJobAtomic: '500000',
  });
  // Nothing of the DeepSeek consent was written.
  expect(saved.subagents).toBeUndefined();
  expect(saved.subagentConsent).toBeUndefined();
  expect((await runConfigNeon('off', {}, ctx)).data).toEqual({ enabled: false });
  expect((await runConfigNeon(undefined, {}, ctx)).data).toEqual({ enabled: false });
});
