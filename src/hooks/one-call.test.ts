import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PRODUCTION_ORIGIN } from '../lib/production-origin';
import type { HookInput, HookTool, ToolKind } from '../adapters/types';
import { ARMS } from './arms/registry';
import {
  cleanup,
  fireContext,
  freshDb,
  hookInput,
  kernelConfig,
  toolInput,
} from './arms/test-support';
import { ask } from './ask';
import type { Arm, KernelConfig, LegRow, Plan } from './types';

/**
 * THE CONTRACT: ONE FIRE, ONE SIGNED SEARCH, ONE ORIGIN.
 *
 * Every other suite pins one arm. This one runs the daemon's whole `ARMS`
 * registry, so the property survives an arm being ADDED: the old two-origin
 * shape is gone from the code, and what keeps it gone is a test nobody has to
 * remember to extend. A new arm that races a second call, or reaches a second
 * host, fails here on the day it is written.
 *
 * WHAT IS PINNED, per arm, over one fire:
 * 1. Every request goes to the ONE configured origin. Not "a shelf origin and a
 *    public origin", which is what this branch replaced, and not a `--base-url`
 *    either: a fire reads the config and nothing else.
 * 2. At most ONE request to `/api/search`. The failure arm's key round is the
 *    only other request any arm may make, and it is a different endpoint on the
 *    same origin, planned in an earlier stage, never a second search.
 * 3. `team.publicFallback` reaches the server as `includePublic` in that one
 *    body. `off` no longer drops a leg locally: the request says so, and the
 *    server returns no public list.
 *
 * EVERY RESPONSE HERE IS A MISS, deliberately. A stage that answers ends the
 * plan, so a hit would hide a later stage's requests; a total miss runs every
 * stage an arm planned and is therefore the most requests that arm can ever
 * make.
 */

/** The one origin, as `kernelConfig` sets it. */
const BASE = PRODUCTION_ORIGIN;
const SHELF = 'backtrack/backtrack';
const SEARCH_ID = '11111111-1111-4111-8111-111111111111';
const PUBLIC_SEARCH_ID = '55555555-5555-4555-8555-555555555555';
const TEAM_POST = '22222222-2222-4222-8222-222222222222';
const PUBLIC_POST = '33333333-3333-4333-8333-333333333333';

/**
 * What each arm may put on the wire in one fire, by `arm.id`. Spelled out rather
 * than derived, because the point is that a new arm cannot appear without
 * someone writing its line down: the test below fails if `ARMS` holds an id this
 * table does not.
 *
 * The five lookup-shaped arms make exactly one call. `failure` makes two, to two
 * DIFFERENT endpoints: the key round resolves fingerprints and the text round is
 * the one search. The rest ask nothing at all — `subagent-start` reads an answer
 * the dispatch arm already parked, and the last four only write local marks.
 */
const WIRE: Record<string, string[]> = {
  prompt: ['/api/search'],
  research: ['/api/search'],
  fetch: ['/api/search'],
  dispatch: ['/api/search'],
  failure: ['/api/keys/resolve', '/api/search'],
  'subagent-start': [],
  'subagent-stop': [],
  stop: [],
  primer: [],
  context: [],
};

const ERROR_TEXT =
  "Error: ENOENT: no such file or directory, open 'drizzle.config.ts'\n    at run (src/migrate.ts:12:3)\n";

/**
 * A canonical tool per kind, so an arm's `on` entry is enough to build its
 * input. Keyed by `ToolKind` rather than switched, so a new kind is a compile
 * error here instead of a silently unexercised arm.
 */
const TOOLS: Record<ToolKind, HookTool> = {
  web: toolInput('web', { query: 'why did the collation flip on the image swap' }),
  fetch: toolInput('fetch', { url: 'https://example.com/docs/collation', prompt: 'what changed' }),
  dispatch: toolInput('dispatch', {
    task: 'find why the collation flipped on the image swap',
    description: 'research',
  }),
  shell: toolInput('shell', { command: 'pnpm db:migrate' }),
  edit: toolInput('edit', { paths: ['src/migrate.ts'] }),
  read: toolInput('read', { paths: ['src/migrate.ts'] }),
};

/**
 * The input that makes an arm fire, built from the arm's OWN `on` entry. A
 * hand-written input per arm would be a second registry to keep in step; this
 * way an arm is exercised by the same map `selectArm` routes on.
 */
