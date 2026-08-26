import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm, writeFile, chmod, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  RETIRED_STATE_ENTRIES,
  STATE_DB_FILE,
  STORE_DDL,
  STORE_SQL,
  STORE_USER_VERSION,
  openStore,
  probeSqlite,
  removeRetiredState,
  storeSource,
} from './state-store';
import { pushContextHookScript, pushFailureHookScript, pushPromptHookScript } from './push-scripts';
import {
  dispatchHookScript,
  sessionPrimerHookScript,
  stopHookScript,
  websearchHookScript,
} from './hook-scripts';

/**
 * The store's own suite. Like `hook-scripts.test.ts` it runs the REAL generated
 * bytes as child processes: the scripts never go through the bundler, their
 * whole contract is process behaviour, and a unit test of an extracted helper
 * would pass on a script that crashes at its first `await import`.
 *
 * Every case gets its own temp data dir. `~/.tenjin` on a developer machine is
 * live state, and nothing here may go near it.
 */

let dataDir: string;
let scriptDir: string;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'tenjin-store-data-'));
  scriptDir = await mkdtemp(join(tmpdir(), 'tenjin-store-bin-'));
});

afterEach(async () => {
  await chmod(dataDir, 0o700).catch(() => undefined);
  await rm(dataDir, { recursive: true, force: true });
  await rm(scriptDir, { recursive: true, force: true });
});

interface HookRun {
  code: number | null;
  stdout: string;
  stderr: string;
}

async function runScript(
  source: string,
  stdin: string,
  env: Record<string, string> = {},
): Promise<HookRun> {
  const path = join(scriptDir, `hook-${Math.random().toString(36).slice(2)}.mjs`);
  await writeFile(path, source, { mode: 0o755 });
  return await new Promise<HookRun>((resolve, reject) => {
    const child = spawn(process.execPath, [path], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { PATH: process.env.PATH ?? '', ...env },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => (stdout += String(c)));
    child.stderr.on('data', (c) => (stderr += String(c)));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(stdin);
  });
}

async function writeConfig(extra: Record<string, unknown> = {}): Promise<void> {
  await writeFile(
    join(dataDir, 'config.json'),
    JSON.stringify({ hooks: { push: 'on', webSearch: 'auto' }, ...extra }),
  );
}

function db(): DatabaseSync {
  return new DatabaseSync(join(dataDir, STATE_DB_FILE));
}

function rows(sql: string, params: (string | number)[] = []): Record<string, unknown>[] {
  const handle = db();
  try {
    return handle.prepare(sql).all(...params) as unknown as Record<string, unknown>[];
  } finally {
    handle.close();
  }
}

