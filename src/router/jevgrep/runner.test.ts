import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { JEV_LIMITS, JEV_MODEL } from './protocol.js';
import { isJevgrepRuntimeAvailable, runJevgrep } from './runner.js';
import type { JevgrepRuntime } from './runner.js';
import type { BoundedCommand, CommandResult } from '../local/process';
const directories: string[] = [];
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'jev-runner-test-'));
  directories.push(dir);
  const root = join(dir, 'repo');
  await mkdir(root);
  const git = (...args: string[]) =>
    execFileSync(
      '/usr/bin/git',
      [
        '-c',
        'core.hooksPath=/dev/null',
        '-c',
        'commit.gpgsign=false',
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@example.invalid',
        '-C',
        root,
        ...args,
      ],
      {
        env: { PATH: '/usr/bin:/bin', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
        stdio: 'pipe',
      },
    );
  git('init', '-q');
  await writeFile(join(root, 'code.ts'), 'export const visible = true;');
  git('add', '.');
  git('commit', '-qm', 'fixture');
  const path = join(dir, 'reviewed.tgz');
  const bytes = Buffer.from('mock artifact, never executed');
  await writeFile(path, bytes);
  const runtime: JevgrepRuntime = {
    kind: 'local-artifact',
    path,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
  return { root, runtime, dataDir: join(dir, 'profile') };
}
const ok: CommandResult = { code: 0, stdout: '', stderr: '' };
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(directories.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});
describe('isolated Jevgrep lifecycle', () => {
  it('keeps unqualified published versions unavailable', async () => {
    expect(isJevgrepRuntimeAvailable({ kind: 'release', version: '0.4.3' })).toBe(false);
    const evaluate = vi.fn();
    expect(
      await runJevgrep({ root: '/unused', dataDir: '/unused', query: 'question', evaluate }),
    ).toMatchObject({
      status: 'unavailable',
      requests: 0,
    });
    expect(evaluate).not.toHaveBeenCalled();
  });
  it('authenticates then searches the committed snapshot with the same isolated environment', async () => {
    const f = await fixture();
    vi.stubEnv('TYPESAFE_API_KEY', 'ambient-do-not-inherit');
    const calls: BoundedCommand[] = [];
    let token = '';
    const runCommand = vi.fn(async (command: BoundedCommand) => {
      calls.push(command);
      if (calls.length === 1) {
        token = command.input!.trim();
        expect(command.argv).toContain('--stdin');
        expect(command.argv).toContain('custom');
        return ok;
      }
      expect(command.argv).not.toContain('--base-url');
      expect(command.argv).not.toContain('--model');
      expect(command.env).toEqual(calls[0]!.env);
      expect(command.env.TYPESAFE_API_KEY).toBeUndefined();
      expect(command.env.HOME).not.toBe(process.env.HOME);
      const source = command.argv.at(-1)!;
      expect(await readFile(join(source, 'code.ts'), 'utf8')).toBe('export const visible = true;');
      return { ...ok, stdout: `${source}/code.ts:1\n${token}\nexport const visible = true;` };
    });
    const result = await runJevgrep(
      { ...f, query: 'Where is visible defined?', evaluate: vi.fn() },
      { runCommand },
    );
    expect(result.status).toBe('complete');
    expect(result.snapshot?.source).toBe('git-head-committed-only');
    expect(result.output).not.toContain(token);
    expect(runCommand).toHaveBeenCalledTimes(2);
    expect(result.output).toContain(join(f.root, 'code.ts'));
    await expect(stat(calls[0]!.cwd)).rejects.toThrow();
  });
  it('does not spawn auth with a mismatched artifact hash', async () => {
    const f = await fixture();
    const runCommand = vi.fn();
    const result = await runJevgrep(
      {
        ...f,
        runtime: { ...f.runtime, sha256: '0'.repeat(64) } as JevgrepRuntime,
        query: 'question',
        evaluate: vi.fn(),
      },
      { runCommand },
    );
    expect(result.status).toBe('failed');
    expect(runCommand).not.toHaveBeenCalled();
  });
  it('rejects reserved CLI commands before spawning', async () => {
    const f = await fixture();
    const runCommand = vi.fn();
    for (const query of ['auth', 'doctor', 'skill', 'cache']) {
      expect(await runJevgrep({ ...f, query, evaluate: vi.fn() }, { runCommand })).toMatchObject({
        status: 'failed',
        requests: 0,
      });
    }
    expect(runCommand).not.toHaveBeenCalled();
  });
  it('keeps UTF-8 output within the byte cap including the snapshot heading', async () => {
    const f = await fixture();
    let calls = 0;
    const runCommand = vi.fn(async () =>
      ++calls === 1 ? ok : { ...ok, stdout: '😀'.repeat(10000) },
    );
    const result = await runJevgrep({ ...f, query: 'question', evaluate: vi.fn() }, { runCommand });
    expect(Buffer.byteLength(result.output)).toBeLessThanOrEqual(JEV_LIMITS.outputBytes);
  });
  it('prevents search after auth failure and removes all temporary state', async () => {
    const f = await fixture();
    let directory = '';
    const runCommand = vi.fn(async (command: BoundedCommand) => {
      directory = command.cwd;
      return { ...ok, code: 1 };
    });
    expect(
      await runJevgrep({ ...f, query: 'question', evaluate: vi.fn() }, { runCommand }),
    ).toMatchObject({ status: 'failed', requests: 0 });
    expect(runCommand).toHaveBeenCalledTimes(1);
    await expect(stat(directory)).rejects.toThrow();
  });
  it('preserves partial output and cancels the setup deadline without starting search', async () => {
    const f = await fixture();
    const partial = vi
      .fn()
      .mockResolvedValueOnce(ok)
      .mockResolvedValueOnce({ ...ok, code: 2, stdout: 'partial source', reason: 'output-limit' });
    expect(
      await runJevgrep({ ...f, query: 'question', evaluate: vi.fn() }, { runCommand: partial }),
    ).toMatchObject({ status: 'partial', reason: 'output-limit' });
    const runCommand = vi.fn(async (command: BoundedCommand) => {
      await new Promise<void>((resolve) => {
        if (command.signal.aborted) resolve();
        else command.signal.addEventListener('abort', () => resolve(), { once: true });
      });
      return { ...ok, code: 130 };
    });
    expect(
      await runJevgrep(
        { ...f, query: 'question', evaluate: vi.fn() },
        { runCommand, setupTimeoutMs: 200 },
      ),
    ).toMatchObject({ status: 'failed', reason: 'setup-timeout' });
    expect(runCommand.mock.calls.length).toBeLessThanOrEqual(1);
  });
  it('cancels a search and closes its proxy without forwarding any source', async () => {
    const f = await fixture();
    const cancel = new AbortController();
    let baseURL = '';
    let count = 0;
    const runCommand = async (command: BoundedCommand) => {
      count++;
      if (count === 1) {
        baseURL = command.argv[command.argv.indexOf('--base-url') + 1]!;
        return ok;
      }
      cancel.abort();
      return { ...ok, code: 130 };
    };
    const result = await runJevgrep(
      { ...f, query: 'question', evaluate: vi.fn(), signal: cancel.signal },
      { runCommand },
    );
    expect(result.status).toBe('cancelled');
    await expect(fetch(baseURL)).rejects.toThrow();
  });
  it('reuses validated answers across isolated runs only after rechecking the source snapshot', async () => {
    const f = await fixture();
    let baseURL = '',
      token = '';
    const evaluate = vi.fn(async () => ({ answers: { q: { type: 'noul' as const, noul: 0.9 } } }));
    const runCommand = async (command: BoundedCommand) => {
      if (command.input) {
        baseURL = command.argv[command.argv.indexOf('--base-url') + 1]!;
        token = command.input.trim();
        return ok;
      }
      expect(command.argv).toContain('--no-cache');
      const source = await readFile(join(command.argv.at(-1)!, 'code.ts'), 'utf8');
      const response = await fetch(`${baseURL}/systemone`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          model: JEV_MODEL,
          state: { source, query: 'same question' },
          questions: { q: { type: 'noul', instructions: 'Relevant?' } },
        }),
      });
      expect(response.status).toBe(200);
      return { ...ok, stdout: 'source evidence' };
    };
    const first = await runJevgrep({ ...f, query: 'same question', evaluate }, { runCommand });
    const second = await runJevgrep({ ...f, query: 'same question', evaluate }, { runCommand });
    expect(first.requests).toBe(1);
    expect(second.requests).toBe(0);
    expect(second.cacheHits).toBe(1);
    expect(evaluate).toHaveBeenCalledTimes(1);
    // A newly added uncommitted ignore policy makes the source unavailable,
    // even though the previous exact answer exists on disk.
    await writeFile(join(f.root, '.ignore'), 'code.ts\n');
    const blocked = vi.fn(runCommand);
    expect(
      await runJevgrep({ ...f, query: 'same question', evaluate }, { runCommand: blocked }),
    ).toMatchObject({ status: 'unavailable', reason: 'snapshot-policy-unavailable' });
    expect(blocked).not.toHaveBeenCalled();
    expect(evaluate).toHaveBeenCalledTimes(1);
  });
});

