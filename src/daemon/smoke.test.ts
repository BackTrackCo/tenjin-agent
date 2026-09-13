import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build, type Options } from 'tsup';
import tsupConfigs from '../../tsup.config';
import pkg from '../../package.json';
import { installDaemonFiles } from './control';
import { HARNESS_MS } from '../hooks/constants';
import { ensureDaemon, readToken } from '../hooks/shim';
import {
  configPath,
  daemonBundlePath,
  daemonLogPath,
  daemonPidPath,
  loopDbPath,
  shimBundlePath,
  vitestReporterPath,
} from '../lib/paths';
import { HOOK_ARMS } from '../lib/config';

/**
 * The one end-to-end test in PR B: the real tsup bundles, a real spawned
 * daemon, real HTTP round trips. Everything else under src/daemon and
 * src/hooks tests its piece against fakes; a wrong bundle key, a wrong import
 * specifier in the shim, or a wrong port derivation would only ever surface
 * here (07-pr-b-daemon-kernel.md "B2 tests").
 */
vi.setConfig({ hookTimeout: 60_000, testTimeout: 20_000 });

/** Every arm off, the baseline this file writes; a case spreads it and names
 *  the one arm it needs. */
const ALL_OFF = Object.fromEntries(HOOK_ARMS.map((arm) => [arm, false]));

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(HERE, '..', 'adapters', 'fixtures', 'claude');

interface Fixture {
  name: string;
  event: string;
  body: string;
}

function eventNameOf(body: string): string {
  const parsed = JSON.parse(body) as { hook_event_name?: unknown };
  return typeof parsed.hook_event_name === 'string' ? parsed.hook_event_name : '';
}

async function loadFixtures(): Promise<Fixture[]> {
  const files = (await readdir(FIXTURES_DIR)).filter((f) => f.endsWith('.json')).sort();
  return Promise.all(
    files.map(async (name) => {
      const body = await readFile(join(FIXTURES_DIR, name), 'utf8');
      return { name, event: eventNameOf(body), body };
    }),
  );
}

let tmpOutDir: string;
let dataDir: string;
let port: number;
let token: string;
let daemonPid: number;
let coldStartMs: number;
let bundleBytes: number;
let fixtures: Fixture[];
let shelf: Server;
let shelfUrl: string;
/** Every /api/search body the stub shelf was handed. */
const shelfBodies: Array<Record<string, unknown>> = [];

/** The one piece the stub shelf holds, free and with its body attached — which
 *  is what PR F puts on every free row and what makes the delivery the whole
 *  finding rather than a pointer. */
const SHELF_TITLE = 'The pgvector collation flip';
const SHELF_BODY = 'swap the image tag back to pgvector/pgvector:pg16 and re-seed';
const SHELF_CALIBRATION = 'hybrid-v1';

function shelfEnvelope(): unknown {
  return {
    schemaVersion: 3,
    searchId: '33333333-3333-4333-8333-333333333333',
    calibration: SHELF_CALIBRATION,
    matched: 1,
    items: [
      {
        resourceId: '44444444-4444-4444-8444-444444444444',
        url: 'https://shelf.example/p/collation',
        slug: 'collation',
        title: SHELF_TITLE,
        artifactType: 'finding',
        price: '0',
        asOf: null,
        validUntil: null,
        matchReasons: ['title'],
        estimatedTokens: 400,
        creator: { handle: 'ali' },
        strong: true,
        body: { text: SHELF_BODY },
      },
    ],
  };
}

/** A shelf on loopback, answering POST /api/search and nothing else. Both legs
 *  point at it, so one prompt is two requests and two `legs` rows. */
function startShelf(): Promise<{ server: Server; url: string }> {
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c: Buffer) => (raw += c.toString('utf8')));
    req.on('end', () => {
      if (req.method !== 'POST' || !(req.url ?? '').startsWith('/api/search')) {
        res.writeHead(404).end();
        return;
      }
      try {
        shelfBodies.push(JSON.parse(raw) as Record<string, unknown>);
      } catch {
        // The assertion below reads what did parse.
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(shelfEnvelope()));
    });
  });
  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('stub shelf did not bind a port'));
        return;
      }
      resolve({ server, url: `http://127.0.0.1:${address.port}` });
    });
  });
}

/** Every pid this file has spawned or is otherwise responsible for; SIGKILLed
 *  in afterAll even when a case fails before it can clean up itself. */
const alivePids = new Set<number>();

