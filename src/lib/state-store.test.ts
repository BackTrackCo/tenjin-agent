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
  STORE_BUSY_TIMEOUT_MS,
  STORE_SQL,
  STORE_USER_VERSION,
  openStore,
  probeSqlite,
  removeRetiredState,
  storeSource,
} from './state-store';
import {
  pushContextHookScript,
  pushFailureHookScript,
  pushPromptHookScript,
  pushSubagentHookScript,
} from './push-scripts';
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
 * A response the arms read as STRONG: rank 1 carries the shelf's own verdict,
 * `corroborated: true` with a confidence that is not 'low'. PAID, so the arm
 * takes the short form and never fetches a body — this suite is about rows, not
 * about rendering.
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
        confidence: 'high',
        corroborated: true,
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

  /**
   * `STORE_DDL` is a plain template literal, so a backtick in one of its SQL
   * comments silently ends it and the file stops parsing. That happened twice
   * during this work; the parse error names a line 40 above the real cause.
   */
  it('has no backtick in the DDL that would close its own template', () => {
    expect(STORE_DDL).not.toContain('`');
  });

  it('leaves no unsubstituted placeholder', () => {
    expect(storeSource()).not.toMatch(/__[A-Z_]+__/);
  });
});

/**
 * The generated hooks end in `main().catch(quiet)`, so a programming error in
 * them — a constant referenced but never declared — is not a crash an operator
 * can see. It is a hook that silently does nothing, forever, on every machine
 * the install reached. That happened once during this work (`STATE_REPLAYED_PREFIX`
 * was used before it existed) and cost nothing but time only because a test
 * asserted on stdout; nothing structural would have caught it.
 */
describe('the generated scripts are complete', () => {
  const scripts = (): [string, string][] => [
    ['push-prompt', pushPromptHookScript(dataDir)],
    ['push-failure', pushFailureHookScript(dataDir)],
    ['push-subagent', pushSubagentHookScript(dataDir)],
    ['push-context', pushContextHookScript(dataDir)],
    ['websearch', websearchHookScript(dataDir)],
    ['dispatch', dispatchHookScript(dataDir)],
    ['stop', stopHookScript(dataDir)],
    ['sessionstart', sessionPrimerHookScript(dataDir)],
  ];

  it('parse as valid ES modules', async () => {
    const { execFile } = await import('node:child_process');
    for (const [name, source] of scripts()) {
      const path = join(scriptDir, `check-${name}.mjs`);
      await writeFile(path, source);
      const code = await new Promise<number | null>((resolve) => {
        execFile(process.execPath, ['--check', path], (err) =>
          resolve(err === null ? 0 : ((err as { code?: number }).code ?? 1)),
        );
      });
      expect(code, `${name} does not parse`).toBe(0);
    }
  });

  it('declare every shared constant they reference', () => {
    for (const [name, source] of scripts()) {
      // The `STATE_*` / `STORE_*` families are the ones spliced in from another
      // module, so they are the ones a rename can leave dangling.
      const used = new Set(source.match(/\b(?:STATE|STORE)_[A-Z0-9_]+\b/g) ?? []);
      for (const token of used) {
        expect(
          new RegExp(`(?:const|let|var)\\s+${token}\\b`).test(source),
          `${name} uses ${token} without declaring it`,
        ).toBe(true);
      }
    }
  });
});

/**
 * The queries a hook runs before it is allowed to speak, checked against the
 * planner rather than against the DDL.
 *
 * `failStreak` runs on EVERY push fire before every lookup and `injectedCount`
 * on every injection decision; both filter by session, and with only a partial
 * index on `resource_id` to work with, both fell back to a full SCAN of the one
 * table that never shrinks — measured at roughly 7 ms at 200k rows, synchronous,
 * inside a 1500 ms budget, with up to 8 concurrent processes. An index is easy
 * to add and just as easy to lose, so this asserts the plan, not its existence.
 */