it('uses qualified pacing and separate source/output bounds only for extended retrieval', async () => {
  const f = await fixture();
  const calls: BoundedCommand[] = [];
  await runJevgrep(
    { ...f, profile: 'extended-v1', query: 'Find the implementation', evaluate: vi.fn() },
    {
      runCommand: async (command) => {
        calls.push(command);
        return ok;
      },
    },
  );
  expect(calls[0]!.argv).toContain('--transport-profile');
  expect(calls[0]!.argv).toContain('tenjin-x402');
  const search = calls[1]!;
  expect(search.argv[search.argv.indexOf('--max-source-bytes') + 1]).toBe('16384');
  expect(search.outputBytes).toBe(32768);
  expect(search.argv[search.argv.indexOf('--concurrency') + 1]).toBe('2');
});

it('pins published 0.7.0 and uses only its supported custom auth flags', async () => {
  const f = await fixture();
  const calls: BoundedCommand[] = [];
  expect(isJevgrepRuntimeAvailable({ kind: 'release', version: '0.7.0' })).toBe(true);
  expect(isJevgrepRuntimeAvailable({ kind: 'release', version: 'latest' })).toBe(false);
  const result = await runJevgrep(
    {
      ...f,
      runtime: { kind: 'release', version: '0.7.0' },
      profile: 'extended-v1',
      query: 'Find the implementation',
      evaluate: vi.fn(),
    },
    {
      runCommand: async (command) => {
        calls.push(command);
        return ok;
      },
    },
  );
  expect(result.status).toBe('complete');
  expect(calls[0]!.argv).toContain('@dzhng/jevgrep@0.7.0');
  expect(calls[0]!.argv).not.toContain('--transport-profile');
  expect(calls[0]!.argv).toContain('custom');
  expect(calls[1]!.outputBytes).toBe(32768);
  expect(calls[1]!.argv[calls[1]!.argv.indexOf('--max-source-bytes') + 1]).toBe('16384');
});
