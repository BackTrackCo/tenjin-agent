// Independent replay identities and arbitration, exercised on the public seams.
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, expect, it } from 'vitest';
import * as state from './lib/state-store';
import { stopHookScript, SYNC_CLAIM_KEY, SYNC_CLAIM_TTL_MS } from './lib/hook-scripts';
import { pushFailureHookScript } from './lib/push-scripts';
import { runSync } from './commands/sync';
import { testSigner } from './lib/read-test-utils';

let root: string;
let data: string;
let calls: string;
let stub: string;
let server: ReturnType<typeof createServer>;
let url: string;
type KeyMessage = { keys: { key: string }[] };
let requests: { path: string | undefined; body: KeyMessage | null }[];
const silence = {
  stdout: { write: () => true },
  stderr: { write: () => true },
  isTTY: false,
};
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'replay-oracle-'));
  data = join(root, 'data');
  await mkdir(data);
  calls = join(root, 'calls.jsonl');
  stub = join(root, 'inert-cli.mjs');
  await writeFile(
    stub,
    `import {appendFileSync} from 'node:fs'; appendFileSync(${JSON.stringify(calls)}, JSON.stringify({argv:process.argv.slice(2),cwd:process.cwd()})+${JSON.stringify('\n')});`,
  );
  requests = [];
  server = createServer((req, res) => {
    let text = '';
    req.on('data', (part) => (text += part));
    req.on('end', () => {
      requests.push({ path: req.url, body: text ? JSON.parse(text) : null });
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          schemaVersion: 3,
          searchId: '11111111-1111-4111-8111-111111111111',
          calibration: 'key-v1',
          items: [],
          matched: 0,
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`;
  await writeFile(
    join(data, 'config.json'),
    JSON.stringify({
      baseUrl: url,
      publicShelfUrl: 'https://public.example',
      shelfBypassSecret: 'synthetic-benchmark-key',
      hooks: { push: 'on' },
    }),
  );
});
afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(root, { recursive: true, force: true });
});

async function repository(name: string, remote: string | null) {
  const repo = join(root, name);
  await mkdir(join(repo, '.git'), { recursive: true });
  await writeFile(
    join(repo, '.git/config'),
    remote ? `[remote "origin"]\n url = ${remote}\n` : '[core]\n bare = false\n',
  );
  return repo;
}
async function seed(cwd: string, suffix = 'one') {
  const store = await state.openStore(data);
  if (!store) throw new Error('Missing synthetic store');
  const uid = randomUUID(),
    at = Date.now() - 90000;
  store.run(state.STORE_SQL.insertPairing, [
    uid,
    at,
    'prior-session',
    state.projectId(cwd),
    'synthetic-machine',
    'sig_v1',
    `fine-${suffix}`,
    `coarse-${suffix}`,
    'pnpm',
    'pnpm test',
    'Error: ENOENT',
    JSON.stringify(['optic.ts']),
    '{}',
    'code',
  ]);
  store.run('UPDATE pairings SET status=?,closes=1,closed_at=?,fix_cmd=?,fix_files=? WHERE uid=?', [
    'unverified',
    at + 1000,
    'pnpm test',
    JSON.stringify(['optic.ts']),
    uid,
  ]);
  store.close();
  return uid;
}
async function script(source: string, input: unknown) {
  const file = join(root, randomUUID() + '.mjs');
  await writeFile(file, source);
  return new Promise<number | null>((resolve, reject) => {
    const child = spawn(process.execPath, [file], {
      env: { PATH: process.env.PATH ?? '', HOME: root },
      stdio: ['pipe', 'ignore', 'pipe'],
    });
    let errors = '';
    child.stderr.on('data', (chunk) => {
      errors += String(chunk);
    });
    const timer = setTimeout(() => child.kill('SIGKILL'), 6000);
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      if (errors.includes('SyntaxError') || errors.includes('ERR_MODULE_NOT_FOUND'))
        reject(new Error(errors));
      else resolve(code);
    });
    child.stdin.end(JSON.stringify(input));
  });
}
async function stop(cwd: string) {
  return script(stopHookScript(data, stub), {
    session_id: 'current-session',
    hook_event_name: 'Stop',
    cwd,
  });
}
async function observedCalls() {
  await sleep(500);
  try {
    return (await readFile(calls, 'utf8'))
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch (error: unknown) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return [];
    throw error;
  }
}
async function sync(cwd: string) {
  const sent: KeyMessage[] = [];
  const signer = testSigner();
  const provider = {
    id: 'local',
    describe: async () => ({
      address: signer.address,
      provider: 'local',
      credentialSource: 'file',
      policyEnforcement: 'client-only',
    }),
    getSigner: async () => signer,
    diagnostics: async () => ({ warnings: [] }),
  };
  const fetchImpl = (async (_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    sent.push(JSON.parse(String(init?.body)));
    return new Response(
      JSON.stringify({
        id: '11111111-1111-4111-8111-111111111111',
        slug: 'synthetic-optics',
        title: 'Synthetic optics repair',
        status: 'published',
        price: '0',
        url: url + '/a/fictional/optics',
        tags: [],
      }),
      { status: 201, headers: { 'content-type': 'application/json' } },
    );
  }) as typeof fetch;
  const result = await runSync(
    { flags: { json: true, timeout: 3000 }, dataDir: data, io: silence },
    { cwd, provider, fetchImpl },
  );
  return { result, sent };
}

it('resolve and publish agree across HTTPS, SCP and SSH, preserving host and full path', async () => {
  const remotes = [
    'https://forge.example/orbit/optics.git',
    'git@forge.example:orbit/optics.git',
    'ssh://git@forge.example/orbit/optics.git',
    'https://elsewhere.example/orbit/optics.git',
    'https://forge.example/fork/optics.git',
    'https://forge.example/orbit/team/optics.git',
  ];
  const scopes = [
    'forge.example/orbit/optics',
    'forge.example/orbit/optics',
    'forge.example/orbit/optics',
    'elsewhere.example/orbit/optics',
    'forge.example/fork/optics',
    'forge.example/orbit/team/optics',
  ];
  const resolveKeys: string[] = [];
  for (let i = 0; i < remotes.length; i++) {
    const repo = await repository('checkout' + i, remotes[i]!);
    const result = await script(pushFailureHookScript(data), {
      session_id: 'failure-' + i,
      cwd: repo,
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'pnpm test' },
      tool_response: {
        stdout: '',
        stderr:
          "Error: ENOENT: no such file or directory, open 'optic.ts'\n    at load (/workspace/optic.ts:8:2)\n",
        interrupted: false,
        isImage: false,
      },
    });
    expect(result).toBe(0);
    const wire = requests.filter((row) => row.path?.startsWith('/api/keys/resolve'));
    const inspection = await state.openStore(data);
    const reasons = inspection?.all('SELECT hook,action,reason FROM injections', []);
    inspection?.close();
    expect(wire, JSON.stringify(reasons)).toHaveLength(i + 1);
    const store = await state.openStore(data);
    if (!store) throw new Error('Missing store');
    const row = store.get('SELECT coarse_key FROM pairings WHERE project=?', [
      state.projectId(repo),
    ]) as { coarse_key: string };
    store.close();
    const expected =
      'sig_v1c:' +
      createHash('sha256')
        .update(row.coarse_key + '|' + scopes[i])
        .digest('hex')
        .slice(0, 16);
    const key = wire[i].body.keys.find((entry: { key: string }) =>
      entry.key.startsWith('sig_v1c:'),
    ).key;
    expect(key).toBe(expected);
    resolveKeys.push(key);
    await seed(repo, 'wire');
    const published = await sync(repo);
    const expectedPublished =
      'sig_v1c:' +
      createHash('sha256')
        .update('coarse-wire|' + scopes[i])
        .digest('hex')
        .slice(0, 16);
    expect(published.sent).toHaveLength(1);
    expect(
      published.sent[0].keys.some((entry: { key: string }) => entry.key === expectedPublished),
    ).toBe(true);
  }
  expect(new Set(resolveKeys.slice(0, 3)).size).toBe(1);
  expect(new Set([resolveKeys[0], ...resolveKeys.slice(3)]).size).toBe(4);
}, 60000);

it.each([null, '../local-clone'])(
  'an origin-less or local-path checkout stays local (%s)',
  async (remote) => {
    const repo = await repository('local', remote);
    const uid = await seed(repo);
    const result = await sync(repo);
    expect(result.sent).toEqual([]);
    expect(result.result.data).toMatchObject({ synced: 0 });
    const store = await state.openStore(data);
    if (!store) throw new Error('Missing store');
    expect(
      (
        store.get('SELECT synced_at FROM pairings WHERE uid=?', [uid]) as {
          synced_at: number | null;
        }
      ).synced_at,
    ).toBeNull();
    store.close();
    expect(await stop(repo)).toBe(0);
    expect(await observedCalls()).toEqual([]);
    await script(pushFailureHookScript(data), {
      session_id: 'local-failure',
      cwd: repo,
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'pnpm test' },
      tool_response: {
        stdout: '',
        stderr: "Error: ENOENT: no such file or directory, open 'optic.ts'\n",
        interrupted: false,
        isImage: false,
      },
    });
    expect(requests.filter((row) => row.path?.startsWith('/api/keys/resolve'))).toEqual([]);
  },
);

it.each(['alias', 'deep'])(
  'Stop passes the literal %s cwd and sync reads only that identity',
  async (mode) => {
    const repo = await repository('actual', 'git@forge.example:orbit/optics.git');
    const deep = join(repo, ...Array.from({ length: 18 }, (_, i) => 'level' + i));
    await mkdir(deep, { recursive: true });
    const alias = join(root, 'alias');
    await symlink(repo, alias, 'dir');
    const target = mode === 'alias' ? alias : deep;
    await seed(target, 'intended');
    await seed(mode === 'alias' ? deep : alias, 'different');
    expect(await stop(target)).toBe(0);
    const got = await observedCalls();
    expect(got).toHaveLength(1);
    expect(got[0].argv).toEqual(['sync', '--cwd', target]);
    expect(await realpath(got[0].cwd)).toBe(mode === 'alias' ? repo : deep);
    const published = await sync(target);
    expect(published.sent).toHaveLength(1);
    expect(
      published.sent[0].keys.some((entry: { key: string }) => entry.key === 'sig_v1:fine-intended'),
    ).toBe(true);
    expect(JSON.stringify(published.sent)).not.toContain('fine-different');
  },
);

it('a stale claim has one takeover winner', async () => {
  const repo = await repository('stale', 'https://forge.example/orbit/optics.git');
  await seed(repo);
  const store = await state.openStore(data);
  if (!store) throw new Error('Missing store');
  const at = Date.now() - SYNC_CLAIM_TTL_MS - 120000;
  store.run(state.STORE_SQL.setState, ['', SYNC_CLAIM_KEY, JSON.stringify({ at }), at]);
  store.close();
  expect(await Promise.all(Array.from({ length: 6 }, () => stop(repo)))).toEqual([
    0, 0, 0, 0, 0, 0,
  ]);
  expect(await observedCalls()).toHaveLength(1);
});

it('a stale claim deleted during acquisition is not resurrected or dispatched', async () => {
  const repo = await repository('deleted-claim', 'https://forge.example/orbit/optics.git');
  await seed(repo);
  const store = await state.openStore(data);
  if (!store) throw new Error('Missing store');
  const at = Date.now() - SYNC_CLAIM_TTL_MS - 120000;
  expect(
    store.run(state.STORE_SQL.setState, ['', SYNC_CLAIM_KEY, JSON.stringify({ at }), at]),
  ).toBe(true);
  expect(store.run('CREATE TABLE oracle_claim_deletions (n INTEGER NOT NULL)', [])).toBe(true);
  expect(store.run('INSERT INTO oracle_claim_deletions VALUES (0)', [])).toBe(true);
  expect(
    store.run(
      `CREATE TRIGGER delete_stale_claim BEFORE INSERT ON session_state
    WHEN NEW.session='' AND NEW.key='sync:claim' AND EXISTS (SELECT 1 FROM session_state WHERE session='' AND key='sync:claim')
    BEGIN DELETE FROM session_state WHERE session='' AND key='sync:claim';
    UPDATE oracle_claim_deletions SET n=n+1; SELECT RAISE(IGNORE); END`,
      [],
    ),
  ).toBe(true);
  store.close();
  expect(await stop(repo)).toBe(0);
  expect(await observedCalls()).toEqual([]);
  const reopened = await state.openStore(data);
  if (!reopened) throw new Error('Missing store');
  expect(reopened.get('SELECT n FROM oracle_claim_deletions', [])).toEqual({ n: 1 });
  expect(
    reopened.get('SELECT * FROM session_state WHERE session=? AND key=?', ['', SYNC_CLAIM_KEY]),
  ).toBeNull();
  reopened.close();
});

it('a refused claim write never spawns automatic sync', async () => {
  const repo = await repository('readonly', 'https://forge.example/orbit/optics.git');
  await seed(repo);
  const store = await state.openStore(data);
  if (!store) throw new Error('Missing store');
  store.run(
    "CREATE TRIGGER blocked_claim BEFORE INSERT ON session_state BEGIN SELECT RAISE(ABORT,'synthetic full disk'); END",
    [],
  );
  store.close();
  expect(await stop(repo)).toBe(0);
  expect(await observedCalls()).toEqual([]);
});

it('the CLI rejects an explicitly empty cwd', async () => {
  const { main } = await import('./cli');
  const output: string[] = [];
  const sink = {
    write: (value: unknown) => {
      output.push(String(value));
      return true;
    },
  };
  const io = { stdout: sink, stderr: sink, isTTY: false };
  expect(await main(['sync', '--cwd', ''], io)).toBe(2);
  expect(output.join('')).toMatch(/cwd|argument/i);
  expect(await observedCalls()).toEqual([]);
});