function inputFor(arm: Arm, cwd: string): HookInput {
  const on = arm.on[0];
  if (on === undefined) throw new Error(`${arm.id} matches no event`);
  const failed = on.event === 'tool.after';
  return hookInput({
    event: on.event,
    cwd,
    prompt: 'why did the collation flip on the image swap',
    agent: 'a1b2c3d4',
    ...(on.kind === undefined
      ? {}
      : {
          tool: {
            ...TOOLS[on.kind],
            // A `tool.after` arm reads a FAILED call: the failure arm plans
            // nothing for a command that succeeded.
            ...(failed ? { ok: false, result: { stderr: ERROR_TEXT } } : {}),
          },
        }),
  });
}

/** A miss on both lists, which is what makes every planned stage run. */
function missBody(path: string): unknown {
  const envelope = (searchId: string): unknown => ({
    schemaVersion: 3,
    searchId,
    calibration: 'hybrid-v1',
    items: [],
    matched: 0,
  });
  return path.endsWith('/keys/resolve')
    ? envelope(SEARCH_ID)
    : { shelf: envelope(SEARCH_ID), public: envelope(PUBLIC_SEARCH_ID) };
}

interface Seen {
  origin: string;
  path: string;
  body: Record<string, unknown>;
}

/**
 * Run one arm's whole fire against a recording `fetch`, and hand back every
 * request it made. `ask` is what runs it, not a hand-walk of the stages: the
 * stage order and the short-circuit are part of how many requests a fire makes,
 * so the thing under test has to be the real one.
 */
