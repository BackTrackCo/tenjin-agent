// Independently authored truth tables for the complete #740 runtime contract.
// Historical tests supply only fixture plumbing; expected rows below are fixed.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { testEnv } from '../tests/setup/test-env';
import { startDatabase } from '#benchmark/database';

let service: any;
let queries: any;
let fixtures: any;
let trending: any;
let now: number;
const options = { days: 7, limit: 100, maxPerRequester: 100 };
const names = (rows: any[]) => rows.map(row => row.query.trim().toLowerCase().replace(/\s+/g, ' ')).sort();
const ago = (hours: number) => new Date(now - hours * 3600000);

beforeAll(async () => {
  for (const [key, value] of Object.entries(testEnv)) vi.stubEnv(key, value);
  vi.stubEnv('POSTGRES_URL', process.env.BENCHMARK_DATABASE_URL!);
  vi.stubEnv('POSTGRES_URL_NON_POOLING', process.env.BENCHMARK_DATABASE_URL!);
  vi.stubGlobal('fetch', () => { throw new Error('Unexpected external request'); });
  const schema = await import('../lib/db/schema');
  service = await startDatabase(schema);
  now = new Date((await service.pool.query('SELECT now() AS epoch')).rows[0].epoch).getTime();
  queries = await import('../lib/search-telemetry');
  fixtures = await import('../tests/integration/_support/fixtures');
  trending = await import('../lib/trending-demand');
}, 60000);
afterAll(async () => { if (service) await service.close(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
beforeEach(async () => {
  await service.pool.query('TRUNCATE search_queries, hidden_search_terms, lookups, creators CASCADE');
});

async function term(text: string, count = 3, result = 2, source = 'agent', old = 48, recent = 2) {
  for (let i = 0; i < count; i++) {
    for (const hours of [old, recent]) {
      await service.pool.query('INSERT INTO search_queries (id, query, source, searcher_hash, result_count, created_at) VALUES ($1,$2,$3,$4,$5,$6)',
        [randomUUID(), text, source, `reader-${i}`, result, ago(hours)]);
    }
  }
}
async function ask(text: string, decision = 'candidates', latest = 30, client: string | null = null) {
  let id = '';
  for (let i = 0; i < 2; i++) {
    id = randomUUID();
    await service.pool.query('INSERT INTO lookups (id, generalized_query, decision, candidate_count, requester_hmac, client_name, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [id, text, decision, decision === 'miss' ? 0 : 1, `${text}-asker-${i}`, client, ago(latest + 2 - i)]);
  }
  return id;
}
async function sale(lookupId: string) {
  const owner = await fixtures.makeCreator(service);
  const post = await fixtures.makePost(service, owner, { title: 'Fictional optics notes', bodyMd: '# Synthetic fixture only' });
  await fixtures.makePayment(service, post, { lookupId, searchAttributed: true });
}

it.each(['getAgentQuestions', 'getAnsweredQuestions', 'getWaitingQuestions', 'getConvertedQuestions'])(
  '%s suppresses qualifying met and unmet terms while keeping real questions', async method => {
    await term('quartz lens');
    await term('amber prism', 5, 0);
    await term('ceramic mirror', 2);
    const decision = method === 'getWaitingQuestions' ? 'miss' : 'candidates';
    for (const text of ['  QUARTZ   LENS ', 'amber prism', 'ceramic mirror', 'why does the quartz lens fog', 'how are silver mirrors cleaned']) {
      const id = await ask(text, decision);
      if (method === 'getConvertedQuestions') await sale(id);
    }
    expect(names(await queries[method](service.db, options))).toEqual([
      'ceramic mirror', 'how are silver mirrors cleaned', 'why does the quartz lens fog',
    ]);
    expect(names(await queries.getPendingAgentQuestions(service.db, options))).toEqual([
      'amber prism', 'ceramic mirror', 'how are silver mirrors cleaned', 'quartz lens', 'why does the quartz lens fog',
    ]);
  },
);

it('a suppressed question stays moderated, then returns when its term expires', async () => {
  await term('violet optics');
  await ask('violet optics', 'miss');
  expect(names(await queries.getAgentQuestions(service.db, options))).toEqual([]);
  expect(names(await queries.getPendingAgentQuestions(service.db, options))).toEqual(['violet optics']);
  await service.pool.query("UPDATE search_queries SET created_at = now() - interval '35 days'");
  expect(names(await queries.getWaitingQuestions(service.db, options))).toEqual(['violet optics']);
});

it('term expiry does not waive a new question’s moderation delay', async () => {
  await term('indigo optics');
  await ask('indigo optics', 'miss', 1);
  await service.pool.query("UPDATE search_queries SET created_at = now() - interval '35 days'");
  expect(names(await queries.getAgentQuestions(service.db, options))).toEqual([]);
  expect(names(await queries.getPendingAgentQuestions(service.db, options))).toEqual(['indigo optics']);
});

it('suppression is bounded by agent source, three words, and eighty codepoints', async () => {
  const rows = [
    { text: 'copper lens mount', source: 'agent', keep: false },
    { text: 'copper lens mount alignment', source: 'agent', keep: true },
    { text: 'f'.repeat(80), source: 'agent', keep: false },
    { text: 'g'.repeat(81), source: 'agent', keep: true },
    { text: 'silver lens mount', source: 'web', keep: true },
  ];
  for (const row of rows) { await term(row.text, 4, 2, row.source); await ask(row.text); }
  expect(names(await queries.getAgentQuestions(service.db, options))).toEqual(rows.filter(row => row.keep).map(row => row.text).sort());
});

it('term eligibility beyond the display cap still prevents duplicate questions', async () => {
  for (let i = 0; i < 28; i++) await term(`lensmaterial${String.fromCharCode(97+i)}`, 4);
  await term('zinc target', 3);
  await ask('zinc target');
  const terms = await queries.getTopSearchTerms(service.db, { days: 30, limit: 25, minCount: 3, source: 'agent' });
  expect(terms).toHaveLength(25);
  expect(names(terms)).not.toContain('zinc target');
  expect(names(await queries.getAgentQuestions(service.db, options))).toEqual([]);
});

it('preserves independent term floors, source, window, persistence and latest-result semantics', async () => {
  await term('healthy lens', 3, 1);
  await term('wanted prism', 5, 0);
  await term('tiny population', 2, 1);
  await term('small unmet', 4, 0);
  await term('web traffic', 6, 1, 'web');
  await term('expired optics', 6, 1, 'agent', 900, 850);
  await term('young demand', 5, 0, 'agent', 2, 1);
  await term('rescued demand', 5, 0);
  await service.pool.query("UPDATE search_queries SET rescued_count=1 WHERE query='rescued demand'");
  await term('formerly found', 5, 2);
  await service.pool.query('INSERT INTO search_queries (id,query,source,searcher_hash,result_count,created_at) VALUES ($1,$2,$3,$4,$5,$6)',
    [randomUUID(), 'formerly found', 'agent', 'reader-0', 0, ago(1)]);
  const read = await trending.readTrendingDemand(service.db);
  expect(read.top.map((row: any) => [row.query, row.searches]).sort()).toEqual([['healthy lens', 6], ['rescued demand', 10]]);
  expect(read.unmet.map((row: any) => [row.query, row.searches]).sort()).toEqual([['formerly found', 11], ['wanted prism', 10]]);
});

it('keeps operator veto, probe suppression and per-requester caps after the anti-join', async () => {
  await ask('ordinary optics question', 'miss');
  await ask('vetoed optics question', 'miss');
  await service.pool.query('INSERT INTO hidden_search_terms (term) VALUES ($1)', ['vetoed optics question']);
  await ask('zzq_probe_optics question', 'miss');
  await ask('probe client optics question', 'miss', 30, 'tenjin-eval');
  for (const text of ['first shared question', 'second shared question']) {
    await ask(text, 'miss');
    await service.pool.query('UPDATE lookups SET requester_hmac=$1 WHERE generalized_query=$2 AND created_at=$3', ['same-latest-reader', text, ago(31)]);
  }
  const result = names(await queries.getWaitingQuestions(service.db, { ...options, maxPerRequester: 1 }));
  expect(result).not.toContain('vetoed optics question');
  expect(result).not.toContain('zzq_probe_optics question');
  expect(result).not.toContain('probe client optics question');
  expect(result).toContain('ordinary optics question');
  expect(result.filter((name: string) => name.includes('shared question'))).toHaveLength(1);
});
