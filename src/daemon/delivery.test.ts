import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ADAPTERS } from '../adapters/registry';
import { openLoopDb, type LoopDb } from '../hooks/store';
import type { Deps, KernelConfig } from '../hooks/types';
import { CONFIG_DEFAULTS, HOOK_ARMS } from '../lib/config';
import { ARMS } from './arms';
import { createHookServer, type HookServer } from './server';

/**
 * Did the hook path carry a delivery, and did the right arm carry it?
 *
 * One synthetic harness payload per case, posted over the daemon's own
 * loopback route into the real `createHookServer` with the real {@link ARMS},
 * the real adapters and a real `loop.db`, against two stub shelves on
 * 127.0.0.1. No model, no credential, no container, and no socket that leaves
 * this machine: both shelf origins are loopback and `loopbackOnlyFetch` throws
 * on any other host, so an arm that planned a leg nobody expected fails here
 * rather than reaching the internet.
 *
 * It is cheap on purpose, so it can be the thing that fails first when the
 * wiring breaks. `smoke.test.ts` covers the layers underneath it that only a
 * spawned process can show (the tsup bundles, port derivation, the shim, the
 * pid file); this file assumes those and asks the one question they do not:
 * for each event, WHICH arm answered, and did what the shelf said reach the
 * agent's payload.
 *
 * WHAT IT DOES NOT SHOW, and it must not be cited for any of it. It measures
 * no tokens and demonstrates no saving. It does not exercise ranking or
 * retrieval, which live in the server: the stubs here answer whatever the case
 * hands them, so a shelf that returns junk passes exactly as a shelf that
 * returns the right piece. It says nothing about whether a delivered piece was
 * worth delivering. It proves two things and stops there: the wiring carries a
 * delivery, and it refuses to invent one when the shelf has nothing.
 *
 * The second half is the half worth keeping. A delivery layer that injected
 * unconditionally would pass every happy-path assertion in this file, so every
 * arm is also driven against an empty shelf and asserted silent.
 */

const TOKEN = 'delivery-test-token';
const RESOURCE_ID = '44444444-4444-4444-8444-444444444444';
const SEARCH_ID = '33333333-3333-4333-8333-333333333333';
const TITLE = 'The pgvector collation flip';
const BODY = 'swap the image tag back to pgvector/pgvector:pg16 and re-seed';
const AGENT = 'a59db2769b6f0fcd1';
const REPO = '/tmp/tenjin-delivery-project';

/** Every arm off; a case turns on the one it drives, so nothing else can
 *  answer the event under test. */
const ALL_OFF = Object.fromEntries(HOOK_ARMS.map((arm) => [arm, false])) as KernelConfig['hooks'];

/** The row lands in `setImmediate` after the response flushes (`server.ts`),
 *  so every read of `fires` waits for the count the case expects. */
const POLL = { timeout: 2000, interval: 5 } as const;

interface ShelfCall {
  shelf: 'team' | 'public';
  path: string;
  body: Record<string, unknown>;
}

/** Every request either stub was handed, in arrival order. */
let calls: ShelfCall[] = [];
/** What both stubs answer with. A case sets it to `[]` for the empty shelf. */
let items: Array<Record<string, unknown>> = [];

/** One free piece with its body attached, which is what the server puts on
 *  every free row and what makes a delivery the finding rather than a pointer. */
function candidate(): Record<string, unknown> {
  return {
    resourceId: RESOURCE_ID,
    url: 'https://shelf.example/p/collation',
    slug: 'collation',
    title: TITLE,
    artifactType: 'finding',
    price: '0',
    asOf: null,
    validUntil: null,
    matchReasons: ['title'],
    estimatedTokens: 400,
    creator: { handle: 'ali' },
    strong: true,
    body: { text: BODY },
  };
}

