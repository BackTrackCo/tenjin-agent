import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { ADAPTERS } from '../adapters/registry';
import { contextArm } from '../hooks/arms/context';
import { dispatchArm } from '../hooks/arms/dispatch';
import { failureArm } from '../hooks/arms/failure';
import { primerArm } from '../hooks/arms/primer';
import { promptArm } from '../hooks/arms/prompt';
import { fetchArm, researchArm } from '../hooks/arms/research';
import { stopArm } from '../hooks/arms/stop';
import { subagentStartArm } from '../hooks/arms/subagent-start';
import { subagentStopArm } from '../hooks/arms/subagent-stop';
import { openLoopDb } from '../hooks/store';
import type { LoopDb } from '../hooks/store';
import type { Arm, Deps, KernelConfig } from '../hooks/types';
import { CONFIG_DEFAULTS } from '../lib/config';
import type { SearchAuthResult } from '../lib/search-auth';
import { createHookServer, type HookServer } from './server';

/**
 * THE WHOLE HOOK PATH IN PROCESS: real arms, real adapters, a real `loop.db` in
 * a temp dir, real HTTP to a loopback stub shelf. No tsup build, no spawned
 * daemon, no model. `src/daemon/smoke.test.ts` is the other shape and costs a
 * cold start; it is for what only a process shows (bundle keys, port
 * derivation, the shim, the pid file).
 *
 * What this file exists for is the change that cannot be seen anywhere else:
 * ONE HTTP REQUEST PRODUCES TWO `legs` ROWS. The request count is an assertion
 * in every case below, because "one question is one unit" is the property, and
 * it is invisible to any test that only reads the ledger.
 *
 * ONE ENDPOINT, too: every search here goes to `/api/search` and every key
 * round to `/api/keys/resolve`, and what separates a shelf call from the
 * anonymous one is the `shelf` field in the body. So each case asserts the PATH
 * and the field together: a request that carried a team's name to the public
 * shape, or reached a shelf without naming one, would pass either alone.
 */

const ARMS: Arm[] = [
  promptArm,
  researchArm,
  fetchArm,
  dispatchArm,
  failureArm,
  subagentStartArm,
  subagentStopArm,
  stopArm,
  primerArm,
  contextArm,
];

/** The QUALIFIED name, the only form the config and the wire carry. */
const SHELF = 'backtrack/backtrack';
const TOKEN = 'test-token';
const SEARCH_ID = '11111111-1111-4111-8111-111111111111';
const PUBLIC_SEARCH_ID = '55555555-5555-4555-8555-555555555555';
const TEAM_POST = '22222222-2222-4222-8222-222222222222';
const PUBLIC_POST = '33333333-3333-4333-8333-333333333333';

let dataDir: string;
let db: LoopDb;
let hook: HookServer;
let port = 0;
let base: string;
let requests: Array<{ path: string; body: Record<string, unknown>; signed: boolean }>;
let escaped: string[];
let realFetch: typeof fetch;
let config: KernelConfig;
let auth: SearchAuthResult;
/** Every `deps.authRefused` the legs raised this case. */
let refusals: number;

/** What the stub shelf answers, set per case. */
let respond: (path: string) => { status: number; body: unknown };

function kernelConfig(over: Partial<KernelConfig> = {}): KernelConfig {
  return {
    hooks: CONFIG_DEFAULTS.hooks,
    loop: { ...CONFIG_DEFAULTS.loop, human_wait_ms: 5000, tool_wait_ms: 5000 },
    team: CONFIG_DEFAULTS.team,
    baseUrl: base,
    shelf: SHELF,
    publish: CONFIG_DEFAULTS.publish,
    ...over,
  };
}

function candidate(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    resourceId: TEAM_POST,
    url: `${base}/p/one`,
    slug: 'one',
    title: 'The collation flip',
    artifactType: 'finding',
    price: '0',
    asOf: null,
    validUntil: null,
    matchReasons: ['title'],
    estimatedTokens: 400,
    creator: { handle: 'ali' },
    strong: true,
    body: { text: 'Swap the image tag back; the collation flips on an image swap.' },
    shelf: { id: 'sh_1', slug: SHELF },
    ...over,
  };
}

function envelope(items: Array<Record<string, unknown>>, searchId = SEARCH_ID): unknown {
  return {
    schemaVersion: 3,
    searchId,
    calibration: 'hybrid-v1',
    items,
    matched: items.length,
  };
}

