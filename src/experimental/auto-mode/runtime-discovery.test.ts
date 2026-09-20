import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { compileResource } from './contracts';
import type { AutoContract } from './contracts';
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
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
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