function tryKill(pid: number, signal: NodeJS.Signals = 'SIGKILL'): void {
  try {
    process.kill(pid, signal);
  } catch {
    // Already gone.
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * THE LEDGER ROW LANDS AFTER THE RESPONSE FLUSHES. `server.ts` defers `commit`
 * to a `setImmediate` past the send, so a reader that opens `loop.db` the
 * instant a POST resolves can be one row early: measured 0 ms late on an idle
 * laptop and 4 to 48 ms late under CPU contention, which is why this only ever
 * reddens CI.
 *
 * So every read of `fires` here is POLLED to the count the case expects, never
 * taken once. `expect.poll` and not a hand-rolled helper: the helper this
 * replaces took "wait until there are at least n", and two call sites handed it
 * the count they had just read, which it satisfies without waiting at all.
 *
 * The bound is {@link HARNESS_MS}, the daemon's own backstop for one fire: a
 * row still missing after it is a broken daemon, not a slow runner.
 */
const POLL = { timeout: HARNESS_MS, interval: 20 } as const;

/** A `type` and not an `interface`: only an object type literal gets the
 *  implicit index signature that lets `node:sqlite`'s row type cast to it. */
type FireRow = {
  id: string;
  arm: string;
  event: string;
  reason: string;
  delivered: string | null;
};

/** The `fires` rows for one Claude session (stored as `claude:<id>`), or for
 *  one agent within that session. */
function firesOf(session: string, agent?: string): FireRow[] {
  const db = new DatabaseSync(loopDbPath(dataDir), { readOnly: true });
  try {
    const stmt = db.prepare(
      `SELECT id, arm, event, reason, delivered FROM fires WHERE session = ?${
        agent === undefined ? '' : ' AND agent = ?'
      }`,
    );
    const key = `claude:${session}`;
    return (agent === undefined ? stmt.all(key) : stmt.all(key, agent)) as FireRow[];
  } finally {
    db.close();
  }
}

function countFires(): number {
  const db = new DatabaseSync(loopDbPath(dataDir), { readOnly: true });
  try {
    const row = db.prepare('SELECT COUNT(*) AS n FROM fires').get() as { n: number };
    return Number(row.n);
  } finally {
    db.close();
  }
}

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Spawn `node <args>`, feed it `stdin`, and collect the whole run. */
function runNode(args: string[], env: NodeJS.ProcessEnv, stdin?: string): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
    if (child.pid !== undefined) alivePids.add(child.pid);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c: Buffer) => (stdout += c.toString('utf8')));
    child.stderr.on('data', (c: Buffer) => (stderr += c.toString('utf8')));
    child.on('error', reject);
    child.on('close', (code) => {
      if (child.pid !== undefined) alivePids.delete(child.pid);
      resolve({ code, stdout, stderr });
    });
    child.stdin.end(stdin);
  });
}

/** Does this tsup config still name exactly the entries this suite builds? */
function hasEntries(config: Options | undefined, names: string[]): boolean {
  const entry = config?.entry;
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return false;
  return names.every((name) => name in entry);
}

function hookUrl(): string {
  return `http://127.0.0.1:${port}/hook/claude`;
}

function authHeaders(contentType = 'application/json'): Record<string, string> {
  return { Authorization: `Bearer ${token}`, 'Content-Type': contentType };
}

beforeAll(async () => {
  // Build the real bundles with tsup's API rather than reading `dist`: dist
  // goes stale between `pnpm build` runs and would pass in CI while lying
  // here (07-pr-b-daemon-kernel.md "B2 tests").
  tmpOutDir = await mkdtemp(join(tmpdir(), 'tenjin-b-smoke-bundle-'));
  const configs = tsupConfigs as unknown as Options[];
  const daemonConfig = configs[1];
  const reporterConfig = configs[2];
  if (
    !hasEntries(daemonConfig, ['tenjin-daemon', 'tenjin-shim']) ||
    !hasEntries(reporterConfig, ['tenjin-vitest-reporter'])
  ) {
    throw new Error(
      'tsup.config.ts no longer has the tenjin-daemon/tenjin-shim/tenjin-vitest-reporter entries; smoke test assumption broke',
    );
  }
  // Both single-file configs: `installDaemonFiles` copies all three, so a
  // missing one would fail the fixture before a single case ran.
  await build({ ...daemonConfig, outDir: tmpOutDir, silent: true });
  await build({ ...reporterConfig, outDir: tmpOutDir, silent: true });

  dataDir = await mkdtemp(join(tmpdir(), 'tenjin-b-smoke-data-'));
  // Every arm is pinned off rather than defaulted: they are on out of the box
  // now, and the fixture cases below are about routing and rows, not about
  // lookups. Without it every fixture would ask the production shelf. A case
  // that needs an arm turns that one on for itself.
  await writeFile(configPath(dataDir), JSON.stringify({ loop: { port: 0 }, hooks: ALL_OFF }));
  installDaemonFiles(dataDir, tmpOutDir);

  const t0 = Date.now();
  const ensured = await ensureDaemon(dataDir, { spawnMs: 10_000 });
  coldStartMs = Date.now() - t0;
  if (!ensured.ok) throw new Error(`daemon did not start: ${ensured.reason}`);
  if (!ensured.spawned)
    throw new Error('ensureDaemon found a pre-existing daemon; expected a fresh spawn');

  port = ensured.health.port;
  daemonPid = ensured.health.pid;
  alivePids.add(daemonPid);
  const t = readToken(dataDir);
  if (t === null) throw new Error('daemon.token missing after installDaemonFiles');
  token = t;

  bundleBytes = (await stat(daemonBundlePath(dataDir))).size;
  fixtures = await loadFixtures();

  const stub = await startShelf();
  shelf = stub.server;
  shelfUrl = stub.url;
});