const publicCandidate = (over: Record<string, unknown> = {}) =>
  candidate({
    resourceId: PUBLIC_POST,
    title: 'A marketplace piece',
    body: { text: 'The marketplace answer.' },
    shelf: null,
    ...over,
  });

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'tenjin-hook-server-'));
  db = openLoopDb(dataDir);
  requests = [];
  escaped = [];
  refusals = 0;
  auth = { kind: 'signed', headers: { 'Tenjin-Session-Delegation': 'stub' } };
  respond = () => ({ status: 200, body: { shelf: envelope([]), public: null } });

  // A LOOPBACK GUARD THAT RECORDS. `legs/shelf.ts` swallows every throw into a
  // `LegStatus`, so a refusal thrown here comes back as an ordinary `error` leg
  // and the case fails with a confusing assertion instead of the real reason.
  realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.hostname !== '127.0.0.1') {
      escaped.push(url.origin);
      throw new Error(`refused a request off loopback: ${url.origin}`);
    }
    if (url.port !== String(port)) {
      requests.push({
        path: url.pathname,
        body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
        signed: new Headers(init?.headers).has('tenjin-session-delegation'),
      });
      const answer = respond(url.pathname);
      return new Response(JSON.stringify(answer.body), {
        status: answer.status,
        headers: { 'content-type': 'application/json' },
      });
    }
    return realFetch(input, init);
  }) as typeof fetch;

  // The stub shelf is not a second server: the wrapper above answers it, and
  // the base URL just has to be a loopback origin that is not the daemon's.
  base = 'http://127.0.0.1:1';
  config = kernelConfig();

  const deps: Deps = {
    db,
    config: () => config,
    clock: () => Date.now(),
    log: () => undefined,
    arms: ARMS,
    adapters: ADAPTERS,
    auth: () => Promise.resolve(auth),
    authRefused: () => {
      refusals += 1;
    },
  };
  const startedAt = Date.now();
  hook = createHookServer({
    deps,
    token: TOKEN,
    version: 'test',
    dataDir,
    startedAt,
    onRequest: () => undefined,
    lastRequestAt: () => startedAt,
    port: () => port,
    refreshConfig: () => Promise.resolve(),
  });
  await new Promise<void>((resolve) => hook.server.listen(0, '127.0.0.1', resolve));
  port = (hook.server.address() as AddressInfo).port;
});

afterEach(async () => {
  await hook.drain();
  await new Promise<void>((resolve) => hook.server.close(() => resolve()));
  globalThis.fetch = realFetch;
  try {
    db.close();
  } catch {
    // Already closed.
  }
  rmSync(dataDir, { recursive: true, force: true });
  expect(escaped, 'a request left loopback').toEqual([]);
});

async function post(native: Record<string, unknown>): Promise<Response> {
  return realFetch(`http://127.0.0.1:${port}/hook/claude`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(native),
  });
}

/** The ledger write is deferred past the response flush, so poll rather than
 *  read once (`server.ts` commits in a `setImmediate`). */
async function firesTo(n: number): Promise<Array<Record<string, unknown>>> {
  for (let i = 0; i < 200; i += 1) {
    const rows = db.prepare('SELECT * FROM fires ORDER BY rowid').all() as unknown as Array<
      Record<string, unknown>
    >;
    if (rows.length >= n) return rows;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`only ${db.prepare('SELECT COUNT(*) c FROM fires').get()?.c ?? 0} fires`);
}

function legRows(): Array<{ shelf: string; status: string; outcome: string }> {
  return db
    .prepare('SELECT shelf, status, outcome FROM legs ORDER BY stage, shelf')
    .all() as unknown as Array<{ shelf: string; status: string; outcome: string }>;
}

const prompt = (text: string): Record<string, unknown> => ({
  session_id: '6d2f0c8a-9b41-4e7a-8c3d-1f5e2a7b9c04',
  transcript_path: '/tmp/t.jsonl',
  cwd: '/tmp/proj',
  permission_mode: 'default',
  hook_event_name: 'UserPromptSubmit',
  prompt_id: '01J9X4M2K7Q8R3T5V6W7Y8Z9A0',
  prompt: text,
});

