import { mkdtemp, mkdir, realpath, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { modelSettings } from './model-settings';
let dir: string;
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});
async function fixture(router: Record<string, unknown>) {
  dir = await realpath(await mkdtemp(join(tmpdir(), 'model-consent-')));
  const data = join(dir, 'data'),
    repo = join(dir, 'repo');
  await mkdir(data);
  await mkdir(repo);
  await mkdir(join(repo, '.git'));
  await writeFile(join(data, 'config.json'), JSON.stringify({ router }));
  return { data, repo };
}
it('does not turn legacy tier routing or a boolean into inference/data consent', async () => {
  const { data, repo } = await fixture({ subagents: 'apply' });
  expect(await modelSettings(data, repo)).toBeNull();
  await writeFile(
    join(data, 'config.json'),
    JSON.stringify({
      router: {
        subagents: true,
        subagentConsent: {
          version: 1,
          recipients: ['Tenjin', 'DeepSeek'],
          repositories: [repo],
          maxJobAtomic: '1000000',
          routerOrigin: 'http://localhost:3939',
        },
      },
    }),
  );
  expect(await modelSettings(data, repo)).toBeNull();
  await writeFile(join(data, 'config.json'), JSON.stringify({ router: { subagents: true } }));
  expect(await modelSettings(data, repo)).toBeNull();
});
it('keeps the actual cwd beneath an explicitly selected workspace and lets a project revoke access immediately', async () => {
  const { data, repo } = await fixture({});
  await writeFile(
    join(data, 'config.json'),
    JSON.stringify({
      router: {
        subagents: true,
        subagentConsent: {
          version: 2,
          instructions: 'applicable',
          recipients: ['Tenjin', 'DeepSeek'],
          repositories: [repo],
          maxJobAtomic: '1000000',
          routerOrigin: 'http://localhost:3939',
        },
      },
    }),
  );
  const nested = join(repo, 'nested');
  await mkdir(nested);
  expect(await modelSettings(data, nested)).toMatchObject({
    root: nested,
    repositories: [repo],
    maxJobAtomic: 1000000n,
  });
  expect(await modelSettings(data, dir)).toBeNull();
  const sibling = `${repo}-other`;
  await mkdir(sibling);
  expect(await modelSettings(data, sibling)).toBeNull();
  await mkdir(join(repo, '.tenjin'));
  await writeFile(
    join(repo, '.tenjin', 'config.json'),
    JSON.stringify({ router: { subagents: false } }),
  );
  expect(await modelSettings(data, repo)).toBeNull();
  expect(await modelSettings(data, nested)).toBeNull();
});