/** A local server standing in for a shelf. */
async function serveSearch(
  handler: (baseUrl: string) => { status: number; json: unknown },
): Promise<{ baseUrl: string; hits: () => number; close: () => Promise<void> }> {
  const { createServer } = await import('node:http');
  let hits = 0;
  let baseUrl = '';
  const server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      hits += 1;
      const { status, json } = handler(baseUrl);
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(json));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  baseUrl = `http://127.0.0.1:${port}`;
  return {
    baseUrl,
    hits: () => hits,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** A valid searchId; the hook drops a whole response whose id is not a uuid. */
const SEARCH_ID = '22222222-2222-4222-8222-222222222222';
const RANK_TWO_ID = '33333333-3333-4333-8333-333333333333';

/**
 * A response the judge reads as STRONG: rank 1's title is exactly the query's
 * content words, rank 2 shares none of them so the margin is rank 1's whole
 * score. PAID, so the arm takes the short form and never fetches a body — this
 * suite is about rows, not about rendering.
 *
 * Candidate urls are re-homed onto the stub's origin: the hook drops a candidate
 * pointing anywhere but the configured base, because an off-origin url is a
 * payable pointer at a host the operator never chose.
 */
function strongAnswer(baseUrl: string, resourceId: string, title: string): unknown {
  return {
    schemaVersion: 3,
    searchId: SEARCH_ID,
    calibration: 'ok',
    matched: 2,
    items: [
      {
        resourceId,
        url: `${baseUrl}/@a/p`,
        slug: 'p',
        title,
        artifactType: 'document',
        price: '150000',
        asOf: null,
        validUntil: null,
        matchReasons: ['exact version match'],
        estimatedTokens: 900,
        creator: { handle: 'a' },
      },
      {
        resourceId: RANK_TWO_ID,
        url: `${baseUrl}/@b/q`,
        slug: 'q',
        title: 'unrelated filler about quarterly billing',
        artifactType: 'document',
        price: '150000',
        asOf: null,
        validUntil: null,
        matchReasons: [],
        estimatedTokens: 900,
        creator: { handle: 'b' },
      },
    ],
  };
}

/** A query whose content words are exactly the title below and nothing else. */
const STRONG_TITLE = 'Drizzle snapshot handpatch trap explained';
const STRONG_QUERY = 'Drizzle snapshot handpatch trap explained. '.repeat(3);

describe('storeSource stays in sync with the module', () => {
  it('bakes the DDL, the version and every statement into the generated source', () => {
    const source = storeSource();
    expect(source).toContain(JSON.stringify(STORE_DDL));
    expect(source).toContain(`const STORE_USER_VERSION = ${STORE_USER_VERSION};`);
    for (const [name, sql] of Object.entries(STORE_SQL)) {
      // Interpolated as one JSON object, so each statement appears verbatim as a
      // JSON string value under its own key.
      expect(source, `statement ${name} missing from storeSource()`).toContain(JSON.stringify(sql));
    }
  });

  it('leaves no unsubstituted placeholder', () => {
    expect(storeSource()).not.toMatch(/__[A-Z_]+__/);
  });
});

describe('openStore', () => {
  it('creates the schema at user_version 1 and is idempotent', async () => {
    const first = await openStore(dataDir);
    expect(first).not.toBeNull();
    first?.close();
    const second = await openStore(dataDir);
    expect(second).not.toBeNull();
    second?.close();
    expect(rows('PRAGMA user_version')[0]).toEqual({ user_version: STORE_USER_VERSION });
    const tables = rows("SELECT name FROM sqlite_master WHERE type = 'table'").map((r) => r.name);
    expect(tables).toEqual(
      expect.arrayContaining([
        'sessions',
        'events',
        'injections',
        'session_state',
        'searches',
        'pairings',
      ]),
    );
  });

  it('returns null for a corrupt database rather than throwing', async () => {
    await writeFile(join(dataDir, STATE_DB_FILE), 'this is not a database');
    expect(await openStore(dataDir)).toBeNull();
  });

  it('probes node:sqlite for doctor', async () => {
    const probe = await probeSqlite();
    expect(probe.ok).toBe(true);
    expect(probe.version).toMatch(/^\d+\.\d+/);
  });
});

describe('rows land per arm', () => {
  it('SessionStart opens a session row and Stop closes it', async () => {
    await writeConfig();
    const payload = JSON.stringify({ session_id: 's1', cwd: '/repo/one' });
    const start = await runScript(sessionPrimerHookScript(dataDir), payload);
    expect(start.code).toBe(0);
    expect(start.stderr).toBe('');

    const opened = rows('SELECT * FROM sessions');
    expect(opened).toHaveLength(1);
    expect(opened[0]?.session).toBe('s1');
    expect(opened[0]?.cwd).toBe('/repo/one');
    expect(typeof opened[0]?.started_at).toBe('number');
    expect(opened[0]?.ended_at).toBeNull();
    // `project` and `machine` are hashes, present so a later team sync has stable
    // keys without a migration.
    expect(String(opened[0]?.project)).toMatch(/^[0-9a-f]{16}$/);
    expect(String(opened[0]?.machine)).toMatch(/^[0-9a-f]{16}$/);

    const stop = await runScript(stopHookScript(dataDir), payload);
    expect(stop.code).toBe(0);
    expect(stop.stderr).toBe('');
    expect(typeof rows('SELECT * FROM sessions')[0]?.ended_at).toBe('number');
  });

  it('the prompt arm writes one event and one injection', async () => {
    const shelf = await serveSearch((baseUrl) => ({
      status: 200,
      json: strongAnswer(baseUrl, '11111111-1111-4111-8111-111111111111', STRONG_TITLE),
    }));
    try {
      await writeConfig({ baseUrl: shelf.baseUrl });
      const run = await runScript(
        pushPromptHookScript(dataDir),
        JSON.stringify({
          session_id: 's1',
          cwd: '/repo/one',
          hook_event_name: 'UserPromptSubmit',
          prompt: STRONG_QUERY,
        }),
      );
      expect(run.code).toBe(0);
      expect(run.stderr).toBe('');

      const events = rows('SELECT * FROM events');
      expect(events).toHaveLength(1);
      expect(events[0]?.hook).toBe('prompt');
      expect(String(events[0]?.data)).toContain('UserPromptSubmit');

      const injections = rows('SELECT * FROM injections');
      expect(injections).toHaveLength(1);
      expect(injections[0]?.hook).toBe('prompt');
      expect(injections[0]?.event_uid).toBe(events[0]?.uid);
      expect(injections[0]?.search_id).toBe(SEARCH_ID);
      expect(injections[0]?.action).toBe('injected');
      expect(rows('SELECT * FROM searches')).toHaveLength(1);
    } finally {
      await shelf.close();
    }
  });
});

describe('already-injected spans two different hooks', () => {
  it('a piece the prompt arm showed is skipped by the WebSearch hint path', async () => {
    const shared = '11111111-1111-4111-8111-111111111111';
    const shelf = await serveSearch((baseUrl) => ({
      status: 200,
      json: strongAnswer(baseUrl, shared, STRONG_TITLE),
    }));
    try {
      // Push OFF for the second run, so the WebSearch arm takes the plain hint
      // path — the half of the sidecar the push ledger could never see.
      await writeFile(
        join(dataDir, 'config.json'),
        JSON.stringify({ baseUrl: shelf.baseUrl, hooks: { push: 'on', webSearch: 'auto' } }),
      );
      const first = await runScript(
        pushPromptHookScript(dataDir),
        JSON.stringify({
          session_id: 's1',
          hook_event_name: 'UserPromptSubmit',
          prompt: STRONG_QUERY,
        }),
      );
      expect(first.stdout).toContain(STRONG_TITLE);

      await writeFile(
        join(dataDir, 'config.json'),
        JSON.stringify({ baseUrl: shelf.baseUrl, hooks: { push: 'off', webSearch: 'auto' } }),
      );
      const second = await runScript(
        websearchHookScript(dataDir),
        JSON.stringify({
          session_id: 's1',
          tool_name: 'WebSearch',
          tool_input: { query: STRONG_TITLE },
        }),
      );
      expect(second.code).toBe(0);
      // Every candidate was either already shown or is rank 2, which the hint
      // path renders — so what must NOT appear is the piece already injected.
      expect(second.stdout).not.toContain(STRONG_TITLE);

      const shown = rows(
        'SELECT hook, action, reason FROM injections WHERE resource_id = ? ORDER BY id',
        [shared],
      );
      expect(shown).toEqual([
        { hook: 'prompt', action: 'injected', reason: null },
        { hook: 'research', action: 'skipped', reason: 'already-injected' },
      ]);
    } finally {
      await shelf.close();
    }
  });

  it('keys a note by candidate.id when it carries no resourceId', async () => {
    const store = await openStore(dataDir);
    expect(store).not.toBeNull();
    store?.run(STORE_SQL.insertInjection, [
      'uid-1',
      null,
      Date.now(),
      's1',
      null,
      'machine',
      'failure',
      'local',
      'pairing:7',
      'a note',
      null,
      '0',
      null,
      null,
      null,
      null,
      null,
      null,
      'injected',
      null,
      'short',
      0,
      12,
    ]);
    expect(store?.get(STORE_SQL.alreadyShown, ['s1', 'pairing:7'])).not.toBeNull();
    expect(store?.get(STORE_SQL.alreadyShown, ['s1', 'pairing:8'])).toBeNull();
    // Session-scoped: another session has not seen it.
    expect(store?.get(STORE_SQL.alreadyShown, ['s2', 'pairing:7'])).toBeNull();
    store?.close();
  });
});

describe('the lookup bucket is read from the database', () => {
  it('counts attempts machine-wide and stops the arm at the cap', async () => {
    const store = await openStore(dataDir);
    const now = Date.now();
    // Eight prompt lookups from a DIFFERENT session: the bucket is machine-wide.
    for (let i = 0; i < 8; i += 1) {
      store?.run(STORE_SQL.insertInjection, [
        `uid-${i}`,
        null,
        now,
        'other-session',
        null,
        'machine',
        'prompt',
        'public',
        null,
        null,
        null,
        null,
        `search-${i}`,
        null,
        null,
        null,
        null,
        null,
        'skipped',
        'miss',
        null,
        0,
        null,
      ]);
    }
    expect(store?.get(STORE_SQL.bucketCount, ['prompt', now - 1000])).toEqual({ n: 8 });
    // A window that starts after the rows sees nothing.
    expect(store?.get(STORE_SQL.bucketCount, ['prompt', now + 1000])).toEqual({ n: 0 });
    // Another arm's bucket is untouched.
    expect(store?.get(STORE_SQL.bucketCount, ['failure', now - 1000])).toEqual({ n: 0 });
    store?.close();

    const shelf = await serveSearch((baseUrl) => ({
      status: 200,
      json: strongAnswer(baseUrl, '11111111-1111-4111-8111-111111111111', STRONG_TITLE),
    }));
    try {
      await writeConfig({ baseUrl: shelf.baseUrl });
      const run = await runScript(
        pushPromptHookScript(dataDir),
        JSON.stringify({
          session_id: 's1',
          hook_event_name: 'UserPromptSubmit',
          prompt: STRONG_QUERY,
        }),
      );
      expect(run.code).toBe(0);
      expect(run.stdout).toBe('');
      // The cap was hit BEFORE the shelf was asked.
      expect(shelf.hits()).toBe(0);
      expect(
        rows("SELECT reason FROM injections WHERE session = 's1'").map((r) => r.reason),
      ).toEqual(['lookup-cap']);
    } finally {
      await shelf.close();
    }
  });
});

describe('concurrency', () => {
  it('eight hook processes on a fresh database: 8 events, 1 injected, 7 skipped', async () => {
    const shelf = await serveSearch((baseUrl) => ({
      status: 200,
      json: strongAnswer(baseUrl, '11111111-1111-4111-8111-111111111111', STRONG_TITLE),
    }));
    try {
      await writeConfig({ baseUrl: shelf.baseUrl });
      const payload = JSON.stringify({
        session_id: 'race',
        hook_event_name: 'UserPromptSubmit',
        prompt: STRONG_QUERY,
      });
      const runs = await Promise.all(
        Array.from({ length: 8 }, () => runScript(pushPromptHookScript(dataDir), payload)),
      );
      for (const run of runs) {
        expect(run.code).toBe(0);
        // The DDL race is the point: nothing may reach stderr, because Claude
        // Code shows the operator every byte of it.
        expect(run.stderr).toBe('');
      }
      expect(rows('SELECT * FROM events')).toHaveLength(8);
      const actions = rows('SELECT action, reason FROM injections');
      expect(actions).toHaveLength(8);
      expect(actions.filter((r) => r.action === 'injected')).toHaveLength(1);
      expect(
        actions.filter((r) => r.action === 'skipped' && r.reason === 'already-injected'),
      ).toHaveLength(7);
    } finally {
      await shelf.close();
    }
  }, 30_000);
});

describe('fail-open', () => {
  it('a corrupt database costs the row, not the tool call', async () => {
    await writeConfig();
    await writeFile(join(dataDir, STATE_DB_FILE), 'not a database at all');
    const run = await runScript(
      pushContextHookScript(dataDir),
      JSON.stringify({
        session_id: 's1',
        hook_event_name: 'PreToolUse',
        tool_name: 'Edit',
        tool_input: { file_path: '/repo/one/src/x.ts' },
      }),
    );
    expect(run.code).toBe(0);
    expect(run.stdout).toBe('');
    expect(run.stderr).toContain('tenjin: state store unavailable');
  });

  it('a read-only data directory costs the row, not the tool call', async () => {
    await writeConfig();
    await chmod(dataDir, 0o500);
    try {
      const run = await runScript(
        pushContextHookScript(dataDir),
        JSON.stringify({
          session_id: 's1',
          hook_event_name: 'PreToolUse',
          tool_name: 'Edit',
          tool_input: { file_path: '/repo/one/src/x.ts' },
        }),
      );
      expect(run.code).toBe(0);
      expect(run.stdout).toBe('');
      expect(run.stderr).toContain('tenjin: state store unavailable');
    } finally {
      await chmod(dataDir, 0o700);
    }
  });

  it('an import failure costs the row, not the tool call', async () => {
    await writeConfig();
    // A hook whose `node:sqlite` import throws is exactly an old Node. The
    // generated source imports it dynamically and inside main() precisely so
    // this is catchable; a static import would exit 1 with a stack trace.
    const source = pushContextHookScript(dataDir).replace(
      "await import('node:sqlite')",
      "await import('node:sqlite-does-not-exist')",
    );
    const run = await runScript(
      source,
      JSON.stringify({
        session_id: 's1',
        hook_event_name: 'PreToolUse',
        tool_name: 'Edit',
        tool_input: { file_path: '/repo/one/src/x.ts' },
      }),
    );
    expect(run.code).toBe(0);
    expect(run.stdout).toBe('');
    expect(run.stderr).toContain('tenjin: state store unavailable');
  });
});

describe('pairings: open, close, replay', () => {
  const failure = (command: string, stderr: string, session = 's1') =>
    JSON.stringify({
      session_id: session,
      cwd: '/repo/one',
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
      tool_input: { command },
      tool_response: { stdout: '', stderr },
    });

  const success = (command: string, session = 's1') =>
    JSON.stringify({
      session_id: session,
      cwd: '/repo/one',
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
      tool_input: { command },
      tool_response: { stdout: 'ok\n', stderr: '' },
    });

  const edit = (path: string, session = 's1') =>
    JSON.stringify({
      session_id: session,
      cwd: '/repo/one',
      hook_event_name: 'PreToolUse',
      tool_name: 'Edit',
      tool_input: { file_path: path },
    });

  const ENOENT =
    "Error: ENOENT: no such file or directory, open 'drizzle.config.ts'\n    at readFileSync (node:fs:1:1)\n    at run (/repo/one/src/migrate.ts:12:3)\n";

  it('opens a pairing on an allowlisted failure and closes it on a later pass', async () => {
    await writeConfig({ baseUrl: 'http://127.0.0.1:1' });
    expect(
      (await runScript(pushFailureHookScript(dataDir), failure('pnpm db:migrate', ENOENT))).code,
    ).toBe(0);

    const opened = rows('SELECT * FROM pairings');
    expect(opened).toHaveLength(1);
    expect(opened[0]?.status).toBe('open');
    expect(opened[0]?.kind).toBe('sig_v1');
    expect(opened[0]?.cmd_head).toBe('pnpm');
    expect(JSON.parse(String(opened[0]?.error_files))).toContain('migrate.ts');

    // A tracked file the error named changes, then the same head passes.
    expect(
      (await runScript(pushContextHookScript(dataDir), edit('/repo/one/src/migrate.ts'))).code,
    ).toBe(0);
    expect((await runScript(pushFailureHookScript(dataDir), success('pnpm db:migrate'))).code).toBe(
      0,
    );

    const closed = rows('SELECT * FROM pairings');
    expect(closed[0]?.status).toBe('unverified');
    expect(closed[0]?.closes).toBe(1);
    expect(closed[0]?.scope).toBe('code');
    expect(JSON.parse(String(closed[0]?.fix_files))).toEqual(['migrate.ts']);
  });

  /**
   * The head a pairing keys on is the LAST ALLOWLISTED one, not the last
   * segment. `pnpm test && echo done` used to key on `echo`, so the pairing it
   * opened could never be closed by a later `pnpm test`.
   */
  it('keys on the build step, not on whatever ran after it', async () => {
    await writeConfig({ baseUrl: 'http://127.0.0.1:1' });
    await runScript(
      pushFailureHookScript(dataDir),
      failure('pnpm db:migrate && echo done', ENOENT),
    );
    expect(rows('SELECT cmd_head FROM pairings')[0]).toEqual({ cmd_head: 'pnpm' });

    await runScript(pushContextHookScript(dataDir), edit('/repo/one/src/migrate.ts'));
    await runScript(pushFailureHookScript(dataDir), success('pnpm db:migrate'));
    expect(rows('SELECT status FROM pairings')[0]?.status).toBe('unverified');
  });

  it('does not close on a pass that changed nothing', async () => {
    await writeConfig({ baseUrl: 'http://127.0.0.1:1' });
    await runScript(pushFailureHookScript(dataDir), failure('pnpm db:migrate', ENOENT));
    await runScript(pushFailureHookScript(dataDir), success('pnpm db:migrate'));
    expect(rows('SELECT status FROM pairings')[0]?.status).toBe('open');
  });

  it('never opens a pairing below the specificity floor', async () => {
    await writeConfig({ baseUrl: 'http://127.0.0.1:1' });
    // No errno, no frame: a bare test-runner verdict that would key identically
    // in every repo on earth.
    await runScript(
      pushFailureHookScript(dataDir),
      failure('pnpm test', 'FAIL  some suite\n\n2 failed\n'),
    );
    expect(rows('SELECT * FROM pairings')).toHaveLength(0);
    // The fire is still recorded — it just has no key worth storing.
    expect(rows("SELECT * FROM events WHERE hook = 'failure'")).toHaveLength(1);
  });

  it('replays a closed pairing locally, before any shelf is asked', async () => {
    const shelf = await serveSearch((baseUrl) => ({
      status: 200,
      json: strongAnswer(baseUrl, '11111111-1111-4111-8111-111111111111', STRONG_TITLE),
    }));
    try {
      await writeConfig({ baseUrl: shelf.baseUrl });
      await runScript(pushFailureHookScript(dataDir), failure('pnpm db:migrate', ENOENT));
      await runScript(pushContextHookScript(dataDir), edit('/repo/one/src/migrate.ts'));
      await runScript(pushFailureHookScript(dataDir), success('pnpm db:migrate'));
      const hitsBefore = shelf.hits();

      // A NEW session hits the same failure.
      const replay = await runScript(
        pushFailureHookScript(dataDir),
        failure('pnpm db:migrate', ENOENT, 's2'),
      );
      expect(replay.code).toBe(0);
      expect(replay.stdout).toContain('Someone once fixed this by touching');
      expect(replay.stdout).toContain('migrate.ts');
      // BEFORE any network call: the shelf was never asked.
      expect(shelf.hits()).toBe(hitsBefore);

      const injected = rows(
        "SELECT hook, shelf, action, resource_id FROM injections WHERE session = 's2'",
      );
      expect(injected).toHaveLength(1);
      expect(injected[0]).toMatchObject({ hook: 'failure', shelf: 'local', action: 'injected' });
      expect(String(injected[0]?.resource_id)).toMatch(/^pairing:\d+$/);
    } finally {
      await shelf.close();
    }
  });

  it('promotes to verified on a second independent close', async () => {
    await writeConfig({ baseUrl: 'http://127.0.0.1:1' });
    await runScript(pushFailureHookScript(dataDir), failure('pnpm db:migrate', ENOENT));
    await runScript(pushContextHookScript(dataDir), edit('/repo/one/src/migrate.ts'));
    await runScript(pushFailureHookScript(dataDir), success('pnpm db:migrate'));

    const store = await openStore(dataDir);
    const id = rows('SELECT id FROM pairings')[0]?.id;
    // A second close, as a second session's success would do it.
    store?.run(STORE_SQL.closePairing, [
      Date.now(),
      'pnpm db:migrate',
      '["migrate.ts"]',
      'code',
      id,
    ]);
    store?.close();

    const verified = rows('SELECT status, closes FROM pairings')[0];
    expect(verified).toEqual({ status: 'verified', closes: 2 });
  });

  it('classifies an env-var failure as user scope, so it never syncs', async () => {
    await writeConfig({ baseUrl: 'http://127.0.0.1:1' });
    await runScript(
      pushFailureHookScript(dataDir),
      failure(
        'pnpm db:migrate',
        'Error: DATABASE_URL is not set\n    at config (/repo/one/src/env.ts:4:9)\n',
      ),
    );
    await runScript(pushContextHookScript(dataDir), edit('/repo/one/src/env.ts'));
    await runScript(pushFailureHookScript(dataDir), success('pnpm db:migrate'));
    expect(rows('SELECT scope, status FROM pairings')[0]).toEqual({
      scope: 'user',
      status: 'unverified',
    });
  });

  it('a .env edit is not a tracked change, so it cannot close a pairing', async () => {
    await writeConfig({ baseUrl: 'http://127.0.0.1:1' });
    await runScript(pushFailureHookScript(dataDir), failure('pnpm db:migrate', ENOENT));
    await runScript(pushContextHookScript(dataDir), edit('/repo/one/.env.local'));
    await runScript(pushFailureHookScript(dataDir), success('pnpm db:migrate'));
    expect(rows('SELECT status FROM pairings')[0]?.status).toBe('open');
  });

  it('never fires behind a command head the allowlist excludes', async () => {
    await writeConfig({ baseUrl: 'http://127.0.0.1:1' });
    await runScript(
      pushFailureHookScript(dataDir),
      failure('which codex', 'codex not found\n    at x (/repo/one/a.ts:1:1)\n'),
    );
    // NOTHING was read or written: the head check runs before the store is even
    // opened, so a `which codex` fire costs one config read and no more.
    const { existsSync } = await import('node:fs');
    expect(existsSync(join(dataDir, STATE_DB_FILE))).toBe(false);
  });
});

describe('the search store round-trips through the database', () => {
  it('the dispatch hook records a search the CLI can read back', async () => {
    const shelf = await serveSearch(() => ({
      status: 200,
      json: { schemaVersion: 3, searchId: SEARCH_ID, calibration: 'ok', matched: 0, items: [] },
    }));
    try {
      await writeFile(
        join(dataDir, 'config.json'),
        JSON.stringify({
          baseUrl: shelf.baseUrl,
          hooks: { push: 'on', webSearch: 'auto', agentDispatch: 'auto' },
        }),
      );
      const run = await runScript(
        dispatchHookScript(dataDir),
        JSON.stringify({
          session_id: 's1',
          tool_name: 'Task',
          tool_input: {
            description: 'research',
            prompt:
              'find out how the drizzle migration slot numbering works and whether the checker catches a taken slot',
          },
        }),
      );
      expect(run.code).toBe(0);

      const { loadSearches, latestSearch, markSearchResolved } = await import('./search-store');
      const stored = await loadSearches(dataDir);
      expect(stored).toHaveLength(1);
      expect(stored[0]?.searchId).toBe(SEARCH_ID);
      expect(stored[0]?.source).toBe('dispatch-hook');
      expect(stored[0]?.sessionId).toBe('s1');
      expect(stored[0]?.decision).toBe('MISS');
      // `--last` skips hook entries: it means "the search I just ran".
      expect(await latestSearch(dataDir)).toBeNull();

      expect(await markSearchResolved(dataDir, stored[0]!.searchId, 'outcome')).toBe('resolved');
      expect((await loadSearches(dataDir))[0]?.resolved?.by).toBe('outcome');
      expect(await markSearchResolved(dataDir, stored[0]!.searchId, 'publish')).toBe(
        'already-resolved',
      );
      expect(
        await markSearchResolved(dataDir, stored[0]!.searchId, 'publish', undefined, {
          relink: true,
        }),
      ).toBe('relinked');
      expect(await markSearchResolved(dataDir, 'no-such-id', 'outcome')).toBe('not-found');
    } finally {
      await shelf.close();
    }
  });

  it('a CLI search is what `--last` targets, and it survives a reload', async () => {
    const { recordSearch, latestSearch, findStoredCandidate, findSearchForResource } =
      await import('./search-store');
    await recordSearch(dataDir, {
      searchId: 'aaaaaaaa-2222-3333-4444-555555555555',
      at: new Date().toISOString(),
      question: 'what is the pgvector collation trap',
      decision: 'CANDIDATES',
      candidates: [
        { resourceId: 'res-9', url: 'https://tenjin.blog/p/z', title: 'trap', price: '1000' },
      ],
      source: 'cli',
      shelfBaseUrl: 'https://tenjin.blog',
      paidBrowseCount: 2,
    });
    const latest = await latestSearch(dataDir);
    expect(latest?.searchId).toBe('aaaaaaaa-2222-3333-4444-555555555555');
    expect(latest?.shelfBaseUrl).toBe('https://tenjin.blog');
    expect(latest?.paidBrowseCount).toBe(2);
    expect((await findStoredCandidate(dataDir, 'res-9'))?.title).toBe('trap');
    expect(await findSearchForResource(dataDir, { resourceId: 'res-9' })).toBe(
      'aaaaaaaa-2222-3333-4444-555555555555',
    );
    expect(await findStoredCandidate(dataDir, 'res-absent')).toBeNull();
  });

  it('reads as empty when the store cannot be opened', async () => {
    await writeFile(join(dataDir, STATE_DB_FILE), 'not a database');
    const { loadSearches, latestSearch } = await import('./search-store');
    expect(await loadSearches(dataDir)).toEqual([]);
    expect(await latestSearch(dataDir)).toBeNull();
  });
});

describe('retired files', () => {
  it('install deletes exactly the named entries and nothing else', async () => {
    await writeFile(join(dataDir, 'push-ledger.jsonl'), '{"at":"x"}\n');
    await writeFile(join(dataDir, 'searches.json'), '{}');
    await mkdir(join(dataDir, 'searches.json.lock'), { recursive: true });
    await mkdir(join(dataDir, 'push'), { recursive: true });
    await writeFile(join(dataDir, 'push', 'capture-asked-s1'), 'x');
    await mkdir(join(dataDir, 'candidates'), { recursive: true });
    // The things that must survive.
    await writeFile(join(dataDir, 'wallet.json'), '{}');
    await writeFile(join(dataDir, 'config.json'), '{}');

    const removed = await removeRetiredState(dataDir);
    expect(removed.map((p) => p.slice(dataDir.length + 1)).sort()).toEqual(
      [...RETIRED_STATE_ENTRIES].sort(),
    );
    const { existsSync } = await import('node:fs');
    for (const name of RETIRED_STATE_ENTRIES) {
      expect(existsSync(join(dataDir, name)), `${name} should be gone`).toBe(false);
    }
    expect(existsSync(join(dataDir, 'wallet.json'))).toBe(true);
    expect(existsSync(join(dataDir, 'config.json'))).toBe(true);
  });

  it('is a no-op on a machine that never had them', async () => {
    expect(await removeRetiredState(dataDir)).toEqual([]);
  });
});