describe('the prompt arm over the real hook server', () => {
  it('one call, two sets, one row: the team answer wins and is injected', async () => {
    respond = () => ({
      status: 200,
      body: {
        shelf: envelope([candidate()]),
        public: envelope([publicCandidate()], PUBLIC_SEARCH_ID),
      },
    });
    const res = await post(prompt('why did the collation flip on the image swap'));
    expect(res.status).toBe(200);
    const payload = (await res.json()) as {
      hookSpecificOutput?: { additionalContext?: string };
    };

    // EXACTLY ONE request, to `/api/search` — the one endpoint — signed, with
    // the qualified shelf and `includePublic` in the body and no `scope`.
    expect(requests).toHaveLength(1);
    expect(requests[0]?.path).toBe('/api/search');
    expect(requests[0]?.signed).toBe(true);
    expect(requests[0]?.body.shelf).toBe(SHELF);
    expect(requests[0]?.body.includePublic).toBe(true);
    expect(requests[0]?.body.scope).toBeUndefined();

    const fires = await firesTo(1);
    expect(fires).toHaveLength(1);
    expect(fires[0]).toMatchObject({ arm: 'prompt', reason: 'hit' });
    expect(String(fires[0]?.delivered)).toMatch(/^inject:/);
    // TWO ROWS OUT OF ONE CALL. The team set won through SHELF_RANK; the public
    // set is a row of its own, shadowed.
    expect(legRows()).toEqual([
      { shelf: 'public', status: 'ok', outcome: 'shadowed' },
      { shelf: 'team', status: 'ok', outcome: 'hit' },
    ]);
    expect(payload.hookSpecificOutput?.additionalContext).toContain('collation flips');
  });

  /**
   * THE 401 HAS TO REACH THE THING THAT HOLDS THE CREDENTIAL. A daemon mints
   * one delegation and keeps it, and the origin is baked in at mint time, so
   * after a `baseUrl` change every signed search is answered 401 for the rest
   * of the process's life unless the refusal travels back. `write-auth.test.ts`
   * owns what the daemon then DOES; this owns that the leg raises it at all,
   * which is the half no unit test of either side can see.
   *
   * A 401 is not a 403 or a 404. All three read `refused` in the ledger, because
   * the ledger's question is whether the shelf answered; this one asks whether
   * the credential is worth re-minting, and only the 401 says yes.
   */
  it('a 401 on the signed call raises authRefused and still records the row', async () => {
    respond = () => ({ status: 401, body: { error: { code: 'session_expired' } } });
    await post(prompt('why did the collation flip on the image swap'));

    expect(requests).toHaveLength(1);
    expect(requests[0]?.signed).toBe(true);
    expect(refusals).toBe(1);
    const fires = await firesTo(1);
    // The row is written either way: `authRefused` is a notification, not a
    // retry, so nothing about this fire's outcome changed.
    expect(fires[0]).toMatchObject({ arm: 'prompt', reason: 'no-answer' });
    expect(String(fires[0]?.error)).toContain('answered 401');
    expect(legRows()).toEqual([
      { shelf: 'public', status: 'refused', outcome: 'no-answer' },
      { shelf: 'team', status: 'refused', outcome: 'no-answer' },
    ]);
  });

  it('a 404 on the signed call is membership, not a stale credential', async () => {
    respond = () => ({ status: 404, body: {} });
    await post(prompt('why did the collation flip on the image swap'));

    expect(requests).toHaveLength(1);
    // NOT RAISED. Re-minting cannot make this wallet a member, and a daemon
    // that dropped its delegation here would decrypt the keystore for nothing.
    expect(refusals).toBe(0);
    const fires = await firesTo(1);
    expect(String(fires[0]?.error)).toContain('not-a-member');
  });

  it('publicFallback off: one request whose body says so, and one row', async () => {
    config = kernelConfig({ team: { publicFallback: 'off' } });
    respond = () => ({ status: 200, body: { shelf: envelope([candidate()]), public: null } });
    await post(prompt('why did the collation flip on the image swap'));

    expect(requests).toHaveLength(1);
    expect(requests[0]?.body.includePublic).toBe(false);
    await firesTo(1);
    // THE TOGGLE CHANGED THE BODY, NOT THE PLAN.
    expect(legRows()).toEqual([{ shelf: 'team', status: 'ok', outcome: 'hit' }]);
  });

  it('org policy off: the body asked for public and the server said no anyway', async () => {
    respond = () => ({ status: 200, body: { shelf: envelope([candidate()]), public: null } });
    await post(prompt('why did the collation flip on the image swap'));

    expect(requests).toHaveLength(1);
    expect(requests[0]?.body.includePublic).toBe(true);
    const fires = await firesTo(1);
    // No error, no retry, one row: the CLI does not distinguish this from the
    // case above, which is the contract.
    expect(fires[0]?.error).toBeNull();
    expect(legRows()).toEqual([{ shelf: 'team', status: 'ok', outcome: 'hit' }]);
  });

  it('no wallet: one unsigned call to /api/search, one public row, no error', async () => {
    auth = { kind: 'no-wallet' };
    respond = () => ({ status: 200, body: envelope([publicCandidate()], PUBLIC_SEARCH_ID) });
    await post(prompt('why did the collation flip on the image swap'));

    expect(requests).toHaveLength(1);
    expect(requests[0]?.path).toBe('/api/search');
    expect(requests[0]?.signed).toBe(false);
    // THE ANONYMOUS BODY, byte for byte what it always was: no shelf, so
    // nothing narrows it and nothing about a team rides out.
    expect(requests[0]?.body.shelf).toBeUndefined();
    expect(requests[0]?.body.includePublic).toBeUndefined();
    const fires = await firesTo(1);
    expect(fires[0]).toMatchObject({ reason: 'hit' });
    expect(fires[0]?.error).toBeNull();
    expect(legRows()).toEqual([{ shelf: 'public', status: 'ok', outcome: 'hit' }]);
  });

  /**
   * THE ONE CASE WHERE THE CONFIGURED SHELF IS NOT THE ROUTE. A credential
   * failure never withholds a public answer (00-principles.md, principle 4), and
   * the fallback has to be explicit now: in the old shape a missing signature
   * left a second leg already planned. It is the first thing to test and the
   * first thing a refactor will drop.
   */
  it('unauthenticated with a shelf set: public answer delivered, reason on the row', async () => {
    auth = { kind: 'unauthenticated', detail: 'WALLET_LOCKED' };
    respond = () => ({ status: 200, body: envelope([publicCandidate()], PUBLIC_SEARCH_ID) });
    await post(prompt('why did the collation flip on the image swap'));

    expect(requests).toHaveLength(1);
    // The same endpoint with NO shelf named: naming one unsigned is a 401 and
    // no answer at all, so the fallback drops the field rather than the call.
    expect(requests[0]?.path).toBe('/api/search');
    expect(requests[0]?.signed).toBe(false);
    expect(requests[0]?.body.shelf).toBeUndefined();
    const fires = await firesTo(1);
    expect(fires[0]).toMatchObject({ reason: 'hit' });
    expect(String(fires[0]?.delivered)).toMatch(/^inject:/);
    expect(String(fires[0]?.error)).toContain('unauthenticated');
    expect(String(fires[0]?.error)).toContain('WALLET_LOCKED');
  });

  it('a public hit over a shelf miss is a hit, on the public row', async () => {
    respond = () => ({
      status: 200,
      body: { shelf: envelope([]), public: envelope([publicCandidate()], PUBLIC_SEARCH_ID) },
    });
    const res = await post(prompt('why did the collation flip on the image swap'));
    const payload = (await res.json()) as { hookSpecificOutput?: { additionalContext?: string } };

    const fires = await firesTo(1);
    expect(fires[0]).toMatchObject({ reason: 'hit' });
    expect(legRows()).toEqual([
      { shelf: 'public', status: 'ok', outcome: 'hit' },
      { shelf: 'team', status: 'ok', outcome: 'miss' },
    ]);
    expect(payload.hookSpecificOutput?.additionalContext).toContain('marketplace answer');
  });

  /** An empty shelf is a DEFINITE miss: the legs were `ok` and said nothing. */
  it('two empty lists is no-hit, not no-answer', async () => {
    respond = () => ({
      status: 200,
      body: { shelf: envelope([]), public: envelope([], PUBLIC_SEARCH_ID) },
    });
    await post(prompt('why did the collation flip on the image swap'));
    const fires = await firesTo(1);
    expect(fires[0]).toMatchObject({ reason: 'no-hit' });
    expect(legRows()).toEqual([
      { shelf: 'public', status: 'ok', outcome: 'miss' },
      { shelf: 'team', status: 'ok', outcome: 'miss' },
    ]);
  });
});