afterAll(async () => {
  if (shelf !== undefined) await new Promise<void>((r) => shelf.close(() => r()));
  for (const pid of alivePids) tryKill(pid, 'SIGKILL');
  if (dataDir !== undefined) await rm(dataDir, { recursive: true, force: true });
  if (tmpOutDir !== undefined) await rm(tmpOutDir, { recursive: true, force: true });
});

describe('the daemon, cold-started from the real bundle', () => {
  it('answers GET /health with version, pid, port and data_dir', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.version).toBe(pkg.version);
    expect(body.pid).toBe(daemonPid);
    expect(body.port).toBe(port);
    expect(body.data_dir).toBe(dataDir);
  });

  it('answers 204 to every valid Claude event fixture, and the primer to SessionStart', async () => {
    const original = await readFile(configPath(dataDir), 'utf8');
    // The primer asks no shelf, so it is the one arm this case turns on: the
    // event a session opens with has to carry its paragraph back.
    await writeFile(
      configPath(dataDir),
      JSON.stringify({ loop: { port: 0 }, hooks: { ...ALL_OFF, primer: true } }),
    );
    try {
      for (const f of fixtures) {
        const res = await fetch(hookUrl(), {
          method: 'POST',
          headers: authHeaders(),
          body: f.body,
        });
        if (f.event === 'SessionStart') {
          expect(res.status, f.name).toBe(200);
          const out = (await res.json()) as { hookSpecificOutput?: { additionalContext?: string } };
          expect(out.hookSpecificOutput?.additionalContext).toContain('Tenjin');
          continue;
        }
        expect(res.status, f.name).toBe(204);
        expect(await res.text(), f.name).toBe('');
      }
    } finally {
      await writeFile(configPath(dataDir), original);
    }
  });

  it('writes one no-question fires row per valid event except a phantom SubagentStop', async () => {
    const stops = fixtures.filter((f) => f.event === 'SubagentStop').length;
    await expect.poll(countFires, POLL).toBe(fixtures.length - stops);
    const db = new DatabaseSync(loopDbPath(dataDir), { readOnly: true });
    try {
      const rows = db
        .prepare('SELECT session, agent, event, arm, reason FROM fires')
        .all() as Array<{
        session: string;
        agent: string;
        event: string;
        arm: string;
        reason: string;
      }>;
      expect(rows).toHaveLength(fixtures.length - stops);
      // This file pins every arm off, so every lookup arm declines
      // and nothing is asked of any shelf. `arm` still names the arm that
      // declined — the WebFetch fixture reaches `fetch`, the Bash result
      // reaches `failure`, the Bash call and the Read reach `context` — and
      // every installed entry now finds an arm.
      for (const r of rows) {
        expect(r.reason, r.event).toBe('no-question');
        expect(r.arm).not.toBe('none');
      }
      // The SubagentStop fixture is from another session than the
      // SubagentStart one, so no `started` mark exists for it (actor.ts): a
      // phantom stop, and it leaves no row at all.
      expect(rows.some((r) => r.event === 'agent.stop')).toBe(false);
      // Every fire the child sent but its stop is filed under the child's own
      // id (the start, and its two tool fires from the captured 2.1.261 turn).
      const start = fixtures.find((f) => f.event === 'SubagentStart');
      if (start !== undefined) {
        const agentId = (JSON.parse(start.body) as { agent_id: string }).agent_id;
        const childFires = fixtures.filter(
          (f) =>
            (JSON.parse(f.body) as { agent_id?: string }).agent_id === agentId &&
            f.event !== 'SubagentStop',
        ).length;
        expect(childFires).toBeGreaterThan(1);
        expect(rows.filter((r) => r.agent === agentId)).toHaveLength(childFires);
      }
    } finally {
      db.close();
    }
  });

  it('drops an agent_id containing a space: 204, no new row', async () => {
    const before = countFires();
    const res = await fetch(hookUrl(), {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        session_id: 's-agent-space',
        cwd: '/x',
        hook_event_name: 'SubagentStart',
        prompt_id: 'p1',
        agent_id: 'a7c 31e9f',
        agent_type: 'Explore',
      }),
    });
    expect(res.status).toBe(204);
    expect(countFires()).toBe(before);
  });

  it('401s with no Authorization header', async () => {
    const res = await fetch(hookUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(401);
  });

  it('401s with the right token but a text/plain Content-Type', async () => {
    const res = await fetch(hookUrl(), {
      method: 'POST',
      headers: authHeaders('text/plain'),
      body: '{}',
    });
    expect(res.status).toBe(401);
  });

  it('400s on invalid JSON', async () => {
    const res = await fetch(hookUrl(), {
      method: 'POST',
      headers: authHeaders(),
      body: '{not valid',
    });
    expect(res.status).toBe(400);
  });

  it('413s on a 5 MB body', async () => {
    const res = await fetch(hookUrl(), {
      method: 'POST',
      headers: authHeaders(),
      body: 'x'.repeat(5 * 1024 * 1024),
    });
    expect(res.status).toBe(413);
  });

  it('404s on /hook/hermes, an unregistered harness', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/hook/hermes`, {
      method: 'POST',
      headers: authHeaders(),
      body: '{}',
    });
    expect(res.status).toBe(404);
  });

  it('404s on GET /nope', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/nope`);
    expect(res.status).toBe(404);
  });

  it('the shim bundle: ensures, forwards stdin, exits 0 with empty stdout, and adds one fires row', async () => {
    const before = countFires();
    const prompt =
      fixtures.find((f) => f.event === 'UserPromptSubmit')?.body ??
      JSON.stringify({
        session_id: 's-shim',
        cwd: '/x',
        hook_event_name: 'UserPromptSubmit',
        prompt_id: 'p1',
        prompt: 'hi',
      });
    const result = await runNode(
      [shimBundlePath(dataDir), '--harness', 'claude'],
      { ...process.env, TENJIN_DATA_DIR: dataDir },
      prompt,
    );
    expect(result.code).toBe(0);
    expect(result.stdout).toBe('');
    await expect.poll(countFires, POLL).toBe(before + 1);
  });

  it('the bind race: a second daemon on the same port exits 0 within 2 s, the first keeps serving', async () => {
    const original = await readFile(configPath(dataDir), 'utf8');
    await writeFile(configPath(dataDir), JSON.stringify({ loop: { port } }));
    try {
      const t0 = Date.now();
      const result = await runNode([daemonBundlePath(dataDir)], {
        ...process.env,
        TENJIN_DATA_DIR: dataDir,
      });
      const elapsed = Date.now() - t0;
      expect(result.code).toBe(0);
      expect(elapsed).toBeLessThan(2000);
    } finally {
      await writeFile(configPath(dataDir), original);
    }
    const health = await fetch(`http://127.0.0.1:${port}/health`);
    expect(health.status).toBe(200);
    const body = (await health.json()) as { pid: number };
    expect(body.pid).toBe(daemonPid);
  });

  it('the shim bundle source imports only node: builtins', async () => {
    const src = await readFile(shimBundlePath(dataDir), 'utf8');
    const specifierRe = /\bfrom\s+["']([^"']+)["']|\bimport\(\s*["']([^"']+)["']\s*\)/g;
    const specifiers: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = specifierRe.exec(src)) !== null) specifiers.push(m[1] ?? m[2] ?? '');
    expect(specifiers.length).toBeGreaterThan(0);
    for (const s of specifiers) expect(s.startsWith('node:')).toBe(true);
  });

  /**
   * THE ONE END-TO-END PASS OF PR C: a real prompt through the real bundle,
   * both arms' shared pieces, two real HTTP legs against a stub shelf, and the
   * finding back out as `additionalContext`. Everything between the POST and
   * the assertion is production code.
   */
  it('a prompt with a stubbed shelf: one hit row, one leg per shelf, the finding injected', async () => {
    const original = await readFile(configPath(dataDir), 'utf8');
    await writeFile(
      configPath(dataDir),
      JSON.stringify({
        loop: { port: 0 },
        baseUrl: shelfUrl,
        publicShelfUrl: shelfUrl,
        hooks: { ...ALL_OFF, prompt: true },
      }),
    );
    let response: Record<string, unknown>;
    try {
      const res = await fetch(hookUrl(), {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({
          session_id: 's-loop-prompt',
          cwd: '/tmp/proj',
          hook_event_name: 'UserPromptSubmit',
          prompt_id: 'p-loop-1',
          prompt:
            'the pgvector testcontainer flipped its collation after the image bump and every ivfflat index test now fails',
        }),
      });
      expect(res.status).toBe(200);
      response = (await res.json()) as Record<string, unknown>;
    } finally {
      await writeFile(configPath(dataDir), original);
    }

    const out = response.hookSpecificOutput as {
      hookEventName?: string;
      additionalContext?: string;
    };
    expect(out.hookEventName).toBe('UserPromptSubmit');
    expect(out.additionalContext).toContain(SHELF_TITLE);
    // The body rode on the candidate, so the agent gets the finding itself
    // rather than a pointer to it.
    expect(out.additionalContext).toContain(SHELF_BODY);

    // Both legs asked, on the one question the prompt arm masked.
    expect(shelfBodies).toHaveLength(2);
    for (const body of shelfBodies) expect(body.trigger).toBe('prompt');

    // The response flushing is not the row landing. Wait for the row, then
    // read it: the fire and its legs go in ONE transaction (`ledger.ts`), so a
    // visible `fires` row means the `legs` rows are visible too.
    await expect.poll(() => firesOf('s-loop-prompt').length, POLL).toBe(1);
    const fires = firesOf('s-loop-prompt');
    expect(fires).toHaveLength(1);
    const fire = fires[0];
    expect(fire?.arm).toBe('prompt');
    expect(fire?.reason).toBe('hit');
    expect(fire?.delivered).toMatch(/^inject:/);
    const db = new DatabaseSync(loopDbPath(dataDir), { readOnly: true });
    try {
      const legs = db
        .prepare(
          'SELECT shelf, status, outcome, calibration FROM legs WHERE fire_id = ? ORDER BY shelf',
        )
        .all(fire?.id ?? '') as Array<{
        shelf: string;
        status: string;
        outcome: string;
        calibration: string | null;
      }>;
      expect(legs.map((l) => l.shelf)).toEqual(['public', 'team']);
      for (const leg of legs) {
        expect(leg.status).toBe('ok');
        expect(leg.calibration).toBe(SHELF_CALIBRATION);
      }
      // Team outranks public, so the team leg is the hit and public is shadowed.
      expect(legs.find((l) => l.shelf === 'team')?.outcome).toBe('hit');
    } finally {
      db.close();
    }
  }, 15_000);

  /**
   * THE ONE END-TO-END PASS OF PR D: the captured events of one dispatched
   * turn (2.1.261) against the stub shelf. The parent's dispatch parks a
   * handoff; the child claims it at its start and gets the finding whole; the
   * child's stop is asked once and its answer turn says nothing; the lead, which
   * only dispatched, is not asked at all.
   */
  it('a dispatched turn with a stubbed shelf: handoff parked and claimed, the child asked once, the lead left alone', async () => {
    const original = await readFile(configPath(dataDir), 'utf8');
    await writeFile(
      configPath(dataDir),
      JSON.stringify({
        loop: { port: 0 },
        baseUrl: shelfUrl,
        publicShelfUrl: shelfUrl,
        hooks: { ...ALL_OFF, subagent: true, publish: true },
      }),
    );
    const session = 's-loop-dispatch';
    const turn = 'p-loop-2';
    const agent = 'a59db2769b6f0fcd1';
    const post = async (body: Record<string, unknown>) => {
      const res = await fetch(hookUrl(), {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ session_id: session, cwd: '/tmp/proj', prompt_id: turn, ...body }),
      });
      return {
        status: res.status,
        body: res.status === 200 ? ((await res.json()) as Record<string, unknown>) : null,
      };
    };
    const contextOf = (r: { body: Record<string, unknown> | null }) =>
      (r.body?.hookSpecificOutput as { additionalContext?: string } | undefined)?.additionalContext;
    const handoffCount = () => {
      const db = new DatabaseSync(loopDbPath(dataDir), { readOnly: true });
      try {
        return Number((db.prepare('SELECT COUNT(*) AS n FROM handoff').get() as { n: number }).n);
      } finally {
        db.close();
      }
    };
    try {
      // 1. The parent dispatches: log-only for the parent, a row parked.
      const dispatched = await post({
        hook_event_name: 'PreToolUse',
        tool_name: 'Agent',
        tool_input: {
          description: 'collation probe',
          prompt: 'find why the pgvector testcontainer flipped its collation after the image bump',
          subagent_type: 'Explore',
        },
      });
      expect(dispatched.status).toBe(204);
      expect(handoffCount()).toBe(1);

      // 2. The child starts and is handed the finding whole; the row is gone.
      const startRes = await post({
        hook_event_name: 'SubagentStart',
        agent_id: agent,
        agent_type: 'Explore',
      });
      expect(startRes.status).toBe(200);
      expect(contextOf(startRes)).toContain(SHELF_BODY);
      expect(handoffCount()).toBe(0);

      // 3. The child EDITS a file: one context row and an `edited:` mark, which
      // is its evidence. A Read is deliberately not enough any more (owner,
      // 2026-09-12): it is the cheapest row an agent can leave, and counting it
      // asked nearly every child whatever it had been doing.
      const edit = await post({
        hook_event_name: 'PreToolUse',
        agent_id: agent,
        agent_type: 'Explore',
        tool_name: 'Edit',
        tool_input: { file_path: '/tmp/proj/README.md', old_string: 'a', new_string: 'b' },
      });
      expect(edit.status).toBe(204);
      // The child's stop is asked only when its edit is ALREADY in the ledger:
      // `capture.ts` reads the marks and `fires` rows for the child's evidence,
      // and both land after this 204. Polling the total count would race the
      // same way, so wait for the row itself.
      await expect
        .poll(() => firesOf(session, agent).filter((f) => f.arm === 'context').length, POLL)
        .toBe(1);

      // 4. The child stops: asked as context, under its own id.
      const stopRes = await post({
        hook_event_name: 'SubagentStop',
        agent_id: agent,
        agent_type: 'Explore',
        stop_hook_active: false,
        last_assistant_message: 'The collation flipped with the image tag.',
      });
      expect(stopRes.status).toBe(200);
      const childAsk = contextOf(stopRes) ?? '';
      expect(childAsk).toContain('Tenjin: this turn did work worth a second look.');
      expect(childAsk).toContain(`--agent ${agent}`);
      // Never a blocking decision: `additionalContext` is the one channel.
      expect(stopRes.body?.decision).toBeUndefined();

      // 5. The child's answer turn: its row is written, and it reads nothing new.
      const answered = await post({
        hook_event_name: 'SubagentStop',
        agent_id: agent,
        agent_type: 'Explore',
        stop_hook_active: true,
        last_assistant_message: 'Published it.',
      });
      expect(answered.status).toBe(204);

      // 6. The lead stops and is NOT asked: it dispatched, and dispatching is
      // not work of its own. Nothing its child did arms it either — the parent
      // is asked on its OWN evidence or not at all (principle 5), and the rule
      // that re-armed it from a child's stored finding is gone with the store.
      const leadRes = await post({
        hook_event_name: 'Stop',
        stop_hook_active: false,
        last_assistant_message: 'done',
      });
      expect(leadRes.status).toBe(204);
    } finally {
      await writeFile(configPath(dataDir), original);
    }
  }, 15_000);

  // Last: tears down the daemon every prior case in this file depends on.
  /**
   * Codex on the same daemon, through the captured 0.153.4 payloads
   * (`adapters/fixtures/codex`). What the adapter tests cannot show is proven
   * here: the route dispatches, the rows are filed under `codex:<session>` and
   * the child's own id, the capture ask reaches a child as a Stop `decision:
   * block`, and the shim forwards a Codex payload under `--harness codex`.
   */
  describe('Codex on the same daemon', () => {
    const CODEX_FIXTURES_DIR = join(HERE, '..', 'adapters', 'fixtures', 'codex');
    let codexFixtures: Fixture[] = [];

    function codexUrl(): string {
      return `http://127.0.0.1:${port}/hook/codex`;
    }

    async function post(body: string): Promise<Response> {
      return fetch(codexUrl(), { method: 'POST', headers: authHeaders(), body });
    }

    async function withArms(arms: Record<string, boolean>, fn: () => Promise<void>): Promise<void> {
      const original = await readFile(configPath(dataDir), 'utf8');
      await writeFile(
        configPath(dataDir),
        JSON.stringify({ loop: { port: 0 }, hooks: { ...ALL_OFF, ...arms } }),
      );
      try {
        await fn();
      } finally {
        await writeFile(configPath(dataDir), original);
      }
    }

    beforeAll(async () => {
      const files = (await readdir(CODEX_FIXTURES_DIR)).filter((f) => f.endsWith('.json')).sort();
      codexFixtures = await Promise.all(
        files.map(async (name) => {
          const body = await readFile(join(CODEX_FIXTURES_DIR, name), 'utf8');
          return { name, event: eventNameOf(body), body };
        }),
      );
    });

    it('answers every captured event: 204, the primer on SessionStart, nothing on SessionEnd', async () => {
      await withArms({ primer: true }, async () => {
        for (const f of codexFixtures) {
          const res = await post(f.body);
          if (f.event === 'SessionStart') {
            expect(res.status, f.name).toBe(200);
            const out = (await res.json()) as {
              hookSpecificOutput?: { hookEventName?: string; additionalContext?: string };
            };
            expect(out.hookSpecificOutput?.hookEventName).toBe('SessionStart');
            expect(out.hookSpecificOutput?.additionalContext).toContain('Tenjin');
            continue;
          }
          expect(res.status, f.name).toBe(204);
        }
      });
    });

    it('files every row under codex:<root session> and the child under its own id; the spawn is no dispatch', async () => {
      // Every mapped fixture is one row, except the two stops: with `publish`
      // off the child's start wrote no `started` mark, so its stops are
      // phantoms (actor.ts), exactly as the Claude case above records them.
      const stops = codexFixtures.filter((f) => f.event === 'SubagentStop').length;
      const mapped = codexFixtures.filter((f) => f.event !== 'SessionEnd').length - stops;
      await expect.poll(countFires, POLL).toBeGreaterThanOrEqual(mapped);
      const db = new DatabaseSync(loopDbPath(dataDir), { readOnly: true });
      try {
        const rows = db
          .prepare("SELECT session, agent, event, arm, reason FROM fires WHERE harness = 'codex'")
          .all() as Array<{
          session: string;
          agent: string;
          event: string;
          arm: string;
          reason: string;
        }>;
        expect(rows.length).toBe(mapped);
        for (const r of rows) expect(r.session.startsWith('codex:'), r.session).toBe(true);
        const child = codexFixtures.find((f) => f.name === 'SubagentStart.json');
        const agentId = (JSON.parse(child?.body ?? '{}') as { agent_id: string }).agent_id;
        const childFixtures = codexFixtures.filter(
          (f) =>
            (JSON.parse(f.body) as { agent_id?: string }).agent_id === agentId &&
            f.event !== 'SubagentStop',
        );
        expect(childFixtures.length).toBeGreaterThanOrEqual(3);
        expect(rows.filter((r) => r.agent === agentId)).toHaveLength(childFixtures.length);
        // The spawn call reaches no arm: its task is opaque on the wire.
        const spawn = rows.find((r) => r.event === 'tool.before' && r.arm === 'dispatch');
        expect(spawn).toBeUndefined();
        // An apply_patch and a Bash call reach the context arm; a Bash result the failure arm.
        expect(rows.some((r) => r.arm === 'context')).toBe(true);
        expect(rows.some((r) => r.arm === 'failure')).toBe(true);
      } finally {
        db.close();
      }
    });

    it('equal native ids on two harnesses are two sessions in the ledger', async () => {
      const stop = fixtures.find((f) => f.event === 'Stop');
      if (stop === undefined) throw new Error('no Claude Stop fixture');
      const claudeSession = (JSON.parse(stop.body) as { session_id: string }).session_id;
      const before = countFires();
      expect((await post(stop.body)).status).toBe(204);
      await expect.poll(countFires, POLL).toBe(before + 1);
      const db = new DatabaseSync(loopDbPath(dataDir), { readOnly: true });
      try {
        const sessions = (
          db
            .prepare('SELECT DISTINCT session FROM fires WHERE session LIKE ?')
            .all(`%:${claudeSession}`) as Array<{ session: string }>
        ).map((r) => r.session);
        expect(sessions.sort()).toEqual([`claude:${claudeSession}`, `codex:${claudeSession}`]);
      } finally {
        db.close();
      }
    });

    it('a child with an edit is asked once at its stop as a block reason, and never again', async () => {
      // The sibling child: its patch is in the fixtures, its stop is built from
      // the captured one so it has a start of its own to answer for.
      const start = codexFixtures.find((f) => f.name === 'SubagentStart-sibling.json');
      const patch = codexFixtures.find((f) => f.name === 'child-PreToolUse-apply_patch.json');
      const stop = codexFixtures.find((f) => f.name === 'SubagentStop.json');
      if (start === undefined || patch === undefined || stop === undefined)
        throw new Error('fixtures');
      const sibling = JSON.parse(start.body) as { agent_id: string; turn_id: string };
      const stopFor = (fuse: boolean, last: string): string =>
        JSON.stringify({
          ...(JSON.parse(stop.body) as Record<string, unknown>),
          agent_id: sibling.agent_id,
          turn_id: sibling.turn_id,
          stop_hook_active: fuse,
          last_assistant_message: last,
        });
      await withArms({ publish: true }, async () => {
        expect((await post(start.body)).status).toBe(204);
        expect((await post(patch.body)).status).toBe(204);
        const asked = await post(stopFor(false, 'gamma written'));
        expect(asked.status).toBe(200);
        const out = (await asked.json()) as {
          decision?: string;
          reason?: string;
          hookSpecificOutput?: unknown;
        };
        expect(out.decision).toBe('block');
        expect(out.reason).toContain('Tenjin');
        expect(out.reason).toContain(`--agent ${sibling.agent_id}`);
        expect(out.hookSpecificOutput).toBeUndefined();
        // The answer turn: the row is written, and nothing more is said.
        const fused = await post(stopFor(true, 'published gamma'));
        expect(fused.status).toBe(204);
        const again = await post(stopFor(false, 'later'));
        expect(again.status).toBe(204);
      });
    });

    it('the shim forwards a Codex prompt under --harness codex and the row is filed under codex:', async () => {
      const prompt = codexFixtures.find((f) => f.event === 'UserPromptSubmit');
      if (prompt === undefined) throw new Error('no Codex prompt fixture');
      const before = countFires();
      const result = await runNode(
        [shimBundlePath(dataDir), '--harness', 'codex'],
        { ...process.env, TENJIN_DATA_DIR: dataDir },
        prompt.body,
      );
      expect(result.code).toBe(0);
      expect(result.stdout).toBe('');
      await expect.poll(countFires, POLL).toBe(before + 1);
      const session = (JSON.parse(prompt.body) as { session_id: string }).session_id;
      const db = new DatabaseSync(loopDbPath(dataDir), { readOnly: true });
      try {
        const rows = db
          .prepare("SELECT harness FROM fires WHERE session = ? AND event = 'prompt'")
          .all(`codex:${session}`) as Array<{ harness: string }>;
        expect(rows.length).toBeGreaterThan(0);
        expect(rows.every((r) => r.harness === 'codex')).toBe(true);
      } finally {
        db.close();
      }
    });
  });

  it('SIGTERM: the daemon exits within 3 s, removes daemon.pid, and logs the exit', async () => {
    process.kill(daemonPid, 'SIGTERM');
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline && (existsSync(daemonPidPath(dataDir)) || isAlive(daemonPid))) {
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(existsSync(daemonPidPath(dataDir))).toBe(false);
    expect(isAlive(daemonPid)).toBe(false);
    alivePids.delete(daemonPid);
    const log = await readFile(daemonLogPath(dataDir), 'utf8');
    expect(log).toMatch(/exit: SIGTERM/);
  }, 5000);

  // 85 to 95 ms on the laptop that wrote this (03-decisions.md measured 75 to
  // 120 for a minimal daemon). Deliberately no upper bound: a CI runner's
  // timing is noise, and a timing assertion that reddens unrelated PRs is a
  // cost the owner has paid before. The number is logged for the PR body.
  it('the built daemon bundle is a non-empty single file that cold-started', () => {
    expect(bundleBytes).toBeGreaterThan(0);
    expect(coldStartMs).toBeGreaterThan(0);
    console.warn(`daemon cold start: ${coldStartMs} ms, bundle ${bundleBytes} bytes`);
  });
});