describe('the hot-path queries never scan', () => {
  it('plans every per-fire read against an index', async () => {
    const store = await openStore(dataDir);
    store?.close();
    const db = new DatabaseSync(join(dataDir, STATE_DB_FILE));
    try {
      const plan = (sql: string, params: (string | number)[]): string =>
        (
          db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as unknown as {
            detail: string;
          }[]
        )
          .map((row) => row.detail)
          .join(' | ');
      const hotPaths: [string, string, (string | number)[]][] = [
        ['recentReasons', STORE_SQL.recentReasons, ['s', 40]],
        ['injectedCount', STORE_SQL.injectedCount, ['s']],
        ['alreadyShown', STORE_SQL.alreadyShown, ['s', 'r']],
        ['bucketCount', STORE_SQL.bucketCount, ['prompt', 0]],
        ['findPairing', STORE_SQL.findPairing, ['p', 'k', 'c']],
        ['openForHead', STORE_SQL.openForHead, ['p', 'h', 0, 8]],
        ['openLoops', STORE_SQL.openLoops, [0, '', '', 25]],
        ['researchedBySession', STORE_SQL.researchedBySession, ['s']],
        ['getState', STORE_SQL.getState, ['s', 'k']],
        // The one-shot CLI tally is not a hook path, but it reads the same
        // never-pruned table.
        ['statusRows', STORE_SQL.statusRows, [0]],
      ];
      for (const [name, sql, params] of hotPaths) {
        expect(plan(sql, params), `${name} scans`).not.toContain('SCAN');
      }
    } finally {
      db.close();
    }
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

  /**
   * THE COLD START IS A DIFFERENT SHAPE FROM A WRITE. Twelve openers meeting an
   * empty database all take `BEGIN IMMEDIATE` at once and queue behind whoever
   * wins, and 250 ms — sized for a sub-millisecond insert — was not always
   * enough for the last of them: measured on this machine, the plan's own
   * 8-process case tripped it about one run in six and the loser printed
   * `state store unavailable (database is locked)` to stderr, which Claude Code
   * shows the operator. The bootstrap has its own longer wait and a retry.
   */
  it('survives a dozen openers racing an empty database', async () => {
    const opened = await Promise.all(Array.from({ length: 12 }, () => openStore(dataDir)));
    expect(opened.every((store) => store !== null)).toBe(true);
    for (const store of opened) store?.close();
    expect(rows('PRAGMA user_version')[0]).toEqual({ user_version: STORE_USER_VERSION });
    // The schema was created ONCE; the retry must not have run the DDL twice.
    expect(
      rows("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'pairings'")[0],
    ).toEqual({ n: 1 });
  });

  /** ...and the raised wait is put back, so no ordinary fire inherits it. */
  it('restores the steady-state busy timeout after the bootstrap', async () => {
    const store = await openStore(dataDir);
    expect(store?.get('PRAGMA busy_timeout')).toEqual({ timeout: STORE_BUSY_TIMEOUT_MS });
    store?.close();
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

describe('fail-open before the store is even opened', () => {
  /**
   * A machine id is not worth a dead hook. `os.userInfo()` throws
   * ERR_SYSTEM_ERROR when the process uid has no passwd entry — a devcontainer
   * or CI image started with `--user 1001`, or Kubernetes with an arbitrary uid
   * — and computing it at MODULE scope put that throw outside every try/catch
   * and before `main()`. Every hook on such a host exited 1 with a stack trace,
   * with push off, before config.json was read.
   */
  it('survives a host where os.userInfo() throws', async () => {
    await writeConfig();
    for (const [name, source] of [
      ['context', pushContextHookScript(dataDir)],
      ['stop', stopHookScript(dataDir)],
      ['sessionstart', sessionPrimerHookScript(dataDir)],
    ] as const) {
      // The BINDING throws, wherever it is called. If the call sat at module
      // scope again, the module would die on load and this would catch it.
      const broken = source.replace(
        "import { homedir, hostname, userInfo } from 'node:os';",
        "import { homedir } from 'node:os';\n" +
          "const boom = () => { const e = new Error('uv_os_get_passwd'); e.code = 'ERR_SYSTEM_ERROR'; throw e; };\n" +
          'const hostname = boom;\n' +
          'const userInfo = boom;',
      );
      expect(broken).not.toBe(source);
      const run = await runScript(
        broken,
        JSON.stringify({
          session_id: 's1',
          cwd: '/repo/one',
          hook_event_name: 'PreToolUse',
          tool_name: 'Edit',
          tool_input: { file_path: '/repo/one/src/x.ts' },
        }),
      );
      expect(run.code, `${name} died`).toBe(0);
      expect(run.stderr, `${name} wrote a stack trace`).not.toContain('ERR_SYSTEM_ERROR');
    }
    // And the store still works: the id falls back to the uid.
    expect(String(rows('SELECT machine FROM sessions')[0]?.machine ?? '')).toMatch(
      /^[0-9a-f]{16}$|^$/,
    );
  });

  /**
   * Hook scripts are regenerated only by `tenjin install`, so v1 hooks can meet
   * a database a newer CLI already migrated. A `!==` gate stamped the version
   * back down; the newer side migrated again; the two ping-ponged forever.
   */
  it('never downgrades a database a newer build already migrated', async () => {
    const store = await openStore(dataDir);
    store?.run(`PRAGMA user_version = ${STORE_USER_VERSION + 1}`);
    store?.close();

    const reopened = await openStore(dataDir);
    expect(reopened).not.toBeNull();
    reopened?.close();
    expect(rows('PRAGMA user_version')[0]).toEqual({
      user_version: STORE_USER_VERSION + 1,
    });
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

/**
 * Fail-open is the contract for SILENCE. It was accidentally also the contract
 * for BOUNDS: `storeCount` answered 0 for an unreadable database, so the
 * per-arm lookup cap, the per-session injection cap and the outage brake all
 * disengaged at the one moment there was no other bookkeeping either, and the
 * sidecar became an uncapped network client in front of every tool call.
 */
describe('a fire with no store makes no request at all', () => {
  const arms: [string, string, () => string][] = [
    [
      'prompt',
      'push-prompt',
      () =>
        JSON.stringify({
          session_id: 's1',
          cwd: '/repo/one',
          hook_event_name: 'UserPromptSubmit',
          prompt: STRONG_QUERY,
        }),
    ],
    [
      'failure',
      'push-failure',
      () =>
        JSON.stringify({
          session_id: 's1',
          cwd: '/repo/one',
          hook_event_name: 'PostToolUse',
          tool_name: 'Bash',
          tool_input: { command: 'pnpm db:migrate' },
          tool_response: {
            stdout: '',
            stderr:
              "Error: ENOENT: no such file or directory, open 'x'\n    at run (/repo/one/a.ts:1:1)\n",
          },
        }),
    ],
    [
      'context',
      'push-context',
      () =>
        JSON.stringify({
          session_id: 's1',
          cwd: '/repo/one',
          hook_event_name: 'PostToolUse',
          tool_name: 'Read',
          tool_input: { file_path: '/repo/one/src/x.ts' },
        }),
    ],
    [
      'websearch',
      'websearch',
      () =>
        JSON.stringify({
          session_id: 's1',
          cwd: '/repo/one',
          tool_name: 'WebSearch',
          tool_input: { query: STRONG_TITLE },
        }),
    ],
    [
      'dispatch',
      'dispatch',
      () =>
        JSON.stringify({
          session_id: 's1',
          cwd: '/repo/one',
          tool_name: 'Task',
          tool_input: { description: 'research', prompt: STRONG_QUERY },
        }),
    ],
  ];

  it('asks no shelf, emits nothing, and exits 0 on a corrupt store', async () => {
    const shelf = await serveSearch((baseUrl) => ({
      status: 200,
      json: strongAnswer(baseUrl, '11111111-1111-4111-8111-111111111111', STRONG_TITLE),
    }));
    try {
      await writeFile(
        join(dataDir, 'config.json'),
        JSON.stringify({
          baseUrl: shelf.baseUrl,
          hooks: { push: 'on', webSearch: 'auto', agentDispatch: 'auto' },
        }),
      );
      await writeFile(join(dataDir, STATE_DB_FILE), 'not a database');

      const sources: Record<string, string> = {
        'push-prompt': pushPromptHookScript(dataDir),
        'push-failure': pushFailureHookScript(dataDir),
        'push-context': pushContextHookScript(dataDir),
        websearch: websearchHookScript(dataDir),
        dispatch: dispatchHookScript(dataDir),
      };
      for (const [name, script, payload] of arms) {
        const run = await runScript(sources[script] as string, payload());
        expect(run.code, `${name} exit`).toBe(0);
        expect(run.stdout, `${name} spoke`).toBe('');
        expect(run.stderr, `${name} stderr`).toContain('tenjin: state store unavailable');
      }
      // THE POINT: no bookkeeping means no bounds, so it must mean no requests.
      expect(shelf.hits()).toBe(0);
    } finally {
      await shelf.close();
    }
  }, 30_000);

  it('reads an unknown count as a bound that engages, not one that disappears', async () => {
    const store = await openStore(dataDir);
    // A live store counts for real...
    expect(store?.get(STORE_SQL.bucketCount, ['prompt', 0])).toEqual({ n: 0 });
    store?.close();
    // ...and the helpers the arms use return Infinity without one, which is what
    // makes `spent < cap` and `injected < max` refuse rather than wave through.
    // Asserted through the generated source, since the helper is not exported.
    const source = pushPromptHookScript(dataDir);
    expect(source).toContain('if (STORE === null) return Infinity;');
    expect(source).toMatch(/function claimState[\s\S]{0,400}if \(STORE === null\) return false;/);
  });

  /**
   * A BUSY past the timeout is the realistic failure of the once-per-session
   * insert, under exactly the contention the index was added for. Every caller
   * branched on 'duplicate' alone, so the row went unwritten and the piece was
   * shown anyway — the second injection the index exists to prevent.
   */
  it('does not show a piece whose row the database refused', async () => {
    const shelf = await serveSearch((baseUrl) => ({
      status: 200,
      json: strongAnswer(baseUrl, '11111111-1111-4111-8111-111111111111', STRONG_TITLE),
    }));
    try {
      await writeConfig({ baseUrl: shelf.baseUrl });
      // A trigger that refuses every injected row, standing in for the BUSY.
      const store = await openStore(dataDir);
      store?.run(
        "CREATE TRIGGER no_inject BEFORE INSERT ON injections WHEN NEW.action = 'injected'" +
          " BEGIN SELECT RAISE(ABORT, 'database is locked'); END",
      );
      store?.close();

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
      expect(rows("SELECT reason FROM injections WHERE session = 's1'")).toEqual([
        { reason: 'already-injected' },
      ]);
    } finally {
      await shelf.close();
    }
  });
});

describe('pairings: open, close, replay', () => {
  const failure = (command: string, stderr: string, session = 's1', cwd = '/repo/one') =>
    JSON.stringify({
      session_id: session,
      cwd,
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
      tool_input: { command },
      tool_response: { stdout: '', stderr },
    });

  const success = (command: string, session = 's1', cwd = '/repo/one') =>
    JSON.stringify({
      session_id: session,
      cwd,
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
      tool_input: { command },
      tool_response: { stdout: 'ok\n', stderr: '' },
    });

  const edit = (path: string, session = 's1', cwd = '/repo/one') =>
    JSON.stringify({
      session_id: session,
      cwd,
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

  /**
   * THE FLOOR IS ABOUT MEANING, NOT SHAPE. `/E[A-Z]{3,}/` matched ERROR, ERRORS,
   * ESLINT, EXPECTED — ordinary capitalised English that toolchains print all
   * day — so a bare "2 failed", deliberately below the floor, cleared it on the
   * strength of the word ERROR appearing anywhere in the output and got a coarse
   * key identical in every repo on earth.
   */
  it('does not take an English word in caps for an errno', async () => {
    await writeConfig({ baseUrl: 'http://127.0.0.1:1' });
    for (const output of [
      'FAIL  some suite\n\nERRORS\n2 failed\n',
      'FAIL  suite\nESLINT found problems\n2 failed\n',
      'FAIL  suite\nEXPECTED something else\n2 failed\n',
    ]) {
      await runScript(
        pushFailureHookScript(dataDir),
        failure('pnpm test', output, 'sess-' + output.length),
      );
    }
    expect(rows('SELECT COUNT(*) AS n FROM pairings')[0]).toEqual({ n: 0 });
  });

  /**
   * THE FLOOR IS ENFORCED AT STORAGE AND WAS BYPASSED AT RETRIEVAL. `sigV1`
   * refuses a signature with neither errno nor frame, but the COARSE key drops
   * the frame — so when the frame alone cleared the floor, the coarse key was a
   * hash of the message and nothing else: exactly the key the floor exists to
   * reject, smuggled back in on the lookup side.
   *
   * This repo's own suite is the case. Vitest's summary line normalizes every
   * digit to N, so it collapses to one string for every failing run in the
   * project; one coarse key would then cover every test failure there is, and
   * any recorded fix would replay at all of them.
   */
  it('stores no coarse key when only the frame cleared the floor', async () => {
    await writeConfig({ baseUrl: 'http://127.0.0.1:1' });
    await runScript(
      pushFailureHookScript(dataDir),
      failure(
        'pnpm test',
        'FAIL  src/a.test.ts\n Tests  2 failed | 5 passed (7)\n    at run (/repo/one/src/a.test.ts:12:3)\n',
      ),
    );
    const opened = rows('SELECT key, coarse_key FROM pairings');
    // The frame cleared the floor, so the pairing exists...
    expect(opened).toHaveLength(1);
    expect(String(opened[0]?.key)).toMatch(/^[0-9a-f]{16}$/);
    // ...but there is no message-only key for a different failure to match on.
    expect(opened[0]?.coarse_key).toBeNull();
  });

  /** A different test file, same vitest summary line: the two must not match. */
  it('does not replay one test failure at another', async () => {
    await writeConfig({ baseUrl: 'http://127.0.0.1:1' });
    const summary = (file: string) =>
      `FAIL  src/${file}\n Tests  2 failed | 5 passed (7)\n    at run (/repo/one/src/${file}:12:3)\n`;
    await runScript(pushFailureHookScript(dataDir), failure('pnpm test', summary('a.test.ts')));
    await runScript(pushContextHookScript(dataDir), edit('/repo/one/src/a.test.ts'));
    await runScript(pushFailureHookScript(dataDir), success('pnpm test'));
    expect(rows('SELECT status FROM pairings')[0]?.status).toBe('unverified');

    const other = await runScript(
      pushFailureHookScript(dataDir),
      failure('pnpm test', summary('b.test.ts'), 's2'),
    );
    expect(other.stdout).toBe('');
    expect(rows('SELECT COUNT(*) AS n FROM pairings')[0]).toEqual({ n: 2 });
  });

  /** ...and the tokens that ARE errnos still clear it. */
  it('takes a real errno, an ERR_ code and a compiler code', async () => {
    await writeConfig({ baseUrl: 'http://127.0.0.1:1' });
    const cases: [string, string][] = [
      ['e1', "Error: ENOENT: no such file or directory, open 'x'\n"],
      ['e2', 'ERR_PNPM_OUTDATED_LOCKFILE  Cannot install with frozen-lockfile\n'],
      ['e3', 'src/a.ts(3,9): error TS2345: Argument of type X\n'],
      ['e4', 'error[E0412]: cannot find type `Foo`\n'],
    ];
    for (const [session, output] of cases) {
      await runScript(pushFailureHookScript(dataDir), failure('pnpm test', output, session));
    }
    // Every one clears the floor: the failure row carries its signature. Only
    // the tsc case names a file, so only it OPENS a pairing (#212: a row whose
    // error named nothing a later edit could match against is never opened).
    expect(
      rows("SELECT COUNT(*) AS n FROM events WHERE hook = 'failure' AND error_hash IS NOT NULL")[0],
    ).toEqual({ n: cases.length });
    expect(rows('SELECT error_files FROM pairings')).toEqual([{ error_files: '["a.ts"]' }]);
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
        "SELECT hook, shelf, action, strength, resource_id FROM injections WHERE session = 's2'",
      );
      expect(injected).toHaveLength(1);
      // `unverified`, not null: one closer is real evidence and it was shown to
      // this session, so a rollup has to be able to tell this row apart from one
      // nothing recorded a strength for at all.
      expect(injected[0]).toMatchObject({
        hook: 'failure',
        shelf: 'local',
        action: 'injected',
        strength: 'unverified',
      });
      expect(String(injected[0]?.resource_id)).toMatch(/^pairing:\d+$/);
    } finally {
      await shelf.close();
    }
  });

  /**
   * 04's close rule end to end, through two hook processes in two sessions.
   *
   * This used to be unreachable. A second session that hit the same failure took
   * the replay branch and returned before `openPairing`, so it never had a row
   * of its own to close — and `openForHead` selects `status = 'open'`, so the
   * first session's now-`unverified` row could not be closed again either.
   * `closes` stopped at 1 forever, and the verified wording was dead code.
   * A replayed pairing is now remembered per command head, so the session that
   * was SHOWN it can be its second independent closer.
   */
  it('reaches verified through two sessions, and says so on the next replay', async () => {
    await writeConfig({ baseUrl: 'http://127.0.0.1:1' });

    // Session 1 opens the pairing and closes it.
    await runScript(pushFailureHookScript(dataDir), failure('pnpm db:migrate', ENOENT));
    await runScript(pushContextHookScript(dataDir), edit('/repo/one/src/migrate.ts'));
    await runScript(pushFailureHookScript(dataDir), success('pnpm db:migrate'));
    expect(rows('SELECT status, closes FROM pairings')[0]).toEqual({
      status: 'unverified',
      closes: 1,
    });

    // Session 2 is SHOWN it, fixes the same file, and passes.
    const replay = await runScript(
      pushFailureHookScript(dataDir),
      failure('pnpm db:migrate', ENOENT, 's2'),
    );
    expect(replay.stdout).toContain('Someone once fixed this by touching');
    await runScript(pushContextHookScript(dataDir), edit('/repo/one/src/migrate.ts', 's2'));
    await runScript(pushFailureHookScript(dataDir), success('pnpm db:migrate', 's2'));

    // One pairing, two independent closers, promoted.
    expect(rows('SELECT * FROM pairings')).toHaveLength(1);
    expect(rows('SELECT status, closes FROM pairings')[0]).toEqual({
      status: 'verified',
      closes: 2,
    });
    expect(
      rows('SELECT session FROM pairing_closes ORDER BY session').map((r) => r.session),
    ).toEqual(['s1', 's2']);

    // And a third session gets the STRONG wording, which was unreachable before.
    const verified = await runScript(
      pushFailureHookScript(dataDir),
      failure('pnpm db:migrate', ENOENT, 's3'),
    );
    expect(verified.stdout).toContain('Fixed here 2 time(s) by changing');
    expect(verified.stdout).not.toContain('Someone once fixed this');
    expect(rows("SELECT strength FROM injections WHERE session = 's3'")[0]?.strength).toBe(
      'strong',
    );
  });

  /**
   * The second closer is RECRUITED by the suggestion, so independence alone is
   * too weak a bar: a session shown "someone once fixed this by touching
   * migrate.ts" re-runs the failing command by definition, which satisfies the
   * same-command branch of the close rule while it edits anything at all. Being
   * shown a pairing therefore buys no relaxation, and a close corroborates only
   * if its fix OVERLAPS the first closer's.
   */
  it('does not promote on a second close that touched something else', async () => {
    await writeConfig({ baseUrl: 'http://127.0.0.1:1' });
    await runScript(pushFailureHookScript(dataDir), failure('pnpm db:migrate', ENOENT));
    await runScript(pushContextHookScript(dataDir), edit('/repo/one/src/migrate.ts'));
    await runScript(pushFailureHookScript(dataDir), success('pnpm db:migrate'));

    // Session 2 is shown it, edits something unrelated, and the command passes.
    const replay = await runScript(
      pushFailureHookScript(dataDir),
      failure('pnpm db:migrate', ENOENT, 's2'),
    );
    expect(replay.stdout).toContain('Someone once fixed this by touching');
    await runScript(pushContextHookScript(dataDir), edit('/repo/one/src/unrelated.ts', 's2'));
    await runScript(pushFailureHookScript(dataDir), success('pnpm db:migrate', 's2'));

    // The close is RECORDED — it is real evidence — but it corroborates nothing.
    expect(rows('SELECT COUNT(*) AS n FROM pairing_closes')[0]).toEqual({ n: 2 });
    expect(rows('SELECT status, closes FROM pairings')[0]).toEqual({
      status: 'unverified',
      closes: 1,
    });
    // And the wording still names only what the corroborating closers touched.
    expect(JSON.parse(String(rows('SELECT fix_files FROM pairings')[0]?.fix_files))).toEqual([
      'migrate.ts',
    ]);
    const third = await runScript(
      pushFailureHookScript(dataDir),
      failure('pnpm db:migrate', ENOENT, 's3'),
    );
    expect(third.stdout).toContain('Someone once fixed this by touching');
    expect(third.stdout).not.toContain('Fixed here');
  });

  /** ...and a shown session that neither touched a named file nor re-ran the
   *  failing command does not close it at all. */
  it('does not close for a shown session with no named file and a different command', async () => {
    await writeConfig({ baseUrl: 'http://127.0.0.1:1' });
    await runScript(pushFailureHookScript(dataDir), failure('pnpm db:migrate', ENOENT));
    await runScript(pushContextHookScript(dataDir), edit('/repo/one/src/migrate.ts'));
    await runScript(pushFailureHookScript(dataDir), success('pnpm db:migrate'));

    await runScript(pushFailureHookScript(dataDir), failure('pnpm db:migrate', ENOENT, 's2'));
    await runScript(pushContextHookScript(dataDir), edit('/repo/one/src/unrelated.ts', 's2'));
    // A different command on the same allowlisted head.
    await runScript(pushFailureHookScript(dataDir), success('pnpm db:migrate --force', 's2'));

    expect(rows('SELECT COUNT(*) AS n FROM pairing_closes')[0]).toEqual({ n: 1 });
    expect(rows('SELECT status, closes FROM pairings')[0]).toEqual({
      status: 'unverified',
      closes: 1,
    });
  });

  /**
   * The replayed-pairing branch is the one that reaches `verified`, so a
   * cross-project close there does not merely add a weak row — it manufactures
   * the confident one, stamped with a filename the first repo has never had.
   */
  it('never closes a shown pairing from another checkout', async () => {
    await writeConfig({ baseUrl: 'http://127.0.0.1:1' });
    await runScript(pushFailureHookScript(dataDir), failure('pnpm db:migrate', ENOENT));
    await runScript(pushContextHookScript(dataDir), edit('/repo/one/src/migrate.ts'));
    await runScript(pushFailureHookScript(dataDir), success('pnpm db:migrate'));
    const before = rows('SELECT status, closes, fix_files FROM pairings')[0];

    // The SAME session is shown it in repo one, then moves to repo two, edits
    // there, and the same command head passes.
    await runScript(pushFailureHookScript(dataDir), failure('pnpm db:migrate', ENOENT, 's2'));
    await runScript(
      pushContextHookScript(dataDir),
      edit('/repo/two/src/other.ts', 's2', '/repo/two'),
    );
    await runScript(pushFailureHookScript(dataDir), success('pnpm db:migrate', 's2', '/repo/two'));

    expect(rows('SELECT status, closes, fix_files FROM pairings')[0]).toEqual(before);
    expect(rows('SELECT COUNT(*) AS n FROM pairing_closes')[0]).toEqual({ n: 1 });
  });

  /**
   * "Two INDEPENDENT closes" means two SESSIONS. With a bare counter one session
   * could close, be replayed to itself, close again and self-promote; the
   * (pairing_id, session) primary key is what makes that impossible.
   */
  it('never lets one session verify a pairing by itself', async () => {
    await writeConfig({ baseUrl: 'http://127.0.0.1:1' });
    await runScript(pushFailureHookScript(dataDir), failure('pnpm db:migrate', ENOENT));
    await runScript(pushContextHookScript(dataDir), edit('/repo/one/src/migrate.ts'));
    await runScript(pushFailureHookScript(dataDir), success('pnpm db:migrate'));
    // The same session hits it again, is replayed its own pairing, and passes again.
    await runScript(pushFailureHookScript(dataDir), failure('pnpm db:migrate', ENOENT));
    await runScript(pushContextHookScript(dataDir), edit('/repo/one/src/migrate.ts'));
    await runScript(pushFailureHookScript(dataDir), success('pnpm db:migrate'));

    expect(rows('SELECT status, closes FROM pairings')[0]).toEqual({
      status: 'unverified',
      closes: 1,
    });
    expect(rows('SELECT COUNT(*) AS n FROM pairing_closes')[0]).toEqual({ n: 1 });
  });

  /**
   * A laptop runs several checkouts. `pnpm test` passing in one repo must not
   * close another repo's pairing and stamp it with a file that repo has never
   * had — nor may a failure in one repo be answered with the other's fix.
   */
  it('never closes or replays across projects', async () => {
    await writeConfig({ baseUrl: 'http://127.0.0.1:1' });
    await runScript(pushFailureHookScript(dataDir), failure('pnpm db:migrate', ENOENT));
    expect(rows('SELECT status FROM pairings')[0]?.status).toBe('open');

    // A different repo, same command head, an edit and a pass.
    await runScript(
      pushContextHookScript(dataDir),
      edit('/repo/two/src/other.ts', 's2', '/repo/two'),
    );
    await runScript(pushFailureHookScript(dataDir), success('pnpm db:migrate', 's2', '/repo/two'));
    expect(rows('SELECT status FROM pairings')[0]?.status).toBe('open');

    // Close it properly in its own repo, then hit the same failure in the other.
    await runScript(pushContextHookScript(dataDir), edit('/repo/one/src/migrate.ts'));
    await runScript(pushFailureHookScript(dataDir), success('pnpm db:migrate'));
    expect(rows('SELECT status FROM pairings')[0]?.status).toBe('unverified');

    const elsewhere = await runScript(
      pushFailureHookScript(dataDir),
      failure('pnpm db:migrate', ENOENT, 's3', '/repo/two'),
    );
    // No replay from a checkout that never had migrate.ts; it opens its own row.
    expect(elsewhere.stdout).not.toContain('Someone once fixed this');
    expect(rows('SELECT COUNT(*) AS n FROM pairings')[0]).toEqual({ n: 2 });
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

describe('what the store is allowed to hold, and hand back', () => {
  /**
   * A command line is the one input this arm sees that routinely carries a
   * credential: leading `FOO=bar` assignments are stepped over by the head
   * parser, so `DATABASE_URL=postgres://app:pw@db.internal/x pnpm db:migrate` is
   * allowlisted. `clean()` only strips control bytes, so the raw line used to
   * land verbatim in `events.data`, `pairings.cmd` and `pairings.fix_cmd` — and
   * `fix_cmd` is read back OUT into a later session's context by the replay.
   */
  it('never stores or replays a credential from the command line', async () => {
    await writeConfig({ baseUrl: 'http://127.0.0.1:1' });
    const secret = 'postgres://app:hunter2@db.internal/x';
    const command = `DATABASE_URL=${secret} pnpm db:migrate`;
    const ENOENT =
      "Error: ENOENT: no such file or directory, open 'drizzle.config.ts'\n" +
      '    at run (/repo/one/src/migrate.ts:12:3)\n';
    const fire = (session: string, response: Record<string, string>) =>
      JSON.stringify({
        session_id: session,
        cwd: '/repo/one',
        hook_event_name: 'PostToolUse',
        tool_name: 'Bash',
        tool_input: { command },
        tool_response: response,
      });

    await runScript(pushFailureHookScript(dataDir), fire('s1', { stdout: '', stderr: ENOENT }));
    await runScript(
      pushContextHookScript(dataDir),
      JSON.stringify({
        session_id: 's1',
        cwd: '/repo/one',
        hook_event_name: 'PreToolUse',
        tool_name: 'Edit',
        tool_input: { file_path: '/repo/one/src/migrate.ts' },
      }),
    );
    await runScript(pushFailureHookScript(dataDir), fire('s1', { stdout: 'ok\n', stderr: '' }));

    // Nothing anywhere in the database.
    const dump = JSON.stringify([
      rows('SELECT data FROM events'),
      rows('SELECT cmd, fix_cmd, error_line FROM pairings'),
      rows('SELECT fix_cmd FROM pairing_closes'),
    ]);
    expect(dump).not.toContain('hunter2');
    expect(dump).not.toContain('db.internal');

    // ...and nothing in what a LATER session is handed back.
    const replay = await runScript(
      pushFailureHookScript(dataDir),
      fire('s2', { stdout: '', stderr: ENOENT }),
    );
    expect(replay.stdout).toContain('Someone once fixed this by touching');
    expect(replay.stdout).not.toContain('hunter2');
    expect(replay.stdout).not.toContain('db.internal');
  });

  /**
   * The close rule's only evidence is the edited-files record, and it used to be
   * one JSON map bounded at 200 keys evicted in Object.keys ORDER — insertion
   * order, which re-writing an existing key does not change. So re-editing the
   * earliest-touched file (very often exactly the config the failing command
   * named) put the freshest timestamp in the map and then deleted it on the next
   * new-path edit, and the pairing never closed.
   */
  it('closes a pairing fixed in a file edited long before 200 others', async () => {
    await writeConfig({ baseUrl: 'http://127.0.0.1:1' });
    const edit = (path: string) =>
      JSON.stringify({
        session_id: 's1',
        cwd: '/repo/one',
        hook_event_name: 'PreToolUse',
        tool_name: 'Edit',
        tool_input: { file_path: path },
      });
    // The file the failure will name, touched FIRST.
    await runScript(pushContextHookScript(dataDir), edit('/repo/one/drizzle.config.ts'));
    await runScript(
      pushFailureHookScript(dataDir),
      JSON.stringify({
        session_id: 's1',
        cwd: '/repo/one',
        hook_event_name: 'PostToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'pnpm db:migrate' },
        tool_response: {
          stdout: '',
          stderr:
            "Error: ENOENT: no such file or directory, open 'x'\n" +
            '    at load (/repo/one/drizzle.config.ts:4:1)\n',
        },
      }),
    );
    // 210 unrelated files, then the fix to the original one.
    for (let i = 0; i < 210; i += 1) {
      await runScript(pushContextHookScript(dataDir), edit(`/repo/one/src/f${i}.ts`));
    }
    await runScript(pushContextHookScript(dataDir), edit('/repo/one/drizzle.config.ts'));
    await runScript(
      pushFailureHookScript(dataDir),
      JSON.stringify({
        session_id: 's1',
        cwd: '/repo/one',
        hook_event_name: 'PostToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'pnpm db:migrate' },
        tool_response: { stdout: 'ok\n', stderr: '' },
      }),
    );
    expect(rows('SELECT status FROM pairings')[0]?.status).toBe('unverified');
    expect(JSON.parse(String(rows('SELECT fix_files FROM pairings')[0]?.fix_files))).toContain(
      'drizzle.config.ts',
    );
  }, 60_000);

  /**
   * Parallel subagents share their parent's session id, and both hook events can
   * fire for one failure on some harnesses. The "seen this signature" check was
   * a read-modify-write of one JSON list, so two processes both passed it: one
   * failure opened two pairings and spent two lookups.
   */
  it('opens one pairing when two hooks fire for one failure at once', async () => {
    await writeConfig({ baseUrl: 'http://127.0.0.1:1' });
    const payload = JSON.stringify({
      session_id: 's1',
      cwd: '/repo/one',
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'pnpm db:migrate' },
      tool_response: {
        stdout: '',
        stderr:
          "Error: ENOENT: no such file or directory, open 'drizzle.config.ts'\n" +
          '    at run (/repo/one/src/migrate.ts:12:3)\n',
      },
    });
    const runs = await Promise.all(
      Array.from({ length: 6 }, () => runScript(pushFailureHookScript(dataDir), payload)),
    );
    for (const run of runs) {
      expect(run.code).toBe(0);
      expect(run.stderr).toBe('');
    }
    expect(rows('SELECT COUNT(*) AS n FROM pairings')[0]).toEqual({ n: 1 });
    expect(rows("SELECT COUNT(*) AS n FROM events WHERE hook = 'failure'")[0]).toEqual({ n: 1 });
  }, 30_000);
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
