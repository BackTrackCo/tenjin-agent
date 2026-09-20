import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { compileResource } from './contracts';
import type { AutoContract } from './contracts';
import { CDP_BAZAAR } from './catalog';
import type { discoverCandidates } from './catalog';
import type { HookEvent, TaskContext } from './context';
import type { Choose } from './routing';
import { ConfigSchema, FIXTURE_RESOURCE, fixtureChooser, routeEvent } from './runtime';

const directories: string[] = [];
const event: HookEvent = {
  hook_event_name: 'PreToolUse',
  session_id: 'discovery-test',
  tool_use_id: 'call-1',
  transcript_path: '/unused',
  tool_name: 'WebSearch',
  tool_input: { query: 'current crypto market prices' },
};
const context: TaskContext = {
  messages: [{ role: 'user', text: 'Compare current crypto market prices.' }],
  fingerprint: 'test-context',
};
type DiscoveryResult = Awaited<ReturnType<typeof discoverCandidates>>;
const chooseNone: Choose = async () => ({ route: { choice: 'none' } });

function candidate(id: string): AutoContract {
  const compiled = compileResource({
    ...FIXTURE_RESOURCE,
    resource: `https://provider.example/${id}`,
    description: `Synthetic capability ${id}`,
  });
  if (compiled.status !== 'supported') throw new Error(compiled.reasons.join('; '));
  return compiled.contract;
}

function result(contracts: AutoContract[], partial = false): DiscoveryResult {
  return {
    contracts,
    resources: contracts.map((contract) => ({ resource: contract.url })),
    rejected: [],
    partial,
  };
}