/**
 * The vitest reporter, as the BUILT bundle rather than as source (E11). It is
 * the one file `installDaemonFiles` copies that is never spawned: a repo's own
 * `vitest.config.ts` imports it into the user's vitest process by the absolute
 * path install gave it. So what has to hold is that the built module loads on
 * its own — importing nothing but `node:fs` — and writes the artifact in the
 * exact shape `hooks/failure/test-identity.ts` reads back.
 */
describe('the built vitest reporter bundle', () => {
  it('writes .vitest-report.json in the shape test-identity.ts reads', async () => {
    const path = vitestReporterPath(dataDir);
    expect(existsSync(path)).toBe(true);
    // No node_modules beside it and no bundler: a bare dynamic import is the
    // same thing vitest does with the path in a repo's own config.
    const mod = (await import(pathToFileURL(path).href)) as {
      default: new (options?: { outputFile?: string }) => {
        onInit(): void;
        onTestRunEnd(modules: unknown[], unhandled: unknown[]): void;
      };
    };
    const outputFile = join(dataDir, 'smoke-report.json');
    const reporter = new mod.default({ outputFile });
    reporter.onInit();
    reporter.onTestRunEnd(
      [
        {
          moduleId: join(dataDir, 'src/lib/http.test.ts'),
          children: {
            allTests: () => [
              { name: 'gives up after three', parent: { type: 'suite', fullName: 'retries' } },
            ],
          },
        },
      ],
      [],
    );

    const report = JSON.parse(await readFile(outputFile, 'utf8')) as {
      startTime: number;
      endTime: number;
      success: boolean;
      failed: { file: string; suite: string; test: string }[];
    };
    expect(report.success).toBe(false);
    expect(report.startTime).toBeGreaterThan(0);
    expect(report.endTime).toBeGreaterThanOrEqual(report.startTime);
    expect(report.failed).toEqual([
      {
        file: join(dataDir, 'src/lib/http.test.ts'),
        suite: 'retries',
        test: 'gives up after three',
      },
    ]);
  });
});
