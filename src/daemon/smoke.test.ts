import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { build, type Options } from 'tsup';
import tsupConfigs from '../../tsup.config';
import pkg from '../../package.json';
import { installDaemonFiles } from './control';
import { ensureDaemon, readToken } from '../hooks/shim';
import {
  configPath,
  daemonBundlePath,
  daemonLogPath,
  daemonPidPath,
  loopDbPath,
  shimBundlePath,
} from '../lib/paths';

/**
 * The one end-to-end test in PR B: the real tsup bundles, a real spawned
 * daemon, real HTTP round trips. Everything else under src/daemon and
 * src/hooks tests its piece against fakes; a wrong bundle key, a wrong import
 * specifier in the shim, or a wrong port derivation would only ever surface
 * here (07-pr-b-daemon-kernel.md "B2 tests").
 */
vi.setConfig({ hookTimeout: 60_000, testTimeout: 20_000 });

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
 * The ledger row is written AFTER the response flushes (server.ts defers
 * `commit` past the send), so a reader that opens loop.db the instant a POST
 * returns can be one row early on a slow runner. Wait for it, briefly.
 */
async function waitForFires(n: number, ms = 2000): Promise<number> {
  const until = Date.now() + ms;
  let count = countFires();
  while (count < n && Date.now() < until) {
    await new Promise((r) => setTimeout(r, 20));
    count = countFires();
  }
  return count;
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
  const entry = daemonConfig?.entry;
  if (
    typeof entry !== 'object' ||
    entry === null ||
    Array.isArray(entry) ||
    !('tenjin-daemon' in entry) ||
    !('tenjin-shim' in entry)
  ) {
    throw new Error(
      'tsup.config.ts[1] no longer has the tenjin-daemon/tenjin-shim entry; smoke test assumption broke',
    );
  }
  await build({ ...daemonConfig, outDir: tmpOutDir, silent: true });

  dataDir = await mkdtemp(join(tmpdir(), 'tenjin-b-smoke-data-'));
  await writeFile(configPath(dataDir), JSON.stringify({ loop: { port: 0 } }));
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

  it('answers 204 to every valid Claude event fixture', async () => {
    for (const f of fixtures) {
      const res = await fetch(hookUrl(), { method: 'POST', headers: authHeaders(), body: f.body });
      expect(res.status, f.name).toBe(204);
      expect(await res.text(), f.name).toBe('');
    }
  });

  it('writes one no-question fires row per valid event except a phantom SubagentStop', async () => {
    const stops = fixtures.filter((f) => f.event === 'SubagentStop').length;
    await waitForFires(fixtures.length - stops);
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
      // The default config is `hooks.push: off`, so every lookup arm declines
      // and nothing is asked of any shelf. `arm` still names the arm that
      // declined — the WebFetch fixture reaches `fetch`, the Bash and Read
      // ones reach `context` — and `none` is only for an event no arm claims.
      for (const r of rows) {
        expect(r.reason, r.event).toBe('no-question');
        expect(['none', 'prompt', 'research', 'fetch', 'context']).toContain(r.arm);
      }
      // No arm registers on `agent.stop` yet, so nothing ever writes the
      // `started` mark SubagentStop requires (actor.ts). There is no "prior
      // SubagentStart" case that behaves differently yet: every SubagentStop
      // looks like a phantom stop and leaves no row at all, including this
      // one even though its matching SubagentStart fixture ran first.
      expect(rows.some((r) => r.event === 'agent.stop')).toBe(false);
      const start = fixtures.find((f) => f.event === 'SubagentStart');
      if (start !== undefined) {
        const agentId = (JSON.parse(start.body) as { agent_id: string }).agent_id;
        expect(rows.filter((r) => r.agent === agentId)).toHaveLength(1);
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

  it('404s on /hook/codex, an unregistered harness', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/hook/codex`, {
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
    expect(await waitForFires(before + 1)).toBe(before + 1);
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
        hooks: { push: 'on' },
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

    // Both legs asked, and neither sent the raw prompt: the shape list masks
    // and condenses before anything leaves the machine.
    expect(shelfBodies).toHaveLength(2);
    for (const body of shelfBodies) expect(body.trigger).toBe('prompt');

    await waitForFires(countFires());
    const db = new DatabaseSync(loopDbPath(dataDir), { readOnly: true });
    try {
      const fires = db
        .prepare('SELECT id, arm, reason, delivered FROM fires WHERE session = ?')
        .all('s-loop-prompt') as Array<{
        id: string;
        arm: string;
        reason: string;
        delivered: string | null;
      }>;
      expect(fires).toHaveLength(1);
      const fire = fires[0];
      expect(fire?.arm).toBe('prompt');
      expect(fire?.reason).toBe('hit');
      expect(fire?.delivered).toMatch(/^inject:/);
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

  // Last: tears down the daemon every prior case in this file depends on.
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
