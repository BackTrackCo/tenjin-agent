import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CliError } from '../lib/errors';
import { sourceVaultPath } from '../lib/paths';
import { testCtx } from '../context-test-utils';
import { runConfigNames, type NameGroup } from './config-names';

/**
 * `tenjin config names` (the list an agent reads before it writes a rule):
 * every name a rule can use, by kind, with the id to type after its flag. It
 * reads the same identities the rules resolve against, live first, then the
 * copy the last read kept.
 */

const IDENTITIES = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../router/fixtures/wire-identities.json', import.meta.url)),
    'utf8',
  ),
) as Record<string, unknown> & { sources: { id: string; label: string }[] };
const WITH_FAL = { ...IDENTITIES, sources: [...IDENTITIES.sources, { id: 'fal', label: 'fal' }] };

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'config-names-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const ctx = () => testCtx(dir, { baseUrl: 'https://tenjin.sh' });
const online = {
  fetchImpl: (async () =>
    new Response(JSON.stringify(WITH_FAL), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as typeof fetch,
};
const offline = {
  fetchImpl: (async () => {
    throw new TypeError('fetch failed');
  }) as typeof fetch,
};

const groupsOf = (result: { data: unknown }) => (result.data as { groups: NameGroup[] }).groups;
const ids = (groups: NameGroup[]) =>
  Object.fromEntries(groups.map(({ kind, names }) => [kind, names.map(({ id }) => id)]));

describe('tenjin config names', () => {
  it('lists every name by kind with its flag, tasks under their categories', async () => {
    const result = await runConfigNames({}, ctx(), online);
    const groups = groupsOf(result);
    expect(groups.map(({ kind, flag }) => [kind, flag])).toEqual([
      ['task', '--task'],
      ['category', '--category'],
      ['provider', '--provider'],
      ['seller', '--seller'],
      ['service', '--service'],
      ['source', '--source'],
    ]);
    expect(groups[0]!.names).toContainEqual({
      id: 'general image',
      label: 'General image',
      category: 'images',
    });
    expect(ids(groups).source).toEqual(['tenjin', 'fal']);
    // At a terminal a task sits under its category's heading, its id beside it.
    const lines = result.humanLines ?? [];
    const heading = lines.indexOf('  Images');
    expect(heading).toBeGreaterThan(-1);
    expect(lines[heading + 1]).toMatch(/^ {4}General image +general image$/);
  });

  it('filters by a word across names and ids, setting aside spacing and a typo', async () => {
    const coin = ids(groupsOf(await runConfigNames({ search: 'coin market' }, ctx(), online)));
    expect(coin).toEqual({ provider: ['coinmarketcap'], service: ['cmc-quotes'] });
    const typo = ids(groupsOf(await runConfigNames({ search: 'exa serch' }, ctx(), online)));
    expect(typo.service).toContain('exa-search');
    const none = await runConfigNames({ search: 'zzzq' }, ctx(), online);
    expect(groupsOf(none)).toEqual([]);
    expect(none.humanLines?.[0]).toBe('No name matches "zzzq".');
  });

  it('keeps one kind, an account being the --source kind, and marks one connected here', async () => {
    await writeFile(
      join(dir, 'config.json'),
      JSON.stringify({
        router: {
          sources: [
            {
              id: 'fal',
              label: 'fal',
              mcpUrl: 'https://mcp.fal.ai/mcp-relay',
              signIn: 'key',
              mapped: true,
            },
          ],
        },
      }),
    );
    await mkdir(join(dir, 'sources'), { recursive: true });
    await writeFile(sourceVaultPath('fal', dir), '{}');
    const result = await runConfigNames({ kind: 'accounts' }, ctx(), online);
    expect(result.data).toMatchObject({ kind: 'source', live: true, total: 2 });
    expect(groupsOf(result)).toEqual([
      {
        kind: 'source',
        flag: '--source',
        names: [
          { id: 'tenjin', label: "Tenjin's tools" },
          { id: 'fal', label: 'fal', connected: true },
        ],
      },
    ]);
    const err = await runConfigNames({ kind: 'acount' }, ctx(), online).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).code).toBe('USAGE');
    expect((err as CliError).fix).toBe('tenjin config names --kind account');
  });

  it('answers from the names saved last time when the router does not answer, and says so', async () => {
    const none = await runConfigNames({}, ctx(), offline).catch((e: unknown) => e);
    expect(none).toBeInstanceOf(CliError);
    expect((none as CliError).message).toContain("couldn't look up the names right now");
    await runConfigNames({}, ctx(), online);
    const saved = await runConfigNames({ search: 'exa' }, ctx(), offline);
    expect(saved.data).toMatchObject({ live: false, reason: expect.any(String) });
    expect(ids(groupsOf(saved)).provider).toEqual(['exa']);
    expect(saved.humanLines?.at(-1)).toContain('the names it saved last time');
  });
});
