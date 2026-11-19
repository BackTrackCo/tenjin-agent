import { mkdtemp, mkdir, realpath, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { modelConsent, modelSettings } from './model-settings';
let dir: string;
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});
const ORIGIN = 'http://localhost:3939';
async function fixture(router: Record<string, unknown>, limits: Record<string, string> = {}) {
  dir = await realpath(await mkdtemp(join(tmpdir(), 'model-consent-')));
  const data = join(dir, 'data'),
    repo = join(dir, 'repo');
  await mkdir(data);
  await mkdir(repo);
  await mkdir(join(repo, '.git'));
  await writeFile(join(data, 'config.json'), JSON.stringify({ ...limits, router }));
  return { data, repo };
}
const save = (data: string, router: Record<string, unknown>, limits = {}) =>
  writeFile(join(data, 'config.json'), JSON.stringify({ ...limits, router }));

it('the one consent covers a session in any directory and saves no directory grant', async () => {
  const consent = modelConsent({ routerOrigin: ORIGIN });
  expect(consent).toEqual({
    version: 2,
    instructions: 'applicable',
    reads: 'claude-home',
    recipients: ['Tenjin', 'DeepSeek', 'Exa'],
    routerOrigin: ORIGIN,
  });
  const { data, repo } = await fixture({ subagents: true, subagentConsent: consent });
  const other = join(dir, 'other');
  await mkdir(other);
  for (const root of [repo, other])
    expect(await modelSettings(data, root)).toEqual({
      version: 2,
      root,
      repositories: [],
      maxJobAtomic: 1000000n,
      routerOrigin: ORIGIN,
      context: 'session',
    });
});

it.each([
  { instructions: undefined },
  { reads: undefined },
  { recipients: ['Tenjin', 'DeepSeek'] },
  { routerOrigin: 'not a url' },
  { version: 1 },
  { repositories: [] },
  { maxJobAtomic: 'not-an-amount' },
])('refuses an incomplete or malformed consent %j', async (change) => {
  const { data, repo } = await fixture({
    subagents: true,
    subagentConsent: { ...modelConsent({ routerOrigin: ORIGIN }), ...change },
  });
  expect(await modelSettings(data, repo)).toBeNull();
});

// Review of b7974566: `on --repository` wrote a second kind of consent that replaced the
// install's and covered only the named directories.
it('a named directory is an addition: a session inside one gets every named one, and a session elsewhere still qualifies', async () => {
  const { data, repo } = await fixture({});
  const sibling = join(dir, 'sibling');
  const elsewhere = join(dir, 'elsewhere');
  const nested = join(repo, 'nested');
  for (const path of [sibling, elsewhere, nested]) await mkdir(path);
  const first = modelConsent({ routerOrigin: ORIGIN, repository: repo });
  // A second turn-on keeps the first directory; one at another router does not.
  const both = modelConsent({ routerOrigin: ORIGIN, prior: first, repository: sibling });
  expect(both.repositories).toEqual([repo, sibling]);
  expect(modelConsent({ routerOrigin: 'https://other.example', prior: first })).not.toHaveProperty(
    'repositories',
  );
  await save(data, { subagents: true, subagentConsent: both });
  expect(await modelSettings(data, nested)).toMatchObject({
    root: nested,
    repositories: [repo, sibling],
  });
  expect(await modelSettings(data, elsewhere)).toMatchObject({
    root: elsewhere,
    repositories: [],
  });
  // A longer sibling name is not inside the named directory.
  const lookalike = `${repo}-other`;
  await mkdir(lookalike);
  expect(await modelSettings(data, lookalike)).toMatchObject({ repositories: [] });
});

it('a repository cannot grant consent, and a global or project stop is immediate', async () => {
  const consent = modelConsent({ routerOrigin: ORIGIN });
  const { data, repo } = await fixture({});
  await mkdir(join(repo, '.tenjin'));
  const project = join(repo, '.tenjin', 'config.json');
  await writeFile(
    project,
    JSON.stringify({ router: { subagents: true, subagentConsent: consent } }),
  );
  expect(await modelSettings(data, repo)).toBeNull();
  await save(data, { subagents: false, subagentConsent: consent });
  expect(await modelSettings(data, repo)).toBeNull();
  await save(data, { subagents: true, subagentConsent: consent });
  expect(await modelSettings(data, repo)).not.toBeNull();
  await writeFile(project, JSON.stringify({ router: { subagents: false } }));
  expect(await modelSettings(data, repo)).toBeNull();
});

// A job is one call to the person. The cap was the consent's own amount, $1 from install,
// whatever the per-call limit said: a $0.25 limit still let a job spend $1.
it.each([
  // [the per-call limit, the ceiling named with --max-job, the cap]
  ['250000', undefined, 250000n],
  ['4000000', undefined, 4000000n],
  ['0', undefined, 0n],
  // A named ceiling lowers the cap and never lifts it.
  ['4000000', '1000000', 1000000n],
  ['250000', '1000000', 250000n],
] as const)(
  'a job cap is the per-call limit %s, under a named ceiling of %s: %s',
  async (maxAutoSpend, maxJobAtomic, cap) => {
    const consent = modelConsent({
      routerOrigin: ORIGIN,
      ...(maxJobAtomic === undefined ? {} : { maxJobAtomic }),
    });
    const { data, repo } = await fixture(
      { subagents: true, subagentConsent: consent },
      { maxAutoSpend },
    );
    expect(await modelSettings(data, repo)).toMatchObject({ maxJobAtomic: cap });
  },
);

it('a turn-on without --max-job drops a ceiling named earlier', async () => {
  const named = modelConsent({ routerOrigin: ORIGIN, maxJobAtomic: '500000' });
  expect(modelConsent({ routerOrigin: ORIGIN, prior: named })).not.toHaveProperty('maxJobAtomic');
});

it('does not turn legacy tier routing or a boolean into inference/data consent', async () => {
  const { data, repo } = await fixture({ subagents: 'apply' });
  expect(await modelSettings(data, repo)).toBeNull();
  await save(data, { subagents: true });
  expect(await modelSettings(data, repo)).toBeNull();
});