async function fire(arm: Arm, config: KernelConfig, cwd: string): Promise<Seen[]> {
  const seen: Seen[] = [];
  vi.stubGlobal('fetch', async (input: unknown, init?: RequestInit) => {
    const url = new URL(String(input));
    const body = (await new Request(String(input), init).json()) as Record<string, unknown>;
    seen.push({ origin: url.origin, path: url.pathname, body });
    return new Response(JSON.stringify(missBody(url.pathname)), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
  try {
    const ctx = fireContext({ db: freshDb(), arm, input: inputFor(arm, cwd), config });
    const planned = await arm.plan?.(ctx);
    if (planned !== null && planned !== undefined && 'stages' in planned) {
      await ask(ctx, planned as Plan);
    }
    return seen;
  } finally {
    vi.unstubAllGlobals();
  }
}

describe('one fire, one signed search, one origin', () => {
  const dirs: string[] = [];
  const cwd = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'tenjin-one-call-'));
    dirs.push(dir);
    return dir;
  };

  afterEach(() => {
    cleanup();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('names every arm the daemon runs, so a new one cannot slip past this file', () => {
    expect(ARMS.map((arm) => arm.id).sort()).toEqual(Object.keys(WIRE).sort());
  });

  it.each(ARMS.map((arm) => [arm.id, arm] as const))(
    'the %s arm reaches one origin and searches at most once',
    async (id, arm) => {
      const seen = await fire(arm, kernelConfig({}, {}, SHELF), cwd());

      // ONE ORIGIN. The set is empty for an arm that asks nothing, and is the
      // configured base for every arm that asks anything.
      expect([...new Set(seen.map((s) => s.origin))]).toEqual(seen.length === 0 ? [] : [BASE]);
      expect(seen.map((s) => s.path)).toEqual(WIRE[id]);
      // ONE SEARCH. Said separately from the path list above because THIS is the
      // property: the paths could grow a second endpoint one day, a second
      // search is what may never come back.
      expect(seen.filter((s) => s.path === '/api/search')).toHaveLength(
        WIRE[id]?.includes('/api/search') === true ? 1 : 0,
      );
    },
  );

  it.each(ARMS.filter((arm) => WIRE[arm.id]?.includes('/api/search') === true))(
    'the $id arm carries the shelf and the public-fallback setting in that one body',
    async (arm) => {
      const on = await fire(arm, kernelConfig({}, { publicFallback: 'on' }, SHELF), cwd());
      const asked = on.find((s) => s.path === '/api/search');
      expect(asked?.body.shelf).toBe(SHELF);
      // The failure arm is shelf-only by decision, so it sends false with the
      // setting ON; every other arm mirrors the setting. Either way the field is
      // THERE: the server is what decides, and it cannot decide on a field it
      // was not sent.
      expect(typeof asked?.body.includePublic).toBe('boolean');

      const off = await fire(arm, kernelConfig({}, { publicFallback: 'off' }, SHELF), cwd());
      const refused = off.find((s) => s.path === '/api/search');
      // `off` IS A REQUEST FIELD, NOT A DROPPED LEG. The call still goes, and it
      // says the marketplace is not part of this question.
      expect(refused?.body.includePublic).toBe(false);
      expect(off.filter((s) => s.path === '/api/search')).toHaveLength(1);
    },
  );

  it('sends no shelf and no includePublic when no shelf is configured', async () => {
    const seen = await fire(
      ARMS.find((a) => a.id === 'prompt')!,
      kernelConfig({}, {}, null),
      cwd(),
    );
    expect(seen.map((s) => s.path)).toEqual(['/api/search']);
    // The anonymous body, byte for byte what it was before shelves existed.
    expect(seen[0]?.body.shelf).toBeUndefined();
    expect(seen[0]?.body.includePublic).toBeUndefined();
  });
});

/**
 * THE LEDGER READS THE RESPONSE, NOT A RACE.
 *
 * Two legs at two origins used to reach the ledger as two rows whose relative
 * timing was the client's own. One call answers both sets at once, so which set
 * answered is now a fact IN the response, and these three cases are the three
 * things a response can say about the marketplace: it answered, it answered
 * nothing, or the server withheld the run.
 */
describe('one response, the rows it produced', () => {
  const promptArm = ARMS.find((arm) => arm.id === 'prompt')!;
  const dirs: string[] = [];

  afterEach(() => {
    cleanup();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
    vi.unstubAllGlobals();
  });

  function candidate(resourceId: string, strong: boolean): Record<string, unknown> {
    return {
      resourceId,
      url: `${BASE}/p/${resourceId}`,
      slug: resourceId,
      title: 'The collation flip',
      artifactType: 'finding',
      price: '0',
      asOf: null,
      validUntil: null,
      matchReasons: ['title'],
      estimatedTokens: 400,
      creator: { handle: 'ali' },
      strong,
    };
  }

  function envelope(items: Array<Record<string, unknown>>, searchId: string): unknown {
    return { schemaVersion: 3, searchId, calibration: 'hybrid-v1', items, matched: items.length };
  }

  /** One fire against one two-list response; hands back the `legs` rows. */
  async function rows(body: unknown): Promise<Array<Pick<LegRow, 'shelf' | 'status' | 'outcome'>>> {
    const dir = mkdtempSync(join(tmpdir(), 'tenjin-one-call-'));
    dirs.push(dir);
    vi.stubGlobal(
      'fetch',
      async () =>
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    const ctx = fireContext({
      db: freshDb(),
      arm: promptArm,
      input: inputFor(promptArm, dir),
      config: kernelConfig({}, {}, SHELF),
    });
    const planned = (await promptArm.plan?.(ctx)) as Plan;
    const result = await ask(ctx, planned);
    return result.legs
      .map((row) => ({ shelf: row.shelf, status: row.status, outcome: row.outcome }))
      .sort((a, b) => a.shelf.localeCompare(b.shelf));
  }

  it('the team set answered: the public row says it was outranked, not that it lost a race', async () => {
    expect(
      await rows({
        shelf: envelope([candidate(TEAM_POST, true)], SEARCH_ID),
        public: envelope([candidate(PUBLIC_POST, true)], PUBLIC_SEARCH_ID),
      }),
    ).toEqual([
      { shelf: 'public', status: 'ok', outcome: 'shadowed' },
      { shelf: 'team', status: 'ok', outcome: 'hit' },
    ]);
  });

  it('the team set missed: the public set answers, out of the same call', async () => {
    expect(
      await rows({
        shelf: envelope([], SEARCH_ID),
        public: envelope([candidate(PUBLIC_POST, true)], PUBLIC_SEARCH_ID),
      }),
    ).toEqual([
      { shelf: 'public', status: 'ok', outcome: 'hit' },
      { shelf: 'team', status: 'ok', outcome: 'miss' },
    ]);
  });

  it('the server withheld the public run: a row that says so, not a missing row', async () => {
    expect(
      await rows({ shelf: envelope([candidate(TEAM_POST, true)], SEARCH_ID), public: null }),
    ).toEqual([
      { shelf: 'public', status: 'withheld', outcome: 'no-answer' },
      { shelf: 'team', status: 'ok', outcome: 'hit' },
    ]);
  });
});
