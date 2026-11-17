import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import {
  prepareWorkerGithub,
  redactWorkerSecrets,
  workerGithubToken,
  workerTokenValues,
  type WorkerGithub,
} from './worker-github';

const TOKEN = `gho_${'Zx9'.repeat(12)}`;
const NAMED = `github_pat_${'q'.repeat(40)}`;
let prepared: WorkerGithub | undefined;
afterEach(async () => {
  await prepared?.close();
  prepared = undefined;
});

/** Stands in for gh and git config; records what was asked. */
const runner = (answers: { token?: string; name?: string; email?: string } = {}) =>
  vi.fn(async (file: string, args: string[]) => {
    if (file === 'gh' && args[0] === 'auth' && args[1] === 'token') {
      if (answers.token === undefined) throw new Error('not logged in');
      return `${answers.token}\n`;
    }
    if (file === 'git' && args.at(-1) === 'user.name' && answers.name) return `${answers.name}\n`;
    if (file === 'git' && args.at(-1) === 'user.email' && answers.email)
      return `${answers.email}\n`;
    throw new Error('unset');
  });

/** Asks the job's git, as the worker's git would, for GitHub credentials. */
function fill(job: WorkerGithub, host: string) {
  return execFileSync('git', ['credential', 'fill'], {
    input: `protocol=https\nhost=${host}\n\n`,
    env: {
      PATH: process.env.PATH,
      HOME: job.directory,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_TERMINAL_PROMPT: '0',
      ...job.env,
    },
    stdio: ['pipe', 'pipe', 'ignore'],
  }).toString();
}

it('prefers a token the person names for workers and never widens a bad one to the gh login', async () => {
  const run = runner({ token: TOKEN });
  expect(await workerGithubToken({ TENJIN_WORKER_GITHUB_TOKEN: NAMED }, run)).toBe(NAMED);
  const dir = await mkdtemp(join(tmpdir(), 'worker-token-'));
  try {
    await writeFile(join(dir, 'token'), `${NAMED}\n`);
    expect(
      await workerGithubToken({ TENJIN_WORKER_GITHUB_TOKEN_FILE: join(dir, 'token') }, run),
    ).toBe(NAMED);
    expect(
      await workerGithubToken({ TENJIN_WORKER_GITHUB_TOKEN_FILE: join(dir, 'missing') }, run),
    ).toBeNull();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  expect(await workerGithubToken({ TENJIN_WORKER_GITHUB_TOKEN: 'not a token' }, run)).toBeNull();
  expect(run).not.toHaveBeenCalled();
  expect(await workerGithubToken({}, run)).toBe(TOKEN);
  expect(await workerGithubToken({}, runner())).toBeNull();
});

it('gives git the person identity and a GitHub-only credential helper fed by the job token', async () => {
  prepared = await prepareWorkerGithub(
    {},
    { run: runner({ token: TOKEN, name: 'Ada "A" Lovelace', email: 'ada@example.com' }) },
  );
  expect(prepared.authenticated).toBe(true);
  expect(prepared.env).toMatchObject({ GH_TOKEN: TOKEN, GH_PROMPT_DISABLED: '1' });
  const config = (key: string) =>
    execFileSync('git', ['config', '--file', prepared!.env.GIT_CONFIG_GLOBAL!, '--get', key])
      .toString()
      .trim();
  expect(config('user.name')).toBe('Ada "A" Lovelace');
  expect(config('user.email')).toBe('ada@example.com');
  expect(fill(prepared, 'github.com')).toContain(`password=${TOKEN}`);
  // No other host is handed the token.
  expect(() => fill(prepared!, 'gitlab.com')).toThrow();
  expect((await stat(prepared.env.GH_CONFIG_DIR!)).isDirectory()).toBe(true);
  const directory = prepared.directory;
  await prepared.close();
  prepared = undefined;
  await expect(stat(directory)).rejects.toThrow();
});

it('still gives git a readable global config with no token, and no credential helper', async () => {
  prepared = await prepareWorkerGithub({}, { run: runner({ name: 'Ada' }) });
  expect(prepared.authenticated).toBe(false);
  expect(prepared.env.GH_TOKEN).toBeUndefined();
  expect(() => fill(prepared!, 'github.com')).toThrow();
});

it("clears the session's own GitHub tokens from a worker that was named a token, also one that cannot be read", async () => {
  const broad = `ghp_${'b'.repeat(36)}`;
  const session = { GH_TOKEN: broad, GITHUB_TOKEN: broad, GITHUB_ENTERPRISE_TOKEN: broad };
  // The worker's environment is its parent's with this laid over it.
  const worker = (env: Record<string, string | undefined>) => ({ ...session, ...env });
  prepared = await prepareWorkerGithub(
    { ...session, TENJIN_WORKER_GITHUB_TOKEN_FILE: join(tmpdir(), 'tenjin-no-such-token') },
    { run: runner({ token: broad }) },
  );
  expect(prepared.authenticated).toBe(false);
  expect(Object.values(worker(prepared.env))).not.toContain(broad);
  // Its commands could still print it from the parent's memory of it: it stays replaced.
  expect(prepared.secrets).toContain(broad);
  await prepared.close();
  prepared = await prepareWorkerGithub(
    { ...session, TENJIN_WORKER_GITHUB_TOKEN: NAMED },
    { run: runner({ token: broad }) },
  );
  expect(worker(prepared.env)).toMatchObject({ GH_TOKEN: NAMED, GITHUB_TOKEN: '' });
  expect(Object.values(worker(prepared.env))).not.toContain(broad);
  await prepared.close();
  // No token named: the worker keeps what a native subagent has, the session's own.
  prepared = await prepareWorkerGithub(session, { run: runner({ token: broad }) });
  expect(worker(prepared.env)).toMatchObject({ GH_TOKEN: broad, GITHUB_TOKEN: broad });
});

it('redacts the job token and any inherited GitHub token everywhere they appear', async () => {
  const inherited = `ghp_${'k'.repeat(36)}`;
  const configured = `ghs_${'s'.repeat(36)}`;
  prepared = await prepareWorkerGithub(
    { GITHUB_TOKEN: inherited },
    { run: runner({ token: TOKEN }) },
  );
  expect(prepared.secrets.sort()).toEqual([TOKEN, inherited].sort());
  // A token in the person's settings env reaches the worker's commands as well.
  const secrets = [...prepared.secrets, ...workerTokenValues({ GH_TOKEN: configured })];
  expect(redactWorkerSecrets(`${TOKEN} and ${TOKEN}; ${inherited}; ${configured}`, secrets)).toBe(
    '[redacted GitHub token] and [redacted GitHub token]; [redacted GitHub token]; [redacted GitHub token]',
  );
});
