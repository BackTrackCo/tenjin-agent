import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm, writeFile, chmod, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  RETIRED_STATE_ENTRIES,
  STATE_DB_FILE,
  STORE_DDL,
  STORE_MIGRATIONS,
  STORE_BUSY_TIMEOUT_MS,
  STORE_QUEUED_FINDING_PREFIX,
  STORE_SQL,
  STORE_USER_VERSION,
  findSearchForResource,
  findStoredCandidate,
  getStoredSearch,
  latestSearch,
  linkSearchesToDraft,
  loadSearches,
  markSearchResolved,
  openSearches,
  openStore,
  probeSqlite,
  assertSelectOnly,
  queryStateReadOnly,
  recordSearch,
  removeRetiredState,
  projectIdOf,
  searchesForDraft,
  shortHash,
  repoSlug,
  teamCoarseKey,
  storeSource,
  type StoredSearch,
} from './state-store';
import {
  pushContextHookScript,
  pushFailureHookScript,
  pushPromptHookScript,
  pushSubagentHookScript,
  PUSH_LOOKUP_CAPS_PER_WINDOW,
  PUSH_LOOKUP_CAP_DEFAULT,
} from './push-scripts';
import {
  dispatchHookScript,
  prelude,
  sessionPrimerHookScript,
  stopHookScript,
  websearchHookScript,
} from './hook-scripts';
import { REPO_SLUG_CASES } from './repo-slug-cases';

const DAY_MS = 24 * 60 * 60_000;

/** A timestamp `ms` in the past, as an ISO string.
 *
 * RELATIVE, because the store's attribution window is measured against the real
 * clock: a fixture pinned to a fixed date silently falls out of the window as
 * the repo ages, and the test that depended on it starts failing on a day
 * nobody touched the code. */
function agoIso(ms: number): string {
  return new Date(Date.now() - ms).toISOString();
}

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

/**
 * A generated hook script with the WAL switch forced to fail on BOTH attempts,
 * so the store runs where #246's give-up leaves it: open, correct, and on a
 * rollback journal for good.
 *
 * The count assertion is the guard. A stub that silently stops matching would
 * turn its test back into an ordinary run of the happy path — passing, and
 * proving nothing — which is the failure mode a stub of production source has
 * and a fixture does not.
 */
