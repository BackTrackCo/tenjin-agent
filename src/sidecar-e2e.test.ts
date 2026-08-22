import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import type { IncomingMessage, Server } from 'node:http';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stopHookScript, websearchHookScript } from './lib/hook-scripts';
import { PUSH_LEDGER_FILE, pushFailureHookScript, pushPromptHookScript } from './lib/push-scripts';
import { addNote } from './lib/notes';
import { runNotesNone } from './commands/notes';
import { readLedgerTallies, runPushStatus } from './commands/push';
import type { PushLedgerTallies } from './commands/push';
import type { CommandContext } from './context';

/**
 * ONE SESSION, END TO END, THROUGH THE REAL GENERATED SCRIPTS.
 *
 * The unit suites each prove one arm against a stub. This one proves the thing
 * none of them can: that the arms SHARE STATE CORRECTLY across a session — the
 * note written by the command layer is the note the generated hook finds, the
 * ledger every arm appends to is the ledger `push status` tallies, and the
 * capture nag the Stop hook raises is the nag `tenjin notes none` clears.
 * Every one of those is a filename or a field name agreed between TypeScript
 * that ships through the bundler and plain JS that is written to disk as a
 * string, which is exactly the kind of contract that breaks silently.
 *
 * Nothing here touches the network. The marketplace is a local socket, and the
 * first case asserts that socket saw ZERO requests: the team shelf answering
 * for free is the whole economic argument for the sidecar, and it is only true
 * if the query never leaves the machine.
 */

const SESSION = 'e2e-session-1';
const SEARCH_ID = '44444444-4444-4444-8444-444444444444';
const RESOURCE_ID = '55555555-5555-4555-8555-555555555555';
const SECOND_RESOURCE_ID = '66666666-6666-4666-8666-666666666666';

/** The body of the marketplace piece the research arm is expected to surface. */
const PIECE_BODY = 'Pin the zod resolver to 4.1 and the optional-chain parse stops throwing.';

/** A note whose card covers every content word of the failure below. */
const NOTE_QUESTION = 'Does pgvector testcontainer image swap flip collation';
const NOTE_BODY = [
  'The pgvector testcontainer image swap is what flips it: a new image tag ships a',
  'different default collation, so the collation mismatch surfaces as an ordering',
  'difference under vitest, never at startup. Pin the tag, re-create the volume.',
].join('\n');

let dataDir: string;
let scriptDir: string;
let server: Server | null = null;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'tenjin-e2e-data-'));
  scriptDir = await mkdtemp(join(tmpdir(), 'tenjin-e2e-bin-'));
});

