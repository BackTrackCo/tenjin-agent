import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CommandContext, CommandResult } from '../context';
import { CliError } from '../lib/errors';
import { directoryCachePath } from '../lib/paths';
import { acceptsFor, type DirectoryListing, type WirePolicy } from '../router/decision';
import { writeObservation, type RouterObservation } from '../router/router-observation';
import { routerSettings } from '../router/settings';
import { runConfigList, runConfigSet } from './config';
import {
  runConfigBlock,
  runConfigFallback,
  runConfigOnly,
  runConfigPrefer,
  runConfigReplacement,
  runConfigReset,
  runConfigUnblock,
  type ConfigRulesDeps,
} from './config-rules';

/**
 * THE OPERATIONS AN AGENT RUNS WHEN A USER CHANGES WHAT TENJIN MAY USE. Each
 * test runs against a real data dir and a stubbed router that answers the
 * shared directory fixture, so a name resolves exactly as it would against
 * the server's catalog, and every assertion reads the file the operation left.
 */

const fixtures = new URL('../router/fixtures/', import.meta.url);
const fixture = <T>(name: string): T =>
  JSON.parse(readFileSync(new URL(name, fixtures), 'utf8')) as T;
const DIRECTORY = fixture<{ schemaVersion: 1; routerVersion: string; directory: DirectoryListing }>(
  'wire-directory.json',
);
/** The same directory with the accounts `tenjin connect` can connect. */
const MCP_DIRECTORY = fixture<{ directory: DirectoryListing }>('wire-directory-mcp.json').directory;

let dir: string;
let work: string;
let prevCwd: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tenjin-rules-'));
  work = join(dir, 'work');
  await mkdir(join(work, '.git'), { recursive: true });
  prevCwd = process.cwd();
  process.chdir(work);
});
afterEach(async () => {
  process.chdir(prevCwd);
  await rm(dir, { recursive: true, force: true });
});

function makeCtx(): CommandContext {
  const sink = () => ({ write: () => true }) as unknown as NodeJS.WritableStream;
  return {
    flags: { json: false, timeout: 10000 },
    dataDir: dir,
    io: { stdout: sink(), stderr: sink(), isTTY: false },
  };
}

interface Router extends Required<Pick<ConfigRulesDeps, 'fetchImpl'>> {
  bodies: unknown[];
}