function startShelf(shelf: 'team' | 'public'): Promise<{ server: Server; url: string }> {
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c: Buffer) => (raw += c.toString('utf8')));
    req.on('end', () => {
      const path = (req.url ?? '').split('?')[0] ?? '';
      if (req.method !== 'POST' || (path !== '/api/search' && path !== '/api/keys/resolve')) {
        res.writeHead(404).end();
        return;
      }
      calls.push({ shelf, path, body: JSON.parse(raw) as Record<string, unknown> });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          schemaVersion: 3,
          searchId: SEARCH_ID,
          calibration: 'hybrid-v1',
          matched: items.length,
          items,
        }),
      );
    });
  });
  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error(`the ${shelf} stub did not bind a port`));
        return;
      }
      resolve({ server, url: `http://127.0.0.1:${address.port}` });
    });
  });
}

let teamShelf: Server;
let publicShelf: Server;
let teamUrl: string;
let publicUrl: string;

let dataDir: string;
let db: LoopDb;
let hook: HookServer;
let port: number;
let config: KernelConfig;

/**
 * The shipped config with every arm off. The two shelves are DIFFERENT
 * loopback origins because that is what makes this a team shelf: `teamOrigin`
 * refuses an origin that is the public one, and the failure arm plans its keys
 * leg only against a team origin.
 */
function configure(hooks: Partial<KernelConfig['hooks']>): void {
  config = {
    loop: CONFIG_DEFAULTS.loop,
    team: CONFIG_DEFAULTS.team,
    publish: CONFIG_DEFAULTS.publish,
    hooks: { ...ALL_OFF, ...hooks },
    baseUrl: teamUrl,
    publicShelfUrl: publicUrl,
    shelfBypassSecret: '',
  };
}

function hookUrl(): string {
  return `http://127.0.0.1:${port}/hook/claude`;
}

interface Posted {
  status: number;
  /** `additionalContext`: the one field the adapter puts an injection in. */
  context: string | null;
}

/** One synthetic Claude event, over the route a real hook entry posts to. */
async function post(payload: Record<string, unknown>): Promise<Posted> {
  const res = await fetch(hookUrl(), {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ session_id: 's-delivery', cwd: REPO, ...payload }),
  });
  if (res.status !== 200) {
    await res.arrayBuffer();
    return { status: res.status, context: null };
  }
  const body = (await res.json()) as {
    hookSpecificOutput?: { additionalContext?: string };
  };
  return { status: res.status, context: body.hookSpecificOutput?.additionalContext ?? null };
}

type FireRow = { arm: string; event: string; reason: string; delivered: string | null };

function fires(): FireRow[] {
  return db
    .prepare('SELECT arm, event, reason, delivered FROM fires ORDER BY at')
    .all() as FireRow[];
}

async function settled(count: number): Promise<FireRow[]> {
  await expect.poll(() => fires().length, POLL).toBe(count);
  return fires();
}

/** The whole finding reached the agent: the title above the fence, the body
 *  inside it, and the fence itself, which is what a pointer form has none of. */
function expectTheFindingItself(context: string | null): void {
  expect(context).toContain(TITLE);
  expect(context).toContain(BODY);
  expect(context).toMatch(/--- tenjin-body [a-z0-9]+ ---/);
}

/**
 * Loopback, checked rather than promised. The real transport still runs; this
 * refuses any destination that is not this machine and remembers it, because a
 * leg swallows its own errors into a `LegStatus` and the refusal would
 * otherwise read as an ordinary miss. `afterEach` fails the case on it, so a
 * future arm that reached past the stubs is caught here rather than quietly
 * asking the production shelf on every CI run.
 */
const realFetch = globalThis.fetch;
let escapes: string[] = [];
const loopbackOnlyFetch: typeof fetch = (input, init) => {
  const target = typeof input === 'object' && 'url' in input ? input.url : String(input);
  const url = new URL(target);
  if (url.hostname !== '127.0.0.1') {
    escapes.push(url.origin);
    return Promise.reject(new Error(`this test may not leave loopback; asked ${url.origin}`));
  }
  return realFetch(input, init);
};

beforeAll(async () => {
  globalThis.fetch = loopbackOnlyFetch;
  const team = await startShelf('team');
  const pub = await startShelf('public');
  teamShelf = team.server;
  publicShelf = pub.server;
  teamUrl = team.url;
  publicUrl = pub.url;
});

