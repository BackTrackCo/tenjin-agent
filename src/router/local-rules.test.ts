import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ROUTER_PATH } from './decision';
import { fixture } from './fixture-test-utils';
import {
  appendLocalCount,
  fetchLocalRules,
  LOCAL_RULES_MAX_AGE_MS,
  LOCAL_RULES_REFRESH_MS,
  LOCAL_RULES_RETRY_MS,
  LocalMemory,
  readLocalRules,
  refreshLocalRules,
  writeLocalRules,
  type LocalRules,
} from './local-rules';

const BASE = 'https://tenjin.sh';
const ANSWER = fixture('wire-local-rules.json');
const RULES = ANSWER.localRules as LocalRules;
const NOW = Date.parse('2026-11-08T12:00:00Z');

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'local-rules-'));
  await mkdir(join(dir, '.git'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const cachePath = () => join(dir, 'router-memo', 'local-rules.json');
const countsPath = () => join(dir, 'router-memo', 'local-counts');

/** A router answering the rule form with `status` and `body`; `sent` is every body it got. */
function router(status: number, body: unknown = ANSWER) {
  const sent: Record<string, unknown>[] = [];
  const fetchImpl = vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    expect(String(input)).toBe(`${BASE}${ROUTER_PATH}`);
    sent.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return { fetchImpl, sent };
}

const deps = (fetchImpl: typeof fetch, now = NOW) => ({
  dataDir: dir,
  baseUrl: BASE,
  accepts: ['spec', 'local'],
  harness: 'claude' as const,
  fetchImpl,
  now: () => now,
});

describe('the cached rule list', () => {
  it('is written atomically at 0600 and read back schema-checked', async () => {
    expect(await writeLocalRules(dir, RULES, NOW)).toBe(true);
    expect((await stat(cachePath())).mode & 0o777).toBe(0o600);
    expect((await readdir(join(dir, 'router-memo'))).filter((n) => n.endsWith('.tmp'))).toEqual([]);
    expect(await readLocalRules(dir)).toMatchObject({ schemaVersion: 1, fetchedAt: NOW });
  });

  it('refuses a copy over 64 KiB, and one with a bad shape', async () => {
    const big = {
      ...RULES,
      version: 'x',
      rules: Array.from({ length: 64 }, () => RULES.rules[0]!),
    };
    const padded = {
      ...big,
      rules: big.rules.map((r) => ({ ...r, line: `${r.line} ${'p'.repeat(900)}` })),
    };
    expect(await writeLocalRules(dir, padded as LocalRules, NOW)).toBe(false);
    await mkdir(join(dir, 'router-memo'), { recursive: true });
    await writeFile(
      cachePath(),
      JSON.stringify({
        schemaVersion: 1,
        fetchedAt: NOW,
        localRules: { version: 'v', rules: 'all' },
      }),
    );
    expect(await readLocalRules(dir)).toBeNull();
    await writeFile(
      cachePath(),
      `${JSON.stringify({ schemaVersion: 1, fetchedAt: NOW, localRules: RULES })}${' '.repeat(64 * 1024)}`,
    );
    expect(await readLocalRules(dir)).toBeNull();
  });

  it('drops only a rule this build cannot read, and uses no copy over 7 days old', async () => {
    const odd = {
      ...RULES,
      rules: [
        ...RULES.rules,
        { ...RULES.rules[0]!, match: { kind: 'regex', regex: '.*' } },
        { ...RULES.rules[0]!, tool: 'curl' },
      ],
    };
    expect(await writeLocalRules(dir, odd as LocalRules, NOW)).toBe(true);
    const memory = new LocalMemory({});
    memory.use(await readLocalRules(dir));
    expect(memory.rules(NOW)).toHaveLength(RULES.rules.length);
    expect(memory.rules(NOW + LOCAL_RULES_MAX_AGE_MS)).toHaveLength(RULES.rules.length);
    expect(memory.rules(NOW + LOCAL_RULES_MAX_AGE_MS + 1)).toEqual([]);
  });
});

describe('the daily fetch', () => {
  it('sends the counts, writes the answer, and deletes the counts on a 2xx', async () => {
    await appendLocalCount(dir, 'squawk-drizzle-generate', 'shown');
    await appendLocalCount(dir, 'squawk-drizzle-generate', 'shown');
    await appendLocalCount(dir, 'squawk-drizzle-generate', 'ran');
    const { fetchImpl, sent } = router(200);
    expect(await fetchLocalRules(deps(fetchImpl))).toBe('fetched');
    expect(sent).toEqual([
      {
        schemaVersion: 1,
        localRules: {},
        accepts: ['spec', 'local'],
        harness: 'claude',
        counts: [{ rule: 'squawk-drizzle-generate', shown: 2, ran: 1 }],
      },
    ]);
    expect((await readLocalRules(dir))?.fetchedAt).toBe(NOW);
    await expect(stat(countsPath())).rejects.toThrow();
    expect((await readdir(join(dir, 'router-memo'))).some((n) => n.includes('sending'))).toBe(
      false,
    );
  });

  /** The answer an older router gives the form today. */
  it('keeps the cached copy and the counts through a 400, and waits an hour before asking again', async () => {
    await writeLocalRules(dir, RULES, NOW - LOCAL_RULES_REFRESH_MS - 1);
    const before = await readFile(cachePath(), 'utf8');
    await appendLocalCount(dir, 'attw-npm-pack', 'shown');
    const refused = router(400, { error: { code: 'invalid_request', message: 'bad body' } });
    expect(await fetchLocalRules(deps(refused.fetchImpl))).toBe('failed');
    expect(await readFile(cachePath(), 'utf8')).toBe(before);
    expect(await readFile(countsPath(), 'utf8')).toContain('"rule":"attw-npm-pack"');
    expect(await fetchLocalRules(deps(refused.fetchImpl, NOW + LOCAL_RULES_RETRY_MS - 1))).toBe(
      'waiting',
    );
    expect(refused.sent).toHaveLength(1);
    const ok = router(200);
    expect(await fetchLocalRules(deps(ok.fetchImpl, NOW + LOCAL_RULES_RETRY_MS + 1))).toBe(
      'fetched',
    );
    expect(ok.sent[0]!.counts).toEqual([{ rule: 'attw-npm-pack', shown: 1, ran: 0 }]);
  });

  it('keeps the cached copy through a 2xx it cannot read', async () => {
    await writeLocalRules(dir, RULES, NOW - LOCAL_RULES_REFRESH_MS - 1);
    const before = await readFile(cachePath(), 'utf8');
    const { fetchImpl } = router(200, {
      schemaVersion: 1,
      routerVersion: 'v',
      localRules: { rules: [] },
    });
    expect(await fetchLocalRules(deps(fetchImpl))).toBe('failed');
    expect(await readFile(cachePath(), 'utf8')).toBe(before);
  });

  it('sends each count once when two processes fetch at the same time', async () => {
    for (let i = 0; i < 5; i++) await appendLocalCount(dir, 'knip-superseded', 'shown');
    const a = router(200);
    const b = router(200);
    await Promise.all([fetchLocalRules(deps(a.fetchImpl)), fetchLocalRules(deps(b.fetchImpl))]);
    const sentCounts = [...a.sent, ...b.sent].flatMap(
      (body) => (body.counts as { shown: number }[] | undefined) ?? [],
    );
    expect(sentCounts.reduce((sum, c) => sum + c.shown, 0)).toBe(5);
  });

  it('fetches only when the copy is a day old, and never with the router off', async () => {
    const memory = new LocalMemory({});
    const schedule = (fetchImpl: typeof fetch, now: number) => ({
      dataDir: dir,
      baseUrl: async () => BASE,
      cwd: dir,
      fetchImpl,
      now: () => now,
    });
    await writeLocalRules(dir, RULES, NOW);
    const fresh = router(200);
    await refreshLocalRules(memory, schedule(fresh.fetchImpl, NOW + LOCAL_RULES_REFRESH_MS - 1));
    expect(fresh.sent).toHaveLength(0);
    expect(memory.rules(NOW)).toHaveLength(RULES.rules.length);
    await writeFile(join(dir, 'config.json'), JSON.stringify({ router: { enabled: false } }));
    const off = router(200);
    await refreshLocalRules(memory, schedule(off.fetchImpl, NOW + LOCAL_RULES_REFRESH_MS + 1));
    expect(off.sent).toHaveLength(0);
    await writeFile(join(dir, 'config.json'), '{}');
    const stale = router(200);
    await refreshLocalRules(memory, schedule(stale.fetchImpl, NOW + LOCAL_RULES_REFRESH_MS + 1));
    expect(stale.sent).toHaveLength(1);
    expect(memory.fetchedAt()).toBe(NOW + LOCAL_RULES_REFRESH_MS + 1);
  });
});
