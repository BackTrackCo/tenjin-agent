// Independent historical team-learning contracts, exercised on public seams.
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, expect, it } from 'vitest';
import * as state from './lib/state-store';
import { stopHookScript, sessionPrimerHookScript } from './lib/hook-scripts';
import { pushFailureHookScript, pushPromptHookScript } from './lib/push-scripts';
import { existsSync } from 'node:fs';
async function ready() {
  expect(existsSync(join(process.cwd(), 'src/commands/sync.ts')), 'team sync feature exists').toBe(
    true,
  );
  return import('./commands/sync');
}
import { testSigner } from './lib/read-test-utils';

let root: string;
let data: string;
let calls: string;
let stub: string;
let server: ReturnType<typeof createServer>;
let url: string;
type KeyMessage = { keys: { key: string }[] };
type JsonBody = Record<string, unknown>;
let requests: { path: string | undefined; body: JsonBody | null }[];
let reply: (path: string) => { status: number; body: unknown };
let lastOutput: string;
let syncRequests: { url: string; method: string; body: KeyMessage }[];
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
  syncRequests = [];
  reply = () => ({
    status: 200,
    body: {
      schemaVersion: 3,
      searchId: '11111111-1111-4111-8111-111111111111',
      calibration: 'key-v1',
      items: [],
      matched: 0,
    },
  });
  server = createServer((req, res) => {
    let text = '';
    req.on('data', (part) => (text += part));
    req.on('end', () => {
      requests.push({ path: req.url, body: text ? JSON.parse(text) : null });
      res.setHeader('content-type', 'application/json');
      const result = reply(req.url ?? '');
      res.statusCode = result.status;
      res.end(JSON.stringify(result.body));
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
  expect(
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
    ]),
  ).toBe(true);
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
  lastOutput = '';
  return new Promise<number | null>((resolve, reject) => {
    const child = spawn(process.execPath, [file], {
      env: { PATH: process.env.PATH ?? '', HOME: root },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (chunk) => {
      lastOutput += String(chunk);
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
async function sync(
  cwd: string,
  response?: (init?: RequestInit) => Response,
  brokenSigner = false,
) {
  const { runSync } = await ready();
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
    getSigner: async () => {
      if (brokenSigner) {
        const { CliError } = await import('./lib/errors');
        throw new CliError('REFUSED', 'synthetic signer refusal');
      }
      return signer;
    },
    diagnostics: async () => ({ warnings: [] }),
  };
  const fetchImpl = (async (_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    sent.push(JSON.parse(String(init?.body)));
    syncRequests.push({ url: String(_url), method: init?.method ?? 'GET', body: sent.at(-1)! });
    if (response) return response(init);
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
      {
        status: init?.method === 'PUT' ? 200 : 201,
        headers: { 'content-type': 'application/json' },
      },
    );
  }) as typeof fetch;
  const result = await runSync(
    { flags: { json: true, timeout: 3000 }, dataDir: data, io: silence },
    { cwd, provider, fetchImpl, useSession: false, env: {} },
  );
  return { result, sent };
}

async function failure(cwd: string, session = randomUUID()) {
  await ready();
  return script(pushFailureHookScript(data), {
    session_id: session,
    cwd,
    hook_event_name: 'PostToolUse',
    tool_name: 'Bash',
    tool_input: { command: 'pnpm test' },
    tool_response: {
      stdout: '',
      stderr:
        'Error: ENOENT synthetic calibration input missing\n    at calibrate (/fictional/optic.ts:22:4)',
      interrupted: false,
      isImage: false,
    },
  });
}
async function store() {
  const s = await state.openStore(data);
  if (!s) throw new Error('Synthetic store absent');
  return s;
}
it('failure lookup transmits only fine and raw-origin-salted coarse keys and persists its MISS receipt', async () => {
  const remote = 'https://forge.example/optics/range.git';
  const repo = await repository('repo', remote);
  expect(await failure(repo)).toBe(0);
  expect(requests).toHaveLength(1);
  expect(requests[0].path).toBe('/api/keys/resolve');
  expect(requests[0].body).toMatchObject({ trigger: 'failure', limit: 3 });
  const s = await store();
  try {
    const row = s.get('SELECT key,coarse_key FROM pairings LIMIT 1') as {
      key: string;
      coarse_key: string;
    };
    expect(row).toBeTruthy();
    expect(requests[0].body).toEqual({
      trigger: 'failure',
      limit: 3,
      keys: [
        { kind: 'fingerprint', key: 'sig_v1:' + row.key },
        {
          kind: 'fingerprint',
          key:
            'sig_v1c:' +
            createHash('sha256')
              .update(row.coarse_key + '|' + remote)
              .digest('hex')
              .slice(0, 16),
        },
      ],
    });
    expect(JSON.stringify(requests)).not.toContain('calibration input missing');
    expect(JSON.stringify(s.all('SELECT search_id FROM injections', []))).toContain(
      '11111111-1111-4111-8111-111111111111',
    );
  } finally {
    s.close();
  }
});
it.each([
  { price: '0', body: true },
  { price: '100000', body: false },
])('exact team-key delivery respects free versus paid price $price', async ({ price, body }) => {
  const repo = await repository('repo', 'https://forge.example/optics/range.git');
  const resource = '22222222-2222-4222-8222-222222222222';
  reply = (path) => ({
    status: 200,
    body: path.startsWith('/api/keys')
      ? {
          schemaVersion: 3,
          searchId: '11111111-1111-4111-8111-111111111111',
          calibration: 'key-v1',
          items: [
            {
              resourceId: resource,
              url: url + '/a/fictional/fix',
              title: 'Optical fixture repair',
              price,
              excerpt: 'A verified calibration rule',
              creator: { handle: 'fictional' },
              confidence: 0.1,
              corroborated: false,
            },
          ],
          matched: 1,
        }
      : { bodyMd: 'Use the measured calibration interval, not the raw endpoint.' },
  });
  expect(await failure(repo)).toBe(0);
  if (body) {
    expect(lastOutput).toContain('measured calibration interval');
    expect(lastOutput).toContain('tenjin-body');
  } else {
    expect(lastOutput).toContain('tenjin inspect');
    expect(lastOutput).not.toContain('measured calibration interval');
    expect(lastOutput).not.toContain('tenjin-body');
  }
  expect(requests.some((x) => x.path === '/a/fictional/fix')).toBe(body);
  const s = await store();
  try {
    expect(JSON.stringify(s.all('SELECT * FROM session_state', []))).toContain(resource);
  } finally {
    s.close();
  }
});
it('a 404 key endpoint installs a cross-session hold', async () => {
  const repo = await repository('repo', 'https://forge.example/optics/range.git');
  reply = () => ({ status: 404, body: { error: 'disabled' } });
  await failure(repo, 'first');
  expect(requests).toHaveLength(1);
  await failure(repo, 'second');
  expect(requests).toHaveLength(1);
  const s = await store();
  try {
    expect(JSON.stringify(s.all('SELECT * FROM session_state', []))).toMatch(
      /keys.*off|keys.*disabled/i,
    );
  } finally {
    s.close();
  }
});
it('publishes a bounded free cardless pairing with exact fingerprints once and records ownership', async () => {
  const remote = 'https://forge.example/optics/range.git';
  const repo = await repository('repo', remote);
  const uid = await seed(repo);
  const { sent } = await sync(repo);
  expect(sent).toHaveLength(1);
  const body = sent[0] as unknown as JsonBody;
  expect(body).toMatchObject({ status: 'published', price: '0' });
  expect(body).not.toHaveProperty('resource');
  expect(String(body.title).length).toBeLessThanOrEqual(120);
  expect(String(body.bodyMd).length).toBeLessThanOrEqual(300);
  expect(String(body.bodyMd)).toContain('optic.ts');
  expect(sent[0].keys.map((x) => x.key)).toEqual(
    expect.arrayContaining([
      'sig_v1:fine-one',
      'sig_v1c:' +
        createHash('sha256')
          .update('coarse-one|' + remote)
          .digest('hex')
          .slice(0, 16),
    ]),
  );
  const s = await store();
  try {
    expect(
      (s.get('SELECT synced_at FROM pairings WHERE uid=?', [uid]) as { synced_at: number })
        .synced_at,
    ).toBeGreaterThan(0);
    expect(
      JSON.stringify(
        s
          .all('SELECT value FROM session_state WHERE key LIKE ?', ['pairing_post:%'])
          .map((row) => JSON.parse(String(row.value))),
      ),
    ).toContain('"own":true');
  } finally {
    s.close();
  }
  expect((await sync(repo)).sent).toEqual([]);
});
it('public mode refuses and only eligible same-project closed code rows enter publication', async () => {
  const repo = await repository('repo', null);
  const other = await repository('other', null);
  await seed(other);
  const uid = await seed(repo);
  const s = await store();
  try {
    expect(s.run("UPDATE pairings SET scope='user' WHERE uid=?", [uid])).toBe(true);
  } finally {
    s.close();
  }
  expect((await sync(repo)).sent).toEqual([]);
  await writeFile(
    join(data, 'config.json'),
    JSON.stringify({ baseUrl: url, publicShelfUrl: url, hooks: { push: 'on' } }),
  );
  await expect(sync(repo)).rejects.toMatchObject({ code: 'REFUSED' });
});
it('a failed publication link stays retryable instead of stamping the pairing synced', async () => {
  const repo = await repository('repo', 'https://forge.example/optics/range.git');
  const uid = await seed(repo);
  let s = await store();
  expect(
    s.run(
      "CREATE TRIGGER deny_link BEFORE INSERT ON session_state WHEN NEW.key LIKE 'pairing_post:%' BEGIN SELECT RAISE(ABORT, 'synthetic link refusal'); END",
      [],
    ),
  ).toBe(true);
  s.close();
  await sync(repo);
  s = await store();
  try {
    expect(
      (s.get('SELECT synced_at FROM pairings WHERE uid=?', [uid]) as { synced_at: null }).synced_at,
    ).toBeNull();
    expect(s.run('DROP TRIGGER deny_link', [])).toBe(true);
  } finally {
    s.close();
  }
  expect((await sync(repo)).sent).toHaveLength(1);
});
it('outages and signer failures abort pending work with distinct telemetry and preserve retry', async () => {
  const repo = await repository('repo', null);
  const uid = await seed(repo);
  await expect(sync(repo, () => new Response('{}', { status: 503 }))).rejects.toMatchObject({
    code: 'PUBLISH_FAILED',
  });
  let s = await store();
  try {
    expect(
      (s.get('SELECT synced_at FROM pairings WHERE uid=?', [uid]) as { synced_at: null }).synced_at,
    ).toBeNull();
    expect(JSON.stringify(s.all("SELECT data FROM events WHERE hook='sync'", []))).toContain(
      'error',
    );
  } finally {
    s.close();
  }
  await expect(sync(repo, undefined, true)).rejects.toMatchObject({ code: 'PUBLISH_FAILED' });
  s = await store();
  try {
    expect(JSON.stringify(s.all("SELECT data FROM events WHERE hook='sync'", []))).toContain(
      'code',
    );
    expect(
      (s.get('SELECT synced_at FROM pairings WHERE uid=?', [uid]) as { synced_at: null }).synced_at,
    ).toBeNull();
  } finally {
    s.close();
  }
  expect((await sync(repo)).sent).toHaveLength(1);
});
it('Stop schedules one inert sync child for pending team work and respects the live claim', async () => {
  await ready();
  const repo = await repository('repo', 'https://forge.example/optics/range.git');
  await seed(repo);
  expect(await stop(repo)).toBe(0);
  let got = await observedCalls();
  expect(got).toHaveLength(1);
  expect(got[0]).toEqual({ argv: ['sync'], cwd: repo });
  expect(await stop(repo)).toBe(0);
  got = await observedCalls();
  expect(got).toHaveLength(1);
});
it('Stop does not start a child for an empty queue or absent baked CLI', async () => {
  await ready();
  const repo = await repository('repo', null);
  await stop(repo);
  expect(await observedCalls()).toEqual([]);
  await seed(repo);
  await script(stopHookScript(data, null), {
    session_id: 'quiet',
    hook_event_name: 'Stop',
    cwd: repo,
  });
  expect(await observedCalls()).toEqual([]);
});
it('scores all five historical patterns once with the specified recency multiplier', async () => {
  await ready();
  const { scoreSession } = await import('./commands/push');
  const event = (
    at: number,
    hook: string,
    tool: string | null = 'Edit',
    files = ['optic.ts'],
    command: string | null = null,
    head: string | null = null,
  ) => ({ at, hook, tool, files, command, head, agentId: null });
  const events = [
    event(1, 'research'),
    event(2, 'edit'),
    event(3, 'prompt', null),
    event(4, 'edit'),
    event(5, 'edit'),
    event(6, 'edit', 'Write'),
    event(7, 'failure', 'Bash', [], 'pnpm test'),
    event(8, 'edit'),
    event(9, 'pass', 'Bash', [], null, 'pnpm'),
  ];
  expect(
    scoreSession({ events: [...events].reverse(), closes: [], searches: [], endedAt: 9 }),
  ).toEqual({
    score: 15.6,
    bonus: 1.3,
    patterns: [
      'error-edit-resolved',
      'edit-across-prompt',
      'write-over-edited',
      'fail-edit-pass',
      'research-then-edit',
    ],
  });
  expect(scoreSession({ events, closes: [], searches: [], endedAt: 150009 })).toMatchObject({
    score: 13.8,
    bonus: 1.15,
  });
  expect(scoreSession({ events, closes: [], searches: [], endedAt: 300009 })).toMatchObject({
    score: 12,
    bonus: 1,
  });
  const negative = [
    event(1, 'research'),
    event(2, 'failure', 'Bash', [], 'pnpm test'),
    event(3, 'edit', 'Edit', ['optic.test.ts']),
    event(4, 'pass', 'Bash', [], null, 'python'),
  ];
  expect(
    scoreSession({ events: negative, closes: [], searches: [], endedAt: 400000 }).patterns,
  ).toEqual(['error-edit-resolved']);
});
it('SessionStart stores measured seven-day trigger counts even when primer text is off', async () => {
  await ready();
  reply = () => ({
    status: 200,
    body: {
      windowDays: 7,
      triggers: [{ trigger: 'prompt', lookups: 20, hits: 20, used: 2, wrong: 3 }],
    },
  });
  await writeFile(
    join(data, 'config.json'),
    JSON.stringify({
      baseUrl: url,
      publicShelfUrl: 'https://public.example',
      shelfBypassSecret: 'synthetic-benchmark-key',
      hooks: { push: 'on', sessionPrimer: 'off' },
    }),
  );
  expect(
    await script(sessionPrimerHookScript(data), {
      session_id: 'measured',
      hook_event_name: 'SessionStart',
      cwd: root,
    }),
  ).toBe(0);
  expect(lastOutput).toBe('');
  expect(requests.map((x) => x.path)).toContain('/api/lookups/stats?days=7');
  const s = await store();
  try {
    expect(
      JSON.stringify(
        s
          .all('SELECT key,value FROM session_state WHERE session=?', ['measured'])
          .map((row) => ({ key: row.key, value: JSON.parse(String(row.value)) })),
      ),
    ).toContain('trigger_rates');
    expect(
      JSON.stringify(
        s
          .all('SELECT key,value FROM session_state WHERE session=?', ['measured'])
          .map((row) => ({ key: row.key, value: JSON.parse(String(row.value)) })),
      ),
    ).toContain('"used":2');
  } finally {
    s.close();
  }
});
it.each([
  { label: 'hot', hits: 20, used: 2, wrong: 3, spent: 8, allowed: true },
  { label: 'hot ceiling', hits: 20, used: 2, wrong: 3, spent: 16, allowed: false },
  { label: 'ungraded', hits: 900, used: 0, wrong: 0, spent: 2, allowed: true },
  { label: 'cold', hits: 20, used: 0, wrong: 20, spent: 2, allowed: false },
  { label: 'small cold sample', hits: 19, used: 0, wrong: 19, spent: 2, allowed: true },
  { label: 'boundary five percent', hits: 20, used: 1, wrong: 19, spent: 2, allowed: true },
])(
  'adaptive prompt allowance uses graded counts: $label',
  async ({ hits, used, wrong, spent, allowed }) => {
    await ready();
    const session = 'adaptive-session';
    const s = await store();
    try {
      expect(
        s.run('INSERT INTO session_state(session,key,value,at) VALUES(?,?,?,?)', [
          session,
          'trigger_rates',
          JSON.stringify({
            at: Date.now(),
            days: 7,
            triggers: { prompt: { lookups: 900, hits, used, wrong, useRate: 1 } },
          }),
          Date.now(),
        ]),
      ).toBe(true);
      for (let i = 0; i < spent; i++)
        expect(
          s.run(state.STORE_SQL.insertInjection, [
            randomUUID(),
            null,
            Date.now() - 1000,
            'other-session',
            state.projectId(root),
            'fictional',
            'prompt',
            'team',
            null,
            null,
            null,
            null,
            randomUUID(),
            null,
            null,
            null,
            null,
            null,
            'none',
            'miss',
            null,
            null,
            0,
          ]),
        ).toBe(true);
    } finally {
      s.close();
    }
    await script(pushPromptHookScript(data), {
      session_id: session,
      cwd: root,
      hook_event_name: 'UserPromptSubmit',
      prompt: 'Investigate the optical calibration algorithm and repair its range normalization.',
    });
    expect(requests.some((x) => x.path === '/api/search')).toBe(allowed);
  },
);
it('every tenth cold suppression escapes only while the original allowance remains', async () => {
  await ready();
  const session = 'cold-escape';
  const s = await store();
  try {
    expect(
      s.run('INSERT INTO session_state(session,key,value,at) VALUES(?,?,?,?)', [
        session,
        'trigger_rates',
        JSON.stringify({ triggers: { prompt: { hits: 20, used: 0, wrong: 20 } } }),
        Date.now(),
      ]),
    ).toBe(true);
    for (let i = 0; i < 2; i++)
      expect(
        s.run(state.STORE_SQL.insertInjection, [
          randomUUID(),
          null,
          Date.now() - 1000,
          'other-session',
          state.projectId(root),
          'fictional',
          'prompt',
          'team',
          null,
          null,
          null,
          null,
          randomUUID(),
          null,
          null,
          null,
          null,
          null,
          'none',
          'miss',
          null,
          null,
          0,
        ]),
      ).toBe(true);
  } finally {
    s.close();
  }
  for (let i = 0; i < 9; i++)
    await script(pushPromptHookScript(data), {
      session_id: session,
      cwd: root,
      hook_event_name: 'UserPromptSubmit',
      prompt: `Investigate calibration scenario ${i}, inspect the optical normalization algorithm, and correct its independent range behavior.`,
    });
  expect(requests).toEqual([]);
  await script(pushPromptHookScript(data), {
    session_id: session,
    cwd: root,
    hook_event_name: 'UserPromptSubmit',
    prompt:
      'Investigate the tenth calibration scenario, inspect the optical normalization algorithm, and correct its independent range behavior.',
  });
  expect(requests.some((x) => x.path === '/api/search')).toBe(true);
});

it.each([true, false])(
  'verified publication respects own versus teammate link: own=$0',
  async (own) => {
    const repo = await repository('linked', 'https://forge.example/optics/range.git');
    const uid = await seed(repo);
    const s = await store();
    const at = Date.now() - 5000;
    const postId = '11111111-1111-4111-8111-111111111111';
    try {
      const row = s.get('SELECT id FROM pairings WHERE uid=?', [uid]) as { id: number };
      expect(
        s.run('UPDATE pairings SET status=?,synced_at=?,closed_at=? WHERE uid=?', [
          own ? 'verified' : 'unverified',
          own ? at : null,
          at + 1000,
          uid,
        ]),
      ).toBe(true);
      expect(
        s.run('INSERT INTO session_state(session,key,value,at) VALUES(?,?,?,?)', [
          '',
          'pairing_post:' + row.id,
          JSON.stringify({ postId, origin: url, at, ...(own ? { own: true } : {}) }),
          at,
        ]),
      ).toBe(true);
    } finally {
      s.close();
    }
    await sync(repo);
    expect(syncRequests).toHaveLength(1);
    expect(syncRequests[0]).toMatchObject({
      method: own ? 'PUT' : 'POST',
      url: url + '/api/posts' + (own ? '/' + postId : ''),
    });
    expect(syncRequests[0].body.keys).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: 'fingerprint', verified: true })]),
    );
  },
);
it('permanent scanner rejection advances the queue without publishing its inert credential marker', async () => {
  const repo = await repository('scan', null);
  const blocked = await seed(repo, 'blocked');
  const clean = await seed(repo, 'clean');
  const s = await store();
  try {
    expect(
      s.run('UPDATE pairings SET at=?,fix_cmd=? WHERE uid=?', [
        Date.now() - 200000,
        'AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE pnpm test',
        blocked,
      ]),
    ).toBe(true);
    expect(s.run('UPDATE pairings SET at=? WHERE uid=?', [Date.now() - 100000, clean])).toBe(true);
  } finally {
    s.close();
  }
  await sync(repo);
  expect(syncRequests).toHaveLength(1);
  expect(JSON.stringify(syncRequests)).not.toContain('AKIAIOSFODNN7EXAMPLE');
  expect(JSON.stringify(syncRequests)).toContain('fine-clean');
  const after = await store();
  try {
    expect(
      after
        .all('SELECT synced_at FROM pairings', [])
        .every((row) => typeof row.synced_at === 'number'),
    ).toBe(true);
  } finally {
    after.close();
  }
});
it('an ordinary outage stops before a second queued row and never records a signing code', async () => {
  const repo = await repository('queue', null);
  await seed(repo, 'first');
  await seed(repo, 'second');
  await expect(sync(repo, () => new Response('{}', { status: 503 }))).rejects.toThrow();
  expect(syncRequests).toHaveLength(1);
  const s = await store();
  try {
    expect(s.all('SELECT synced_at FROM pairings', []).map((row) => row.synced_at)).toEqual([
      null,
      null,
    ]);
    const rows = s.all("SELECT data FROM events WHERE hook='sync' ORDER BY at DESC", []);
    const event = JSON.parse(String(rows[0].data));
    expect(event).toHaveProperty('error');
    expect(event).not.toHaveProperty('code');
  } finally {
    s.close();
  }
});
it('a closed local pairing wins before any team fingerprint lookup', async () => {
  const repo = await repository('local', 'https://forge.example/optics/range.git');
  await failure(repo, 'open');
  const s = await store();
  try {
    expect(
      s.run(
        "UPDATE pairings SET status='unverified',scope='code',closes=1,closed_at=?,fix_cmd='pnpm test',fix_files=?",
        [Date.now(), JSON.stringify(['optic.ts'])],
      ),
    ).toBe(true);
  } finally {
    s.close();
  }
  requests = [];
  await failure(repo, 'replay');
  expect(requests).toEqual([]);
  expect(lastOutput).toContain('pnpm test');
  const after = await store();
  try {
    expect(
      after
        .all("SELECT shelf FROM injections WHERE session='replay'", [])
        .some((row) => row.shelf === 'local'),
    ).toBe(true);
  } finally {
    after.close();
  }
});