describe('the failure arm over the real hook server', () => {
  const failure = (error: string): Record<string, unknown> => ({
    session_id: '6d2f0c8a-9b41-4e7a-8c3d-1f5e2a7b9c04',
    transcript_path: '/tmp/t.jsonl',
    cwd: '/tmp/proj',
    permission_mode: 'default',
    hook_event_name: 'PostToolUseFailure',
    prompt_id: '01J9X4M2K7Q8R3T5V6W7Y8Z9A0',
    tool_name: 'Bash',
    tool_input: { command: 'pnpm db:migrate' },
    tool_use_id: 'toolu_01Mv6Rt2Yk8Pq3Xw5Nz7Lb4H',
    error,
    is_interrupt: false,
  });

  it('keys first, then the words, both naming the shelf and never the marketplace', async () => {
    respond = (path) =>
      path.endsWith('/keys/resolve')
        ? { status: 200, body: envelope([]) }
        : { status: 200, body: { shelf: envelope([]), public: null } };
    await post(
      failure(
        "Error: ENOENT: no such file or directory, open 'drizzle.config.ts'\n    at run (src/migrate.ts:12:3)\n",
      ),
    );

    expect(requests.map((r) => r.path)).toEqual(['/api/keys/resolve', '/api/search']);
    expect(requests.every((r) => r.signed)).toBe(true);
    // BOTH ROUNDS NAME THE SHELF IN THE BODY, which is the only thing that
    // makes either of them a shelf call.
    expect(requests.map((r) => r.body.shelf)).toEqual([SHELF, SHELF]);
    // The failure round is shelf-only by an EXPLICIT false: `team.publicFallback`
    // is on by default, so the shared helper would otherwise send `true`. The
    // keys round has no such field at all: there is no public resolve to ask for.
    expect(requests[0]?.body.includePublic).toBeUndefined();
    expect(requests[1]?.body.includePublic).toBe(false);

    const fires = await firesTo(1);
    expect(fires).toHaveLength(1);
    expect(fires[0]).toMatchObject({ arm: 'failure', reason: 'no-hit' });
    expect(legRows()).toEqual([
      { shelf: 'keys', status: 'ok', outcome: 'miss' },
      { shelf: 'team', status: 'ok', outcome: 'miss' },
    ]);
  });

  it('never reaches the words when a fingerprint answered', async () => {
    respond = () => ({ status: 200, body: envelope([candidate()]) });
    await post(
      failure(
        "Error: ENOENT: no such file or directory, open 'drizzle.config.ts'\n    at run (src/migrate.ts:12:3)\n",
      ),
    );
    expect(requests.map((r) => r.path)).toEqual(['/api/keys/resolve']);
    expect(requests[0]?.body.shelf).toBe(SHELF);
    const fires = await firesTo(1);
    expect(fires[0]).toMatchObject({ reason: 'hit' });
    expect(legRows()).toEqual([{ shelf: 'keys', status: 'ok', outcome: 'hit' }]);
  });

  it('asks nothing at all with no shelf set', async () => {
    config = kernelConfig({ shelf: null });
    await post(
      failure(
        "Error: ENOENT: no such file or directory, open 'drizzle.config.ts'\n    at run (src/migrate.ts:12:3)\n",
      ),
    );
    expect(requests).toHaveLength(0);
    const fires = await firesTo(1);
    expect(fires[0]).toMatchObject({ arm: 'failure', reason: 'no-question' });
  });

  /**
   * THE SHELF-ONLY ROUND HAS NOWHERE TO FALL BACK TO. A credential failure
   * never withholds a PUBLIC answer, which is why the prompt case above still
   * gets one; but this arm asked the shelf ALONE on purpose. The words it would
   * send are masked failure text, and decision 13 keeps that off the
   * marketplace. An expired session must not turn it into a question for
   * tenjin.blog, so the round asks nobody and files the credential failure.
   */
  it('unauthenticated: neither round is sent, so nothing reaches the marketplace', async () => {
    auth = { kind: 'unauthenticated', detail: 'WALLET_LOCKED' };
    await post(
      failure(
        "Error: ENOENT: no such file or directory, open 'drizzle.config.ts'\n    at run (src/migrate.ts:12:3)\n",
      ),
    );

    // ZERO REQUESTS, not one unsigned one. Both rounds are shelf-only: the keys
    // endpoint has no public form at all, and the words round sent
    // `includePublic: false`, which says the marketplace is not part of this
    // question rather than that it is the second choice.
    expect(requests).toHaveLength(0);
    const fires = await firesTo(1);
    expect(fires).toHaveLength(1);
    // Not a hit, and not the `no-hit` that would blame a shelf for an empty
    // answer it was never asked for: the legs failed, so it is `no-answer`.
    expect(fires[0]).toMatchObject({ arm: 'failure', reason: 'no-answer' });
    expect(String(fires[0]?.error)).toMatch(/^unauthenticated: WALLET_LOCKED/);
    expect(legRows()).toEqual([
      { shelf: 'keys', status: 'refused', outcome: 'no-answer' },
      { shelf: 'team', status: 'refused', outcome: 'no-answer' },
    ]);
  });
});
