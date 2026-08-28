import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import type { IncomingMessage, Server } from 'node:http';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CAPTURE_REASON_TEAM, stopHookScript, websearchHookScript } from './lib/hook-scripts';
import { pushFailureHookScript, pushPromptHookScript } from './lib/push-scripts';
import { STATE_DB_FILE, STORE_SQL, openStore } from './lib/state-store';
import { readLedgerTallies, runPushStatus } from './commands/push';
import type { PushLedgerTallies } from './commands/push';
import type { CommandContext } from './context';

/**
 * ONE SESSION, END TO END, THROUGH THE REAL GENERATED SCRIPTS.
 *
 * The unit suites each prove one arm against a stub. This one proves the thing
 * none of them can: that the arms SHARE STATE CORRECTLY across a session — the
 * shelf order every arm applies is the order the ledger records, the ledger
 * every arm appends to is the ledger `push status` tallies, and the ask the
 * Stop hook raises fires once and then lets the session end. Every one of those
 * is a filename or a field name agreed between TypeScript that ships through
 * the bundler and plain JS that is written to disk as a string, which is exactly
 * the kind of contract that breaks silently.
 *
 * Nothing here touches the real network. BOTH shelves are local sockets, and the
 * first case asserts the public one saw ZERO requests: team-first is the whole
 * order, and it is only real if a team hit costs the public shelf nothing.
 */

const SESSION = 'e2e-session-1';
const SEARCH_ID = '44444444-4444-4444-8444-444444444444';
const RESOURCE_ID = '55555555-5555-4555-8555-555555555555';
const SECOND_RESOURCE_ID = '66666666-6666-4666-8666-666666666666';
const TEAM_RESOURCE_ID = '77777777-7777-4777-8777-777777777777';

/** The Vercel protection-bypass secret the team shelf's deployment is behind. */
const BYPASS_HEADER = 'x-vercel-protection-bypass';
const SECRET = 'e2e-shelf-secret';

/** The body of the marketplace piece the research arm is expected to surface. */
const PIECE_BODY = 'Pin the zod resolver to 4.1 and the optional-chain parse stops throwing.';

/** The team shelf's own piece, on the failure below. */
const TEAM_BODY = [
  'The pgvector testcontainer image swap is what flips it: a new image tag ships a',
  'different default collation, so the collation mismatch surfaces as an ordering',
  'difference under vitest, never at startup. Pin the tag, re-create the volume.',
].join('\n');

let dataDir: string;
let scriptDir: string;
let servers: Server[] = [];

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'tenjin-e2e-data-'));
  scriptDir = await mkdtemp(join(tmpdir(), 'tenjin-e2e-bin-'));
});

afterEach(async () => {
  for (const s of servers) await new Promise<void>((res) => s.close(() => res()));
  servers = [];
  await rm(dataDir, { recursive: true, force: true });
  await rm(scriptDir, { recursive: true, force: true });
});

