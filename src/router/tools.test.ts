import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CommandContext } from '../context';
import { directoryCachePath } from '../lib/paths';
import type { DirectoryListing } from './decision';
import { runTools } from './tools';

const directory = JSON.parse(
  readFileSync(new URL('./fixtures/wire-directory.json', import.meta.url), 'utf8'),
) as {
  schemaVersion: 1;
  routerVersion: string;
  directory: DirectoryListing;
};
let dir: string;
let cwd: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tenjin-tools-'));
  cwd = join(dir, 'project');
  await mkdir(join(cwd, '.git'), { recursive: true });
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const support = { supported: false, why: 'This host keeps getting ordinary offers.' };
function ctx(): CommandContext {
  const sink = () => ({ write: () => true }) as unknown as NodeJS.WritableStream;
  return {
    dataDir: dir,
    flags: { json: true, timeout: 100 },
    io: { stdout: sink(), stderr: sink(), isTTY: false },
  };
}
async function config(router: unknown) {
  await writeFile(join(dir, 'config.json'), JSON.stringify({ router }));
}
function network(listing = directory.directory) {
  const bodies: Record<string, unknown>[] = [];
  const fetchImpl: typeof fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    bodies.push(body);
    return Response.json({ ...directory, directory: listing });
  };
  return { fetchImpl, bodies };
}
const run = (filter = '', fetchImpl = network().fetchImpl) =>
  runTools({ filter }, ctx(), { cwd, fetchImpl, support });