function withoutWal(source: string): string {
  const statement = "db.exec('PRAGMA journal_mode = wal');";
  expect(
    source.split(statement).length - 1,
    'the WAL switch is not where this stub expects it; setWal moved or changed',
  ).toBe(1);
  return source.replace(statement, "throw new Error('forced: no wal');");
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
    // The deltas travel too, or a hook meeting a v1 database creates the schema
    // it was compiled against and stamps a version the column is missing from.
    expect(source).toContain(JSON.stringify(STORE_MIGRATIONS));
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

  /**
   * `projectIdOf` is the CLI's copy of the `project` a hook stamps on a row, and
   * `publish --finding` compares one against the other to decide whether a
   * finding was captured in the checkout it is being published from. Two
   * implementations of that value that drift make every finding cross-project,
   * or none, and neither failure announces itself. The generated function cannot
   * import the exported one, so the pin is its own text.
   */
  it('mirrors the project id the generated store stamps on a row', () => {
    const source = storeSource();
    expect(source).toContain(
      "return createHash('sha256').update(String(text)).digest('hex').slice(0, 16);",
    );
    expect(source).toContain(
      "return typeof cwd === 'string' && cwd.length > 0 ? shortHash(cwd) : null;",
    );
    expect(projectIdOf('/repo/one')).toBe(
      createHash('sha256').update('/repo/one').digest('hex').slice(0, 16),
    );
    expect(projectIdOf('/repo/one')).not.toBe(projectIdOf('/repo/two'));
    expect(projectIdOf(null)).toBeNull();
    expect(projectIdOf('')).toBeNull();
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
        ['alreadyShownOrLiveRelay', STORE_SQL.alreadyShownOrLiveRelay, ['s', 'r', 0]],
        ['bucketCount', STORE_SQL.bucketCount, ['prompt', 0]],
        ['findPairing', STORE_SQL.findPairing, ['p', 'k', 'c']],
        ['openForHead', STORE_SQL.openForHead, ['p', 'h', 0, 8]],
        ['openLoops', STORE_SQL.openLoops, [0, '', '', 25]],
        ['researchedBySession', STORE_SQL.researchedBySession, ['s']],
        ['getState', STORE_SQL.getState, ['s', 'k']],
        // The subagent handoff: one take per fire, and the range it seeks on is
        // the primary key's own.
        [
          'takeStateOldestByPrefix',
          STORE_SQL.takeStateOldestByPrefix,
          ['s', 's', 'dispatch_cache', 'dispatch_cache￿'],
        ],
        // The SubagentStop capture gate runs before a child may be held open for
        // one more turn, so it may not be the read that scans a table that never
        // shrinks (tenjin-agent#228). The finding half of that gate now reads the
        // queue prefix below, not `events`.
        ['openDispatchMiss', STORE_SQL.openDispatchMiss, ['s', 0]],
        // The finding queue is read ACROSS sessions at every capture ask, which
        // `events` has no index for: under one `session_state` prefix it is a
        // primary-key range seek instead of a scan of a table that never shrinks.
        [
          'statePrefixSince (finding queue)',
          STORE_SQL.statePrefixSince,
          ['', STORE_QUEUED_FINDING_PREFIX, STORE_QUEUED_FINDING_PREFIX + '\uffff', 0, 200],
        ],
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
  it('creates the schema at the current version and is idempotent', async () => {
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

/**
 * VERSION 1, FROZEN. The four tables version 2 alters, exactly as the build that
 * shipped them wrote them — a copy, never an import, because the point of every
 * case below is a file THIS BUILD DID NOT CREATE. Reading the live `STORE_DDL`
 * here would make these tests assert that today's schema migrates to today's
 * schema, which is true of any schema and proves nothing.
 *
 * Only the columns the step touches are spelled out; the rest of a v1 file is
 * identical to a v2 one, so the fixture lays these down FIRST and lets
 * `STORE_DDL`'s `IF NOT EXISTS` fill in everything else around them.
 */
const V1_DDL = `
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY,
  uid TEXT NOT NULL UNIQUE,
  at INTEGER NOT NULL,
  session TEXT NOT NULL,
  project TEXT,
  machine TEXT NOT NULL,
  hook TEXT NOT NULL,
  tool TEXT,
  error_hash TEXT,
  files TEXT,
  data TEXT
);
CREATE TABLE IF NOT EXISTS injections (
  id INTEGER PRIMARY KEY,
  uid TEXT NOT NULL UNIQUE,
  event_uid TEXT,
  at INTEGER NOT NULL,
  session TEXT NOT NULL,
  project TEXT,
  machine TEXT NOT NULL,
  hook TEXT NOT NULL,
  shelf TEXT NOT NULL,
  resource_id TEXT,
  title TEXT,
  url TEXT,
  price TEXT,
  search_id TEXT,
  score REAL,
  second REAL,
  strength TEXT,
  confidence TEXT,
  corroborated INTEGER,
  action TEXT NOT NULL,
  reason TEXT,
  form TEXT,
  deny INTEGER DEFAULT 0,
  tokens INTEGER,
  outcome TEXT,
  outcome_at INTEGER,
  outcome_by TEXT,
  posted_at INTEGER,
  synced_at INTEGER
);
CREATE TABLE IF NOT EXISTS searches (
  search_id TEXT PRIMARY KEY,
  at INTEGER NOT NULL,
  session TEXT NOT NULL,
  question TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  decision TEXT NOT NULL,
  candidates TEXT NOT NULL,
  source TEXT,
  shelf_base_url TEXT,
  paid_browse_count INTEGER,
  resolved_by TEXT,
  resolved_at TEXT
);
CREATE TABLE IF NOT EXISTS pairing_closes (
  pairing_id INTEGER NOT NULL,
  session TEXT NOT NULL,
  at INTEGER NOT NULL,
  fix_cmd TEXT,
  fix_files TEXT,
  scope TEXT,
  PRIMARY KEY (pairing_id, session)
);
`;

/** The statements a v1 hook script carries for those tables, frozen for the same
 *  reason `V1_DDL` is: an installed hook is regenerated only by `tenjin
 *  install`, so v1 scripts go on writing to a file a newer CLI has migrated. */
const V1_SQL = {
  insertEvent: `INSERT INTO events (uid, at, session, project, machine, hook, tool, error_hash, files, data)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  recordSearch: `INSERT INTO searches (
       search_id, at, session, question, fingerprint, decision, candidates,
       source, shelf_base_url, paid_browse_count
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  claimClose: `INSERT OR IGNORE INTO pairing_closes
       (pairing_id, session, at, fix_cmd, fix_files, scope)
     VALUES (?, ?, ?, ?, ?, ?)`,
} as const;

/**
 * A state.db at version 1 with one row in each of the four tables the step
 * touches, so a migration that drops and recreates rather than altering is
 * caught by the rows going missing and not only by the column list.
 *
 * The `events` row carries the `data.agentId` tenjin-agent#242 has been writing
 * since 2026-08-28, because lifting that into the column is half of what the
 * step does.
 */
function seedV1(): void {
  const handle = db();
  try {
    handle.exec(V1_DDL);
    // Everything else at its current shape; the four above are already there,
    // and every statement in STORE_DDL is IF NOT EXISTS.
    handle.exec(STORE_DDL);
    handle
      .prepare(V1_SQL.insertEvent)
      .run('e-lead', 1, 'sess-v1', null, 'machine', 'edit', 'Edit', null, null, '{"event":"x"}');
    handle
      .prepare(V1_SQL.insertEvent)
      .run(
        'e-child',
        2,
        'sess-v1',
        null,
        'machine',
        'edit',
        'Edit',
        null,
        null,
        '{"event":"x","agentId":"a1"}',
      );
    handle
      .prepare(
        `INSERT INTO injections (
           uid, event_uid, at, session, project, machine, hook, shelf,
           resource_id, title, url, price,
           search_id, score, second, strength, confidence, corroborated,
           action, reason, form, deny, tokens
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'u-old',
        null,
        1,
        'sess-v1',
        null,
        'machine',
        'prompt',
        'public',
        'res-1',
        'an old row',
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        'injected',
        null,
        null,
        0,
        null,
      );
    handle
      .prepare(V1_SQL.recordSearch)
      .run(
        'v1-search',
        1,
        'sess-v1',
        'why does it fail',
        'why does it fail',
        'MISS',
        '[]',
        'cli',
        null,
        null,
      );
    handle.prepare(V1_SQL.claimClose).run(1, 'sess-v1', 1, 'pnpm test', '["a.ts"]', 'code');
    handle.exec('PRAGMA user_version = 1');
  } finally {
    handle.close();
  }
}

/** The column names of `table`, in declaration order. */
function columns(table: string): string[] {
  return rows(`PRAGMA table_info(${table})`).map((r) => String(r.name));
}

/** The four tables version 2 puts `agent_id` on. */
const V2_TABLES = ['events', 'injections', 'searches', 'pairing_closes'] as const;

/**
 * `tenjin state query` (tenjin-agent#252): read-only ad hoc SQL against the
 * state db, for an operator who reaches for `sqlite3 -readonly` and hits
 * "unable to open database file (14)" against the WAL-mode store.
 */
describe('queryStateReadOnly', () => {
  it('runs a SELECT and returns rows as plain objects', async () => {
    const store = await openStore(dataDir);
    if (store === null) throw new Error('no store');
    store.run(STORE_SQL.setState, ['', 'k1', 'v1', 1000]);
    store.run(STORE_SQL.setState, ['', 'k2', 'v2', 2000]);
    store.close();

    const rows = await queryStateReadOnly(
      dataDir,
      "SELECT key, value FROM session_state WHERE session = '' ORDER BY key",
    );
    expect(rows).toEqual([
      { key: 'k1', value: 'v1' },
      { key: 'k2', value: 'v2' },
    ]);
  });

  it('accepts a WITH ... SELECT statement and a single trailing semicolon', async () => {
    const store = await openStore(dataDir);
    if (store === null) throw new Error('no store');
    store.run(STORE_SQL.setState, ['', 'k1', 'v1', 1000]);
    store.close();

    const rows = await queryStateReadOnly(
      dataDir,
      'WITH t AS (SELECT key FROM session_state) SELECT key FROM t;',
    );
    expect(rows).toEqual([{ key: 'k1' }]);
  });

  it('rejects a non-SELECT statement before opening the file', async () => {
    await expect(queryStateReadOnly(dataDir, 'DELETE FROM session_state')).rejects.toMatchObject({
      code: 'USAGE',
    });
    await expect(queryStateReadOnly(dataDir, '   ')).rejects.toMatchObject({ code: 'USAGE' });
  });

  /** A SELECT smuggling a second statement after a `;` is still one write this
   *  verb must never make room for. */
  it('rejects a second statement riding after a semicolon', async () => {
    await expect(
      queryStateReadOnly(dataDir, 'SELECT 1; DROP TABLE session_state'),
    ).rejects.toMatchObject({ code: 'USAGE' });
  });

  /** `readOnly: true` fails outright rather than creating the file — the right
   *  answer for an inspection tool that must never materialize the store it was
   *  asked to look inside. */
  it('fails STATE_QUERY_FAILED against a data dir with no store yet', async () => {
    const empty = await mkdtemp(join(tmpdir(), 'tenjin-state-query-'));
    try {
      await expect(queryStateReadOnly(empty, 'SELECT 1 AS one')).rejects.toMatchObject({
        code: 'STATE_QUERY_FAILED',
      });
    } finally {
      await rm(empty, { recursive: true, force: true });
    }
  });

  it('fails STATE_QUERY_FAILED on a query the driver itself refuses', async () => {
    const store = await openStore(dataDir);
    if (store === null) throw new Error('no store');
    store.close();
    await expect(queryStateReadOnly(dataDir, 'SELECT * FROM no_such_table')).rejects.toMatchObject({
      code: 'STATE_QUERY_FAILED',
    });
  });
});

/**
 * Edge cases in the single-read-statement guard, filed against Greptile's PR
 * 277 review: a semicolon or a write keyword sitting INSIDE a string literal
 * or a comment must not be read as though it were outside one, and a `WITH`
 * clause must not be allowed to lead into a write just because the leading
 * keyword happens to be `WITH`.
 */
describe('assertSelectOnly: literals, comments, and WITH-prefixed writes', () => {
  it('accepts a SELECT whose only ";" sits inside a string literal', () => {
    expect(assertSelectOnly("SELECT * FROM t WHERE msg = 'a;b'")).toBe(
      "SELECT * FROM t WHERE msg = 'a;b'",
    );
  });

  it('still rejects a real second statement after a literal that contains a ";"', () => {
    expect(() => assertSelectOnly("SELECT * FROM t WHERE msg = 'a;b'; DROP TABLE t")).toThrow(
      /one statement/i,
    );
  });

  it('accepts a SELECT preceded by a line comment', () => {
    expect(assertSelectOnly('-- note\nSELECT 1')).toBe('-- note\nSELECT 1');
  });

  it('accepts a SELECT preceded by a block comment', () => {
    expect(assertSelectOnly('/* note */ SELECT 1')).toBe('/* note */ SELECT 1');
  });

  it('rejects a WITH clause that leads into a DELETE rather than a SELECT', () => {
    expect(() => assertSelectOnly('WITH x AS (SELECT 1) DELETE FROM session_state')).toThrow(
      /read-only/i,
    );
  });

  it('rejects a WITH clause that leads into an INSERT rather than a SELECT', () => {
    expect(() =>
      assertSelectOnly("WITH x AS (SELECT 1) INSERT INTO session_state VALUES ('', 'k', 'v', 0)"),
    ).toThrow(/read-only/i);
  });

  it('does not misfire on a write keyword that only appears inside a string literal', () => {
    expect(assertSelectOnly("SELECT * FROM injections WHERE reason = 'insert failed'")).toBe(
      "SELECT * FROM injections WHERE reason = 'insert failed'",
    );
  });

  it('does not misfire on a column name that merely contains a write keyword as a substring', () => {
    expect(assertSelectOnly('SELECT deleted_at FROM pairings')).toBe(
      'SELECT deleted_at FROM pairings',
    );
  });

  it('still rejects a bare PRAGMA', () => {
    expect(() => assertSelectOnly('PRAGMA journal_mode')).toThrow(/SELECT/i);
  });
});

/**
 * A database that already exists is the ONLY interesting case for a schema
 * change: the fresh path is covered by every other test in this file, and a
 * migration that only works on an empty directory has migrated nothing.
 *
 * BOTH BOOTSTRAPS ARE TESTED, because there are two of them: the CLI's
 * `openStore` and the copy `storeSource()` bakes into every hook. A machine
 * whose hooks are older than its CLI (they are regenerated only by `tenjin
 * install`) can have either side meet the old database first.
 */
describe('migration', () => {
  /**
   * THE STEP, ON A FILE THIS BUILD DID NOT CREATE.
   *
   * `STORE_DDL` is all `IF NOT EXISTS`, so for one version the bootstrap could
   * afford to be careless: running it twice was a no-op. Version 2 is `ALTER
   * TABLE ADD COLUMN`, which is NOT idempotent — a second run throws `duplicate
   * column name` and, inside the bootstrap, costs that process its whole store.
   * So the branch is exclusive and gated on a version re-read inside the
   * transaction, and this is the case that says the migrating half works.
   */
  it('migrates a version 1 database in place and keeps its rows (CLI copy)', async () => {
    seedV1();
    // The premise, checked rather than assumed: without it a schema bug would
    // read as "the migration worked" on a file that was already v2.
    expect(rows('PRAGMA user_version')[0]).toEqual({ user_version: 1 });
    for (const table of V2_TABLES) expect(columns(table)).not.toContain('agent_id');

    const store = await openStore(dataDir);
    expect(store).not.toBeNull();
    store?.close();

    expect(rows('PRAGMA user_version')[0]).toEqual({ user_version: STORE_USER_VERSION });
    // ALL FOUR, or the identity is only part migrated: one version, one entry.
    for (const table of V2_TABLES) expect(columns(table)).toContain('agent_id');
    // ALTERED, NOT REBUILT. The rows a machine already had are the whole reason
    // this is a migration rather than a fresh file.
    expect(rows('SELECT uid, session, agent_id FROM injections')).toEqual([
      { uid: 'u-old', session: 'sess-v1', agent_id: null },
    ]);
    expect(rows('SELECT search_id, session, agent_id FROM searches')).toEqual([
      { search_id: 'v1-search', session: 'sess-v1', agent_id: null },
    ]);
    expect(rows('SELECT pairing_id, session, agent_id FROM pairing_closes')).toEqual([
      { pairing_id: 1, session: 'sess-v1', agent_id: null },
    ]);
    // BACKFILLED. #242 wrote the agent into `events.data` for the fortnight
    // before this column existed; a step that only added the column would hand
    // every one of those rows back to the lead, and the score would credit a
    // child's fix to its parent.
    expect(rows('SELECT uid, agent_id FROM events ORDER BY uid')).toEqual([
      { uid: 'e-child', agent_id: 'a1' },
      { uid: 'e-lead', agent_id: null },
    ]);

    // ...and a second open steps nothing: the version gate is what keeps the
    // non-idempotent ALTER from running twice.
    const again = await openStore(dataDir);
    expect(again).not.toBeNull();
    again?.close();
    expect(rows('PRAGMA user_version')[0]).toEqual({ user_version: STORE_USER_VERSION });
    expect(columns('events').filter((c) => c === 'agent_id')).toHaveLength(1);
  });

  it('migrates a version 1 database in place (hook copy)', async () => {
    await writeConfig();
    seedV1();

    const run = await runScript(
      stopHookScript(dataDir),
      JSON.stringify({ session_id: 'sess-v1', hook_event_name: 'Stop', cwd: '/repo/one' }),
    );
    expect(run.code).toBe(0);
    expect(run.stderr).toBe('');

    expect(rows('PRAGMA user_version')[0]).toEqual({ user_version: STORE_USER_VERSION });
    for (const table of V2_TABLES) expect(columns(table)).toContain('agent_id');
    expect(rows('SELECT uid, agent_id FROM events ORDER BY uid')).toEqual([
      { uid: 'e-child', agent_id: 'a1' },
      { uid: 'e-lead', agent_id: null },
    ]);
    expect(rows('SELECT uid, agent_id FROM injections')).toEqual([
      { uid: 'u-old', agent_id: null },
    ]);
  });

  /**
   * THE COLD START, BUT ON A MIGRATION — the case the fresh-database race
   * elsewhere in this file cannot cover.
   *
   * Twelve hook processes meeting a v1 file all take `BEGIN IMMEDIATE`, and
   * eleven of them come back to a database the winner has just altered. With an
   * idempotent DDL that was survivable however the gate behaved; with `ALTER
   * TABLE ADD COLUMN` the loser that re-runs the step throws `duplicate column
   * name`, and the bootstrap turns that into a null store — one fire's whole
   * state, with `state store unavailable (duplicate column name: agent_id)` on
   * the stderr Claude Code shows the operator.
   *
   * THROUGH THE SPAWNED SCRIPTS, so it is the JS copy of the stepper under test
   * and not the TS one: the hooks are where twelve concurrent openers actually
   * happen, and the two copies are separate source.
   */
  it('survives a dozen hook processes racing a version 1 database', async () => {
    await writeConfig({ baseUrl: 'http://127.0.0.1:1' });
    seedV1();
    const payload = JSON.stringify({
      session_id: 'v1-race',
      hook_event_name: 'Stop',
      cwd: '/repo/one',
    });

    const runs = await Promise.all(
      Array.from({ length: 12 }, () => runScript(stopHookScript(dataDir), payload)),
    );
    for (const run of runs) {
      expect(run.code).toBe(0);
      // Every byte of stderr reaches the operator, and this is the exact
      // sentence a re-run ALTER would put there.
      expect(run.stderr).not.toContain('duplicate column');
      expect(run.stderr).toBe('');
    }

    expect(rows('PRAGMA user_version')[0]).toEqual({ user_version: STORE_USER_VERSION });
    // ONCE. Twelve openers, one column each: a stepper that ran the ALTER per
    // process would have thrown rather than added a second, so the count says
    // the gate held and not merely that SQLite refused.
    for (const table of V2_TABLES) {
      expect(columns(table).filter((c) => c === 'agent_id')).toHaveLength(1);
    }
    expect(rows('SELECT COUNT(*) AS n FROM searches')[0]).toEqual({ n: 1 });
  }, 30_000);

  /**
   * THE OTHER DIRECTION: a version 1 hook script against a file a newer CLI has
   * migrated. Hook scripts are regenerated only by `tenjin install`, so this is
   * the ordinary state of a machine that upgraded the CLI and has not
   * re-installed — the same asymmetry the `<` version gate exists for. A v1
   * statement names its columns explicitly and the new one is nullable, so the
   * write lands, unstamped, which is exactly what it means.
   */
  it('takes a version 1 hook core writing to a version 2 database', async () => {
    const store = await openStore(dataDir);
    expect(store).not.toBeNull();
    store?.close();
    expect(rows('PRAGMA user_version')[0]).toEqual({ user_version: STORE_USER_VERSION });

    const handle = db();
    try {
      expect(() =>
        handle
          .prepare(V1_SQL.insertEvent)
          .run('old-hook', 1, 'sess-old', null, 'machine', 'edit', 'Edit', null, null, null),
      ).not.toThrow();
      expect(() =>
        handle
          .prepare(V1_SQL.recordSearch)
          .run('old-search', 1, 'sess-old', 'q', 'q', 'MISS', '[]', 'cli', null, null),
      ).not.toThrow();
      expect(() =>
        handle.prepare(V1_SQL.claimClose).run(7, 'sess-old', 1, 'pnpm test', '["a.ts"]', 'code'),
      ).not.toThrow();
    } finally {
      handle.close();
    }

    expect(rows('SELECT agent_id FROM events')).toEqual([{ agent_id: null }]);
    expect(rows('SELECT agent_id FROM searches')).toEqual([{ agent_id: null }]);
    expect(rows('SELECT agent_id FROM pairing_closes')).toEqual([{ agent_id: null }]);
  });

  /** The fresh path CREATES the current shape rather than stepping up to it, so
   *  a new machine must never need the migration to catch up. */
  it('a fresh database lands at the current version with the columns present', async () => {
    const store = await openStore(dataDir);
    store?.close();
    expect(rows('PRAGMA user_version')[0]).toEqual({ user_version: STORE_USER_VERSION });
    for (const table of V2_TABLES) expect(columns(table)).toContain('agent_id');
  });
});

/**
 * THE WAL SWITCH, BOTH ENDINGS (tenjin-agent#246).
 *
 * `PRAGMA journal_mode = wal` is the one statement in this module the busy
 * timeout does not cover: against a connection holding a write lock it throws at
 * 0 ms with the busy handler never consulted, which is how the cold-start
 * stampede killed the loser one line before the transaction `bootstrap()`
 * protects. The fix is a second attempt AFTER the bootstrap, and a give-up that
 * leaves the store open on a rollback journal rather than dead.
 *
 * IN PROCESS, NOT AS HOOK CHILDREN, for the retry: the case only exists while a
 * lock is held across the FIRST attempt and released before the second, and the
 * first attempt happens microseconds into the open. Against a spawned child that
 * window is node's startup time — a release timed to land inside it is a
 * coin flip, and the losing side of the flip is a test that passes while
 * exercising nothing. Calling `openStore` directly makes the ordering exact. The
 * hooks' own copy of the retry is pinned by the eight-process case below and by
 * the drift test above, which requires the two to stay the same shape.
 */
describe('the WAL switch', () => {
  function connect(): DatabaseSync {
    const handle = new DatabaseSync(join(dataDir, STATE_DB_FILE));
    handle.exec(`PRAGMA busy_timeout = ${STORE_BUSY_TIMEOUT_MS}`);
    return handle;
  }

  /**
   * Hold a write lock on the state database for `ms`, and resolve once it IS
   * held.
   *
   * ANOTHER PROCESS, NOT ANOTHER CONNECTION. `DatabaseSync` is synchronous, so
   * an in-process holder on a timer can never let go: `openStore` blocks the
   * event loop that timer lives on for the whole of the bootstrap that is
   * waiting for it, and the open fails outright instead of retrying. The child
   * has its own loop and its own clock. (Cost of learning this: the first draft
   * of the test above, which failed with a null store after 1.2 s.)
   */
  async function holdWriteLock(ms: number): Promise<void> {
    const script = join(scriptDir, `lock-${Math.random().toString(36).slice(2)}.mjs`);
    await writeFile(
      script,
      [
        `import { DatabaseSync } from 'node:sqlite';`,
        `const db = new DatabaseSync(${JSON.stringify(join(dataDir, STATE_DB_FILE))});`,
        `db.exec('PRAGMA busy_timeout = ${STORE_BUSY_TIMEOUT_MS}');`,
        `db.exec('BEGIN IMMEDIATE');`,
        `process.stdout.write('locked');`,
        `setTimeout(() => { db.exec('COMMIT'); db.close(); }, ${ms});`,
      ].join('\n'),
    );
    const child = spawn(process.execPath, [script], { stdio: ['ignore', 'pipe', 'inherit'] });
    await new Promise<void>((resolve, reject) => {
      child.on('error', reject);
      child.on('close', () => reject(new Error('the lock holder exited before taking the lock')));
      child.stdout.on('data', (chunk) => {
        if (String(chunk).includes('locked')) resolve();
      });
    });
  }

  it('is taken on the second attempt, after the bootstrap it lost the first to', async () => {
    // #246's exact shape: a fresh file and another opener already inside its
    // DDL, letting go while the bootstrap waits on it. 300 ms sits between the
    // first attempt (which fails at 0 ms) and the bootstrap's first try (which
    // waits STORE_BOOTSTRAP_TIMEOUT_MS), so the second attempt meets a file
    // nobody is holding.
    await holdWriteLock(300);

    // NOT VACUOUS. Prove the first attempt cannot succeed in this state before
    // building a test on it: another connection taking the same pragma is
    // refused outright. Without this the case could be passing quietly because
    // the switch worked the first time and the retry never ran.
    const probe = connect();
    expect(() => probe.exec('PRAGMA journal_mode = wal')).toThrow(/locked/);
    probe.close();

    const store = await openStore(dataDir);

    expect(store).not.toBeNull();
    // The point of the retry: WAL, even though the switch lost the first time.
    expect(rows('PRAGMA journal_mode')[0]).toEqual({ journal_mode: 'wal' });
    // ...having gone through the bootstrap it was waiting on, not around it.
    expect(rows('PRAGMA user_version')[0]).toEqual({ user_version: STORE_USER_VERSION });
    // ...and the fire that opened it writes its rows.
    expect(store?.run(STORE_SQL.setState, ['s1', 'k', '"v"', Date.now()])).toBe(true);
    expect(store?.get(STORE_SQL.getState, ['s1', 'k'])).toEqual({ value: '"v"' });
    // A store that recovered WAL is not a degraded one, so it records nothing.
    expect(store?.get(STORE_SQL.getStoreJournal)).toBeNull();
    store?.close();
  }, 15_000);

  it('gives up rather than dying, leaving the store open on a rollback journal', async () => {
    // Schema first and BY HAND, on a rollback journal. Not via `openStore`: that
    // would leave the file in WAL, and a no-op switch needs no exclusive lock at
    // all (third bullet of the probe in `setWal`), so both attempts would then
    // succeed and this would test the happy path. This case is about the switch,
    // not the bootstrap, and a reader held across a bootstrap blocks its COMMIT
    // rather than its pragma.
    const seed = connect();
    seed.exec(STORE_DDL);
    seed.exec(STORE_SQL.setUserVersion);
    seed.close();
    expect(rows('PRAGMA journal_mode')[0]).toEqual({ journal_mode: 'delete' });

    // A READ lock nobody releases. Per the probe in `setWal`: a reader makes the
    // pragma consult the busy handler and fail anyway, so BOTH attempts burn
    // STORE_BUSY_TIMEOUT_MS and both give up — the branch under test.
    const reader = connect();
    reader.exec('BEGIN');
    reader.prepare('SELECT COUNT(*) AS n FROM sessions').get();

    const store = await openStore(dataDir);
    // OPEN. Losing WAL is not losing the store: NO-STORE-NO-FIRE is about
    // absence, and a store on a rollback journal is present and correct.
    expect(store).not.toBeNull();

    reader.exec('ROLLBACK');
    reader.close();

    // The premise, checked rather than assumed.
    expect(rows('PRAGMA journal_mode')[0]).toEqual({ journal_mode: 'delete' });
    // And the claim the give-up rests on: every statement here runs on it.
    expect(store?.run(STORE_SQL.setState, ['s1', 'k', '"v"', Date.now()])).toBe(true);
    expect(store?.get(STORE_SQL.getState, ['s1', 'k'])).toEqual({ value: '"v"' });
    expect(store?.get(STORE_SQL.countStatePrefix, ['s1', 'k', 'l'])).toEqual({ n: 1 });
    store?.close();
    // Nothing is asserted about `store_journal` here on purpose: the marker is
    // one more write, so the lock that caused this give-up also refuses it. The
    // case it survives to describe is the durable one — a data dir on a
    // filesystem that cannot do WAL — which the eight-process case covers.
  }, 15_000);

  it('records nothing on a healthy open, and clears a stale rollback mark', async () => {
    const first = await openStore(dataDir);
    // No row on a machine that has never lost WAL: the healthy path is one
    // primary-key lookup and no write, on every fire.
    expect(first?.get(STORE_SQL.getStoreJournal)).toBeNull();
    // Now a machine that WAS degraded, by an earlier open.
    expect(first?.run(STORE_SQL.setStoreJournal, ['rollback', 1_700_000_000_000])).toBe(true);
    first?.close();

    const second = await openStore(dataDir);
    const healed = second?.get(STORE_SQL.getStoreJournal);
    expect(healed?.value).toBe('wal');
    expect(Number(healed?.at)).toBeGreaterThan(1_700_000_000_000);
    // ...and it stays healed without a write on every open after that. Stamped
    // by hand so a rewrite would be unmistakable rather than a same-millisecond
    // coincidence.
    expect(second?.run(STORE_SQL.setStoreJournal, ['wal', 1_700_000_000_001])).toBe(true);
    second?.close();

    const third = await openStore(dataDir);
    expect(third?.get(STORE_SQL.getStoreJournal)).toEqual({
      value: 'wal',
      at: 1_700_000_000_001,
    });
    third?.close();
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

  /**
   * AN OUTCOME IS A REPORT ABOUT A PIECE THE AGENT WAS SHOWN. Every decision an
   * arm makes writes a row — `skipped`, `capped`, `none` — and the queries that
   * feed a verdict must see only the injected ones. Without the predicate,
   * `--label <uid> used` on a row the arm decided against would stamp it and
   * post "the agent used this" to the shelf about a piece it never served.
   */
  it('only an injected row can be labelled, or owed to a shelf', async () => {
    const store = await openStore(dataDir);
    if (store === null) throw new Error('no store');
    const AT = 1_700_000_000_000;
    const row = (uid: string, action: string, at = AT): (string | number | null)[] => [
      uid,
      null,
      at,
      's1',
      null,
      'machine',
      'failure',
      'public',
      `res-${uid}`,
      'a title',
      'https://tenjin.blog/p/x',
      null,
      '0197aaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      null,
      null,
      null,
      null,
      null,
      action,
      null,
      null,
      0,
      12,
    ];
    try {
      store.run(STORE_SQL.insertInjection, row('shown', 'injected'));
      store.run(STORE_SQL.insertInjection, row('unshown', 'skipped'));

      expect(store.get(STORE_SQL.injectionByUid, ['shown'])).not.toBeNull();
      expect(store.get(STORE_SQL.injectionByUid, ['unshown'])).toBeNull();

      // Even with a verdict written straight onto it, the row the arm never
      // showed is not in the queue owed to the shelf.
      store.run(STORE_SQL.setOutcome, ['used', 'hand', 'shown']);
      store.run(STORE_SQL.setOutcome, ['used', 'hand', 'unshown']);
      expect(store.all(STORE_SQL.unpostedOutcomes, [0]).map((r) => r.uid)).toEqual(['shown']);

      // The window is `at >= floor`: a row AT the floor is still owed, one a
      // millisecond older has aged out of the queue -- unless a hand put the
      // verdict there, in which case age is no excuse.
      store.run(STORE_SQL.insertInjection, row('older', 'injected', AT - 1));
      store.run(STORE_SQL.setOutcome, ['rejected', 'none', 'older']);
      store.run(STORE_SQL.setOutcome, ['used', 'none', 'shown']);
      expect(store.all(STORE_SQL.unpostedOutcomes, [AT]).map((r) => r.uid)).toEqual(['shown']);
      expect(store.all(STORE_SQL.unpostedOutcomes, [AT + 1])).toEqual([]);
      store.run(STORE_SQL.setOutcome, ['used', 'hand', 'older']);
      expect(store.all(STORE_SQL.unpostedOutcomes, [AT + 1]).map((r) => r.uid)).toEqual(['older']);
    } finally {
      store.close();
    }
  });
});

describe('the lookup bucket is read from the database', () => {
  it('counts attempts machine-wide and stops the arm at the cap', async () => {
    const store = await openStore(dataDir);
    const now = Date.now();
    // A full prompt bucket from a DIFFERENT session: the bucket is machine-wide.
    const cap = PUSH_LOOKUP_CAPS_PER_WINDOW.prompt ?? PUSH_LOOKUP_CAP_DEFAULT;
    for (let i = 0; i < cap; i += 1) {
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
    expect(store?.get(STORE_SQL.bucketCount, ['prompt', now - 1000])).toEqual({ n: cap });
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

  /**
   * THE SAME EIGHT, ON THE JOURNAL THE GIVE-UP LEAVES THEM (#246).
   *
   * "Every statement in this module runs correctly on a rollback journal" is the
   * sentence the give-up rests on, and it was a claim rather than an observation.
   * The eight-process case above exists because this class of thing is not
   * obvious under contention, so it is the right instrument to point at it: WAL
   * is what lets these overlap, and taking it away leaves eight processes
   * serialising through a 250 ms busy timeout for every read and every write.
   *
   * STUBBED, NOT LOCKED. A held lock is the OTHER way to force the give-up, and
   * it cannot be used here: the same lock that refuses the pragma refuses the
   * eight processes' rows, so the test would prove nothing about a rollback
   * journal and everything about a lock. Forcing the switch to throw leaves the
   * file genuinely and permanently on a rollback journal — the durable case, a
   * data dir on a filesystem that cannot do WAL — with every other line of the
   * hook untouched and real.
   */
  it('eight hook processes on a store that never gets WAL: every row still lands', async () => {
    const shelf = await serveSearch((baseUrl) => ({
      status: 200,
      json: strongAnswer(baseUrl, '11111111-1111-4111-8111-111111111111', STRONG_TITLE),
    }));
    try {
      await writeConfig({ baseUrl: shelf.baseUrl });
      const payload = JSON.stringify({
        session_id: 'rollback-race',
        hook_event_name: 'UserPromptSubmit',
        prompt: STRONG_QUERY,
      });
      const script = withoutWal(pushPromptHookScript(dataDir));
      const runs = await Promise.all(Array.from({ length: 8 }, () => runScript(script, payload)));
      for (const run of runs) {
        expect(run.code).toBe(0);
        // Same rule as the WAL race: Claude Code shows the operator every byte
        // of stderr, so a store that had to fall back may not say so there.
        expect(run.stderr).toBe('');
      }

      // The premise, checked rather than assumed: they really did run on a
      // rollback journal, and none of them quietly got WAL back.
      expect(rows('PRAGMA journal_mode')[0]).toEqual({ journal_mode: 'delete' });

      expect(rows('SELECT * FROM events')).toHaveLength(8);
      const actions = rows('SELECT action, reason FROM injections');
      expect(actions).toHaveLength(8);
      /**
       * THE COUNTS ARE REAL, NOT `Infinity`. This split is the assertion that
       * matters. `storeCount` answers `Infinity` for a store it cannot read, and
       * every caller of it is a bound — so an unreadable store would hold all
       * eight back behind a cap and inject none. One-and-seven is only reachable
       * when `alreadyShown` and `injectedCount` are reading actual rows off the
       * rollback journal, under the contention that made WAL worth having.
       */
      expect(actions.filter((r) => r.action === 'injected')).toHaveLength(1);
      expect(
        actions.filter((r) => r.action === 'skipped' && r.reason === 'already-injected'),
      ).toHaveLength(7);

      // ...and the machine is no longer silent about it: one row, whatever the
      // eight of them raced over.
      expect(rows(STORE_SQL.getStoreJournal)).toEqual([
        { value: 'rollback', at: expect.any(Number) },
      ]);
    } finally {
      await shelf.close();
    }
  }, 30_000);
});

/**
 * The dispatch relay's arbiter, pinned on its own.
 *
 * Every other test that touches it drives the prompt arm through
 * `alreadyShownOrLiveRelay`, which reads the `relayed` ROW; the DO UPDATE
 * success path — an expired holder displaced — had no assertion at all, so
 * mutating the WHERE clause to constant false kept the suite green while the
 * session's handoff slot became unclaimable for the rest of the session.
 */
describe('claimStateFresh arbitrates on the holder age', () => {
  it('takes a free slot, refuses a fresh holder, and displaces an expired one', async () => {
    await writeConfig();
    (await openStore(dataDir))?.close();
    const handle = db();
    try {
      const claim = (value: string, heldSinceMs: number): number => {
        const now = Date.now();
        const result = handle
          .prepare(STORE_SQL.claimStateFresh)
          .run('s', 'relay:handoff', JSON.stringify(value), now, now - heldSinceMs);
        return Number(result.changes);
      };
      const held = (): unknown =>
        JSON.parse(
          (
            handle
              .prepare('SELECT value FROM session_state WHERE session = ? AND key = ?')
              .get('s', 'relay:handoff') as unknown as { value: string }
          ).value,
        );

      // Absent: taken, and the value marks who took it.
      expect(claim('piece-a', 60_000)).toBe(1);
      expect(held()).toBe('piece-a');

      // A holder younger than the window: refused, and it keeps the slot.
      expect(claim('piece-b', 60_000)).toBe(0);
      expect(held()).toBe('piece-a');

      // The holder ages past the window: displaced. Backdated rather than
      // waited out, because the window is minutes of wall clock and a timer
      // would be a flake. Without this path the slot is a permanent claim, and
      // one unconsumed handoff suppresses relaying for the whole session.
      handle
        .prepare('UPDATE session_state SET at = at - ? WHERE session = ? AND key = ?')
        .run(120_000, 's', 'relay:handoff');
      expect(claim('piece-c', 60_000)).toBe(1);
      expect(held()).toBe('piece-c');
    } finally {
      handle.close();
    }
  });

  /**
   * AND IT FAILS CLOSED, which is the half the SQL cannot show.
   *
   * `storeRun` swallows every write error as null, and SQLITE_BUSY past the
   * busy timeout is what parallel Task calls in one assistant message produce,
   * which is the contention this claim exists for. Reading null as a win there
   * lets every contender win, the second park evict the first, and both
   * announce a relay for a handoff only one of them holds. `claimState` is a
   * dedupe aid whose worst loss is a duplicate lookup, so its fail-OPEN
   * contract is deliberately unchanged; that difference is asserted here
   * rather than only described in a comment.
   *
   * Driven as the REAL generated bytes, with the open store swapped for one
   * that throws on prepare, which is exactly the shape `storeRun` catches.
   */
  it('fails the relay claim closed on a swallowed write, and leaves claimState open', async () => {
    await writeConfig();
    const probe = `${prelude(dataDir, 5_000)}${storeSource()}
async function main() {
  if ((await openStore()) === null) {
    process.stdout.write('no-store');
    return;
  }
  STORE = {
    prepare() {
      throw new Error('SQLITE_BUSY: database is locked');
    },
    close() {},
  };
  process.stdout.write(
    JSON.stringify({
      fresh: claimStateFresh('s', 'relay:handoff', 120000, 'piece-a'),
      plain: claimState('s', 'some:key'),
    }),
  );
}
main().catch((err) => process.stdout.write('threw: ' + err.message));
`;
    const run = await runScript(probe, '');
    expect(run.code).toBe(0);
    expect(JSON.parse(run.stdout)).toEqual({ fresh: false, plain: true });
  });
});

/**
 * The peek an evictor uses, at the SQL level.
 *
 * `cacheSlot` may not drop the slot whose piece the parent was already told is
 * queued for a child, so it has to see the row before deleting it. The peek is
 * only safe while it names the SAME row the take would take: an ordering that
 * drifted from `takeStateOldestByPrefix` would protect one slot and evict a
 * different one, which is the announced-delivery loss with extra steps.
 */
describe('oldestStateByPrefix names the row the take would take', () => {
  it('agrees with takeStateOldestByPrefix, row for row, and takes nothing', async () => {
    const store = await openStore(dataDir);
    if (store === null) throw new Error('no store');
    try {
      const range = ['sess', 'dispatch_cache', 'dispatch_cache￿'];
      const put = (key: string, at: number): void => {
        store.run(STORE_SQL.setState, ['sess', key, JSON.stringify({ k: key }), at]);
      };
      // Out of insertion order, and with a same-millisecond pair, so `at` and
      // the `key` tie-break are both exercised.
      put('dispatch_cache:c', 300);
      put('dispatch_cache:a', 100);
      put('dispatch_cache:b2', 200);
      put('dispatch_cache:b1', 200);

      const drained: unknown[] = [];
      for (let i = 0; i < 4; i += 1) {
        const peeked = store.get(STORE_SQL.oldestStateByPrefix, range) as { key: string };
        // The peek leaves the row where it is: asking twice answers the same.
        expect((store.get(STORE_SQL.oldestStateByPrefix, range) as { key: string }).key).toBe(
          peeked.key,
        );
        const taken = store.get(STORE_SQL.takeStateOldestByPrefix, ['sess', ...range]) as {
          key: string;
        };
        expect(taken.key).toBe(peeked.key);
        drained.push(taken.key);
      }
      expect(drained).toEqual([
        'dispatch_cache:a',
        'dispatch_cache:b1',
        'dispatch_cache:b2',
        'dispatch_cache:c',
      ]);
      expect(store.get(STORE_SQL.oldestStateByPrefix, range)).toBe(null);
    } finally {
      store.close();
    }
  });
});

/**
 * The statement behind the subagent handoff, at the SQL level.
 *
 * The arm's behaviour is pinned in `push-scripts.test.ts`; this pins the
 * statement itself, because the delete IS the read and an ORDER BY or a range
 * bound lost in an edit would put that back to a race nothing else catches.
 */
describe('takeStateOldestByPrefix', () => {
  const take = (store: { get: (sql: string, params: unknown[]) => unknown }): unknown =>
    store.get(STORE_SQL.takeStateOldestByPrefix, [
      'sess',
      'sess',
      'dispatch_cache',
      'dispatch_cache￿',
    ]);

  it('hands each caller a different slot, oldest first, and empties the range', async () => {
    const store = await openStore(dataDir);
    if (store === null) throw new Error('no store');
    try {
      // The legacy single key a stale hook still writes, then two keyed slots.
      store.run(STORE_SQL.setState, ['sess', 'dispatch_cache', '"legacy"', 1]);
      store.run(STORE_SQL.setState, ['sess', 'dispatch_cache:b', '"second"', 3]);
      store.run(STORE_SQL.setState, ['sess', 'dispatch_cache:a', '"first"', 2]);
      // A key under another prefix, which the range must not reach.
      store.run(STORE_SQL.setState, ['sess', 'edits:src/a.ts', '"3"', 0]);
      // Another session's slot, which is not this consumer's to take.
      store.run(STORE_SQL.setState, ['other', 'dispatch_cache:a', '"theirs"', 0]);

      expect(take(store)).toMatchObject({ key: 'dispatch_cache', value: '"legacy"' });
      expect(take(store)).toMatchObject({ key: 'dispatch_cache:a', value: '"first"' });
      expect(take(store)).toMatchObject({ key: 'dispatch_cache:b', value: '"second"' });
      expect(take(store)).toBeNull();
    } finally {
      store.close();
    }
    expect(rows('SELECT key, session FROM session_state ORDER BY key')).toEqual([
      { key: 'dispatch_cache:a', session: 'other' },
      { key: 'edits:src/a.ts', session: 'sess' },
    ]);
  });
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
  /** `agent` is Claude Code's `agent_id`: present only inside a subagent, and
   *  never a substitute for the session id, which every child shares with its
   *  parent. Omitted here means the lead's own turn. */
  const failure = (
    command: string,
    stderr: string,
    session = 's1',
    cwd = '/repo/one',
    agent?: string,
  ) =>
    JSON.stringify({
      session_id: session,
      cwd,
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
      tool_input: { command },
      tool_response: { stdout: '', stderr },
      ...(agent === undefined ? {} : { agent_id: agent }),
    });

  const success = (command: string, session = 's1', cwd = '/repo/one', agent?: string) =>
    JSON.stringify({
      session_id: session,
      cwd,
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
      tool_input: { command },
      tool_response: { stdout: 'ok\n', stderr: '' },
      ...(agent === undefined ? {} : { agent_id: agent }),
    });

  const edit = (path: string, session = 's1', cwd = '/repo/one', agent?: string) =>
    JSON.stringify({
      session_id: session,
      cwd,
      hook_event_name: 'PreToolUse',
      tool_name: 'Edit',
      tool_input: { file_path: path },
      ...(agent === undefined ? {} : { agent_id: agent }),
    });

  const ENOENT =
    "Error: ENOENT: no such file or directory, open 'drizzle.config.ts'\n    at readFileSync (node:fs:1:1)\n    at run (/repo/one/src/migrate.ts:12:3)\n";

  /** A DIFFERENT failure behind the SAME head: another errno-bearing message,
   *  another frame, so it keys on its own fine and coarse signature. */
  const ENOENT_SCHEMA =
    "Error: ENOENT: no such file or directory, open 'schema.sql'\n    at readFileSync (node:fs:1:1)\n    at load (/repo/one/src/loader.ts:8:1)\n";

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
   * A SESSION IS NOT AN AGENT, and the close rule means the agent.
   *
   * Claude Code gives every subagent its parent's `session_id` and tells them
   * apart only by `agent_id`, so `replayed:<head>` and `edited:<path>` keyed by
   * session were keys parallel children wrote over each other. What that bought
   * was the worst outcome the close rule has: child a1 is replayed a pairing,
   * child a2 edits a file and its own command passes, and a2's pass closes the
   * row a1 was shown — which is counted as the SECOND INDEPENDENT close, so the
   * pairing is promoted to `verified` and every later session is told "Fixed
   * here 2 time(s)" on the strength of an edit nobody made to fix it.
   */
  it('does not let a sibling subagent close the pairing another was shown', async () => {
    await writeConfig({ baseUrl: 'http://127.0.0.1:1' });
    await runScript(pushFailureHookScript(dataDir), failure('pnpm db:migrate', ENOENT));
    await runScript(pushContextHookScript(dataDir), edit('/repo/one/src/migrate.ts'));
    await runScript(pushFailureHookScript(dataDir), success('pnpm db:migrate'));

    // Session 2's FIRST subagent hits the failure and is replayed the pairing.
    const replay = await runScript(
      pushFailureHookScript(dataDir),
      failure('pnpm db:migrate', ENOENT, 's2', '/repo/one', 'a1'),
    );
    expect(replay.stdout).toContain('Someone once fixed this by touching');

    // Its SIBLING — same session id, different agent — edits the very file the
    // error named and runs the very command that failed. Both halves of the
    // close rule are satisfied for a2; none of them is evidence about a1's
    // pairing, because a2 was never shown it.
    await runScript(
      pushContextHookScript(dataDir),
      edit('/repo/one/src/migrate.ts', 's2', '/repo/one', 'a2'),
    );
    await runScript(
      pushFailureHookScript(dataDir),
      success('pnpm db:migrate', 's2', '/repo/one', 'a2'),
    );
    expect(rows('SELECT status, closes FROM pairings')[0]).toEqual({
      status: 'unverified',
      closes: 1,
    });
    expect(rows('SELECT COUNT(*) AS n FROM pairing_closes')[0]).toEqual({ n: 1 });

    // ...and a1 doing the same work DOES close it, so the scoping narrowed the
    // rule to the right agent rather than switching it off.
    await runScript(
      pushContextHookScript(dataDir),
      edit('/repo/one/src/migrate.ts', 's2', '/repo/one', 'a1'),
    );
    await runScript(
      pushFailureHookScript(dataDir),
      success('pnpm db:migrate', 's2', '/repo/one', 'a1'),
    );
    expect(rows('SELECT status, closes FROM pairings')[0]).toEqual({
      status: 'verified',
      closes: 2,
    });
  });

  /**
   * ONE HEAD, TWO PAIRINGS (Greptile P1 on #242). `pnpm db:migrate` answers for
   * a whole build step, so one agent can be replayed several distinct failures
   * behind it in a run. The replay memory stored ONE id per head, so the second
   * replay overwrote the first and the first pairing lost its only route to a
   * second closer — it stayed `unverified` forever however many times this
   * machine actually fixed it.
   */
  it('closes every pairing replayed behind one head, not just the last', async () => {
    await writeConfig({ baseUrl: 'http://127.0.0.1:1' });

    // Session 1 opens and closes TWO pairings behind the same head.
    await runScript(pushFailureHookScript(dataDir), failure('pnpm db:migrate', ENOENT));
    await runScript(pushContextHookScript(dataDir), edit('/repo/one/src/migrate.ts'));
    await runScript(pushFailureHookScript(dataDir), success('pnpm db:migrate'));
    await runScript(pushFailureHookScript(dataDir), failure('pnpm db:migrate', ENOENT_SCHEMA));
    await runScript(pushContextHookScript(dataDir), edit('/repo/one/src/loader.ts'));
    await runScript(pushFailureHookScript(dataDir), success('pnpm db:migrate'));
    expect(rows('SELECT status, closes FROM pairings ORDER BY id')).toEqual([
      { status: 'unverified', closes: 1 },
      { status: 'unverified', closes: 1 },
    ]);

    // Session 2 is replayed BOTH, in order, behind the one head.
    const first = await runScript(
      pushFailureHookScript(dataDir),
      failure('pnpm db:migrate', ENOENT, 's2'),
    );
    expect(first.stdout).toContain('migrate.ts');
    const second = await runScript(
      pushFailureHookScript(dataDir),
      failure('pnpm db:migrate', ENOENT_SCHEMA, 's2'),
    );
    expect(second.stdout).toContain('loader.ts');

    // It fixes both and the head passes once.
    await runScript(pushContextHookScript(dataDir), edit('/repo/one/src/migrate.ts', 's2'));
    await runScript(pushContextHookScript(dataDir), edit('/repo/one/src/loader.ts', 's2'));
    await runScript(pushFailureHookScript(dataDir), success('pnpm db:migrate', 's2'));

    // BOTH promoted. Before this the earlier pairing was silently unreachable.
    expect(rows('SELECT status, closes FROM pairings ORDER BY id')).toEqual([
      { status: 'verified', closes: 2 },
      { status: 'verified', closes: 2 },
    ]);
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
    expect(await loadSearches(dataDir)).toEqual([]);
    expect(await latestSearch(dataDir)).toBeNull();
  });
});

/**
 * The typed handle the commands read the `searches` table through. These moved
 * here with the helpers when `search-store.ts` — a second module over this one
 * table — was folded in.
 */
describe('searches: the typed handle', () => {
  function entry(over: Partial<StoredSearch> = {}): StoredSearch {
    return {
      searchId: '0197aaaa-bbbb-cccc-dddd-000000000001',
      at: agoIso(60_000),
      question: 'q',
      decision: 'CANDIDATES',
      candidates: [
        { resourceId: 'res-1', url: 'https://x/api/read/a/b', title: 't', price: '100000' },
      ],
      ...over,
    };
  }

  // The Stop hook reads this field to tell one session's open loops from a
  // sibling's; a schema that dropped it would silently un-scope every nag.
  it('round-trips a sessionId, and an entry without one still loads', async () => {
    await recordSearch(dataDir, entry({ sessionId: 'session-a' }));
    await recordSearch(
      dataDir,
      entry({ searchId: '0197aaaa-bbbb-cccc-dddd-000000000009', question: 'unstamped' }),
    );
    const loaded = await loadSearches(dataDir);
    expect(loaded).toHaveLength(2);
    expect(loaded.find((s) => s.question === 'unstamped')?.sessionId).toBeUndefined();
    expect(loaded.find((s) => s.sessionId !== undefined)?.sessionId).toBe('session-a');
  });

  it('records newest-first and latestSearch returns the most recent', async () => {
    await recordSearch(dataDir, entry({ searchId: '0197aaaa-bbbb-cccc-dddd-000000000001' }));
    await recordSearch(dataDir, entry({ searchId: '0197aaaa-bbbb-cccc-dddd-000000000002' }));
    expect((await latestSearch(dataDir))?.searchId).toBe('0197aaaa-bbbb-cccc-dddd-000000000002');
  });

  // `--last` means "the search I just ran". In auto mode the WebSearch hook
  // prepends an entry on EVERY web search, so without the source filter an
  // `outcome --last` after any web search would report against a ridealong query
  // the agent never chose (found in dogfooding).
  it('latestSearch skips hook-sourced entries: --last targets the last deliberate search', async () => {
    await recordSearch(dataDir, entry({ searchId: '0197aaaa-bbbb-cccc-dddd-000000000003' }));
    await recordSearch(
      dataDir,
      entry({ searchId: '0197aaaa-bbbb-cccc-dddd-000000000004', source: 'websearch-hook' }),
    );
    expect((await latestSearch(dataDir))?.searchId).toBe('0197aaaa-bbbb-cccc-dddd-000000000003');
  });

  it('latestSearch is null when only hook-sourced entries exist', async () => {
    await recordSearch(
      dataDir,
      entry({ searchId: '0197aaaa-bbbb-cccc-dddd-000000000005', source: 'websearch-hook' }),
    );
    expect(await latestSearch(dataDir)).toBeNull();
  });

  // The demand arm records what an agent was ABOUT to research, which is even
  // further from "the search I just ran" than a ridealong web search is.
  it('round-trips the dispatch source, and --last skips it too', async () => {
    await recordSearch(dataDir, entry({ searchId: '0197aaaa-bbbb-cccc-dddd-000000000006' }));
    await recordSearch(
      dataDir,
      entry({ searchId: '0197aaaa-bbbb-cccc-dddd-000000000007', source: 'dispatch-hook' }),
    );
    const loaded = await loadSearches(dataDir);
    expect(loaded.map((s) => s.source)).toContain('dispatch-hook');
    expect((await latestSearch(dataDir))?.searchId).toBe('0197aaaa-bbbb-cccc-dddd-000000000006');
  });

  it('resolves a candidate url by resourceId (buy <id>)', async () => {
    await recordSearch(dataDir, entry());
    expect((await findStoredCandidate(dataDir, 'res-1'))?.url).toBe('https://x/api/read/a/b');
    expect(await findStoredCandidate(dataDir, 'res-absent')).toBeNull();
  });

  it('finds the searchId that surfaced a resource (attribution)', async () => {
    await recordSearch(dataDir, entry({ searchId: '0197aaaa-bbbb-cccc-dddd-000000000009' }));
    expect(await findSearchForResource(dataDir, { resourceId: 'res-1' })).toBe(
      '0197aaaa-bbbb-cccc-dddd-000000000009',
    );
    expect(await findSearchForResource(dataDir, { url: 'https://x/api/read/a/b' })).toBe(
      '0197aaaa-bbbb-cccc-dddd-000000000009',
    );
    expect(await findSearchForResource(dataDir, { resourceId: 'nope' })).toBeNull();
  });

  /**
   * The candidate blob is JSON, and `json_each` is what keeps `buy <id>` off a
   * 500-row scan through every recent search's array. It has to answer both
   * questions the callers ask — by id and by url — and it has to prefer the
   * NEWEST search that carried the piece, since that is the attribution a
   * purchase belongs to.
   */
  it('searchForResource matches by id and by url through json_each, newest first', async () => {
    const older = '0197aaaa-bbbb-cccc-dddd-000000000010';
    const newer = '0197aaaa-bbbb-cccc-dddd-000000000011';
    await recordSearch(dataDir, entry({ searchId: older, at: agoIso(2 * DAY_MS) }));
    await recordSearch(dataDir, entry({ searchId: newer, at: agoIso(DAY_MS) }));
    expect(await findSearchForResource(dataDir, { resourceId: 'res-1' })).toBe(newer);
    expect(await findSearchForResource(dataDir, { url: 'https://x/api/read/a/b' })).toBe(newer);
    // An empty match is not a wildcard: a caller asking by url alone must not
    // match a candidate whose resourceId happens to be absent.
    expect(await findSearchForResource(dataDir, {})).toBeNull();
  });

  /**
   * `json_each` over an unpruned table is cheap while it stops early and
   * unbounded when it does not, and the MISS is the common case: `buy <id>` for
   * a piece no local search surfaced expands every row's candidate array. The
   * bound that keeps that proportional to recent activity counts ROWS, the same
   * `RECENT_LIMIT` window `listSearches` reads.
   *
   * It counts rows and not days ON PURPOSE. A date floor lived here for a
   * while, and it made `buy <resourceId>` fail by the calendar: a piece an
   * agent had deliberately parked stopped resolving a month later, reported as
   * "No local search knows resource …". Age alone must never cost a
   * resolution — see resource-ref.test.ts for the same edge at the buy command.
   */
  it('searchForResource reaches an ancient row, and stops at the row bound', async () => {
    const ancient = '0197aaaa-bbbb-cccc-dddd-000000000030';
    await recordSearch(dataDir, entry({ searchId: ancient, at: agoIso(400 * DAY_MS) }));
    expect(await findSearchForResource(dataDir, { resourceId: 'res-1' })).toBe(ancient);
    expect(await findStoredCandidate(dataDir, 'res-1')).not.toBeNull();

    // 500 newer searches carrying nothing push it out of the window.
    const store = await openStore(dataDir);
    if (store === null) throw new Error('no store');
    try {
      for (let i = 0; i < 500; i += 1) {
        store.run(STORE_SQL.recordSearch, [
          `0197bbbb-cccc-dddd-eeee-${String(i).padStart(12, '0')}`,
          Date.now() - 300 * DAY_MS + i,
          '',
          null,
          'decoy',
          'decoy',
          'MISS',
          '[]',
          null,
          null,
          null,
        ]);
      }
    } finally {
      store.close();
    }
    expect(await findSearchForResource(dataDir, { resourceId: 'res-1' })).toBeNull();
    expect(await findStoredCandidate(dataDir, 'res-1')).toBeNull();
  });

  /**
   * The table never prunes (plan 03, owner decision 2: no retention), so the
   * bound belongs to the query. This one feeds a reminder, not a report: a
   * machine with ten thousand unresolved rows must not pull them all into JS
   * to render a nag about the newest few.
   */
  it('openSearches stops at the bound the file-backed store had', async () => {
    const store = await openStore(dataDir);
    if (store === null) throw new Error('no store');
    try {
      for (let i = 0; i < 505; i += 1) {
        store.run(STORE_SQL.recordSearch, [
          `0197aaaa-bbbb-cccc-dddd-${String(i).padStart(12, '0')}`,
          Date.now() - i * 1000,
          's1',
          null,
          'q',
          'fp',
          'MISS',
          '[]',
          null,
          null,
          null,
        ]);
      }
    } finally {
      store.close();
    }
    const open = await openSearches(dataDir);
    expect(open).toHaveLength(500);
    // Newest first, so the bound drops the oldest rows rather than a slice from
    // the middle.
    expect(open[0]?.searchId).toBe('0197aaaa-bbbb-cccc-dddd-000000000000');
  });

  /** `normalizeSearchIds` case-folds every id before it looks one up, while the
   *  row carries whatever spelling the server sent. */
  it('getStoredSearch is case-insensitive, and null for an id nothing recorded', async () => {
    await recordSearch(dataDir, entry({ searchId: '0197AAAA-BBBB-CCCC-DDDD-000000000012' }));
    expect((await getStoredSearch(dataDir, '0197aaaa-bbbb-cccc-dddd-000000000012'))?.question).toBe(
      'q',
    );
    expect(await getStoredSearch(dataDir, '0197ffff-ffff-4fff-8fff-ffffffffffff')).toBeNull();
  });

  /**
   * `outcome --all-open` scopes to the session that is closing, and an UNSTAMPED
   * row belongs to no session — scoping must never make a loop unreachable
   * everywhere at once, so it stays in every scope.
   */
  it('openSearches scopes to a session, keeps unstamped rows, and drops resolved ones', async () => {
    const mine = '0197aaaa-bbbb-cccc-dddd-000000000020';
    const theirs = '0197aaaa-bbbb-cccc-dddd-000000000021';
    const unstamped = '0197aaaa-bbbb-cccc-dddd-000000000022';
    const closed = '0197aaaa-bbbb-cccc-dddd-000000000023';
    await recordSearch(dataDir, entry({ searchId: mine, sessionId: 's1' }));
    await recordSearch(dataDir, entry({ searchId: theirs, sessionId: 's2' }));
    await recordSearch(dataDir, entry({ searchId: unstamped }));
    await recordSearch(dataDir, entry({ searchId: closed, sessionId: 's1' }));
    await markSearchResolved(dataDir, closed, 'outcome');

    expect((await openSearches(dataDir, 's1')).map((s) => s.searchId).sort()).toEqual(
      [mine, unstamped].sort(),
    );
    // No session named is every session, which is what an unscoped sweep wants.
    expect((await openSearches(dataDir)).map((s) => s.searchId).sort()).toEqual(
      [mine, theirs, unstamped].sort(),
    );
  });

  it('de-dupes a re-recorded searchId', async () => {
    await recordSearch(dataDir, entry());
    await recordSearch(dataDir, entry());
    expect(await loadSearches(dataDir)).toHaveLength(1);
  });

  it('round-trips paidBrowseCount and reads it as unknown on an entry written without it', async () => {
    const id2 = '0197aaaa-bbbb-cccc-dddd-000000000002';
    await recordSearch(dataDir, entry({ decision: 'MISS', candidates: [], paidBrowseCount: 3 }));
    expect((await latestSearch(dataDir))?.paidBrowseCount).toBe(3);

    // A row recorded without the field must stay `undefined` rather than default
    // to 0: `outcome` refuses purchase_declined on a zero and must not invent
    // that refusal for a search that never recorded whether it had a payable
    // browse tail. The upsert also must not CLEAR a count a later re-record
    // omits, which is what the COALESCE in the statement is for.
    await recordSearch(dataDir, entry({ searchId: id2, decision: 'MISS', candidates: [] }));
    const loaded = await loadSearches(dataDir);
    expect(loaded.find((s) => s.searchId === id2)?.paidBrowseCount).toBeUndefined();
    await recordSearch(dataDir, entry({ decision: 'MISS', candidates: [] }));
    expect(loaded.find((s) => s.searchId !== id2)?.paidBrowseCount).toBe(3);
  });

  it('reads empty (never throws) on a corrupt store', async () => {
    await writeFile(join(dataDir, STATE_DB_FILE), 'not a database', 'utf8');
    expect(await loadSearches(dataDir)).toEqual([]);
    expect(await openSearches(dataDir)).toEqual([]);
    expect(await getStoredSearch(dataDir, '0197aaaa-bbbb-cccc-dddd-000000000001')).toBeNull();
    expect(await findStoredCandidate(dataDir, 'res-1')).toBeNull();
    expect(await findSearchForResource(dataDir, { resourceId: 'res-1' })).toBeNull();
  });
});

describe('markSearchResolved', () => {
  const ID = '0197aaaa-bbbb-cccc-dddd-000000000001';

  function entry(over: Partial<StoredSearch> = {}): StoredSearch {
    return {
      searchId: ID,
      at: agoIso(60_000),
      question: 'q',
      decision: 'CANDIDATES',
      candidates: [
        { resourceId: 'res-1', url: 'https://x/api/read/a/b', title: 't', price: '100000' },
      ],
      ...over,
    };
  }

  it('records who closed the loop, leaving everything else alone', async () => {
    await recordSearch(dataDir, entry({ decision: 'MISS' }));
    await markSearchResolved(dataDir, ID, 'publish', '2026-08-09T10:00:00.000Z');

    const [stored] = await loadSearches(dataDir);
    expect(stored?.resolved).toEqual({ by: 'publish', at: '2026-08-09T10:00:00.000Z' });
    expect(stored?.question).toBe(entry().question);
    expect(stored?.candidates).toEqual(entry().candidates);
  });

  // The lookup and the update have to agree on case, or the receipt lies: the
  // caller case-folds the id (`normalizeSearchIds`) while the row carries the
  // server's spelling, so an update matching case-exactly closes nothing and
  // still reports `resolved` — the Stop hook then keeps raising a loop the
  // agent was told was closed.
  it('closes a row recorded under a different case, and drops it from openSearches', async () => {
    const stored = '0197AAAA-BBBB-CCCC-DDDD-000000000031';
    const folded = '0197aaaa-bbbb-cccc-dddd-000000000031';
    await recordSearch(dataDir, entry({ searchId: stored, decision: 'MISS' }));
    await expect(markSearchResolved(dataDir, folded, 'outcome')).resolves.toBe('resolved');
    expect((await getStoredSearch(dataDir, folded))?.resolved?.by).toBe('outcome');
    expect(await openSearches(dataDir)).toEqual([]);
  });

  // A publish after an outcome report is still one closed loop; rewriting who
  // closed it would lose the fact that the reuse signal was already sent.
  it('keeps the first resolution and ignores later ones', async () => {
    await recordSearch(dataDir, entry());
    await markSearchResolved(dataDir, ID, 'outcome', '2026-08-09T10:00:00.000Z');
    await markSearchResolved(dataDir, ID, 'publish', '2026-08-09T11:00:00.000Z');
    expect((await loadSearches(dataDir))[0]?.resolved?.by).toBe('outcome');
  });

  it('touches nothing for a searchId this machine never recorded', async () => {
    await recordSearch(dataDir, entry());
    await markSearchResolved(dataDir, '0197aaaa-bbbb-cccc-dddd-000000000099', 'outcome');
    expect((await loadSearches(dataDir))[0]?.resolved).toBeUndefined();
  });

  // Bookkeeping for a hook nudge, so it may never fail the verb that ran. It
  // still SAYS what happened, so a caller that reports the close does not report
  // one that did not land — and with no data dir at all the honest answer is
  // `not-found` rather than `failed`: the store opens (creating the dir the way
  // every other write path does) and simply holds no such search. `failed` is
  // the answer when the store itself cannot be opened, which is the case below.
  it('never throws, even with no store and no data dir', async () => {
    await rm(dataDir, { recursive: true, force: true });
    await expect(markSearchResolved(dataDir, ID, 'outcome')).resolves.toBe('not-found');
  });

  it('leaves a corrupt store readable-as-empty rather than throwing', async () => {
    await writeFile(join(dataDir, STATE_DB_FILE), 'not a database', 'utf8');
    await expect(markSearchResolved(dataDir, ID, 'outcome')).resolves.toBe('failed');
    expect(await loadSearches(dataDir)).toEqual([]);
  });

  // The four outcomes, so a caller can tell "the loop is closed" from "I could
  // not close it" — the distinction publish's receipt is built on.
  it('reports resolved, then already-resolved, and never rewrites the first closer', async () => {
    await recordSearch(dataDir, entry());
    await expect(markSearchResolved(dataDir, ID, 'outcome')).resolves.toBe('resolved');
    await expect(markSearchResolved(dataDir, ID, 'publish')).resolves.toBe('already-resolved');
    expect((await loadSearches(dataDir))[0]?.resolved?.by).toBe('outcome');
  });

  // The #161 loop: a MISS closed as `regenerated` while the answer was still
  // being written, then published minutes later. The publish takes the loop over.
  it('relinks a resolution recorded by something else when asked', async () => {
    await recordSearch(dataDir, entry());
    await markSearchResolved(dataDir, ID, 'outcome', '2026-08-09T10:00:00.000Z');
    await expect(
      markSearchResolved(dataDir, ID, 'publish', '2026-08-09T11:00:00.000Z', { relink: true }),
    ).resolves.toBe('relinked');
    expect((await loadSearches(dataDir))[0]?.resolved).toEqual({
      by: 'publish',
      at: '2026-08-09T11:00:00.000Z',
    });
  });

  // Relinking is not re-stamping: the loop is already where it should be, so
  // nothing is written and nothing claims a change.
  it('reports already-resolved when the recorded closer is the same one', async () => {
    await recordSearch(dataDir, entry());
    await markSearchResolved(dataDir, ID, 'publish', '2026-08-09T10:00:00.000Z');
    await expect(
      markSearchResolved(dataDir, ID, 'publish', '2026-08-09T11:00:00.000Z', { relink: true }),
    ).resolves.toBe('already-resolved');
    expect((await loadSearches(dataDir))[0]?.resolved?.at).toBe('2026-08-09T10:00:00.000Z');
  });

  // The flag is opt-in, so an ordinary outcome report after a publish still
  // leaves the publish as the closer.
  it('leaves the first resolution alone without the flag', async () => {
    await recordSearch(dataDir, entry());
    await markSearchResolved(dataDir, ID, 'publish', '2026-08-09T10:00:00.000Z');
    await expect(markSearchResolved(dataDir, ID, 'outcome')).resolves.toBe('already-resolved');
    expect((await loadSearches(dataDir))[0]?.resolved?.by).toBe('publish');
  });

  it('relinking an unclosed loop is an ordinary resolve', async () => {
    await recordSearch(dataDir, entry());
    await expect(
      markSearchResolved(dataDir, ID, 'publish', '2026-08-09T10:00:00.000Z', { relink: true }),
    ).resolves.toBe('resolved');
  });

  it('reports not-found for an id the store does not carry', async () => {
    await recordSearch(dataDir, entry());
    await expect(
      markSearchResolved(dataDir, '0197ffff-ffff-4fff-8fff-ffffffffffff', 'publish'),
    ).resolves.toBe('not-found');
  });

  // The write cannot happen, and the caller is told so rather than being handed
  // a silent success. This used to be a lock nobody released, and it was the one
  // test in the file that had to wait out a 5s timeout; there is no lock any
  // more, so an unopenable store stands in for the same condition instantly.
  it('reports failed when the store cannot be opened', async () => {
    await rm(join(dataDir, STATE_DB_FILE), { force: true });
    await writeFile(join(dataDir, STATE_DB_FILE), 'not a database', 'utf8');
    await expect(markSearchResolved(dataDir, ID, 'publish')).resolves.toBe('failed');
  });

  it('round-trips through the schema, so a resolved entry still loads', async () => {
    await recordSearch(dataDir, entry());
    await markSearchResolved(dataDir, ID, 'publish');
    expect(await latestSearch(dataDir)).toMatchObject({
      searchId: ID,
      resolved: { by: 'publish' },
    });
  });
});

/**
 * The claim a `publish --draft --search-id` withholds from the wire and parks
 * locally, and the promotion that reads it back. Both halves live here because
 * the two commands only ever meet in this store: publish writes the link, and
 * `edit --status published` is the only reader.
 */
describe('draft claims', () => {
  const ID = '0197aaaa-bbbb-cccc-dddd-000000000001';
  const ID2 = '0197aaaa-bbbb-cccc-dddd-000000000002';
  const DRAFT = '0197dddd-eeee-4fff-8aaa-bbbbbbbbbbbb';
  const OTHER_DRAFT = '0197dddd-eeee-4fff-8aaa-cccccccccccc';

  function entry(over: Partial<StoredSearch> = {}): StoredSearch {
    return {
      searchId: ID,
      at: agoIso(60_000),
      question: 'q',
      decision: 'CANDIDATES',
      candidates: [
        { resourceId: 'res-1', url: 'https://x/api/read/a/b', title: 't', price: '100000' },
      ],
      ...over,
    };
  }

  it('parks the withheld claim and hands it back for the promotion', async () => {
    await recordSearch(dataDir, entry());
    await linkSearchesToDraft(dataDir, [ID], DRAFT);
    const parked = await searchesForDraft(dataDir, DRAFT);
    expect(parked.map((s) => s.searchId)).toEqual([ID]);
    expect(parked[0]?.draftPostId).toBe(DRAFT);
    expect(await searchesForDraft(dataDir, OTHER_DRAFT)).toEqual([]);
  });

  // The link is a session_state row, so every `loadSearches` caller reaches it
  // through the LEFT JOIN: it must carry the link where there is one and drop
  // neither the unlinked rows nor a row's own identity where there is not.
  it('rides loadSearches through the LEFT JOIN without dropping or duplicating a row', async () => {
    await recordSearch(dataDir, entry());
    await recordSearch(dataDir, entry({ searchId: ID2, question: 'unlinked' }));
    await linkSearchesToDraft(dataDir, [ID], DRAFT);
    const loaded = await loadSearches(dataDir);
    expect(loaded).toHaveLength(2);
    expect(loaded.find((s) => s.searchId === ID)?.draftPostId).toBe(DRAFT);
    expect(loaded.find((s) => s.searchId === ID2)?.draftPostId).toBeUndefined();
  });

  // A link to a row this ledger never recorded would never be read back, since
  // `searchesForDraft` joins on the searches table. Refused at the write.
  it('writes nothing for a searchId this machine never recorded', async () => {
    await recordSearch(dataDir, entry());
    await linkSearchesToDraft(dataDir, ['0197aaaa-bbbb-cccc-dddd-000000000099'], DRAFT);
    expect(await searchesForDraft(dataDir, DRAFT)).toEqual([]);
    expect((await loadSearches(dataDir))[0]?.draftPostId).toBeUndefined();
  });

  // `UUID_RE` takes a post id in either case and SQLite compares text as bytes,
  // so without the fold `edit 0197DDDD-… --status published` would find no
  // claim and lose the attribution behind a successful receipt.
  it('matches a post id in either case, in both directions', async () => {
    await recordSearch(dataDir, entry());
    await recordSearch(dataDir, entry({ searchId: ID2, question: 'parked in caps' }));
    await linkSearchesToDraft(dataDir, [ID], DRAFT);
    await linkSearchesToDraft(dataDir, [ID2], OTHER_DRAFT.toUpperCase());

    expect((await searchesForDraft(dataDir, DRAFT.toUpperCase())).map((s) => s.searchId)).toEqual([
      ID,
    ]);
    expect((await searchesForDraft(dataDir, OTHER_DRAFT)).map((s) => s.searchId)).toEqual([ID2]);
    // One spelling on the way out too, so nothing downstream echoes a post id
    // in a case the store does not hold.
    expect((await loadSearches(dataDir)).find((s) => s.searchId === ID2)?.draftPostId).toBe(
      OTHER_DRAFT,
    );
  });

  // Resolved entries are returned ON PURPOSE: an `outcome` that closed the loop
  // first does not change who ended up answering it, and the promotion is the
  // publish arriving late. This is the only route to a `relinked` receipt.
  it('includes a search something else already closed', async () => {
    await recordSearch(dataDir, entry());
    await linkSearchesToDraft(dataDir, [ID], DRAFT);
    await markSearchResolved(dataDir, ID, 'outcome', '2026-08-09T10:00:00.000Z');
    const parked = await searchesForDraft(dataDir, DRAFT);
    expect(parked.map((s) => s.searchId)).toEqual([ID]);
    expect(parked[0]?.resolved?.by).toBe('outcome');
    await expect(
      markSearchResolved(dataDir, ID, 'publish', '2026-08-09T11:00:00.000Z', { relink: true }),
    ).resolves.toBe('relinked');
  });

  it('records the link in one call when the caller already knows it', async () => {
    await recordSearch(dataDir, entry({ draftPostId: DRAFT.toUpperCase() }));
    expect((await searchesForDraft(dataDir, DRAFT)).map((s) => s.searchId)).toEqual([ID]);
  });

  it('never throws on a corrupt store, in either direction', async () => {
    await rm(join(dataDir, STATE_DB_FILE), { force: true });
    await writeFile(join(dataDir, STATE_DB_FILE), 'not a database', 'utf8');
    await expect(linkSearchesToDraft(dataDir, [ID], DRAFT)).resolves.toBeUndefined();
    await expect(searchesForDraft(dataDir, DRAFT)).resolves.toEqual([]);
  });
});

/**
 * What the 50-entry cap and the demand budget existed to protect.
 *
 * The searches ledger held 50 entries in its file era, so a wide subagent
 * fan-out drained the slots `buy <resourceId>` and `outcome --last` depend on;
 * the answer was a hand-rolled budget capping the two demand sources at 15
 * between them, written twice — in the CLI and in the generated hook — so the
 * bound belonged to whichever process wrote last rather than to the store.
 *
 * The table is unbounded (plan 03, owner decision 2: no retention, no pruning),
 * so nothing evicts anything and both copies of the budget are gone. These pin
 * the property, not the mechanism.
 */
describe('a demand flood costs a deliberate search nothing', () => {
  const id = (n: number): string => `0197aaaa-bbbb-cccc-dddd-${String(n).padStart(12, '0')}`;

  it('keeps the deliberate entry, its candidate, and `--last`, under a 60-deep flood', async () => {
    await recordSearch(dataDir, {
      searchId: id(1),
      at: agoIso(60_000),
      question: 'q',
      decision: 'CANDIDATES',
      candidates: [
        { resourceId: 'res-1', url: 'https://x/api/read/a/b', title: 't', price: '100000' },
      ],
      source: 'cli',
    });
    for (let i = 0; i < 60; i += 1) {
      await recordSearch(dataDir, {
        searchId: id(100 + i),
        at: new Date(Date.now() - (60 - i) * 1000).toISOString(),
        question: 'q',
        decision: 'CANDIDATES',
        candidates: [],
        source: 'dispatch-hook',
      });
    }

    const loaded = await loadSearches(dataDir);
    expect(loaded.map((s) => s.searchId)).toContain(id(1));
    expect(loaded.filter((s) => s.source === 'dispatch-hook')).toHaveLength(60);
    // Still resolvable, which is what the slot was being taken from.
    expect(await findStoredCandidate(dataDir, 'res-1')).not.toBeNull();
    expect(await findSearchForResource(dataDir, { resourceId: 'res-1' })).toBe(id(1));
    // And `--last` still means "the search I ran", not the newest fan-out row.
    expect((await latestSearch(dataDir))?.searchId).toBe(id(1));
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

/**
 * THE STALE END OF A CLAIM, IN ONE STATEMENT (tenjin-agent#249).
 *
 * The Stop hook's machine-wide sync claim expires by age, and taking an expired
 * one over used to be `clearState` then `claimState` — two statements with a
 * window between them that two Stop hooks could both be inside, so both cleared,
 * both re-claimed, and both spawned a detached `tenjin sync`. The guard existed
 * precisely to make that one child.
 *
 * The property asserted here is the one the pair could not have: a SECOND
 * takeover computing the same `staleBefore` finds nothing to take, because the
 * first takeover's own write moved the row out of range. Clear-then-claim would
 * have handed the row to both callers, since `clearState` asks nothing about
 * what it deletes.
 */
describe('takeStaleState', () => {
  const KEY = 'sync:claim';
  const TTL = 2 * 60 * 1000;

  async function db(): Promise<DatabaseSync> {
    const store = await openStore(dataDir);
    store?.close();
    return new DatabaseSync(join(dataDir, STATE_DB_FILE));
  }

  function claim(handle: DatabaseSync, at: number): void {
    handle.prepare(STORE_SQL.setState).run('', KEY, JSON.stringify({ at }), at);
  }

  function take(handle: DatabaseSync, now: number): number {
    return Number(
      handle
        .prepare(STORE_SQL.takeStaleState)
        .run(JSON.stringify({ at: now }), now, '', KEY, now - TTL).changes,
    );
  }

  it('is taken by exactly one of two callers that both see it stale', async () => {
    const handle = await db();
    try {
      const now = Date.now();
      claim(handle, now - TTL - 60_000);
      // Both callers computed their cutoff before either wrote — the state two
      // racing Stop hooks are in when they have both read the claim as expired.
      expect(take(handle, now)).toBe(1);
      expect(take(handle, now)).toBe(0);
    } finally {
      handle.close();
    }
  });

  it('leaves a claim younger than the cutoff to its holder', async () => {
    const handle = await db();
    try {
      const now = Date.now();
      claim(handle, now - 1_000);
      expect(take(handle, now)).toBe(0);
      const row = handle.prepare(STORE_SQL.getState).get('', KEY) as unknown as { value: string };
      expect(JSON.parse(row.value)).toEqual({ at: now - 1_000 });
    } finally {
      handle.close();
    }
  });

  /**
   * THE PAIR THIS REPLACED, RUN THE SAME WAY, so the difference is on the record
   * rather than argued: `clearState` asks nothing about what it deletes, so the
   * second caller's DELETE removes the claim the first caller had just taken and
   * its INSERT walks straight in. Two winners, two detached syncs.
   *
   * A process-level race is not what proves this. Eight Stop hooks started
   * together are separated by node's own startup, which is milliseconds against
   * a window of microseconds, so the old shape passes that test most of the
   * time. The statement is where the property lives.
   */
  it('is a takeover the clearState + claimState pair could not be', async () => {
    const handle = await db();
    try {
      const now = Date.now();
      claim(handle, now - TTL - 60_000);
      const clearThenClaim = (): number => {
        handle.prepare(STORE_SQL.deleteState).run('', KEY);
        return Number(
          handle.prepare(STORE_SQL.claimState).run('', KEY, JSON.stringify({ at: now }), now)
            .changes,
        );
      };
      expect(clearThenClaim()).toBe(1);
      expect(clearThenClaim()).toBe(1);
    } finally {
      handle.close();
    }
  });

  /** It cannot INSERT, so it can never resurrect a claim someone just cleared. */
  it('creates nothing when there is no claim to take', async () => {
    const handle = await db();
    try {
      expect(take(handle, Date.now())).toBe(0);
      expect(handle.prepare(STORE_SQL.getState).get('', KEY)).toBeUndefined();
    } finally {
      handle.close();
    }
  });
});

/**
 * The `owner/name` the coarse key is salted with (tenjin-agent#249). The table
 * is shared with push-scripts.test.ts, which runs the generated failure arm's
 * inline copy against exactly these rows: two implementations, one table, so a
 * shape either holds on both sides or the suite is red.
 */
describe('repoSlug', () => {
  it.each(REPO_SLUG_CASES)('reduces %j to %j', (url, slug) => {
    expect(repoSlug(url)).toBe(slug);
  });

  /** The point of the whole change: transport is not identity. */
  it('gives one salt to every spelling of one repo', () => {
    const spellings = [
      'git@github.com:acme/api.git',
      'https://github.com/acme/api.git',
      'https://github.com/acme/api',
      'ssh://git@github.com:2222/acme/api',
    ];
    expect(new Set(spellings.map((u) => teamCoarseKey('abc123', repoSlug(u)))).size).toBe(1);
  });

  /** And a fork is still a different shelf scope than its upstream. */
  it('keeps two repos, and a fork of one, on different salts', () => {
    const upstream = teamCoarseKey('abc123', repoSlug('git@github.com:acme/api.git'));
    expect(upstream).not.toBe(teamCoarseKey('abc123', repoSlug('git@github.com:other/api.git')));
    expect(upstream).not.toBe(teamCoarseKey('abc123', repoSlug('git@github.com:acme/web.git')));
  });

  /**
   * THE OTHER HALF OF "transport is not identity": identity is not the tail of
   * the path either (round-1 review of #256). The same `acme/api` on two hosts
   * is two repos — an internal mirror, a self-hosted rewrite — and two GitLab
   * namespaces that end alike are two repos. The last-two-segments rule pooled
   * both pairs into one coarse scope, which is the state the salt exists to
   * prevent.
   */
  it('keeps the same path on two hosts, and two deep paths that end alike, apart', () => {
    expect(teamCoarseKey('abc123', repoSlug('git@github.com:acme/api.git'))).not.toBe(
      teamCoarseKey('abc123', repoSlug('git@git.internal.acme.dev:acme/api.git')),
    );
    expect(teamCoarseKey('abc123', repoSlug('https://gitlab.com/a/b/c/api.git'))).not.toBe(
      teamCoarseKey('abc123', repoSlug('https://gitlab.com/x/y/c/api.git')),
    );
    // And Azure DevOps's two transports are the documented split, pinned so a
    // later reader sees it was chosen rather than missed.
    expect(repoSlug('https://dev.azure.com/org/proj/_git/api')).not.toBe(
      repoSlug('git@ssh.dev.azure.com:v3/org/proj/api'),
    );
  });

  /**
   * '' MEANS NO REMOTE, AND IT IS NOT A SALT (#249, owner decision). Every
   * origin-less checkout reduces to the same empty string, so publishing and
   * querying under it would pool all of them into one coarse bucket on a shared
   * shelf — and a coarse hit is rank 1 with no relevance check to run. The
   * pooling is a property of the reduction and cannot be fixed here; what
   * changed is that both callers now treat '' as "local only" and neither
   * publishes nor asks under it (sync.test.ts and push-scripts.test.ts pin
   * that end).
   */
  it("reduces every checkout with no remote to the same '', which is why neither side uses it", () => {
    expect(repoSlug('/srv/mirrors/api')).toBe('');
    expect(repoSlug('../scratch')).toBe('');
    expect(repoSlug('')).toBe('');
  });
});

/**
 * The coarse fingerprint as it goes on the team-shelf wire. `tenjin sync` writes
 * this key on a post and the failure arm's resolve leg queries it; the two run in
 * different processes, months apart, on different machines, and a shelf lookup
 * that silently matches nothing is indistinguishable from "no teammate has hit
 * this". So the VALUE is pinned, not the formula: a test written as
 * `teamCoarseKey(a, b) === shortHash(a + '|' + b)` restates the implementation
 * and would follow any change to it, including a change that stranded every key
 * already on a shelf.
 */
describe('teamCoarseKey', () => {
  it('is a pinned value, so sync and resolve can never drift apart', () => {
    expect(teamCoarseKey('abc123', 'https://github.com/acme/widgets.git')).toBe('a7b33a270638732d');
  });

  it('is the repo salt over the STORED coarse hash, so no raw message is needed', () => {
    expect(teamCoarseKey('abc123', 'https://github.com/acme/widgets.git')).toBe(
      shortHash('abc123|https://github.com/acme/widgets.git'),
    );
  });

  it('separates the same error across two repos, which is the whole point of the salt', () => {
    expect(teamCoarseKey('abc123', 'repo-a')).not.toBe(teamCoarseKey('abc123', 'repo-b'));
  });

  it('still yields a key when the checkout has no origin remote', () => {
    expect(teamCoarseKey('abc123', '')).toBe(shortHash('abc123|'));
  });
});
