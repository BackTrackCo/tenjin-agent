import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { testCtx } from '../context-test-utils';
import { runConfigSubagents } from './config-subagents';
import { modelSettings } from '../router/model-settings';

let dir: string;
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

it('records explicit accepted-worker instruction consent while preserving wallet and account settings', async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), 'config-subagents-')));
  const repo = join(dir, 'repo');
  await mkdir(join(repo, '.git'), { recursive: true });
  await writeFile(
    join(dir, 'config.json'),
    JSON.stringify({
      maxAutoSpend: '250000',
      sessionBudget: '5000000',
      router: {
        enabled: true,
        accounts: true,
        subagents: true,
        subagentConsent: {
          version: 1,
          recipients: ['Tenjin', 'DeepSeek'],
          repositories: [repo],
          maxJobAtomic: '1000000',
          routerOrigin: 'https://tenjin.test',
        },
      },
    }),
  );
  expect(await modelSettings(dir, repo)).toBeNull();
  const result = await runConfigSubagents('on', { repository: repo, maxJob: '1' }, testCtx(dir));
  const saved = JSON.parse(await readFile(join(dir, 'config.json'), 'utf8'));
  expect(saved).toMatchObject({
    maxAutoSpend: '250000',
    sessionBudget: '5000000',
    router: {
      accounts: true,
      subagentConsent: {
        version: 2,
        instructions: 'applicable',
        repositories: [repo],
        maxJobAtomic: '1000000',
      },
    },
  });
  expect(JSON.stringify(result.data)).toContain('After acceptance');
  expect(JSON.stringify(result.data)).toContain('no extra tool or filesystem permission');
  expect(JSON.stringify(result.data)).not.toContain(
    'TypeSafe/Jev for routing) to receive this repository’s subagent assignments, bounded parent context and applicable',
  );
  expect(await modelSettings(dir, repo)).not.toBeNull();
  await runConfigSubagents('off', {}, testCtx(dir));
  expect(await modelSettings(dir, repo)).toBeNull();
});
