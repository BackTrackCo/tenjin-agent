import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ANSWER_CACHE_LIMITS, createJevgrepAnswerCache } from './answer-cache';
import { JEV_MODEL, type NativeEvaluationRequest } from './protocol';
import { JEVGREP_SUPPLIER, MAPLE_JEVGREP_SUPPLIER } from './supplier';

const dirs: string[] = [];
const request: NativeEvaluationRequest = {
  model: JEV_MODEL,
  state: { query: 'private-query-text', source: 'private-source-text' },
  questions: {
    'private-question-id': { type: 'noul', instructions: 'private-instructions' },
    second: { type: 'noul', instructions: 'Second?' },
  },
};
const response = {
  model: JEV_MODEL,
  answers: {
    'private-question-id': { type: 'noul' as const, noul: 0.8 },
    second: { type: 'noul' as const, noul: 0.2 },
  },
  usage: { input_tokens: 12000, output_tokens: 2 },
};
async function fixture() {
  const dataDir = await mkdtemp(join(tmpdir(), 'jev-answer-cache-'));
  dirs.push(dataDir);
  const options = {
    dataDir,
    root: '/approved/repository',
    commit: 'a'.repeat(40),
    query: 'private-query-text',
    runtime: { kind: 'local-artifact' as const, path: '/reviewed.tgz', sha256: 'b'.repeat(64) },
  };
  return {
    options,
    directory: join(dataDir, 'jevgrep', 'answers'),
    cache: createJevgrepAnswerCache(options),
  };
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('private cross-run Jevgrep answers', () => {
  it('survives a fresh instance, stores no request text or IDs, and reports zero new usage', async () => {
    const f = await fixture();
    expect(await f.cache.get(request)).toBeUndefined();
    await f.cache.put(request, response);
    const hit = await createJevgrepAnswerCache(f.options).get(request);
    expect(hit).toEqual({ ...response, usage: { input_tokens: 0, output_tokens: 0 } });
    expect((await stat(f.directory)).mode & 0o777).toBe(0o700);
    const [name] = await readdir(f.directory);
    expect(name).toMatch(/^[a-f0-9]{64}\.json$/);
    const path = join(f.directory, name!);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(await readFile(path, 'utf8')).not.toMatch(/private-|Second|reviewed|approved/);
  });

  it('keys source, query, question semantics, approved root, commit and artifact identity', async () => {
    const f = await fixture();
    await f.cache.put(request, response);
    for (const changed of [
      { ...request, state: { query: 'different', source: 'private-source-text' } },
      { ...request, state: { query: 'private-query-text', source: 'changed source' } },
      {
        ...request,
        questions: {
          ...request.questions,
          second: { type: 'noul' as const, instructions: 'Changed?' },
        },
      },
    ])
      expect(await f.cache.get(changed)).toBeUndefined();
    for (const changed of [
      { query: 'different-run-query' },
      { root: '/other/repository' },
      { commit: 'c'.repeat(40) },
      { runtime: { ...f.options.runtime, sha256: 'd'.repeat(64) } },
      { runtime: { kind: 'release' as const, version: '0.4.4' } },
    ])
      expect(
        await createJevgrepAnswerCache({ ...f.options, ...changed }).get(request),
      ).toBeUndefined();
    // Moving the same reviewed artifact is not a new runtime; question ordering
    // does not confuse the sorted score positions.
    expect(
      await createJevgrepAnswerCache({
        ...f.options,
        runtime: { ...f.options.runtime, path: '/moved.tgz' },
      }).get({
        ...request,
        questions: Object.fromEntries(Object.entries(request.questions).reverse()),
      }),
    ).toEqual({ ...response, usage: { input_tokens: 0, output_tokens: 0 } });
  });

  it('misses malformed, mismatched, expired, future, overlarge and nonprivate records', async () => {
    const f = await fixture();
    const time = Date.now();
    const cache = createJevgrepAnswerCache({ ...f.options, now: () => time });
    await cache.put(request, response);
    const path = join(f.directory, (await readdir(f.directory))[0]!);
    const valid = await readFile(path, 'utf8');
    for (const value of [
      '{',
      'null',
      JSON.stringify({ ...JSON.parse(valid), key: 'wrong' }),
      JSON.stringify({ ...JSON.parse(valid), scores: [0.1, 0.2] }),
      'x'.repeat(ANSWER_CACHE_LIMITS.entryBytes + 1),
    ]) {
      await writeFile(path, value);
      expect(await cache.get(request)).toBeUndefined();
    }
    await writeFile(path, valid);
    expect(
      await createJevgrepAnswerCache({
        ...f.options,
        now: () => time + ANSWER_CACHE_LIMITS.ttlMs,
      }).get(request),
    ).toBeUndefined();
    expect(
      await createJevgrepAnswerCache({ ...f.options, now: () => time - 1 }).get(request),
    ).toBeUndefined();
    await chmod(path, 0o644);
    expect(await cache.get(request)).toBeUndefined();
  });

  it('refuses symlink files/directories and never persists invalid answers', async () => {
    const f = await fixture();
    await f.cache.put(request, { answers: {} });
    expect(await f.cache.get(request)).toBeUndefined();
    await f.cache.put(request, response);
    const name = (await readdir(f.directory))[0]!;
    const path = join(f.directory, name);
    const elsewhere = join(f.options.dataDir, 'elsewhere');
    await writeFile(elsewhere, await readFile(path), { mode: 0o600 });
    await rm(path);
    await symlink(elsewhere, path);
    expect(await f.cache.get(request)).toBeUndefined();
    await rm(f.directory, { recursive: true });
    const target = join(f.options.dataDir, 'target');
    await mkdir(target, { mode: 0o700 });
    await symlink(target, f.directory);
    await f.cache.put(request, response);
    expect(await readdir(target)).toEqual([]);
  });

  it('publishes complete responses across concurrent instances and tolerates a crashed writer lock', async () => {
    const f = await fixture();
    await Promise.all(
      Array.from({ length: 8 }, () => createJevgrepAnswerCache(f.options).put(request, response)),
    );
    expect((await f.cache.get(request))?.answers).toEqual(response.answers);
    expect((await readdir(f.directory)).filter((name) => name.endsWith('.json'))).toHaveLength(1);
    await mkdir(join(f.directory, '.write.lock'));
    await createJevgrepAnswerCache(f.options).put({ ...request, state: 'new' }, response);
    expect((await f.cache.get(request))?.answers).toEqual(response.answers);
    expect(await f.cache.get({ ...request, state: 'new' })).toBeUndefined();
  });

  it('bounds persistent entry count and aggregate bytes under serialized writes', async () => {
    const f = await fixture();
    await f.cache.put(request, response);
    for (let start = 0; start < ANSWER_CACHE_LIMITS.entries; start += 64)
      await Promise.all(
        Array.from({ length: 64 }, (_, i) =>
          writeFile(join(f.directory, `${(start + i).toString(16).padStart(64, '0')}.json`), '{}', {
            mode: 0o600,
          }),
        ),
      );
    await f.cache.put({ ...request, state: 'count-bound' }, response);
    expect((await readdir(f.directory)).length).toBeLessThanOrEqual(ANSWER_CACHE_LIMITS.entries);
    for (let i = 0; i < 33; i++)
      await writeFile(
        join(f.directory, `${(4096 + i).toString(16).padStart(64, '0')}.json`),
        Buffer.alloc(1024 * 1024),
        { mode: 0o600 },
      );
    await f.cache.put({ ...request, state: 'byte-bound' }, response);
    const sizes = await Promise.all(
      (await readdir(f.directory)).map(async (name) => (await stat(join(f.directory, name))).size),
    );
    expect(sizes.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(ANSWER_CACHE_LIMITS.bytes);
    expect(await f.cache.get({ ...request, state: 'byte-bound' })).toBeDefined();
  });
});

it('keeps legacy standard answers and isolates extended policy answers', async () => {
  const f = await fixture();
  await f.cache.put(request, response);
  expect(
    await createJevgrepAnswerCache({ ...f.options, profile: 'standard-v1' }).get(request),
  ).toBeDefined();
  const extended = createJevgrepAnswerCache({ ...f.options, profile: 'extended-v1' });
  expect(await extended.get(request)).toBeUndefined();
  const changed = {
    ...response,
    answers: { ...response.answers, second: { type: 'noul' as const, noul: 0.9 } },
  };
  await extended.put(request, changed);
  expect(
    (await createJevgrepAnswerCache({ ...f.options, profile: 'extended-v1' }).get(request))?.answers
      .second?.noul,
  ).toBe(0.9);
  expect((await f.cache.get(request))?.answers.second?.noul).toBe(0.2);
  expect((await readdir(f.directory)).filter((name) => name.endsWith('.json'))).toHaveLength(2);
});

it('preserves legacy answers while isolating Maple provider and model identity', async () => {
  const f = await fixture();
  await f.cache.put(request, response);
  expect(
    await createJevgrepAnswerCache({ ...f.options, supplier: JEVGREP_SUPPLIER }).get(request),
  ).toBeDefined();
  const maple = createJevgrepAnswerCache({ ...f.options, supplier: MAPLE_JEVGREP_SUPPLIER });
  expect(await maple.get(request)).toBeUndefined();
  const changed = {
    ...response,
    answers: { ...response.answers, second: { type: 'noul' as const, noul: 0.9 } },
  };
  await maple.put(request, changed);
  expect((await maple.get(request))?.answers.second?.noul).toBe(0.9);
  expect((await f.cache.get(request))?.answers.second?.noul).toBe(0.2);
  expect((await readdir(f.directory)).filter((name) => name.endsWith('.json'))).toHaveLength(2);
});