interface HookRun {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Run a generated script as the harness runs it: a real child process, real
 *  bytes on disk, stdin in and stdout out. Same shape as the two unit suites. */
async function runScript(source: string, stdin: string): Promise<HookRun> {
  const path = join(scriptDir, `hook-${Math.random().toString(36).slice(2)}.mjs`);
  await writeFile(path, source, { mode: 0o755 });
  return await new Promise<HookRun>((resolve, reject) => {
    const child = spawn(process.execPath, [path], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { PATH: process.env.PATH ?? '' },
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

interface Stub {
  baseUrl: string;
  /** Every request that reached the socket, search and body fetch alike. */
  hits: () => number;
  queries: () => string[];
  /** Every request's headers, in arrival order. */
  headers: () => Array<Record<string, string>>;
}

/**
 * One shelf, on loopback. It answers a search matching `answers` with two ranked
 * items (rank 2 has to exist for rank 1 to be `strong`: the margin gate has
 * nothing to measure against otherwise) and answers everything else with a miss,
 * so the "matches nothing" case really does match nothing. A GET to the
 * candidate's url is the free-body endpoint.
 */
async function serveShelf(
  answers: RegExp,
  resourceId: string,
  bodyMd: string,
  handle: string,
): Promise<Stub> {
  let hits = 0;
  let base = '';
  const queries: string[] = [];
  const headers: Array<Record<string, string>> = [];
  const s = createServer((req: IncomingMessage, res) => {
    hits += 1;
    headers.push(
      Object.fromEntries(
        Object.entries(req.headers).map(([k, v]) => [
          k,
          Array.isArray(v) ? v.join(',') : (v ?? ''),
        ]),
      ),
    );
    let body = '';
    req.on('data', (c) => (body += String(c)));
    req.on('end', () => {
      const url = req.url ?? '';
      const send = (json: unknown): void => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(json));
      };
      if (url.startsWith('/api/search')) {
        let query: string;
        try {
          query = String((JSON.parse(body) as { query?: unknown }).query ?? '');
        } catch {
          query = '';
        }
        queries.push(query);
        send({
          schemaVersion: 3,
          searchId: SEARCH_ID,
          items: answers.test(query)
            ? [
                {
                  resourceId,
                  url: `${base}/@${handle}/piece`,
                  title: query.slice(0, 190),
                  price: '0',
                  excerpt: 'the excerpt',
                  creator: { handle },
                  // The whole verdict: a shelf that corroborated the hit and did
                  // not call it 'low' is what makes it strong.
                  confidence: 'high',
                  corroborated: true,
                },
                {
                  resourceId: SECOND_RESOURCE_ID,
                  url: `${base}/@someone/unrelated`,
                  title: 'unrelated invoice settlement batching',
                  price: '0',
                  excerpt: 'about something else entirely',
                  creator: { handle: 'someone' },
                },
              ]
            : [],
        });
        return;
      }
      // The free-body GET the candidate url points at.
      send({ bodyMd });
    });
  });
  servers.push(s);
  await new Promise<void>((res) => s.listen(0, '127.0.0.1', () => res()));
  const addr = s.address();
  const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
  base = `http://127.0.0.1:${port}`;
  return { baseUrl: base, hits: () => hits, queries: () => queries, headers: () => headers };
}

async function writeConfig(config: Record<string, unknown>): Promise<void> {
  await writeFile(join(dataDir, 'config.json'), JSON.stringify(config, null, 2));
}

interface LedgerRow {
  [key: string]: unknown;
  session?: string;
  trigger?: string;
  shelf?: string;
  action?: string;
  reason?: string;
  candidate?: { id?: string; resourceId?: string } | null;
}

/**
 * The decision rows a run left behind, projected back into the flat shape the
 * ledger used to write: the store splits them across `events` (the query and
 * the harness event name) and `injections` (the decision), and this file's
 * assertions are about the sidecar's behaviour rather than its columns.
 */
async function ledger(): Promise<LedgerRow[]> {
  if (!existsSync(join(dataDir, STATE_DB_FILE))) return [];
  const store = await openStore(dataDir);
  if (store === null) return [];
  try {
    return store
      .all(
        `SELECT i.*, e.data AS event_data FROM injections i
           LEFT JOIN events e ON e.uid = i.event_uid
         ORDER BY i.id`,
        [],
      )
      .map((r) => {
        const event = typeof r.event_data === 'string' ? JSON.parse(r.event_data) : {};
        return {
          session: r.session === '' ? null : r.session,
          trigger: r.hook,
          event: event.event,
          query: event.query,
          shelf: r.shelf,
          searchId: r.search_id ?? undefined,
          candidate: r.resource_id === null ? null : { resourceId: r.resource_id, title: r.title },
          strength: r.strength,
          action: r.action,
          reason: r.reason ?? undefined,
          form: r.form ?? undefined,
          tokens: r.tokens ?? undefined,
        } as LedgerRow;
      });
  } finally {
    store.close();
  }
}

function injected(run: HookRun): string | null {
  if (run.stdout.trim().length === 0) return null;
  const parsed = JSON.parse(run.stdout) as {
    hookSpecificOutput?: { additionalContext?: string };
  };
  return parsed.hookSpecificOutput?.additionalContext ?? null;
}

function makeCtx(): CommandContext {
  const sink = (): NodeJS.WritableStream =>
    ({ write: () => true }) as unknown as NodeJS.WritableStream;
  return {
    flags: { json: true, timeout: 5000 },
    dataDir,
    io: { stdout: sink(), stderr: sink(), isTTY: false },
  };
}

const stopInput = JSON.stringify({
  session_id: SESSION,
  hook_event_name: 'Stop',
  cwd: '/tmp',
});

describe('the sidecar, end to end over one session', () => {
  it('answers from the team shelf, then the public one, stays quiet, then asks to publish', async () => {
    // Two deployments, two sockets. The team shelf answers the pgvector prompt;
    // the public marketplace answers the zod research question.
    const team = await serveShelf(/pgvector|collation/i, TEAM_RESOURCE_ID, TEAM_BODY, 'backtrack');
    const pub = await serveShelf(/zod|resolver/i, RESOURCE_ID, PIECE_BODY, 'vraspar');
    await writeConfig({
      baseUrl: team.baseUrl,
      publicShelfUrl: pub.baseUrl,
      shelfBypassSecret: SECRET,
      hooks: { push: 'on', capture: 'block' },
    });

    // ---- (a) a prompt the team shelf already answers ------------------------
    // The prompt arm rather than the failure arm: since #212 a failure asks no
    // shelf by text at all (local pairings only, the team shelf by fingerprint
    // in the following PR), so the "team first" order is proved on the arm
    // that still searches. Step (e) below is the failure arm's own contract.
    const teamPrompt = await runScript(
      pushPromptHookScript(dataDir),
      JSON.stringify({
        session_id: SESSION,
        hook_event_name: 'UserPromptSubmit',
        prompt:
          'The pgvector testcontainer collation mismatch shows up on an image swap under vitest and I need to know what flips it',
      }),
    );
    expect(teamPrompt.code).toBe(0);
    expect(injected(teamPrompt)).toContain(TEAM_BODY);
    expect(injected(teamPrompt)).toContain('your team shelf');

    const afterFailure = await ledger();
    expect(afterFailure).toHaveLength(1);
    expect(afterFailure[0]).toMatchObject({
      session: SESSION,
      trigger: 'prompt',
      event: 'UserPromptSubmit',
      shelf: 'team',
      action: 'injected',
      candidate: { resourceId: TEAM_RESOURCE_ID },
    });
    // TEAM FIRST IS THE WHOLE ORDER: a team hit costs the public shelf nothing.
    expect(pub.hits()).toBe(0);
    expect(pub.queries()).toEqual([]);
    // And the door key went to the team shelf, on every request it made.
    expect(team.headers().length).toBeGreaterThan(0);
    for (const h of team.headers()) expect(h[BYPASS_HEADER]).toBe(SECRET);

    // ---- (b) a WebSearch only the public shelf answers ----------------------
    const search = await runScript(
      websearchHookScript(dataDir),
      JSON.stringify({
        session_id: SESSION,
        hook_event_name: 'PreToolUse',
        tool_name: 'WebSearch',
        tool_input: { query: 'zod resolver throws on an optional chain during parse' },
      }),
    );
    expect(search.code).toBe(0);
    // BESIDE THE SEARCH, NEVER INSTEAD OF IT: the finding is context and the
    // WebSearch still runs.
    expect(search.stdout).not.toContain('permissionDecision');
    const shown = injected(search);
    expect(shown).toContain(PIECE_BODY);
    expect(shown).toContain('Third-party text');
    expect(pub.hits()).toBeGreaterThan(0);
    // THE KEY NEVER LEAVES ITS OWN ORIGIN, body fetch included.
    for (const h of pub.headers()) expect(h[BYPASS_HEADER]).toBeUndefined();

    const afterSearch = await ledger();
    // The team leg missed and is on the record; the public leg answered.
    expect(afterSearch).toHaveLength(3);
    expect(afterSearch[1]).toMatchObject({
      session: SESSION,
      trigger: 'research',
      shelf: 'team',
      action: 'skipped',
      reason: 'miss',
    });
    expect(afterSearch[2]).toMatchObject({
      session: SESSION,
      trigger: 'research',
      shelf: 'public',
      action: 'injected',
      candidate: { resourceId: RESOURCE_ID },
    });

    // ---- (c) a prompt nothing on either shelf answers ------------------------
    const prompt = await runScript(
      pushPromptHookScript(dataDir),
      JSON.stringify({
        session_id: SESSION,
        hook_event_name: 'UserPromptSubmit',
        prompt:
          'Refactor the invoice reconciliation service so the nightly settlement job batches its writes into one statement instead of issuing a separate insert for every ledger entry it walks',
      }),
    );
    expect(prompt.code).toBe(0);
    // Silence is the contract: a miss must cost the transcript nothing.
    expect(prompt.stdout).toBe('');

    const afterPrompt = await ledger();
    expect(afterPrompt).toHaveLength(5);
    expect(afterPrompt.slice(3).map((r) => r.shelf)).toEqual(['team', 'public']);
    for (const row of afterPrompt.slice(3)) {
      expect(row).toMatchObject({ session: SESSION, trigger: 'prompt', action: 'skipped' });
    }

    // ---- (f) a Bash failure: silent, local, and never on the wire -----------
    const teamHitsBefore = team.hits();
    const pubHitsBefore = pub.hits();
    const failure = await runScript(
      pushFailureHookScript(dataDir),
      JSON.stringify({
        session_id: SESSION,
        hook_event_name: 'PostToolUseFailure',
        tool_name: 'Bash',
        tool_input: { command: 'pnpm vitest run src/lib/db.test.ts' },
        error: 'Exit code 1\nerror: pgvector testcontainer collation mismatch on image swap',
      }),
    );
    expect(failure.code).toBe(0);
    expect(failure.stdout).toBe('');
    // The error text this shelf would have matched never left the machine, and
    // no decision row says otherwise: the arm wrote its event row and stopped.
    expect(team.hits()).toBe(teamHitsBefore);
    expect(pub.hits()).toBe(pubHitsBefore);
    expect(await ledger()).toHaveLength(5);

    // ---- (d) the capture ask, once, in the team shelf's words ---------------
    const stop = await runScript(stopHookScript(dataDir), stopInput);
    expect(stop.code).toBe(0);
    const blocked = JSON.parse(stop.stdout) as { decision?: string; reason?: string };
    expect(blocked.decision).toBe('block');
    expect(blocked.reason).toBe(CAPTURE_REASON_TEAM.replace('<mode>', 'review'));
    const asked = await openStore(dataDir);
    expect(asked?.get(STORE_SQL.getState, [SESSION, 'capture_asked'])).not.toBeNull();
    asked?.close();

    // Once per session, whether or not anything was published: the second stop
    // is silent, which is what lets the operator end the session.
    const stopAgain = await runScript(stopHookScript(dataDir), stopInput);
    expect(stopAgain.stdout).toBe('');

    // ---- (e) what `tenjin push status` reports about all of it --------------
    const tallies: PushLedgerTallies = await readLedgerTallies(dataDir, Date.now());
    expect(tallies.rows).toBe(5);
    expect(tallies.byShelf).toEqual({ team: 3, public: 2 });
    expect(tallies.byTriggerAction).toMatchObject({
      research: { injected: 1, skipped: 1 },
      prompt: { injected: 1, skipped: 2 },
    });
    // The failure arm wrote no decision row at all: it asked nothing.
    expect(tallies.byTriggerAction).not.toHaveProperty('failure');
    // Two distinct findings across the two shelves.
    expect(tallies.candidates).toBe(2);
    expect(Object.values(tallies.byReason).reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(1);

    const status = await runPushStatus(makeCtx());
    expect(status.data).toMatchObject({ mode: 'on', captureMode: 'block' });
    const human = status.humanLines?.join('\n') ?? '';
    expect(human).toContain('5 row(s)');
    expect(human).toContain('2 finding(s)');
    expect(human).toContain('shelf: team=3, public=2');
    expect(human).toContain('reasons:');
    // The whole walk runs in well under a second alone. The explicit budget is
    // for the full suite, where six spawned node processes and two loopback
    // sockets share a machine with everything else: the global 5s testTimeout is
    // a per-TEST budget, and this test is six hook invocations long.
  }, 20_000);
});
