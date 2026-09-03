import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { build, type Options } from 'tsup';
import tsupConfigs from '../../tsup.config';
import pkg from '../../package.json';
import { installDaemonFiles } from '../commands/daemon';
import { SPAWN_MS } from '../hooks/constants';
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
});

afterAll(async () => {
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

  it('writes one fires row per valid event (reason no-question, arm none) except a phantom SubagentStop', async () => {
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
      for (const r of rows) {
        expect(r.reason).toBe('no-question');
        expect(r.arm).toBe('none');
      }
      // No arm is registered in PR B, so nothing ever writes the `started`
      // mark SubagentStop requires (actor.ts). There is no "prior
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
  // 120 for a minimal daemon). The production shim polls for SPAWN_MS; a CI
  // runner is slower and noisier, so the bound here is three times that: a
  // regression that triples the cold start is what this should catch.
  it('the built daemon bundle is a non-empty single file and cold-starts inside 3 x SPAWN_MS', () => {
    expect(bundleBytes).toBeGreaterThan(0);
    expect(coldStartMs).toBeGreaterThan(0);
    expect(coldStartMs).toBeLessThan(3 * SPAWN_MS);
  });
});
