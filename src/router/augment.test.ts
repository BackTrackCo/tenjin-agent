import { execFile } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DOCS_QUERY_MAX, docsUrl, PREFETCH_SCRIPT } from './augment';

const exec = promisify(execFile);

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'router-augment-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/**
 * THE SCRIPT THE DETACHED PROCESS RUNS, run for real: the same string, in a
 * real `node -e`, with only `fetch` replaced by a stub in front of it. The run
 * is awaited and bounded, so no process outlives the test, and nothing touches
 * the network. The stub records what it was asked into `seen.json`.
 */
async function prefetch(
  answer: string,
  timeoutMs = 2_000,
): Promise<{ written: unknown; seen: { url: string; init: Record<string, unknown> } }> {
  const stub = [
    "const { writeFileSync: seenWrite } = require('node:fs');",
    'globalThis.fetch = (url, init) => {',
    `  seenWrite(${JSON.stringify(join(dir, 'seen.json'))}, JSON.stringify({ url, init }));`,
    `  ${answer}`,
    '};',
  ].join('\n');
  const out = join(dir, 'augment-x.docs');
  await exec(
    process.execPath,
    [
      '-e',
      `${stub}\n${PREFETCH_SCRIPT}`,
      'https://tenjin.sh/api/docs-lookup?query=zod',
      out,
      'tenjin-cli/1.0.0 (+https://tenjin.blog)',
      String(timeoutMs),
      '10',
    ],
    { timeout: 10_000 },
  );
  return {
    written: JSON.parse(await readFile(out, 'utf8')),
    seen: JSON.parse(await readFile(join(dir, 'seen.json'), 'utf8')),
  };
}

describe('the prefetch script', () => {
  it('writes the status and the text of a 200, bounded, and sends the CLI identity', async () => {
    const { written, seen } = await prefetch(
      "return Promise.resolve(new Response('Context7 matched: /colinhacks/zod', { status: 200 }));",
    );
    expect(written).toEqual({ status: 200, text: 'Context7 m' });
    expect(seen.url).toBe('https://tenjin.sh/api/docs-lookup?query=zod');
    expect(seen.init).toMatchObject({
      headers: { accept: 'text/plain', 'user-agent': 'tenjin-cli/1.0.0 (+https://tenjin.blog)' },
      redirect: 'error',
    });
    // Only the answer is left behind: the temp file was renamed over it.
    expect((await readdir(dir)).sort()).toEqual(['augment-x.docs', 'seen.json']);
  });

  it.each([
    ['a 404 with no match', 404],
    ['a 503', 503],
    ['a 429', 429],
  ])('writes %s as its status and no text', async (_label, status) => {
    const body = JSON.stringify({ error: { code: 'x', message: 'Use your own tools.' } });
    const { written } = await prefetch(
      `return Promise.resolve(new Response(${JSON.stringify(body)}, { status: ${status} }));`,
    );
    expect(written).toEqual({ status, text: '' });
  });

  it('writes status 0 for a fetch that fails', async () => {
    const { written } = await prefetch("return Promise.reject(new TypeError('fetch failed'));");
    expect(written).toEqual({ status: 0, text: '' });
  });

  /** A lookup that never settles holds nothing open by itself: the deadline
   *  is what answers, and the process is gone by then. */
  it('writes status 0 and exits when the lookup runs past its deadline', async () => {
    const started = Date.now();
    const { written } = await prefetch('return new Promise(() => {});', 50);
    expect(written).toEqual({ status: 0, text: '' });
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});

describe('the docs URL', () => {
  const ENDPOINT = 'https://tenjin.sh/api/docs-lookup';

  it("carries the agent's own query, cut to what the endpoint accepts", () => {
    expect(docsUrl(ENDPOINT, 'next.js middleware matcher', 'https://tenjin.sh')).toBe(
      `${ENDPOINT}?query=next.js+middleware+matcher`,
    );
    const long = docsUrl(ENDPOINT, 'q'.repeat(900), 'https://tenjin.sh');
    expect(new URL(long!).searchParams.get('query')).toHaveLength(DOCS_QUERY_MAX);
  });

  it('is fetched on the deployment the gate answered from, and its aliases', () => {
    expect(docsUrl(ENDPOINT, 'q', 'https://tenjin.blog')).not.toBeNull();
    expect(docsUrl('http://localhost:3000/api/docs-lookup', 'q', 'http://localhost:3000')).not.toBe(
      null,
    );
  });

  it.each([
    ['another origin', 'https://docs.example.test/api/docs-lookup'],
    ['a local address', 'http://169.254.169.254/latest/meta-data'],
    ['credentials in the URL', 'https://user:pass@tenjin.sh/api/docs-lookup'],
    ['no URL at all', 'not a url'],
  ])('is not fetched at all for %s', (_label, endpoint) => {
    expect(docsUrl(endpoint, 'q', 'https://tenjin.sh')).toBeNull();
  });
});