it('verified-key holder collisions retain ownership and allow later queued publication', async () => {
  const repo = await repository('holder', 'https://forge.example/optics/range.git');
  const first = await seed(repo, 'held');
  const second = await seed(repo, 'following');
  const holder = '33333333-3333-4333-8333-333333333333';
  const s = await store();
  let firstId: number;
  try {
    firstId = (s.get('SELECT id FROM pairings WHERE uid=?', [first]) as { id: number }).id;
    expect(s.run('UPDATE pairings SET at=? WHERE uid=?', [Date.now() - 200000, first])).toBe(true);
    expect(s.run('UPDATE pairings SET at=? WHERE uid=?', [Date.now() - 100000, second])).toBe(true);
  } finally {
    s.close();
  }
  await sync(repo, () =>
    syncRequests.length === 1
      ? new Response(
          JSON.stringify({
            error: {
              message: 'fingerprint is already verified on post ' + holder,
              details: {
                fieldErrors: { keys: ['fingerprint key is already verified on post ' + holder] },
              },
            },
          }),
          { status: 400 },
        )
      : new Response(
          JSON.stringify({
            id: '11111111-1111-4111-8111-111111111111',
            slug: 'independent',
            title: 'Independent optics',
            status: 'published',
            price: '0',
            url: url + '/a/fictional/independent',
            tags: [],
          }),
          { status: 201 },
        ),
  );
  expect(syncRequests).toHaveLength(2);
  expect(syncRequests.every((row) => row.method === 'POST' && !row.url.includes(holder))).toBe(
    true,
  );
  const after = await store();
  try {
    const link = after.get('SELECT value FROM session_state WHERE session=? AND key=?', [
      '',
      'pairing_post:' + firstId!,
    ]) as { value: string };
    expect(JSON.parse(link.value)).toMatchObject({ postId: holder, held: true });
    expect(
      after
        .all('SELECT synced_at FROM pairings', [])
        .every((row) => typeof row.synced_at === 'number'),
    ).toBe(true);
  } finally {
    after.close();
  }
});
it('database-backed status keeps worker events separate and exposes capture and publication observations', async () => {
  await ready();
  const { readSessionScores, runPushStatus } = await import('./commands/push');
  const s = await store();
  const clock = Date.now();
  const start = clock - 60000;
  try {
    for (const session of ['split', 'whole'])
      expect(
        s.run(
          'INSERT INTO sessions(session,project,cwd,started_at,ended_at,machine) VALUES(?,?,?,?,?,?)',
          [session, state.projectId(root), root, start, start + 10000, 'synthetic'],
        ),
      ).toBe(true);
    const event = (
      session: string,
      agentId: string | null,
      at: number,
      hook: string,
      tool: string,
      command: string | null,
      head: string | null,
    ) =>
      expect(
        s.run(state.STORE_SQL.insertEvent, [
          randomUUID(),
          at,
          session,
          state.projectId(root),
          'synthetic',
          hook,
          tool,
          null,
          JSON.stringify(hook === 'edit' ? ['optic.ts'] : []),
          JSON.stringify({ agentId, command, head }),
        ]),
      ).toBe(true);
    event('split', null, start + 1, 'prompt', 'UserPromptSubmit', null, null);
    event('split', 'worker-a', start + 2, 'failure', 'Bash', 'pnpm test', null);
    event('split', 'worker-b', start + 3, 'edit', 'Edit', null, null);
    event('split', 'worker-b', start + 4, 'pass', 'Bash', null, 'pnpm');
    event('whole', 'worker-c', start + 2, 'failure', 'Bash', 'pnpm test', null);
    event('whole', 'worker-c', start + 3, 'edit', 'Edit', null, null);
    event('whole', 'worker-c', start + 4, 'pass', 'Bash', null, 'pnpm');
    expect(
      s.run('INSERT INTO session_state(session,key,value,at) VALUES(?,?,?,?)', [
        'split',
        'capture_asked',
        'true',
        start + 5,
      ]),
    ).toBe(true);
    expect(
      s.run('INSERT INTO session_state(session,key,value,at) VALUES(?,?,?,?)', [
        '',
        'published:fixture',
        'true',
        start + 6,
      ]),
    ).toBe(true);
  } finally {
    s.close();
  }
  const rows = await readSessionScores(data, clock);
  expect(rows).toHaveLength(4);
  const split = rows.filter((row) => row.session === 'split');
  expect(split).toHaveLength(3);
  expect(
    split.every((row) => row.score === 0 && !row.patterns.includes('error-edit-resolved')),
  ).toBe(true);
  expect(split.filter((row) => row.captureAsked).map((row) => row.agent)).toEqual([null]);
  expect(rows.every((row) => row.published === 1)).toBe(true);
  expect(rows[0]).toMatchObject({ session: 'whole', agent: 'worker-c' });
  expect(rows[0].score).toBeGreaterThan(0);
  const deps = {
    scriptsWired: async () => false,
    hookEntries: async () => ({ present: 0, planned: 4, path: null }),
    lookupStats: async () => null,
    now: () => clock,
    homeDir: root,
  };
  const ctx = { flags: { json: true, timeout: 2000 }, dataDir: data, io: silence };
  const report = await runPushStatus(ctx, deps, { sessions: true });
  expect(report.data).toHaveProperty('sessions', rows);
  expect(report.humanLines.join('\n')).toContain('worker-c');
  expect((await runPushStatus(ctx, deps)).data).not.toHaveProperty('sessions');
});