afterAll(async () => {
  globalThis.fetch = realFetch;
  await new Promise<void>((r) => teamShelf.close(() => r()));
  await new Promise<void>((r) => publicShelf.close(() => r()));
});

beforeEach(async () => {
  calls = [];
  escapes = [];
  items = [candidate()];
  dataDir = mkdtempSync(join(tmpdir(), 'tenjin-delivery-'));
  db = openLoopDb(dataDir);
  configure({});
  const now = Date.now();
  hook = createHookServer({
    deps: {
      db,
      config: () => config,
      clock: () => Date.now(),
      log: () => undefined,
      arms: ARMS,
      adapters: ADAPTERS,
    } satisfies Deps,
    token: TOKEN,
    version: 'test',
    dataDir,
    startedAt: now,
    onRequest: () => undefined,
    lastRequestAt: () => now,
    port: () => port,
    refreshConfig: () => Promise.resolve(),
  });
  await new Promise<void>((resolve, reject) => {
    hook.server.on('error', reject);
    hook.server.listen(0, '127.0.0.1', () => {
      const address = hook.server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('the daemon did not bind a port'));
        return;
      }
      port = address.port;
      resolve();
    });
  });
});

afterEach(async () => {
  // Nothing this file starts outlives it, on any path out: `drain` waits for
  // the deferred ledger write so the close below cannot land under it.
  await hook.drain();
  await new Promise<void>((resolve) => hook.server.close(() => resolve()));
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
  expect(escapes).toEqual([]);
});

describe('a shelf with the answer', () => {
  it('a prompt: the prompt arm delivers, and the finding is in the payload', async () => {
    configure({ prompt: true });
    const res = await post({
      hook_event_name: 'UserPromptSubmit',
      prompt_id: 'p-1',
      prompt: 'the pgvector testcontainer flipped its collation after the image bump',
    });

    expect(res.status).toBe(200);
    expectTheFindingItself(res.context);
    // Not "some arm delivered": this one, on this event, with this piece.
    expect(await settled(1)).toEqual([
      { arm: 'prompt', event: 'prompt', reason: 'hit', delivered: `inject:${RESOURCE_ID}` },
    ]);
    expect(calls.map((c) => `${c.shelf} ${c.path}`).sort()).toEqual([
      'public /api/search',
      'team /api/search',
    ]);
    for (const call of calls) expect(call.body.trigger).toBe('prompt');
  });

  it('a WebSearch: the research arm delivers under its own trigger', async () => {
    configure({ 'web-search': true });
    const res = await post({
      hook_event_name: 'PreToolUse',
      tool_name: 'WebSearch',
      tool_input: { query: 'pgvector ivfflat collation after image bump' },
    });

    expect(res.status).toBe(200);
    expectTheFindingItself(res.context);
    expect(await settled(1)).toEqual([
      { arm: 'research', event: 'tool.before', reason: 'hit', delivered: `inject:${RESOURCE_ID}` },
    ]);
    for (const call of calls) expect(call.body.trigger).toBe('research');
  });

  it('a failed command: the failure arm delivers off the team keys route', async () => {
    configure({ failure: true });
    const res = await post({
      hook_event_name: 'PostToolUseFailure',
      tool_name: 'Bash',
      tool_input: { command: 'pnpm db:migrate' },
      error:
        "Error: ENOENT: no such file or directory, open 'drizzle.config.ts'\n    at run (src/migrate.ts:12:3)\n",
    });

    expect(res.status).toBe(200);
    expectTheFindingItself(res.context);
    expect(await settled(1)).toEqual([
      { arm: 'failure', event: 'tool.after', reason: 'hit', delivered: `inject:${RESOURCE_ID}` },
    ]);
    // Fingerprints, to the team shelf only: there is no public keys resolve.
    expect(calls.map((c) => `${c.shelf} ${c.path}`)).toEqual(['team /api/keys/resolve']);
    const keys = calls[0]?.body.keys as Array<{ kind: string; key: string }>;
    expect(keys.map((k) => k.kind)).toEqual(['fingerprint']);
  });

  it('a dispatch: the parent is told nothing and the child is handed the finding', async () => {
    configure({ subagent: true });
    const parent = await post({
      hook_event_name: 'PreToolUse',
      prompt_id: 'p-2',
      tool_name: 'Agent',
      tool_input: {
        description: 'collation probe',
        prompt: 'find why the pgvector testcontainer flipped its collation',
        subagent_type: 'Explore',
      },
    });
    // The dispatch arm's delivery is `log`: it parks the answer for the child
    // and says nothing to the parent, so 204 here IS the correct delivery.
    expect(parent.status).toBe(204);
    expect(await settled(1)).toEqual([
      { arm: 'dispatch', event: 'tool.before', reason: 'hit', delivered: `log:${RESOURCE_ID}` },
    ]);

    const child = await post({
      hook_event_name: 'SubagentStart',
      prompt_id: 'p-2',
      agent_id: AGENT,
      agent_type: 'Explore',
    });
    expect(child.status).toBe(200);
    expectTheFindingItself(child.context);
    expect((await settled(2))[1]).toEqual({
      arm: 'subagent-start',
      event: 'agent.start',
      reason: 'hit',
      delivered: `inject:${RESOURCE_ID}`,
    });
    // The child's piece came off the parked row, not a second lookup.
    expect(calls).toHaveLength(2);
  });
});