async function config(seeds?: string | string[]) {
  const stateDir = await mkdtemp(join(tmpdir(), 'auto-query-seeds-'));
  directories.push(stateDir);
  return ConfigSchema.parse({
    version: 1,
    mode: 'route',
    stateDir,
    policyPath: join(stateDir, 'policy.json'),
    discoveryQueries: seeds === undefined ? {} : { WebSearch: seeds },
  });
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function localResource(id: string) {
  return {
    ...FIXTURE_RESOURCE,
    resource: `https://provider.example/${id}`,
    description: `Synthetic capability ${id}`,
  };
}

async function localCatalog(
  resources: unknown[] = [localResource('selected')],
  source = CDP_BAZAAR,
) {
  const settings = await config(['a configured seed that must not run']);
  const catalogFile = join(settings.stateDir, 'operator-catalog.json');
  const document = { source, fetchedAt: '2026-09-20T19:05:47.325Z', resources };
  await writeFile(catalogFile, JSON.stringify(document));
  return {
    settings: ConfigSchema.parse({ ...settings, catalogFile }),
    catalogFile,
    document,
  };
}

describe('operator-selected local CDP catalog', () => {
  it.each([CDP_BAZAAR, `${CDP_BAZAAR}/discovery/search`, `${CDP_BAZAAR}/discovery/resources`])(
    'routes a catalog from %s without network discovery and records its provenance',
    async (source) => {
      const { settings, document } = await localCatalog(undefined, source);
      const discover = vi.fn<typeof discoverCandidates>();
      const network = vi
        .spyOn(globalThis, 'fetch')
        .mockRejectedValue(new Error('Unexpected network'));
      const routed = await routeEvent(event, settings, {
        context,
        discover,
        choose: fixtureChooser,
      });
      expect(routed).toMatchObject({
        status: 'selected',
        contract: { url: 'https://provider.example/selected' },
        args: { body: { query: event.tool_input.query } },
      });
      expect(discover).not.toHaveBeenCalled();
      expect(network).not.toHaveBeenCalled();
      const evidence = JSON.parse(
        await readFile(join(settings.stateDir, 'catalog-last.json'), 'utf8'),
      );
      expect(evidence).toMatchObject({
        mode: 'local-catalog',
        source,
        fetchedAt: document.fetchedAt,
        resources: document.resources,
        rejected: [],
        partial: false,
        selection: 'operator-selected',
        catalogHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      });
      expect(evidence.contracts).toHaveLength(1);
    },
  );

  it('deduplicates executable contracts while preserving raw and unsupported records', async () => {
    const valid = localResource('valid');
    const invalid = { type: 'http', resource: 'https://unknown.example/action' };
    const { settings, document } = await localCatalog([valid, valid, invalid]);
    const discover = vi.fn<typeof discoverCandidates>();
    const choose = vi.fn<Choose>(async (_state, questions) => {
      expect(Object.keys(questions.route!.criteria).sort()).toEqual(['c0', 'none']);
      return { route: { choice: 'none' } };
    });
    await routeEvent(event, settings, { context, discover, choose });
    const evidence = JSON.parse(
      await readFile(join(settings.stateDir, 'catalog-last.json'), 'utf8'),
    );
    expect(evidence.resources).toEqual(document.resources);
    expect(evidence.contracts).toHaveLength(1);
    expect(evidence.rejected).toHaveLength(1);
    expect(evidence.rejected[0]).toMatchObject({ status: 'unsupported', url: invalid.resource });
    expect(evidence.rejected[0].reasons.length).toBeGreaterThan(0);
    expect(evidence.partial).toBe(true);
    expect(discover).not.toHaveBeenCalled();
    expect(choose).toHaveBeenCalledTimes(1);
  });

  it('updates catalog evidence when the operator changes the file', async () => {
    const { settings, catalogFile, document } = await localCatalog();
    const deps = { context, discover: vi.fn<typeof discoverCandidates>(), choose: chooseNone };
    await routeEvent(event, settings, deps);
    const before = JSON.parse(await readFile(join(settings.stateDir, 'catalog-last.json'), 'utf8'));
    await writeFile(
      catalogFile,
      JSON.stringify({ ...document, resources: [localResource('replacement')] }),
    );
    await routeEvent(event, settings, deps);
    const after = JSON.parse(await readFile(join(settings.stateDir, 'catalog-last.json'), 'utf8'));
    expect(after.catalogHash).not.toBe(before.catalogHash);
    expect(after.contracts).toHaveLength(1);
    expect(after.contracts[0].url).toBe('https://provider.example/replacement');
    expect(deps.discover).not.toHaveBeenCalled();
  });

  it.each([
    ['malformed JSON', '{'],
    [
      'wrong source',
      JSON.stringify({
        source: 'https://untrusted.example/catalog',
        fetchedAt: '2026-09-20T19:05:47.325Z',
        resources: [localResource('valid')],
      }),
    ],
    [
      'source prefix spoof',
      JSON.stringify({
        source: `${CDP_BAZAAR}.evil.example`,
        fetchedAt: '2026-09-20T19:05:47.325Z',
        resources: [localResource('valid')],
      }),
    ],
    [
      'invalid timestamp',
      JSON.stringify({
        source: CDP_BAZAAR,
        fetchedAt: 'yesterday',
        resources: [localResource('valid')],
      }),
    ],
    [
      'empty resources',
      JSON.stringify({ source: CDP_BAZAAR, fetchedAt: '2026-09-20T19:05:47.325Z', resources: [] }),
    ],
    [
      'too many resources',
      JSON.stringify({
        source: CDP_BAZAAR,
        fetchedAt: '2026-09-20T19:05:47.325Z',
        resources: Array.from({ length: 21 }, (_, index) => localResource(`candidate-${index}`)),
      }),
    ],
    ['oversized file', `${' '.repeat(2 * 1024 * 1024)}{}`],
  ])('rejects %s before discovery or Jev', async (_name, raw) => {
    const { settings, catalogFile } = await localCatalog();
    await writeFile(catalogFile, raw);
    const discover = vi.fn<typeof discoverCandidates>();
    const choose = vi.fn<Choose>();
    await expect(routeEvent(event, settings, { context, discover, choose })).rejects.toThrow();
    expect(discover).not.toHaveBeenCalled();
    expect(choose).not.toHaveBeenCalled();
  });

  it('still restricts local catalog candidates to the exact live URL and method policy', async () => {
    const { settings } = await localCatalog([
      localResource('wrong-method'),
      localResource('allowed'),
      localResource('outside-scope'),
    ]);
    await writeFile(
      settings.policyPath,
      JSON.stringify({
        allowedResources: [
          { url: 'https://provider.example/wrong-method', method: 'GET' },
          { url: 'https://provider.example/allowed', method: 'POST' },
        ],
      }),
    );
    const discover = vi.fn<typeof discoverCandidates>();
    const choose: Choose = vi.fn(async (state, questions) => {
      if (questions.route) {
        expect(Object.keys(questions.route.criteria).sort()).toEqual(['c0', 'none']);
        expect(questions.route.criteria.c0).toContain('https://provider.example/allowed');
      }
      return fixtureChooser(state, questions);
    });
    const routed = await routeEvent(
      event,
      { ...settings, mode: 'live' },
      { context, discover, choose },
    );
    expect(routed).toMatchObject({
      status: 'selected',
      contract: { url: 'https://provider.example/allowed', method: 'POST' },
    });
    expect(discover).not.toHaveBeenCalled();
  });
});

describe('generic multi-query discovery seeds', () => {
  it('accepts legacy strings and bounded arrays, rejecting empty or oversized seed lists', async () => {
    expect((await config('web search')).discoveryQueries.WebSearch).toBe('web search');
    expect((await config(['web search', 'market prices'])).discoveryQueries.WebSearch).toEqual([
      'web search',
      'market prices',
    ]);
    for (const seeds of [[], ['a', 'b', 'c', 'd'], [''], [' '.repeat(3)], ['x'.repeat(401)]]) {
      expect(() =>
        ConfigSchema.parse({
          version: 1,
          mode: 'route',
          stateDir: '/unused',
          policyPath: '/unused',
          discoveryQueries: { WebSearch: seeds },
        }),
      ).toThrow();
    }
  });

  it('searches both families concurrently and keeps configured order when requests finish in reverse order', async () => {
    const settings = await config(['general research', 'market prices']);
    const finish = new Map<string, (value: DiscoveryResult) => void>();
    const discover = vi
      .fn<typeof discoverCandidates>()
      .mockImplementation((query) => new Promise((resolve) => finish.set(query, resolve)));
    const choose: Choose = vi.fn(async (state, questions) => {
      if (questions.route) {
        expect(questions.route.criteria.c0).toContain('/research');
        expect(questions.route.criteria.c1).toContain('/prices');
        return { route: { choice: 'c1' } };
      }
      return fixtureChooser(state, questions);
    });
    const pending = routeEvent(event, settings, { context, discover, choose });
    await vi.waitFor(() => expect(discover).toHaveBeenCalledTimes(2));
    expect(discover.mock.calls).toEqual([
      ['general research', { limit: 10 }],
      ['market prices', { limit: 10 }],
    ]);
    finish.get('market prices')!(result([candidate('prices')]));
    finish.get('general research')!(result([candidate('research')]));
    const routed = await pending;
    expect(routed).toMatchObject({
      status: 'selected',
      contract: { url: 'https://provider.example/prices' },
      args: { body: { query: event.tool_input.query } },
    });
    const evidence = JSON.parse(
      await readFile(join(settings.stateDir, 'catalog-last.json'), 'utf8'),
    );
    expect(evidence.queries).toEqual(['general research', 'market prices']);
    expect(evidence.searches.map((search: { query: string }) => search.query)).toEqual(
      evidence.queries,
    );
    expect(evidence.resources).toEqual([
      { resource: 'https://provider.example/research' },
      { resource: 'https://provider.example/prices' },
    ]);
    expect(evidence.partial).toBe(false);
  });

  it('round-robins three ranked families, deduplicates by source hash, and explicitly records the candidate cap', async () => {
    const settings = await config(['family a', 'family b', 'family c']);
    const a = Array.from({ length: 10 }, (_, index) => candidate(`a-${index}`));
    const b = Array.from({ length: 10 }, (_, index) =>
      index === 1 ? a[0]! : candidate(`b-${index}`),
    );
    const c = Array.from({ length: 10 }, (_, index) => candidate(`c-${index}`));
    const rejected = {
      status: 'unsupported' as const,
      id: 'missing',
      url: 'https://incomplete.example/action',
      reasons: ['Missing input schema'],
    };
    const batches = new Map([
      ['family a', result(a)],
      [
        'family b',
        {
          ...result(b),
          resources: [...result(b).resources, { resource: rejected.url }],
          rejected: [rejected],
        },
      ],
      ['family c', result(c, true)],
    ]);
    const discover = vi
      .fn<typeof discoverCandidates>()
      .mockImplementation(async (query) => batches.get(query)!);
    let choices: Record<string, string> = {};
    const choose: Choose = async (_state, questions) => {
      choices = questions.route!.criteria;
      return { route: { choice: 'none' } };
    };
    await routeEvent(event, settings, { context, discover, choose });
    const evidence = JSON.parse(
      await readFile(join(settings.stateDir, 'catalog-last.json'), 'utf8'),
    );
    expect(evidence.contracts).toHaveLength(20);
    expect(Object.keys(choices)).toHaveLength(21); // 20 capabilities plus explicit none.
    expect(evidence.uniqueCandidates).toBe(29);
    expect(evidence.truncated).toBe(true);
    expect(evidence.partial).toBe(true);
    expect(evidence.contracts.slice(0, 5).map((contract: AutoContract) => contract.url)).toEqual(
      ['a-0', 'b-0', 'c-0', 'a-1', 'c-1'].map((path) => `https://provider.example/${path}`),
    );
    expect(
      new Set(evidence.contracts.map((contract: AutoContract) => contract.sourceHash)).size,
    ).toBe(20);
    expect(evidence.rejected).toEqual([rejected]);
    expect(evidence.searches[1].resources.at(-1)).toEqual({ resource: rejected.url });
    expect(evidence.searches[2].partial).toBe(true);
  });

  it('records a failed seed as partial while keeping candidates from successful discovery', async () => {
    const settings = await config(['unavailable', 'available']);
    const discover = vi.fn<typeof discoverCandidates>().mockImplementation(async (query) => {
      if (query === 'unavailable') throw new Error('Discovery HTTP 503');
      return result([candidate('available')]);
    });
    await routeEvent(event, settings, { context, discover, choose: chooseNone });
    const evidence = JSON.parse(
      await readFile(join(settings.stateDir, 'catalog-last.json'), 'utf8'),
    );
    expect(evidence.partial).toBe(true);
    expect(evidence.contracts).toHaveLength(1);
    expect(evidence.searches[0]).toEqual({
      query: 'unavailable',
      status: 'failed',
      error: 'Discovery HTTP 503',
    });
  });

  it('saves all failure evidence without invoking Jev when no query succeeded', async () => {
    const settings = await config(['unavailable-a', 'unavailable-b']);
    const choose = vi.fn<Choose>();
    const discover = vi
      .fn<typeof discoverCandidates>()
      .mockRejectedValue(new Error('Discovery unavailable'));
    await expect(routeEvent(event, settings, { context, discover, choose })).rejects.toThrow(
      'All CDP discovery queries failed',
    );
    const evidence = JSON.parse(
      await readFile(join(settings.stateDir, 'catalog-last.json'), 'utf8'),
    );
    expect(evidence.searches).toHaveLength(2);
    expect(evidence.partial).toBe(true);
    expect(choose).not.toHaveBeenCalled();
  });

  it('keeps task-based discovery as the default and runs repeated seeds only once', async () => {
    const discover = vi
      .fn<typeof discoverCandidates>()
      .mockResolvedValue(result([candidate('default')]));
    await routeEvent(event, await config(), { context, discover, choose: chooseNone });
    expect(discover.mock.calls[0]).toEqual([
      'web search Compare current crypto market prices.',
      { limit: 10 },
    ]);
    discover.mockClear();
    await routeEvent(event, await config(['same seed', 'same seed']), {
      context,
      discover,
      choose: chooseNone,
    });
    expect(discover).toHaveBeenCalledTimes(1);
  });
});