afterEach(async () => {
  if (server !== null) await new Promise<void>((res) => server!.close(() => res()));
  server = null;
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
}

/**
 * The marketplace, on loopback. It answers a search about the zod resolver with
 * two ranked items (rank 2 has to exist for rank 1 to be `strong`: the margin
 * gate has nothing to measure against otherwise) and answers everything else
 * with a miss, so the "matches nothing" case really does match nothing. A GET
 * to the candidate's url is the free-body endpoint.
 */
async function serveJson(): Promise<Stub> {
  let hits = 0;
  let base = '';
  const queries: string[] = [];
  const s = createServer((req: IncomingMessage, res) => {
    hits += 1;
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
        const hit = /zod|resolver/i.test(query);
        send({
          schemaVersion: 3,
          searchId: SEARCH_ID,
          items: hit
            ? [
                {
                  resourceId: RESOURCE_ID,
                  url: `${base}/@vraspar/zod-resolver`,
                  // Echoing the query back makes the overlap score 1.0 without
                  // hand-tuning words, the same trick the unit suite uses.
                  title: query.slice(0, 190),
                  price: '0',
                  excerpt: 'the excerpt',
                  creator: { handle: 'vraspar' },
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
      send({ bodyMd: PIECE_BODY });
    });
  });
  server = s;
  await new Promise<void>((res) => s.listen(0, '127.0.0.1', () => res()));
  const addr = s.address();
  const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
  base = `http://127.0.0.1:${port}`;
  return { baseUrl: base, hits: () => hits, queries: () => queries };
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
  deny?: boolean;
  candidate?: { id?: string; resourceId?: string } | null;
}

async function ledger(): Promise<LedgerRow[]> {
  const path = join(dataDir, PUSH_LEDGER_FILE);
  if (!existsSync(path)) return [];
  return (await readFile(path, 'utf8'))
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as LedgerRow);
}

function injected(run: HookRun): string | null {
  if (run.stdout.trim().length === 0) return null;
  const parsed = JSON.parse(run.stdout) as {
    hookSpecificOutput?: { additionalContext?: string };
  };
  return parsed.hookSpecificOutput?.additionalContext ?? null;
}

function denied(run: HookRun): string | null {
  if (run.stdout.trim().length === 0) return null;
  const parsed = JSON.parse(run.stdout) as {
    hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string };
  };
  if (parsed.hookSpecificOutput?.permissionDecision !== 'deny') return null;
  return parsed.hookSpecificOutput.permissionDecisionReason ?? null;
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
  it('answers from the team shelf, from the marketplace, stays quiet, then asks for notes', async () => {
    const stub = await serveJson();
    await writeConfig({ baseUrl: stub.baseUrl, hooks: { push: 'on', capture: 'block' } });

    // The team shelf, written by the command layer the operator actually types.
    const note = await addNote(dataDir, {
      question: NOTE_QUESTION,
      appliesTo: ['pgvector'],
      body: NOTE_BODY,
      author: 'vraspar',
    });

    // ---- (a) a Bash failure the team shelf already answers ------------------
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
    expect(injected(failure)).toContain(NOTE_BODY.split('\n')[0]);
    expect(injected(failure)).toContain(NOTE_BODY);

    const afterFailure = await ledger();
    expect(afterFailure).toHaveLength(1);
    expect(afterFailure[0]).toMatchObject({
      session: SESSION,
      trigger: 'failure',
      event: 'PostToolUseFailure',
      shelf: 'team',
      action: 'injected',
      candidate: { id: note.id },
      deny: false,
    });
    // THE POINT OF THE TEAM SHELF: the question never left the machine.
    expect(stub.hits()).toBe(0);
    expect(stub.queries()).toEqual([]);

    // ---- (b) a WebSearch the marketplace answers for free -------------------
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
    const reason = denied(search);
    expect(reason).toContain(PIECE_BODY);
    expect(stub.hits()).toBeGreaterThan(0);

    const afterSearch = await ledger();
    expect(afterSearch).toHaveLength(2);
    expect(afterSearch[1]).toMatchObject({
      session: SESSION,
      trigger: 'research',
      shelf: 'public',
      action: 'injected',
      candidate: { resourceId: RESOURCE_ID },
      deny: true,
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
    expect(afterPrompt).toHaveLength(3);
    expect(afterPrompt[2]).toMatchObject({
      session: SESSION,
      trigger: 'prompt',
      shelf: 'public',
      action: 'skipped',
    });

    // ---- (d) the capture ask, and the command that clears it ----------------
    const stop = await runScript(stopHookScript(dataDir), stopInput);
    expect(stop.code).toBe(0);
    const blocked = JSON.parse(stop.stdout) as { decision?: string; reason?: string };
    expect(blocked.decision).toBe('block');
    expect(blocked.reason).toContain('tenjin notes none');
    expect(await readFile(join(dataDir, 'push', 'capture-pending'), 'utf8')).toBe(SESSION);

    // `tenjin notes none` with NO session in the environment: it has to learn
    // the session from the `capture-pending` file the Stop hook just wrote.
    await runNotesNone(makeCtx(), { env: {} });
    expect(existsSync(join(dataDir, 'push', `capture-done-${SESSION}`))).toBe(true);
    expect(existsSync(join(dataDir, 'push', 'capture-pending'))).toBe(false);

    const stopAgain = await runScript(stopHookScript(dataDir), stopInput);
    expect(stopAgain.stdout).toBe('');

    // ---- (e) what `tenjin push status` reports about all of it --------------
    const tallies: PushLedgerTallies = await readLedgerTallies(dataDir, Date.now());
    expect(tallies.rows).toBe(3);
    expect(tallies.byShelf).toEqual({ team: 1, public: 2 });
    expect(tallies.byTriggerAction).toMatchObject({
      failure: { injected: 1 },
      research: { injected: 1 },
      prompt: { skipped: 1 },
    });
    expect(tallies.denies).toBe(1);
    // One note and one piece: two distinct findings across two candidate shapes.
    expect(tallies.candidates).toBe(2);
    expect(Object.values(tallies.byReason).reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(1);

    const status = await runPushStatus(makeCtx());
    expect(status.data).toMatchObject({ mode: 'on', captureMode: 'block' });
    const human = status.humanLines?.join('\n') ?? '';
    expect(human).toContain('3 row(s)');
    expect(human).toContain('2 finding(s)');
    expect(human).toContain('shelf: team=1, public=2');
    expect(human).toContain('reasons:');
    // The whole walk runs in well under a second alone. The explicit budget is
    // for the full suite, where five spawned node processes and a loopback
    // socket share a machine with everything else: the global 5s testTimeout is
    // a per-TEST budget, and this test is five hook invocations long.
  }, 20_000);
});
