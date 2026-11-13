import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { modelSettings } from './model-settings';
let dir: string;
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});
async function fixture(router: Record<string, unknown>) {
  dir = await mkdtemp(join(tmpdir(), 'model-consent-'));
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
  await writeFile(join(data, 'config.json'), JSON.stringify({ router: { subagents: true } }));
  expect(await modelSettings(data, repo)).toBeNull();
});
it('requires the exact consented root and lets a project revoke access immediately', async () => {
  const { data, repo } = await fixture({});
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
  expect(await modelSettings(data, repo)).toMatchObject({ maxJobAtomic: 1000000n });
  await mkdir(join(repo, '.tenjin'));
  await writeFile(
    join(repo, '.tenjin', 'config.json'),
    JSON.stringify({ router: { subagents: false } }),
  );
  expect(await modelSettings(data, repo)).toBeNull();
});