describe('tool inspection', () => {
  it('keeps blocked tools visible beside enabled tools, with their real rule', async () => {
    await config({ policy: { version: 1, block: [{ kind: 'provider', id: 'exa' }] } });
    const { data } = await run();
    expect(data.catalog).toBe('current');
    expect(data.rows).toHaveLength(directory.directory.services.length);
    expect(data.rows.find(({ id }) => id === 'exa-search')).toMatchObject({
      state: 'disabled',
      reason: 'Blocked by your provider setting: Exa.',
    });
    expect(data.rows.find(({ id }) => id === 'stableenrich-exa-answer')?.state).toBe('disabled');
    expect(data.rows.find(({ id }) => id === 'cmc-quotes')?.state).toBe('enabled');
  });

  it('uses all upstream providers for only rules, and shows the restriction', async () => {
    await config({
      policy: {
        version: 1,
        only: [
          {
            scope: { kind: 'global' },
            dimension: 'provider',
            targets: [{ kind: 'provider', id: 'google' }],
          },
        ],
      },
    });
    const { data } = await run();
    expect(data.rows.find(({ id }) => id === 'aispace-nano-banana-2.1')).toMatchObject({
      state: 'disabled',
      reason: expect.stringContaining('only Google'),
    });
  });

  it('evaluates task scopes and category blocks without hiding their services', async () => {
    await config({
      policy: {
        version: 1,
        only: [
          {
            scope: { kind: 'task', id: 'web research' },
            dimension: 'service',
            targets: [{ kind: 'service', id: 'exa-search' }],
          },
        ],
        block: [{ kind: 'category', id: 'images' }],
      },
    });
    const { data } = await run();
    expect(data.rows.find(({ id }) => id === 'exa-search')?.state).toBe('enabled');
    expect(data.rows.find(({ id }) => id === 'stableenrich-exa-answer')?.state).toBe('disabled');
    expect(data.rows.find(({ id }) => id === 'cmc-quotes')?.state).toBe('enabled');
    expect(data.rows.find(({ id }) => id === 'aispace-nano-banana-2.1')).toMatchObject({
      state: 'disabled',
      reason: expect.stringContaining('Images'),
    });
  });

  it('keeps preferences and automatic use separate from enabled state', async () => {
    await config({
      policy: {
        version: 1,
        prefer: [
          {
            scope: { kind: 'task', id: 'web research' },
            targets: [{ kind: 'provider', id: 'exa' }],
          },
        ],
      },
    });
    const { data } = await run();
    expect(data.rows.every(({ state }) => state === 'enabled')).toBe(true);
    expect(data.header.join('\n')).toContain('Prefer Exa');
    expect(data.header.join('\n')).toContain("Run Tenjin's picks automatically: off");
  });

  it('shows a project pause and its scope while inspection still works', async () => {
    await mkdir(join(cwd, '.tenjin'));
    await writeFile(
      join(cwd, '.tenjin/config.json'),
      JSON.stringify({ router: { enabled: false } }),
    );
    const net = network();
    const { data } = await run('', net.fetchImpl);
    expect(data.enabled).toMatchObject({ value: false, source: 'project' });
    expect(data.rows.every(({ state }) => state === 'disabled')).toBe(true);
    expect(net.bodies).toEqual([{ schemaVersion: 1, directory: {} }]);
  });

  it('marks invalid personal settings disabled rather than implying all tools are enabled', async () => {
    await config({ policy: { version: 99 } });
    const { data } = await run();
    expect(
      data.rows.every(
        ({ state, reason }) => state === 'disabled' && reason.includes("can't be read"),
      ),
    ).toBe(true);
  });

  it('shows an unconnected source without treating its descriptor as a connection', async () => {
    const listing = structuredClone(directory.directory);
    listing.sources.push({ id: 'apify', label: 'Apify account' });
    listing.services[0]!.identity.source = 'apify';
    const { data } = await run('', network(listing).fetchImpl);
    expect(data.rows.find(({ id }) => id === 'exa-search')).toMatchObject({
      state: 'disabled',
      reason: 'Apify account is not connected on this machine.',
    });
  });

  it('keeps retired and unknown saved service targets visible', async () => {
    await config({ policy: { version: 1, block: [{ kind: 'service', id: 'old-search' }] } });
    const listing = structuredClone(directory.directory);
    listing.retired.push({ kind: 'service', id: 'retired-search', label: 'Retired search' });
    const { data } = await run('', network(listing).fetchImpl);
    expect(
      data.rows
        .filter(({ state }) => state === 'unavailable')
        .map(({ id }) => id)
        .sort(),
    ).toEqual(['old-search', 'retired-search']);
  });

  it('rereads a block saved during a directory request and never sends the filter', async () => {
    const net = network();
    const fetchImpl: typeof fetch = async (...args) => {
      await config({ policy: { version: 1, block: [{ kind: 'provider', id: 'exa' }] } });
      return net.fetchImpl(...args);
    };
    const { data } = await run('Exa search', fetchImpl);
    expect(data.rows).toHaveLength(1);
    expect(data.rows.every(({ state }) => state === 'disabled')).toBe(true);
    expect(net.bodies).toEqual([{ schemaVersion: 1, directory: {} }]);
    expect(JSON.stringify(net.bodies)).not.toContain('Exa');
  });

  it('marks cached results unverified offline and never overwrites config', async () => {
    await config({ enabled: true });
    await run();
    const before = await readFile(join(dir, 'config.json'), 'utf8');
    const { data, humanLines } = await run('', async () => {
      throw new TypeError('offline');
    });
    expect(data.catalog).toBe('cached');
    expect(data.rows.every(({ state }) => state === 'unverified')).toBe(true);
    expect(humanLines?.join('\n')).toContain('Cached catalog');
    expect(await readFile(join(dir, 'config.json'), 'utf8')).toBe(before);
  });

  it('shows local readback without inventing tools when offline with no cache', async () => {
    const { data } = await run('', async () => Response.json({}, { status: 503 }));
    expect(data.catalog).toBe('unavailable');
    expect(data.rows).toEqual([]);
    expect(data.header.join('\n')).toContain('Limits:');
  });

  it('revalidates a held directory revision on each invocation', async () => {
    await run();
    const calls: unknown[] = [];
    const result = await run('', async (_url, init) => {
      calls.push(JSON.parse(String(init?.body)));
      return Response.json({
        ...directory,
        directory: { revision: directory.directory.revision, unchanged: true },
      });
    });
    expect(calls).toEqual([
      { schemaVersion: 1, directory: { ifRevision: directory.directory.revision } },
    ]);
    expect(result.data.catalog).toBe('current');
    expect(JSON.parse(await readFile(directoryCachePath(dir), 'utf8'))).toEqual(
      directory.directory,
    );
  });
});