/** The router as far as settings see it: the directory, and nothing else. */
function router(listing: DirectoryListing = DIRECTORY.directory): Router {
  const bodies: unknown[] = [];
  const fetchImpl = (async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { directory?: { ifRevision?: string } };
    bodies.push(body);
    if (body.directory === undefined) throw new Error('settings asked the router something else');
    const answer =
      body.directory.ifRevision === listing.revision
        ? { revision: listing.revision, unchanged: true }
        : listing;
    return new Response(JSON.stringify({ ...DIRECTORY, directory: answer }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  return { fetchImpl, bodies };
}

/** A router that cannot be reached: every operation that needs it must fail
 *  closed, and every one that does not must never ask it. */
function offline(): Router {
  const bodies: unknown[] = [];
  const fetchImpl = (async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    throw new TypeError('fetch failed');
  }) as typeof fetch;
  return { fetchImpl, bodies };
}

const configFile = () => join(dir, 'config.json');
const readFileJson = async (): Promise<Record<string, unknown> | undefined> => {
  try {
    return JSON.parse(await readFile(configFile(), 'utf8')) as Record<string, unknown>;
  } catch {
    return undefined;
  }
};
const savedPolicy = async () =>
  ((await readFileJson())?.router as { policy?: unknown } | undefined)?.policy;
const settings = () => routerSettings({ cwd: work, dataDir: dir });
const lines = (result: CommandResult) => (result.humanLines ?? []).join('\n');
const data = (result: CommandResult) => result.data as Record<string, unknown>;

async function caught(fn: () => Promise<unknown>): Promise<CliError> {
  try {
    await fn();
  } catch (e) {
    if (e instanceof CliError) return e;
    throw e;
  }
  throw new Error('expected the call to throw');
}

const exaFirst = {
  scope: { kind: 'task', id: 'web research' },
  targets: [{ kind: 'provider', id: 'exa' }],
};

describe('prefer', () => {
  it('saves a task preference by name and reads it back in the user words', async () => {
    const net = router();
    const result = await runConfigPrefer(
      { task: ['web research'], provider: ['Exa'] },
      makeCtx(),
      net,
    );
    expect(await savedPolicy()).toEqual({ version: 1, prefer: [exaFirst] });
    expect(lines(result)).toContain(
      'Saved on this machine (not synced): Prefer Exa when Tenjin handles web research. Other allowed services remain available if Exa can',
    );
    expect(lines(result)).toContain(
      "Run Tenjin's picks automatically is off, and this doesn't turn it on.",
    );
    expect(lines(result)).toContain(
      'To undo: `tenjin config reset --task "web research" --preference`',
    );
    expect(data(result)).toMatchObject({
      operation: 'prefer',
      changed: true,
      scope: 'user',
      saved: 'Saved on this machine; not synced.',
      reset: 'tenjin config reset --task "web research" --preference',
    });
    // One free directory call, nothing else asked.
    expect(net.bodies).toEqual([{ schemaVersion: 1, directory: {}, accepts: acceptsFor(false) }]);
  });

  it('replaces the list at its scope and leaves every other rule alone', async () => {
    const net = router();
    await runConfigBlock({ provider: ['firecrawl'] }, makeCtx(), net);
    await runConfigPrefer({ task: ['web research'], provider: ['exa'] }, makeCtx(), net);
    await runConfigPrefer({ source: ['tenjin'] }, makeCtx(), net);
    const result = await runConfigPrefer(
      { task: ['web research'], service: ['Exa Answer', 'exa-search'] },
      makeCtx(),
      net,
    );
    expect(await savedPolicy()).toEqual({
      version: 1,
      block: [{ kind: 'provider', id: 'firecrawl' }],
      prefer: [
        {
          scope: { kind: 'task', id: 'web research' },
          targets: [
            { kind: 'service', id: 'stableenrich-exa-answer' },
            { kind: 'service', id: 'exa-search' },
          ],
        },
        { scope: { kind: 'global' }, targets: [{ kind: 'source', id: 'tenjin' }] },
      ],
    });
    expect(data(result).removed).toEqual([exaFirst]);
    // The second fetch sent the copy's revision and was answered unchanged.
    expect(net.bodies.at(-1)).toEqual({
      schemaVersion: 1,
      directory: { ifRevision: DIRECTORY.directory.revision },
      accepts: acceptsFor(false),
    });
  });

  it('refuses a shape it cannot save before asking the router anything', async () => {
    const net = router();
    for (const flags of [
      { provider: ['exa'] },
      { task: ['web research'] },
      { task: ['web research'], provider: ['exa'], service: ['exa-search'] },
      { task: ['web research'], category: ['images'] },
      { task: ['web research', 'computation'], provider: ['exa'] },
      { global: true, task: ['web research'], source: ['tenjin'] },
    ]) {
      expect((await caught(() => runConfigPrefer(flags, makeCtx(), net))).code).toBe('USAGE');
    }
    expect(net.bodies).toEqual([]);
    expect(await readFileJson()).toBeUndefined();
  });

  it('refuses a blocked target, and a service a block covers, and writes nothing', async () => {
    const net = router();
    await runConfigBlock({ provider: ['exa'] }, makeCtx(), net);
    const before = await readFileJson();
    const err = await caught(() =>
      runConfigPrefer({ task: ['web research'], provider: ['exa'] }, makeCtx(), net),
    );
    expect(err.code).toBe('REFUSED');
    expect(err.message).toBe(
      "Exa is blocked in your settings, so it can't be chosen here. Nothing was saved.",
    );
    const covered = await caught(() =>
      runConfigPrefer({ task: ['web research'], service: ['Exa Answer'] }, makeCtx(), net),
    );
    expect(covered.message).toContain('Exa Answer is covered by your block on Exa');
    expect(await readFileJson()).toEqual(before);
  });
});

describe('name resolution', () => {
  it('refuses an unknown name with candidates, and writes nothing', async () => {
    const err = await caught(() =>
      runConfigPrefer({ task: ['web research'], service: ['exa'] }, makeCtx(), router()),
    );
    expect(err.code).toBe('USAGE');
    expect(err.message).toBe('Tenjin has no service named "exa". Nothing was saved.');
    expect(
      (err.details as { candidates: { id: string }[] }).candidates.map(({ id }) => id),
    ).toEqual(['exa-search', 'exa-contents', 'stableenrich-exa-answer']);
    expect(await readFileJson()).toBeUndefined();
  });

  it('refuses an ambiguous label, naming each id it could be', async () => {
    const twin = { id: 'exa-labs', label: 'exa' };
    const listing = { ...DIRECTORY.directory, providers: [...DIRECTORY.directory.providers, twin] };
    const err = await caught(() =>
      runConfigBlock({ provider: ['EXA '] }, makeCtx(), router(listing)),
    );
    expect(err.code).toBe('USAGE');
    expect(err.message).toBe(
      '"EXA" matches more than one provider: Exa (exa), exa (exa-labs). Nothing was saved.',
    );
    expect(await readFileJson()).toBeUndefined();
  });

  it('prefers an exact id over a label, and refuses a retired name', async () => {
    const listing = {
      ...DIRECTORY.directory,
      providers: [...DIRECTORY.directory.providers, { id: 'exa2', label: 'exa' }],
      retired: [{ kind: 'provider' as const, id: 'tavily', label: 'Tavily' }],
    };
    await runConfigBlock({ provider: ['exa'] }, makeCtx(), router(listing));
    expect(await savedPolicy()).toEqual({ version: 1, block: [{ kind: 'provider', id: 'exa' }] });
    const err = await caught(() =>
      runConfigBlock({ provider: ['Tavily'] }, makeCtx(), router(listing)),
    );
    expect(err.message).toBe('Tavily is no longer available through Tenjin, so nothing was saved.');
  });

  it('saves nothing when the router cannot be reached', async () => {
    const err = await caught(() =>
      runConfigBlock({ provider: ['firecrawl'] }, makeCtx(), offline()),
    );
    expect(['API_UNREACHABLE', 'NETWORK_ERROR']).toContain(err.code);
    expect(err.message).toContain(
      "Tenjin couldn't look up those names right now, so nothing was saved.",
    );
    expect(await readFileJson()).toBeUndefined();
  });
});

describe('only', () => {
  it('limits who does one task, and replaces that set when repeated', async () => {
    const net = router();
    const first = await runConfigOnly(
      { task: ['web research'], provider: ['exa'] },
      makeCtx(),
      net,
    );
    expect(lines(first)).toContain(
      "When Tenjin handles web research, it can use only Exa. If it can't meet a request, Tenjin explains rather than use another provider. Other tasks are unaffected.",
    );
    await runConfigOnly(
      { task: ['web research'], seller: ['StableEnrich', 'exa'] },
      makeCtx(),
      net,
    );
    await runConfigOnly({ task: ['web research'], provider: ['exa', 'Firecrawl'] }, makeCtx(), net);
    expect(await savedPolicy()).toEqual({
      version: 1,
      only: [
        {
          scope: { kind: 'task', id: 'web research' },
          dimension: 'provider',
          targets: [
            { kind: 'provider', id: 'exa' },
            { kind: 'provider', id: 'firecrawl' },
          ],
        },
        {
          scope: { kind: 'task', id: 'web research' },
          dimension: 'seller',
          targets: [
            { kind: 'seller', id: 'stableenrich' },
            { kind: 'seller', id: 'exa' },
          ],
        },
      ],
    });
  });

  it('limits which tasks Tenjin does anywhere, naming the tasks a category covers', async () => {
    const result = await runConfigOnly(
      { global: true, category: ['Images'], task: ['web research'] },
      makeCtx(),
      router(),
    );
    const text = lines(result);
    expect(text).toContain(
      'Tenjin may handle Images and web research only, including services added there later.',
    );
    expect(text).toContain('photoreal image');
    expect(text).not.toContain('image text extraction');
    expect(text).toContain('To undo: `tenjin config reset --global --capabilities`');
  });

  it('says a provider rule leaves out a route that also runs through another party', async () => {
    const result = await runConfigOnly({ global: true, provider: ['google'] }, makeCtx(), router());
    expect(lines(result)).toContain(
      'Left out: Google Nano Banana 2.1, which also runs through Venice.',
    );
  });

  it('refuses a shape it cannot save', async () => {
    const net = router();
    for (const flags of [
      { source: ['tenjin'] },
      { global: true, category: ['images'], provider: ['exa'] },
      { global: true, provider: ['exa'], seller: ['exa'] },
      { category: ['images'] },
      { task: ['web research'] },
      { provider: ['exa'] },
      { task: ['a', 'b'], provider: ['exa'] },
    ]) {
      expect((await caught(() => runConfigOnly(flags, makeCtx(), net))).code).toBe('USAGE');
    }
    expect(net.bodies).toEqual([]);
  });

  it('refuses a task its category block covers', async () => {
    const net = router();
    await runConfigBlock({ category: ['images'] }, makeCtx(), net);
    const err = await caught(() =>
      runConfigOnly({ global: true, task: ['photoreal image'] }, makeCtx(), net),
    );
    expect(err.message).toBe(
      "photoreal image is covered by your block on Images, so it can't be chosen here. Nothing was saved.",
    );
  });
});

describe('block and unblock', () => {
  it('blocks a provider with its reseller routes, and says what that covers', async () => {
    const result = await runConfigBlock({ provider: ['Firecrawl'] }, makeCtx(), router());
    expect(await savedPolicy()).toEqual({
      version: 1,
      block: [{ kind: 'provider', id: 'firecrawl' }],
    });
    expect(lines(result)).toContain(
      'Saved on this machine (not synced): Firecrawl is blocked, including reviewed reseller routes identified as using it. Covers Firecrawl page read.',
    );
    expect(lines(result)).toContain(
      "A service whose upstream Tenjin can't verify is treated as blocked too.",
    );
    expect(data(result)).toMatchObject({
      changed: true,
      added: [{ kind: 'provider', id: 'firecrawl' }],
    });
    const again = await runConfigBlock({ provider: ['firecrawl'] }, makeCtx(), router());
    expect(data(again).changed).toBe(false);
    expect(lines(again)).toContain('Firecrawl was already blocked.');
  });

  it("blocks Tenjin's own tools and says the routing fee still uses the balance", async () => {
    const result = await runConfigBlock({ source: ['tenjin'] }, makeCtx(), router());
    expect(lines(result)).toContain(
      "Tenjin's tools are blocked, saved and direct calls included. Tenjin's routing fee can still use your balance, within your limits.",
    );
  });

  it('wins over a preference it makes unusable, which stays saved and is marked', async () => {
    const net = router();
    await runConfigPrefer({ task: ['web research'], provider: ['exa'] }, makeCtx(), net);
    const result = await runConfigBlock({ provider: ['exa'] }, makeCtx(), net);
    expect(lines(result)).toContain(
      'This leaves a saved rule unusable, kept as it is: Prefer Exa when Tenjin handles web research.',
    );
    expect(lines(result)).toContain('(inactive: Exa is blocked)');
    expect(await savedPolicy()).toEqual({
      version: 1,
      block: [{ kind: 'provider', id: 'exa' }],
      prefer: [exaFirst],
    });
  });

  it('unblocks by id, any case, or the name last fetched, with no network', async () => {
    await runConfigBlock(
      { provider: ['firecrawl'], service: ['exa-contents'], task: ['crypto price quote'] },
      makeCtx(),
      router(),
    );
    const net = offline();
    const result = await runConfigUnblock(
      { provider: ['FIRECRAWL'], service: ['Exa page read'] },
      makeCtx(),
      net,
    );
    expect(net.bodies).toEqual([]);
    expect(await savedPolicy()).toEqual({
      version: 1,
      block: [{ kind: 'task', id: 'crypto price quote' }],
    });
    expect(lines(result)).toContain(
      'Saved on this machine (not synced): Firecrawl and Exa page read are no longer blocked.',
    );
    expect(data(result).reset).toBe(
      'tenjin config block --provider firecrawl --service exa-contents',
    );
    const none = await runConfigUnblock({ provider: ['exa'] }, makeCtx(), net);
    expect(data(none).changed).toBe(false);
    expect(lines(none)).toContain(
      'Nothing saved blocks a provider named "exa", so nothing changed for it.',
    );
    expect(lines(none)).toContain('Saved blocks: crypto price quote.');
  });

  it('drops router.policy once the last rule is gone', async () => {
    await runConfigBlock({ provider: ['firecrawl'] }, makeCtx(), router());
    await runConfigUnblock({ provider: ['firecrawl'] }, makeCtx(), offline());
    expect(await readFileJson()).toEqual({ router: {} });
  });
});

describe('reset', () => {
  async function seed(): Promise<void> {
    const net = router();
    await runConfigBlock({ provider: ['firecrawl'] }, makeCtx(), net);
    await runConfigPrefer({ task: ['web research'], provider: ['exa'] }, makeCtx(), net);
    await runConfigPrefer({ source: ['tenjin'] }, makeCtx(), net);
    await runConfigOnly({ task: ['web research'], provider: ['exa'] }, makeCtx(), net);
    await runConfigOnly({ task: ['web research'], seller: ['exa'] }, makeCtx(), net);
    await runConfigOnly({ global: true, category: ['lookups'] }, makeCtx(), net);
  }
  const policy = async () => (await savedPolicy()) as Required<WirePolicy>;

  it('removes a task preference and nothing else, offline', async () => {
    await seed();
    const net = offline();
    const result = await runConfigReset(
      { task: ['Web Research'], preference: true },
      makeCtx(),
      net,
    );
    expect(net.bodies).toEqual([]);
    const after = await policy();
    expect(after.prefer).toEqual([
      { scope: { kind: 'global' }, targets: [{ kind: 'source', id: 'tenjin' }] },
    ]);
    expect(after.block).toHaveLength(1);
    expect(after.only).toHaveLength(3);
    expect(lines(result)).toContain(
      'Saved on this machine (not synced): removed your preference for web research. Your blocks, limits and other rules stay as they are.',
    );
    expect(data(result).reset).toBe('tenjin config prefer --task "web research" --provider exa');
  });

  it('removes one account from the account-wide order, and the entry once it is empty', async () => {
    await seed();
    await runConfigReset({ source: ['tenjin'], preference: true }, makeCtx(), offline());
    expect((await policy()).prefer).toEqual([exaFirst]);
  });

  it('removes one dimension of a task restriction, then the rest of it', async () => {
    await seed();
    const one = await runConfigReset(
      { task: ['web research'], restriction: true, dimension: 'provider' },
      makeCtx(),
      offline(),
    );
    expect(data(one).reset).toBe('tenjin config only --task "web research" --provider exa');
    expect((await policy()).only.map(({ dimension }) => dimension)).toEqual([
      'seller',
      'capability',
    ]);
    await runConfigReset({ task: ['web research'], restriction: true }, makeCtx(), offline());
    expect((await policy()).only.map(({ dimension }) => dimension)).toEqual(['capability']);
    const result = await runConfigReset({ global: true, capabilities: true }, makeCtx(), offline());
    expect(lines(result)).toContain('removed the limit on which tasks Tenjin does.');
    const after = await policy();
    expect(after).not.toHaveProperty('only');
    expect(after.block).toHaveLength(1);
  });

  it('says when there is nothing to reset, and changes nothing', async () => {
    await seed();
    const before = await readFileJson();
    const result = await runConfigReset(
      { task: ['computation'], preference: true },
      makeCtx(),
      offline(),
    );
    expect(data(result).changed).toBe(false);
    expect(lines(result)).toContain(
      'There is no saved preference for computation to reset. Nothing changed.',
    );
    expect(await readFileJson()).toEqual(before);
  });

  it('says --all removed the blocks too, and leaves the spending limits', async () => {
    await seed();
    await runConfigSet({ key: 'maxAutoSpend', value: '0.5' }, makeCtx());
    const limit = (await readFileJson())?.maxAutoSpend;
    const result = await runConfigReset({ all: true }, makeCtx(), offline());
    expect(await savedPolicy()).toBeUndefined();
    expect((await readFileJson())?.maxAutoSpend).toBe(limit);
    expect(lines(result)).toContain(
      'Saved on this machine (not synced): removed every saved routing rule, including your blocks, restrictions and preferences, so anything you blocked can be used again. Your spending limits stay as they are.',
    );
    expect(lines(result)).not.toContain('Your blocks, limits and other rules stay as they are.');
  });

  it('writes no file at all when a fresh machine has nothing to reset or unblock', async () => {
    await runConfigReset({ all: true }, makeCtx(), offline());
    await runConfigUnblock({ provider: ['exa'] }, makeCtx(), offline());
    expect(await readFileJson()).toBeUndefined();
  });

  it('refuses a reset it cannot read as one rule', async () => {
    for (const flags of [
      {},
      { preference: true, restriction: true },
      { preference: true },
      { restriction: true },
      { restriction: true, dimension: 'colour', global: true },
      { all: true, task: ['web research'] },
      { capabilities: true, task: ['web research'] },
      { dimension: 'provider', preference: true, global: true },
    ]) {
      expect((await caught(() => runConfigReset(flags, makeCtx(), offline()))).code).toBe('USAGE');
    }
  });
});

describe('replacement', () => {
  const personal = async () => (await readFileJson())?.router as Record<string, unknown>;

  it('turns on for named providers in one write, and off keeps the choice', async () => {
    const on = await runConfigReplacement({ state: 'on', provider: ['Exa'] }, makeCtx(), router());
    expect(await personal()).toEqual({
      nativeReplacement: 'when-routed',
      nativeReplacementProviders: [{ kind: 'provider', id: 'exa' }],
    });
    const text = lines(on);
    expect(text).toContain(
      "Saved on this machine (not synced): Run Tenjin's picks automatically is on for Exa.",
    );
    expect(text).toContain(
      'Your limits still apply ($0.25 a call, $5.00 a day, Tenjin balance): a call over them is not run in place, it is offered as usual and asks first.',
    );
    // No running session to check: where it works, never that it is active.
    expect(text).toContain(
      'It works in Claude Code 2.1.287 or later with the Tenjin plugin; other agents keep getting ordinary offers.',
    );
    // No account connected: what one would do, and who pays for it.
    expect(text).toContain(
      'An account you connect with `tenjin connect` runs this way too within the same provider choice, for the jobs Tenjin has checked, and its own plan pays, not the Tenjin balance.',
    );
    expect(data(on)).toMatchObject({ replacement: { supported: false } });
    expect(data(on)).toMatchObject({ scope: 'machine', reset: 'tenjin config replacement off' });
    const off = await runConfigReplacement({ state: 'off' }, makeCtx(), offline());
    expect(await personal()).toEqual({
      nativeReplacement: 'off',
      nativeReplacementProviders: [{ kind: 'provider', id: 'exa' }],
    });
    expect(lines(off)).toContain(
      "Run Tenjin's picks automatically: off (its saved choice of Exa is kept for when it is turned on).",
    );
  });

  it("names the connected accounts it also runs, which bill their own plans, never one that isn't", async () => {
    // Apify connected here with a map; fal saved but not signed in on this
    // machine; an address with no map runs only when named.
    await writeFile(
      configFile(),
      JSON.stringify({
        router: {
          sources: [
            { id: 'apify', label: 'Apify', mcpUrl: 'https://mcp.apify.com', mapped: true },
            { id: 'fal', label: 'fal', mcpUrl: 'https://mcp.fal.ai/mcp-relay', mapped: true },
            {
              id: 'mcp-example-com',
              label: 'mcp.example.com',
              mcpUrl: 'https://mcp.example.com/mcp',
              signIn: 'key',
            },
          ],
        },
      }),
    );
    await mkdir(join(dir, 'sources'), { recursive: true });
    for (const id of ['apify', 'mcp-example-com'])
      await writeFile(join(dir, 'sources', `${id}.json`), '{}');
    const on = await runConfigReplacement(
      { state: 'on', allProviders: true },
      makeCtx(),
      offline(),
    );
    const text = lines(on);
    expect(text).toContain(
      "It also runs your Apify account this way, for the jobs Tenjin has checked: those calls bill your own plan, not the Tenjin balance, and don't count toward these limits.",
    );
    expect(text).not.toMatch(/\bfal\b|mcp\.example\.com|mcp-example-com/);
  });

  it('names only the connected accounts whose jobs fit the provider choice', async () => {
    // Apify, Firecrawl and fal connected with maps. fal's image job needs
    // Black Forest Labs too, so naming fal alone leaves it out.
    await writeFile(
      configFile(),
      JSON.stringify({
        router: {
          sources: [
            { id: 'apify', label: 'Apify', mcpUrl: 'https://mcp.apify.com', mapped: true },
            {
              id: 'firecrawl',
              label: 'Firecrawl',
              mcpUrl: 'https://mcp.firecrawl.dev/v2/mcp-oauth',
              mapped: true,
            },
            { id: 'fal', label: 'fal', mcpUrl: 'https://mcp.fal.ai/mcp-relay', mapped: true },
          ],
        },
      }),
    );
    await mkdir(join(dir, 'sources'), { recursive: true });
    for (const id of ['apify', 'firecrawl', 'fal'])
      await writeFile(join(dir, 'sources', `${id}.json`), '{}');
    const net = router(MCP_DIRECTORY);
    const firecrawl = lines(
      await runConfigReplacement({ state: 'on', provider: ['firecrawl', 'fal'] }, makeCtx(), net),
    );
    expect(firecrawl).toContain(
      "It also runs your Firecrawl account this way within the same provider choice, for the jobs Tenjin has checked: those calls bill your own plan, not the Tenjin balance, and don't count toward these limits.",
    );
    expect(firecrawl).not.toMatch(/\bApify\b/);
    // None fits: no account is named as running automatically.
    const google = lines(
      await runConfigReplacement({ state: 'on', provider: ['google'] }, makeCtx(), net),
    );
    expect(google).toContain(
      'An account you connect with `tenjin connect` runs this way too within the same provider choice, for the jobs Tenjin has checked, and its own plan pays, not the Tenjin balance.',
    );
    expect(google).not.toMatch(/\bApify\b|\bFirecrawl\b|\bfal\b/);
  });

  it('says it runs in place only where a running Claude Code with the plugin can', async () => {
    const seen = (o: Partial<RouterObservation>) =>
      writeObservation(dir, {
        version: 1,
        pid: process.pid,
        startedAt: 1,
        at: 2,
        cliVersion: 'test',
        harness: 'claude',
        launchedByPlugin: true,
        cwd: work,
        address: null,
        servedSession: true,
        env: { passphraseSet: false, keySet: false },
        sign: { status: 'ready' },
        ...o,
      });
    await seen({ client: { name: 'claude-code', version: '2.1.309' } });
    const on = await runConfigReplacement(
      { state: 'on', allProviders: true },
      makeCtx(),
      offline(),
    );
    expect(lines(on)).toContain(
      'Your Claude Code runs it in place of its own web search or page fetch.',
    );
    expect(data(on)).toMatchObject({ replacement: { supported: true } });
    // A rule saved while it is on says it holds for the calls run in place.
    const prefer = await runConfigPrefer(
      { task: ['web research'], provider: ['exa'] },
      makeCtx(),
      router(),
    );
    expect(lines(prefer)).toContain(
      "Run Tenjin's picks automatically is on, so this also holds for the searches and fetches Tenjin runs in place.",
    );
    // A host that cannot is named, and the switch is never called active there.
    await seen({ harness: 'codex', servedSession: false, client: undefined });
    const codex = await runConfigList(makeCtx());
    expect(lines(codex)).toContain("Codex can't run a pick in place of its own search or fetch");
    expect(data(codex)).toMatchObject({ settings: { replacement: { supported: false } } });
  });

  it('removes a saved provider choice for --all-providers, asking nothing', async () => {
    await runConfigReplacement({ state: 'on', provider: ['exa'] }, makeCtx(), router());
    const net = offline();
    await runConfigReplacement({ state: 'on', allProviders: true }, makeCtx(), net);
    expect(net.bodies).toEqual([]);
    expect(await personal()).toEqual({ nativeReplacement: 'when-routed' });
    const s = await settings();
    expect(s.nativeReplacement).toEqual({ mode: 'when-routed' });
  });

  it('needs a provider or --all-providers to turn on, and is out of reach of config set', async () => {
    for (const args of [
      { state: 'on' },
      { state: 'on', provider: ['exa'], allProviders: true },
      { state: 'off', allProviders: true },
      { state: 'maybe' },
    ]) {
      expect((await caught(() => runConfigReplacement(args, makeCtx(), offline()))).code).toBe(
        'USAGE',
      );
    }
    for (const key of [
      'router.nativeReplacement',
      'router.policy',
      'router.nativeReplacementProviders',
      'router.sources',
    ]) {
      const err = await caught(() => runConfigSet({ key, value: 'when-routed' }, makeCtx()));
      expect(err.code).toBe('USAGE');
      expect(err.message).toBe(`${key} changes only through its own operations`);
    }
    expect(await readFileJson()).toBeUndefined();
  });

  it('refuses a provider the user has blocked', async () => {
    const net = router();
    await runConfigBlock({ provider: ['firecrawl'] }, makeCtx(), net);
    const err = await caught(() =>
      runConfigReplacement({ state: 'on', provider: ['firecrawl'] }, makeCtx(), net),
    );
    expect(err.code).toBe('REFUSED');
    expect((await personal()).nativeReplacement).toBeUndefined();
  });
});

/**
 * WHAT HAPPENS WHEN ONE OF THE USER'S ACCOUNTS REFUSES A CALL (#37): stop and
 * offer Tenjin's own tool (the default), or run it in the account's place.
 * Saved on the account's own entry, offline, and read back with its undo.
 */
describe('fallback', () => {
  async function apifySaved(extra: Record<string, unknown> = {}): Promise<void> {
    await writeFile(
      configFile(),
      JSON.stringify({
        router: {
          sources: [
            {
              id: 'apify',
              label: 'Apify',
              mcpUrl: 'https://mcp.apify.com',
              signIn: 'oauth',
              ...extra,
            },
          ],
        },
      }),
    );
  }
  const saved = async () =>
    ((await readFileJson())?.router as { sources: Record<string, unknown>[] }).sources[0];

  it('runs Tenjin’s tool when the account refuses, by its name, offline, and undoes', async () => {
    await apifySaved();
    const net = offline();
    const on = await runConfigFallback({ state: 'on', source: ['Apify'] }, makeCtx(), {
      fetchImpl: net.fetchImpl,
    });
    expect(await saved()).toMatchObject({ id: 'apify', onRefusal: 'tenjin' });
    expect(data(on)).toMatchObject({
      operation: 'fallback',
      changed: true,
      scope: 'user',
      reset: 'tenjin config fallback off --source apify',
      account: { label: 'Apify', onRefusal: 'tenjin' },
    });
    expect(lines(on)).toContain(
      'when your Apify account refuses a call (its sign-in expired, or its plan or rate limit ran out), Tenjin runs its own tool for the same job instead.',
    );
    // "What have I changed?" names it, with its undo.
    const list = await runConfigList(makeCtx());
    expect(lines(list)).toContain(
      "When your Apify account refuses a call, Tenjin's own tool for that job runs in its place",
    );
    expect(lines(list)).toContain('Undo: `tenjin config fallback off --source apify`');
    const off = await runConfigFallback({ state: 'off', source: ['apify'] }, makeCtx(), {
      fetchImpl: net.fetchImpl,
    });
    expect(await saved()).not.toHaveProperty('onRefusal');
    expect(data(off)).toMatchObject({ changed: true, account: { onRefusal: 'ask' } });
    expect(net.bodies).toEqual([]);
  });

  it('names every connected account in "What have I changed?", with who pays and its undo', async () => {
    // Connected with --no-prefer, and by its address: no rule names either.
    await writeFile(
      configFile(),
      JSON.stringify({
        router: {
          sources: [
            { id: 'apify', label: 'Apify', mcpUrl: 'https://mcp.apify.com', signIn: 'oauth' },
            {
              id: 'mcp-example-com',
              label: 'mcp.example.com',
              mcpUrl: 'https://mcp.example.com/mcp',
              signIn: 'key',
            },
          ],
          policy: {
            version: 1,
            prefer: [{ scope: { kind: 'global' }, targets: [{ kind: 'source', id: 'apify' }] }],
          },
        },
      }),
    );
    const list = await runConfigList(makeCtx());
    expect(lines(list)).toContain(
      'Your Apify account, used first for the jobs it can do: its own plan pays, outside your limits on the Tenjin balance.',
    );
    expect(lines(list)).toContain('Disconnect: `tenjin disconnect apify`');
    expect(lines(list)).toContain(
      'Your mcp.example.com account: its own plan pays, outside your limits on the Tenjin balance.',
    );
    expect(lines(list)).toContain('Disconnect: `tenjin disconnect mcp-example-com`');
  });

  it('refuses an account that is not connected, and saves nothing', async () => {
    await apifySaved();
    const error = await caught(() =>
      runConfigFallback({ state: 'on', source: ['fal'] }, makeCtx(), offline()),
    );
    expect(error.code).toBe('USAGE');
    expect(error.message).toBe(
      '"fal" isn\'t one of your connected accounts, so nothing was saved.',
    );
    expect(await saved()).not.toHaveProperty('onRefusal');
  });
});

describe('the saved policy is the one the server reads', () => {
  /** The plan's own example, built by its four commands: the same rules the
   *  server's settings fixture carries, down to the revision. */
  it('builds the shared hook fixture policy from the plan example commands', async () => {
    const net = router();
    await runConfigPrefer({ task: ['web research'], provider: ['exa'] }, makeCtx(), net);
    await runConfigBlock({ provider: ['firecrawl'] }, makeCtx(), net);
    await runConfigOnly(
      { global: true, category: ['images'], task: ['web research'] },
      makeCtx(),
      net,
    );
    await runConfigReplacement({ state: 'on', provider: ['exa'] }, makeCtx(), net);
    const { policy } = fixture<{ policy: WirePolicy }>('wire-hook-request-policy.json');
    const s = await settings();
    expect(s.policy.status === 'ok' && JSON.stringify(s.policy.wire)).toBe(JSON.stringify(policy));
    // Replacement rides on the machine, never inside the policy sent.
    expect(JSON.stringify(s.policy)).not.toContain('nativeReplacement');
  });

  it('lands every change when two writers change unrelated rules at once', async () => {
    await Promise.all([
      runConfigPrefer({ task: ['web research'], provider: ['exa'] }, makeCtx(), router()),
      runConfigBlock({ provider: ['firecrawl'] }, makeCtx(), router()),
      runConfigOnly(
        { global: true, category: ['images'], task: ['web research'] },
        makeCtx(),
        router(),
      ),
      runConfigReplacement({ state: 'on', allProviders: true }, makeCtx(), router()),
      runConfigSet({ key: 'router.context', value: 'turn' }, makeCtx()),
    ]);
    const file = (await readFileJson()) as { router: Record<string, unknown> };
    expect(file.router.context).toBe('turn');
    expect(file.router.nativeReplacement).toBe('when-routed');
    const saved = file.router.policy as Required<WirePolicy>;
    expect(saved.prefer).toEqual([exaFirst]);
    expect(saved.block).toEqual([{ kind: 'provider', id: 'firecrawl' }]);
    expect(saved.only).toHaveLength(1);
  });
});

/**
 * A POLICY THIS BUILD CANNOT READ NEVER LOCKS THE USER OUT. Show, pause and
 * reset keep working with no network; only a change that adds or ranks
 * something waits for the rules to be readable again.
 */
describe('offline, with rules this build cannot read', () => {
  const broken = {
    router: {
      policy: {
        version: 1,
        block: [{ kind: 'provider', id: 'firecrawl' }],
        only: [
          {
            scope: { kind: 'global' },
            dimension: 'provider',
            targets: [{ kind: 'provider', id: 'exa' }],
          },
          {
            scope: { kind: 'global' },
            dimension: 'provider',
            targets: [{ kind: 'provider', id: 'firecrawl' }],
          },
        ],
      },
    },
  };

  beforeEach(async () => {
    await writeFile(configFile(), JSON.stringify(broken));
  });

  it('shows the settings with the problem and the way out', async () => {
    const { data: listed, humanLines } = await runConfigList(makeCtx());
    expect((listed as Record<string, unknown>).settings).toMatchObject({
      policy: { status: 'invalid' },
      reset: 'tenjin config reset --all',
    });
    expect((humanLines ?? []).join('\n')).toContain(
      "Your Tenjin settings can't be read, so Tenjin won't run services until they're fixed. router.policy.only: one only rule per scope and dimension.",
    );
  });

  it('pauses Tenjin, keeping the rules as they are, and says it is paused', async () => {
    await runConfigSet({ key: 'router.enabled', value: 'false' }, makeCtx());
    const file = (await readFileJson()) as { router: Record<string, unknown> };
    expect(file.router.enabled).toBe(false);
    expect(file.router.policy).toEqual(broken.router.policy);
    expect((await settings()).enabled.value).toBe(false);
    const { humanLines } = await runConfigList(makeCtx());
    expect((humanLines ?? []).join('\n')).toContain(
      'Tenjin is paused on this machine, so none of these apply until it is on again (router.enabled).',
    );
  });

  it('removes a rule from them, and clears them all', async () => {
    const net = offline();
    await runConfigUnblock({ provider: ['firecrawl'] }, makeCtx(), net);
    await runConfigReset(
      { global: true, restriction: true, dimension: 'provider' },
      makeCtx(),
      net,
    );
    expect(await savedPolicy()).toBeUndefined();
    expect(net.bodies).toEqual([]);
    await writeFile(
      configFile(),
      JSON.stringify({ router: { enabled: true, policy: 'not a policy' } }),
    );
    const result = await runConfigReset({ all: true }, makeCtx(), net);
    expect(await readFileJson()).toEqual({ router: { enabled: true } });
    expect(lines(result)).toContain('removed every saved routing rule');
    expect((await settings()).policy.status).toBe('none');
  });

  it('refuses to add a preference to them, and says how to clear them', async () => {
    const err = await caught(() =>
      runConfigPrefer({ task: ['web research'], provider: ['exa'] }, makeCtx(), router()),
    );
    expect(err.code).toBe('CONFIG_INVALID');
    expect(err.fix).toContain('tenjin config reset --all');
    expect(await readFileJson()).toEqual(broken);
  });
});

describe('the readback', () => {
  it('lists saved rules in the user words, with each undo, and no protocol terms', async () => {
    const net = router();
    await runConfigBlock({ provider: ['firecrawl'], source: ['tenjin'] }, makeCtx(), net);
    await runConfigPrefer({ task: ['web research'], provider: ['exa'] }, makeCtx(), net);
    const { humanLines, data: listed } = await runConfigList(makeCtx());
    const text = (humanLines ?? []).join('\n');
    const settingsPart = text.slice(text.indexOf('Your settings'));
    expect(settingsPart).toContain('Undo: `tenjin config unblock --provider firecrawl`');
    expect(settingsPart).toContain('Limits: $0.25 a call, $5.00 a day (Tenjin balance).');
    // Which build enforces them: one from before settings ignores them.
    expect(settingsPart).toMatch(
      /Enforced by this Tenjin \([^)]+\); a version from before these settings ignores them\./,
    );
    expect(settingsPart).not.toMatch(/wallet|x402|USDC|\bJev\b/i);
    const rules = (listed as { settings: { rules: { kind: string; reset: string }[] } }).settings
      .rules;
    expect(rules.map(({ kind }) => kind)).toEqual(['block', 'block', 'prefer']);
  });

  it('keeps the copy of the directory it named things from', async () => {
    await runConfigBlock({ provider: ['firecrawl'] }, makeCtx(), router());
    const copy = JSON.parse(await readFile(directoryCachePath(dir), 'utf8')) as {
      revision: string;
    };
    expect(copy.revision).toBe(DIRECTORY.directory.revision);
  });
});