/**
 * The other polarity. A delivery layer that injected whatever it was holding,
 * or one that spoke on a miss, passes every case above; it fails every case
 * here. Each asserts the shelf WAS asked, so a silent arm and a silenced miss
 * stay distinguishable.
 */
describe('a shelf with nothing', () => {
  beforeEach(() => {
    items = [];
  });

  it('a prompt: nothing is injected', async () => {
    configure({ prompt: true });
    const res = await post({
      hook_event_name: 'UserPromptSubmit',
      prompt_id: 'p-1',
      prompt: 'the pgvector testcontainer flipped its collation after the image bump',
    });

    expect(res).toEqual({ status: 204, context: null });
    expect(await settled(1)).toEqual([
      { arm: 'prompt', event: 'prompt', reason: 'no-hit', delivered: null },
    ]);
    expect(calls).toHaveLength(2);
  });

  it('a WebSearch: nothing is injected', async () => {
    configure({ 'web-search': true });
    const res = await post({
      hook_event_name: 'PreToolUse',
      tool_name: 'WebSearch',
      tool_input: { query: 'pgvector ivfflat collation after image bump' },
    });

    expect(res).toEqual({ status: 204, context: null });
    expect(await settled(1)).toEqual([
      { arm: 'research', event: 'tool.before', reason: 'no-hit', delivered: null },
    ]);
    expect(calls).toHaveLength(2);
  });

  it('a failed command: nothing is injected', async () => {
    configure({ failure: true });
    const res = await post({
      hook_event_name: 'PostToolUseFailure',
      tool_name: 'Bash',
      tool_input: { command: 'pnpm db:migrate' },
      error:
        "Error: ENOENT: no such file or directory, open 'drizzle.config.ts'\n    at run (src/migrate.ts:12:3)\n",
    });

    expect(res).toEqual({ status: 204, context: null });
    expect(await settled(1)).toEqual([
      { arm: 'failure', event: 'tool.after', reason: 'no-hit', delivered: null },
    ]);
    expect(calls).toHaveLength(1);
  });

  it('a dispatch: the child that claims the miss is injected nothing', async () => {
    configure({ subagent: true });
    await post({
      hook_event_name: 'PreToolUse',
      prompt_id: 'p-2',
      tool_name: 'Agent',
      tool_input: { description: 'collation probe', prompt: 'find why the collation flipped' },
    });
    const child = await post({
      hook_event_name: 'SubagentStart',
      prompt_id: 'p-2',
      agent_id: AGENT,
      agent_type: 'Explore',
    });

    expect(child).toEqual({ status: 204, context: null });
    expect(await settled(2)).toEqual([
      { arm: 'dispatch', event: 'tool.before', reason: 'no-hit', delivered: null },
      { arm: 'subagent-start', event: 'agent.start', reason: 'no-hit', delivered: null },
    ]);
  });
});
