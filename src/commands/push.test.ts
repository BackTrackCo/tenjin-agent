import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runPushGrade, runPushOff, runPushOn, runPushStatus } from './push';
import { loadRawConfig } from '../lib/config';
import { claudeSettingsPath } from '../lib/harness-permissions';
import { hooksDir, shimBundlePath } from '../lib/paths';
import { openLoopDb, type LoopDb } from '../hooks/store';
import type { TranscriptLookup } from '../lib/grade';
import type { CommandContext } from '../context';

let dir: string;
let home: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tenjin-push-cmd-'));
  home = await mkdtemp(join(tmpdir(), 'tenjin-push-home-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
});

/** No existing status test may reach the network: the default `lookupStats` is a
 *  real GET, so every call below hands in a shelf that is down. The rendering of
 *  a reachable one has its own case. */
const shelfDown = async (): Promise<never> => {
  throw new Error('shelf unreachable');
};

function makeCtx(): CommandContext {
  const sink = () => ({ write: () => true }) as unknown as NodeJS.WritableStream;
  return {
    flags: { json: true, timeout: 5000 },
    dataDir: dir,
    io: { stdout: sink(), stderr: sink(), isTTY: false },
  };
}

/** One `legs` row, as a leg's verdict left it. */
interface SeedLeg {
  stage?: number;
  shelf: string;
  /** `hit` is the winning leg — the only one `status` and `grade` count. */
  outcome?: 'hit' | 'miss' | 'shadowed' | 'no-answer';
  searchId?: string | null;
  title?: string;
  url?: string;
  /** `<outcome>:<by>`, as `push grade` writes it. */
  graded?: string;
  postedAt?: number;
}

/** One `fires` row, as the kernel commits it after a fire. */
interface SeedFire {
  id: string;
  at: number;
  arm: string;
  reason: string;
  session?: string;
  agent?: string;
  /** `inject:<resourceId>` when the agent was shown the piece, `log:<id>` when
   *  the arm only recorded it, null when the fire reached no answer. */
  delivered?: string | null;
  legs?: SeedLeg[];
}

function withDb<T>(fn: (db: LoopDb) => T): T {
  const db = openLoopDb(dir);
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

function seedFires(fires: SeedFire[]): void {
  withDb((db) => {
    for (const fire of fires) {
      db.prepare(
        `INSERT INTO fires (id, at, session, agent, arm, harness, event, prompt_id, cwd, wait,
           deadline_ms, elapsed_ms, reason, question_key, question, delivered, emit, error)
         VALUES (?, ?, ?, ?, ?, 'claude', 'prompt', NULL, '/repo', 'tool', 100, 1, ?, NULL, NULL, ?, NULL, NULL)`,
      ).run(
        fire.id,
        fire.at,
        fire.session ?? 'sess',
        fire.agent ?? '',
        fire.arm,
        fire.reason,
        fire.delivered ?? null,
      );
      for (const leg of fire.legs ?? []) {
        db.prepare(
          `INSERT INTO legs (fire_id, stage, shelf, status, outcome, elapsed_ms, search_id, title,
             url, form, calibration, graded, posted_at)
           VALUES (?, ?, ?, 'ok', ?, 1, ?, ?, ?, NULL, NULL, ?, ?)`,
        ).run(
          fire.id,
          leg.stage ?? 0,
          leg.shelf,
          leg.outcome ?? 'hit',
          leg.searchId ?? null,
          leg.title ?? null,
          leg.url ?? null,
          leg.graded ?? null,
          leg.postedAt ?? null,
        );
      }
    }
  });
}

/** One pairing row, as the failure arm opens it, then closed as asked. */
function seedPairing(
  at: number,
  head: string,
  close?: { status: 'unverified' | 'verified'; scope: string; postId?: string },
): void {
  withDb((db) => {
    const uid = `pair-${at}-${head}-${Math.random().toString(36).slice(2)}`;
    db.prepare(
      `INSERT INTO pairings (uid, at, session, project, machine, kind, key, cmd_head, cmd,
         error_line, error_files, pkg_versions, scope, status, closed_at, post_id)
       VALUES (?, ?, 'sess', 'proj', 'machine', 'sig_v1', ?, ?, ?, 'Error: ENOENT', '["a.ts"]', '{}',
         ?, ?, ?, ?)`,
    ).run(
      uid,
      at,
      `key-${uid}`,
      head,
      `${head} test`,
      close?.scope ?? 'ambiguous',
      close?.status ?? 'open',
      close === undefined ? null : at + 1,
      close?.postId ?? null,
    );
  });
}

describe('runPushOn / runPushOff', () => {
  /**
   * A CONFIG WRITE AND NOTHING ELSE, which is the whole change. There is no
   * wiring step: `tenjin install` registers the eleven entries once, and the
   * daemon re-stats config.json per fire, so this key takes effect on the next
   * prompt with nothing installed and no process restarted.
   */
  it('persists hooks.push and touches nothing else', async () => {
    const on = await runPushOn(makeCtx());
    expect((await loadRawConfig(dir)).hooks?.push).toBe('on');
    expect(on.data).toEqual({ mode: 'on' });
    expect(on.humanLines?.join('\n')).toContain('next prompt');
    // No settings file, no hooks dir: this verb writes neither.
    expect(await readFile(claudeSettingsPath(home), 'utf8').catch(() => null)).toBeNull();
    expect(existsSync(hooksDir(dir))).toBe(false);

    const off = await runPushOff(makeCtx());
    expect((await loadRawConfig(dir)).hooks?.push).toBe('off');
    expect(off.data).toEqual({ mode: 'off' });
    expect(off.humanLines?.join('\n')).toContain('no unwiring step');
    expect(await readFile(claudeSettingsPath(home), 'utf8').catch(() => null)).toBeNull();
  });

  it('does not care what hooks.webSearch says: that key is the arms’ own', async () => {
    await writeFile(join(dir, 'config.json'), JSON.stringify({ hooks: { webSearch: 'off' } }));
    await runPushOn(makeCtx());
    expect((await loadRawConfig(dir)).hooks?.push).toBe('on');
    expect((await loadRawConfig(dir)).hooks?.webSearch).toBe('off');
  });
});

describe('runPushStatus', () => {
  it('reports the on/on defaults, nothing-wired and an empty ledger on a fresh dir', async () => {
    const result = await runPushStatus(makeCtx(), { homeDir: home, lookupStats: shelfDown });
    expect(result.data).toEqual({
      mode: 'on',
      captureMode: 'on',
      daemonInstalled: false,
      hooksRegistered: false,
      ledger: {
        windowDays: 7,
        rows: 0,
        byArmReason: {},
        byShelf: {},
        delivered: 0,
        candidates: 0,
        pairings: { opened: 0, closed: 0, verified: 0, scope: {}, byHead: {}, published: 0 },
        graded: {},
      },
      // Public mode is one shelf, and it is unreachable in this test.
      server: { public: null },
    });
    expect(result.humanLines?.join('\n')).toContain(
      'pairings, last 7d: 0 opened, 0 closed, 0 verified, 0 published',
    );
  });

  /**
   * BOTH HALVES, and either alone reports an armed sidecar that does nothing: a
   * daemon bundle nobody registered entries for, or entries pointing at a hooks
   * dir with no bundle in it. The fix names `tenjin install`, the one verb that
   * writes both.
   */
  it('is only armed when the daemon is installed AND the entries are registered', async () => {
    await writeFile(
      join(dir, 'config.json'),
      JSON.stringify({ hooks: { push: 'on', capture: 'on' } }),
    );
    const bare = await runPushStatus(makeCtx(), { homeDir: home, lookupStats: shelfDown });
    expect(bare.data).toMatchObject({
      mode: 'on',
      captureMode: 'on',
      daemonInstalled: false,
      hooksRegistered: false,
    });
    expect(bare.humanLines?.join('\n')).toContain('nothing is wired yet; run `tenjin install`');

    // Bundle on disk, nothing registered: the half that would read healthy.
    await mkdir(hooksDir(dir), { recursive: true });
    await writeFile(shimBundlePath(dir), '// shim');
    const halfWired = await runPushStatus(makeCtx(), { homeDir: home, lookupStats: shelfDown });
    expect(halfWired.data).toMatchObject({ daemonInstalled: true, hooksRegistered: false });
    expect(halfWired.humanLines?.join('\n')).toContain('nothing is wired yet');

    await mkdir(join(home, '.claude'), { recursive: true });
    await writeFile(
      claudeSettingsPath(home),
      JSON.stringify({
        hooks: { Stop: [{ hooks: [{ type: 'http', url: 'http://127.0.0.1:31999/hook/claude' }] }] },
      }),
    );
    const wired = await runPushStatus(makeCtx(), { homeDir: home, lookupStats: shelfDown });
    expect(wired.data).toMatchObject({ daemonInstalled: true, hooksRegistered: true });
    const lines = wired.humanLines?.join('\n') ?? '';
    expect(lines).toContain('daemon installed: yes');
    expect(lines).toContain('hook entries registered: yes');
    expect(lines).not.toContain('nothing is wired yet');
  });

  /**
   * A week of `fires` and their `legs`: how many fired, what closed them, which
   * shelves were asked, how many actually put a piece in front of the agent and
   * how many distinct pieces that was. The vocabulary is read off the rows, so
   * a reason this build has never heard of still counts.
   */
  it('tallies the last 7 days of fires by arm x reason, legs by shelf, and the delivered rows', async () => {
    const now = Date.parse('2026-08-22T00:00:00Z');
    const recent = now - 60_000;
    const stale = now - 8 * 24 * 60 * 60 * 1000;
    seedFires([
      {
        id: 'f-1',
        at: recent,
        arm: 'failure',
        reason: 'hit',
        delivered: 'inject:res-1',
        legs: [{ shelf: 'keys' }, { stage: 1, shelf: 'public', outcome: 'shadowed' }],
      },
      {
        id: 'f-2',
        at: recent,
        arm: 'failure',
        reason: 'seen',
        delivered: null,
        legs: [{ shelf: 'keys', outcome: 'miss' }],
      },
      // Delivered but only recorded: never shown, so it is not a candidate.
      { id: 'f-3', at: recent, arm: 'context', reason: 'hit', delivered: 'log:res-9' },
      { id: 'f-4', at: recent, arm: 'prompt', reason: 'no-question', delivered: null },
      // Outside the 7-day window: must not be counted at all.
      {
        id: 'f-stale',
        at: stale,
        arm: 'failure',
        reason: 'hit',
        delivered: 'inject:res-stale',
        legs: [{ shelf: 'team' }],
      },
    ]);

    const result = await runPushStatus(makeCtx(), {
      homeDir: home,
      now: () => now,
      lookupStats: shelfDown,
    });
    expect(result.data).toMatchObject({
      ledger: {
        windowDays: 7,
        rows: 4,
        byArmReason: {
          failure: { hit: 1, seen: 1 },
          context: { hit: 1 },
          prompt: { 'no-question': 1 },
        },
        byShelf: { keys: 2, public: 1 },
        delivered: 1,
        candidates: 1,
      },
    });
    const human = result.humanLines?.join('\n') ?? '';
    expect(human).toContain('4 fire(s), 1 delivered, 1 finding(s)');
    expect(human).toContain('failure: hit=1, seen=1');
    expect(human).toContain('shelf: keys=2, public=1');
  });

  /** Two rows about the same piece are one finding, and a local pairing is a
   *  piece like any other: it is delivered under `pairing:<id>`, so it counts. */
  it('counts distinct pieces, not deliveries', async () => {
    const now = Date.parse('2026-08-22T00:00:00Z');
    seedFires([
      { id: 'f-1', at: now - 1000, arm: 'prompt', reason: 'hit', delivered: 'inject:res-a' },
      { id: 'f-2', at: now - 900, arm: 'context', reason: 'hit', delivered: 'inject:res-a' },
      { id: 'f-3', at: now - 800, arm: 'failure', reason: 'hit', delivered: 'inject:res-b' },
      // A local pairing: no marketplace piece behind it, but it was shown, and
      // `pairingAnswer` gives it a resource id of its own.
      { id: 'f-4', at: now - 700, arm: 'failure', reason: 'hit', delivered: 'inject:pairing:9' },
    ]);
    const result = await runPushStatus(makeCtx(), {
      homeDir: home,
      now: () => now,
      lookupStats: shelfDown,
    });
    expect(result.data).toMatchObject({ ledger: { delivered: 4, candidates: 3 } });
  });

  /**
   * The mechanical lane's own line: how many pairings the machine opened, how
   * many a later pass closed and verified, what scope they landed in, which
   * heads opened them, and how many an agent has since published a fix note for
   * (`publish --key` stamps `post_id`).
   */
  it('reports the pairings opened in the window: closed, verified, scope, heads, published', async () => {
    const now = Date.parse('2026-08-22T00:00:00Z');
    const recent = now - 60_000;
    const stale = now - 8 * 24 * 60 * 60 * 1000;
    seedPairing(recent, 'pnpm');
    seedPairing(recent, 'pnpm', { status: 'unverified', scope: 'code' });
    seedPairing(recent, 'pytest', { status: 'verified', scope: 'code', postId: 'post-1' });
    seedPairing(recent, 'tsc', { status: 'unverified', scope: 'user' });
    seedPairing(stale, 'cargo', { status: 'unverified', scope: 'code' });

    const result = await runPushStatus(makeCtx(), { homeDir: home, now: () => now });
    expect(result.data).toMatchObject({
      ledger: {
        pairings: {
          opened: 4,
          closed: 3,
          verified: 1,
          published: 1,
          scope: { code: 2, user: 1 },
          byHead: { pnpm: 2, pytest: 1, tsc: 1 },
        },
      },
    });
    expect(result.humanLines?.join('\n')).toContain(
      'pairings, last 7d: 4 opened, 3 closed, 1 verified, 1 published; scope: code=2, user=1; heads: pnpm=2, pytest=1, tsc=1',
    );
  });

  /** Complete, not a floor: the rows are indexed, so the window is the window. */
  it('counts the whole window on a large ledger', async () => {
    const now = Date.parse('2026-08-22T00:00:00Z');
    seedFires(
      Array.from({ length: 2000 }, (_, i) => ({
        id: `f-${i}`,
        at: now - 60_000 - i,
        arm: 'prompt',
        reason: 'no-answer',
      })),
    );
    const result = await runPushStatus(makeCtx(), {
      homeDir: home,
      now: () => now,
      lookupStats: shelfDown,
    });
    expect((result.data as { ledger: { rows: number } }).ledger.rows).toBe(2000);
  });
});

describe('runPushGrade', () => {
  const SEARCH = '0197aaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const RES = '0197aaaa-bbbb-cccc-dddd-ffffffffffff';
  const URL = 'https://tenjin.blog/p/the-collation-trap';
  const NOW = Date.parse('2026-08-22T00:00:00Z');
  const SHOWN = `Tenjin found "The collation trap". Read it free: tenjin read ${RES}. The fix is \`pnpm db:generate --force\`.`;

  function contextRow(text: string): string {
    return JSON.stringify({
      type: 'attachment',
      attachment: { type: 'hook_additional_context', content: [text] },
    });
  }
  function toolUse(input: unknown): string {
    return JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', name: 'Bash', input }] },
    });
  }

  interface Call {
    url: string;
    init: RequestInit;
  }

  /** A shelf that accepts every outcome, and remembers what it was told. */
  function acceptingShelf(status = 202): { fetchImpl: typeof fetch; calls: Call[] } {
    const calls: Call[] = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(JSON.stringify({ accepted: 1 }), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;
    return { fetchImpl, calls };
  }

  /** Transcripts keyed by session, or by `<session>/<agent>` for a child's own
   *  file; `findTranscript` hands the key back as the path, so no home directory
   *  is involved. A key in `unreadable` is the projects directory this run could
   *  not read — which is not the same answer as a session that simply has no
   *  transcript. `idle` is what says a session is over: `loop.db` keeps no
   *  session table, so the file going quiet is the whole signal. */
  function transcriptDeps(
    byKey: Record<string, string>,
    opts: { unreadable?: string[]; idle?: boolean } = {},
  ) {
    return {
      findTranscript: async (
        _home: string,
        session: string,
        agentId: string | null = null,
      ): Promise<TranscriptLookup> => {
        const key = agentId === null ? session : `${session}/${agentId}`;
        if ((opts.unreadable ?? []).includes(key)) return { kind: 'unreadable', reason: 'EACCES' };
        return key in byKey ? { kind: 'found', path: key } : { kind: 'absent' };
      },
      transcriptText: async (path: string): Promise<string> => byKey[path] ?? '',
      transcriptIdle: async (): Promise<boolean> => opts.idle ?? true,
    };
  }

  function gradedLegs(): Record<string, unknown>[] {
    return withDb(
      (db) =>
        db.prepare('SELECT fire_id, graded, posted_at FROM legs ORDER BY fire_id').all() as Record<
          string,
          unknown
        >[],
    );
  }

  it('marks used by read, rejects a quiet session, and leaves a live one open', async () => {
    seedFires([
      {
        id: 'f-used',
        at: NOW - 1000,
        arm: 'failure',
        reason: 'hit',
        session: 'quiet',
        delivered: `inject:${RES}`,
        legs: [{ shelf: 'public', url: URL, searchId: SEARCH }],
      },
      {
        id: 'f-rejected',
        at: NOW - 1000,
        arm: 'prompt',
        reason: 'hit',
        session: 'quiet',
        delivered: 'inject:res-b',
        legs: [{ shelf: 'public', title: 'res-b' }],
      },
      {
        id: 'f-open',
        at: NOW - 1000,
        arm: 'prompt',
        reason: 'hit',
        session: 'live',
        delivered: 'inject:res-c',
        legs: [{ shelf: 'public', title: 'res-c' }],
      },
      {
        id: 'f-notranscript',
        at: NOW - 10 * 60 * 60 * 1000,
        arm: 'prompt',
        reason: 'hit',
        session: 'gone',
        delivered: 'inject:res-e',
        legs: [{ shelf: 'public' }],
      },
      // Never shown, so there is nothing to have used.
      {
        id: 'f-logonly',
        at: NOW - 1000,
        arm: 'prompt',
        reason: 'hit',
        session: 'quiet',
        delivered: 'log:res-f',
        legs: [{ shelf: 'public' }],
      },
    ]);
    const { fetchImpl } = acceptingShelf();

    const result = await runPushGrade(
      makeCtx(),
      {},
      {
        now: () => NOW,
        fetchImpl,
        ...transcriptDeps(
          {
            quiet: [
              contextRow(SHOWN),
              toolUse({ command: `tenjin read ${RES}` }),
              contextRow('Tenjin found res-b here.'),
              toolUse({ command: 'ls' }),
            ].join('\n'),
            live: [contextRow('Tenjin found res-c here.'), toolUse({ command: 'ls' })].join('\n'),
          },
          { idle: false },
        ),
        // Only the quiet session's file has stopped moving.
        transcriptIdle: async (path: string): Promise<boolean> => path === 'quiet',
      },
    );

    expect(result.data).toMatchObject({
      since: '7d',
      graded: {
        used: 1,
        rejected: 1,
        unobserved: 1,
        open: 1,
        byTier: { read: 1, span: 0, likely: 0 },
      },
    });
    expect(result.humanLines?.join('\n')).toContain(
      'used=1 (read=1 span=0 likely=0) rejected=1 unobserved=1 open=1',
    );
    const byFire = new Map(
      (result.data as { rows: { fire: string; outcome: string; by: string }[] }).rows.map((r) => [
        r.fire,
        r,
      ]),
    );
    expect(byFire.get('f-used')).toMatchObject({ outcome: 'used', by: 'read' });
    expect(byFire.get('f-rejected')).toMatchObject({ outcome: 'rejected', by: 'none' });
    expect(byFire.get('f-open')).toMatchObject({ outcome: 'open' });
    expect(byFire.get('f-notranscript')).toMatchObject({ outcome: 'unobserved' });
    // A log-only fire is not in the population at all.
    expect(byFire.has('f-logonly')).toBe(false);

    // The open leg stays NULL, so the next run can still answer it.
    expect(gradedLegs()).toEqual([
      { fire_id: 'f-logonly', graded: null, posted_at: null },
      { fire_id: 'f-notranscript', graded: 'unobserved:none', posted_at: null },
      { fire_id: 'f-open', graded: null, posted_at: null },
      { fire_id: 'f-rejected', graded: 'rejected:none', posted_at: null },
      { fire_id: 'f-used', graded: 'used:read', posted_at: NOW },
    ]);
  });

  /**
   * A subagent's tool calls appear in NO parent file, so a fire that ran inside
   * a child is answered by that child's own transcript or by nothing. A
   * `subagent-start` fire is a finding RELAYED to the child — the child's
   * opening context — so it has no anchor in either file and is judged from the
   * child's first tool call.
   */
  it('grades a relayed child fire from its first tool call, and the child file never the parent', async () => {
    seedFires([
      {
        id: 'f-relayed',
        at: NOW - 1000,
        arm: 'subagent-start',
        reason: 'hit',
        session: 's1',
        agent: 'a1',
        delivered: `inject:${RES}`,
        legs: [{ shelf: 'team', url: URL }],
      },
      {
        id: 'f-relayed-span',
        at: NOW - 1000,
        arm: 'subagent-start',
        reason: 'hit',
        session: 's1',
        agent: 'a2',
        delivered: 'inject:res-span',
        legs: [{ shelf: 'team', title: 'Run `pnpm db:generate --force` first' }],
      },
      // A prompt fire stamped with an agent id: the PARENT's file holds the very
      // evidence that would have flipped the verdict, and is never consulted.
      {
        id: 'f-child-prompt',
        at: NOW - 1000,
        arm: 'prompt',
        reason: 'hit',
        session: 's1',
        agent: 'a3',
        delivered: `inject:${RES}`,
        legs: [{ shelf: 'public', url: URL }],
      },
      // Relayed with no agent recorded: nothing names a file, and nothing ever will.
      {
        id: 'f-relayed-nochild',
        at: NOW - 1000,
        arm: 'subagent-start',
        reason: 'hit',
        session: 's1',
        delivered: 'inject:res-old',
        legs: [{ shelf: 'team' }],
      },
    ]);

    const result = await runPushGrade(
      makeCtx(),
      { explain: true },
      {
        now: () => NOW,
        ...transcriptDeps({
          // The very first call, with no context row before it: a relayed
          // finding preceded everything the child did.
          's1/a1': toolUse({ command: `tenjin read ${RES}` }),
          's1/a2': toolUse({ command: 'pnpm db:generate --force' }),
          's1/a3': [contextRow(SHOWN), toolUse({ command: 'ls' })].join('\n'),
          s1: [contextRow(SHOWN), toolUse({ command: `tenjin read ${RES}` })].join('\n'),
        }),
      },
    );

    const byFire = new Map(
      (result.data as { rows: { fire: string; outcome: string; by: string }[] }).rows.map((r) => [
        r.fire,
        r,
      ]),
    );
    expect(byFire.get('f-relayed')).toMatchObject({ outcome: 'used', by: 'read' });
    expect(byFire.get('f-relayed-span')).toMatchObject({ outcome: 'used', by: 'span' });
    expect(byFire.get('f-child-prompt')).toMatchObject({ outcome: 'rejected' });
    expect(byFire.get('f-relayed-nochild')).toMatchObject({ outcome: 'unobserved' });
    const text = result.humanLines?.join('\n') ?? '';
    expect(text).toContain('relayed to a subagent whose id was not recorded');
    expect(text).toContain('    agent a1');
    expect(text).toContain('    read s1/a1');
  });

  /**
   * `unobserved` IS A VERDICT, and a verdict is never re-graded. So it may only
   * be written from a fact about the SESSION — the projects directory was read
   * and holds no file for it — never from a fact about this run. One sweep on a
   * machine whose home was not mounted would otherwise close every open row as
   * never-seen with no way back.
   */
  it('leaves a fire ungraded when the transcript could not be looked for at all', async () => {
    seedFires([
      {
        id: 'f-unreadable',
        at: NOW - 10 * 60 * 60 * 1000,
        arm: 'prompt',
        reason: 'hit',
        session: 'blocked',
        delivered: `inject:${RES}`,
        legs: [{ shelf: 'public', url: URL, searchId: SEARCH }],
      },
    ]);
    const { fetchImpl, calls } = acceptingShelf();

    const result = await runPushGrade(
      makeCtx(),
      { explain: true },
      { now: () => NOW, fetchImpl, ...transcriptDeps({}, { unreadable: ['blocked'] }) },
    );

    expect(result.data).toMatchObject({ graded: { unobserved: 0, open: 1 } });
    expect(result.humanLines?.join('\n')).toContain('transcript unreadable (EACCES)');
    expect(calls).toEqual([]);
    expect(gradedLegs()).toEqual([{ fire_id: 'f-unreadable', graded: null, posted_at: null }]);
  });

  /**
   * The harness writes the transcript as the session runs, so a fire minted
   * seconds ago on a session that is still starting has no file YET. Only once
   * a transcript would have appeared — the fire is older than the idle window —
   * is its absence the answer.
   */
  it('waits for a young fire before calling an absent transcript unobserved', async () => {
    seedFires([
      {
        id: 'f-young',
        at: NOW - 60_000,
        arm: 'prompt',
        reason: 'hit',
        session: 'starting',
        delivered: 'inject:res-young',
        legs: [{ shelf: 'public' }],
      },
      {
        id: 'f-old',
        at: NOW - 2 * 60 * 60 * 1000,
        arm: 'prompt',
        reason: 'hit',
        session: 'long-gone',
        delivered: 'inject:res-old',
        legs: [{ shelf: 'public' }],
      },
    ]);

    const result = await runPushGrade(
      makeCtx(),
      { explain: true },
      { now: () => NOW, ...transcriptDeps({}) },
    );

    const byFire = new Map(
      (result.data as { rows: { fire: string; outcome: string }[] }).rows.map((r) => [r.fire, r]),
    );
    expect(byFire.get('f-young')).toMatchObject({ outcome: 'open' });
    expect(byFire.get('f-old')).toMatchObject({ outcome: 'unobserved' });
    expect(result.humanLines?.join('\n')).toContain('no transcript for this session yet');
  });

  it('posts used as used, a copied span as partially_used, and rejected as rejected', async () => {
    seedFires([
      {
        id: 'f-read',
        at: NOW - 1000,
        arm: 'failure',
        reason: 'hit',
        session: 's1',
        delivered: `inject:${RES}`,
        legs: [{ shelf: 'public', url: URL, searchId: SEARCH }],
      },
      {
        id: 'f-span',
        at: NOW - 900,
        arm: 'prompt',
        reason: 'hit',
        session: 's2',
        delivered: 'inject:res-span',
        legs: [
          {
            shelf: 'public',
            title: 'span piece',
            url: 'https://tenjin.blog/p/span-piece',
            searchId: SEARCH,
          },
        ],
      },
      {
        id: 'f-no',
        at: NOW - 800,
        arm: 'prompt',
        reason: 'hit',
        session: 's3',
        delivered: 'inject:res-no',
        legs: [
          {
            shelf: 'public',
            title: 'no piece',
            url: 'https://tenjin.blog/p/no-piece',
            searchId: SEARCH,
          },
        ],
      },
    ]);
    const { fetchImpl, calls } = acceptingShelf();

    const result = await runPushGrade(
      makeCtx(),
      {},
      {
        now: () => NOW,
        fetchImpl,
        ...transcriptDeps({
          s1: [contextRow(SHOWN), toolUse({ command: `tenjin read ${RES}` })].join('\n'),
          s2: [
            contextRow('Tenjin found "span piece": try `pnpm db:generate --force`.'),
            toolUse({ command: 'pnpm db:generate --force' }),
          ].join('\n'),
          s3: [contextRow('Tenjin found "no piece".'), toolUse({ command: 'ls' })].join('\n'),
        }),
      },
    );

    expect(result.data).toMatchObject({ posted: 3, postFailed: 0 });
    const statuses = calls.map(
      (c) => (JSON.parse(String(c.init.body)) as { status: string }).status,
    );
    expect(statuses).toEqual(['used', 'partially_used', 'rejected']);
    // A resourceId only rides along when it is a uuid the server could match.
    const bodies = calls.map((c) => JSON.parse(String(c.init.body)) as { resourceId?: string });
    expect(bodies[0]?.resourceId).toBe(RES);
    expect(bodies[1]?.resourceId).toBeUndefined();
    expect(result.humanLines?.join('\n')).toContain('posted 3 outcome(s)');
    // Every posted leg carries the stamp that keeps it from being sent twice.
    expect(gradedLegs().every((r) => r.posted_at === NOW)).toBe(true);
  });

  /**
   * A search id is minted by ONE shelf and means nothing on another, and the
   * leg's url is the only record of which one served it. The key rides the
   * leg's LABEL: a public-shelf verdict must not carry the team's bypass
   * secret, whatever origin it is bound for — and a team verdict must not hand
   * the key to an origin the shelf's own answer named.
   */
  it('posts to the origin that served it, with the bypass only on a team leg', async () => {
    await writeFile(
      join(dir, 'config.json'),
      JSON.stringify({ baseUrl: 'https://team.example', shelfBypassSecret: 'shh' }),
    );
    seedFires([
      {
        id: 'f-team',
        at: NOW - 1000,
        arm: 'failure',
        reason: 'hit',
        session: 's1',
        delivered: `inject:${RES}`,
        legs: [
          {
            shelf: 'team',
            url: 'https://team.example/p/the-collation-trap',
            searchId: SEARCH,
          },
        ],
      },
      {
        id: 'f-public',
        at: NOW - 900,
        arm: 'failure',
        reason: 'hit',
        session: 's2',
        delivered: `inject:${RES}`,
        // A PUBLIC leg whose url happens to sit on the configured team origin:
        // the label is what decides, so the team's secret stays home.
        legs: [
          { shelf: 'public', url: 'https://team.example/p/the-collation-trap', searchId: SEARCH },
        ],
      },
      // A local pairing has no shelf to tell, and no url to tell it at.
      {
        id: 'f-local',
        at: NOW - 800,
        arm: 'failure',
        reason: 'hit',
        session: 's3',
        delivered: 'inject:',
        legs: [{ shelf: 'local', title: 'local pairing', searchId: SEARCH }],
      },
    ]);
    const { fetchImpl, calls } = acceptingShelf();

    const result = await runPushGrade(
      makeCtx(),
      { explain: true },
      {
        now: () => NOW,
        fetchImpl,
        ...transcriptDeps({
          s1: [contextRow(SHOWN), toolUse({ command: `tenjin read ${RES}` })].join('\n'),
          s2: [contextRow(SHOWN), toolUse({ command: `tenjin read ${RES}` })].join('\n'),
          s3: [contextRow('Tenjin replayed "local pairing".'), toolUse({ command: 'ls' })].join(
            '\n',
          ),
        }),
      },
    );

    expect(calls.map((c) => c.url)).toEqual([
      `https://team.example/api/searches/${SEARCH}/outcomes`,
      `https://team.example/api/searches/${SEARCH}/outcomes`,
    ]);
    const team = calls[0]?.init.headers as Record<string, string>;
    const pub = calls[1]?.init.headers as Record<string, string>;
    expect(Object.keys(team).some((k) => k.includes('bypass'))).toBe(true);
    expect(Object.keys(pub).some((k) => k.includes('bypass'))).toBe(false);
    // The verdict on the local leg stands; only the posted stamp is withheld.
    expect(result.data).toMatchObject({ posted: 2, postSkipped: 1 });
    expect(result.humanLines?.join('\n')).toContain('not posted: f-local');
  });

  /**
   * `posted_at` is the POSTED stamp, so it is both the idempotence and the
   * retry queue: a landed post is never repeated (the server keeps the first
   * verdict per lookup and post, so a second would be dropped rather than
   * corrected), and a failed one is still owed.
   */
  it('never re-posts a landed verdict, and retries a failed one on the next run', async () => {
    seedFires([
      {
        id: 'f-1',
        at: NOW - 1000,
        arm: 'failure',
        reason: 'hit',
        session: 's1',
        delivered: `inject:${RES}`,
        legs: [{ shelf: 'public', url: URL, searchId: SEARCH }],
      },
    ]);
    const transcripts = transcriptDeps({
      s1: [contextRow(SHOWN), toolUse({ command: `tenjin read ${RES}` })].join('\n'),
    });

    const down = acceptingShelf(500);
    const first = await runPushGrade(
      makeCtx(),
      {},
      { now: () => NOW, fetchImpl: down.fetchImpl, ...transcripts },
    );
    expect(first.data).toMatchObject({ posted: 0, postFailed: 1 });
    expect(first.humanLines?.join('\n')).toContain('retried on the next run');

    // The verdict is recorded, so the second run has nothing to grade — and the
    // post it still owes is sent anyway.
    const up = acceptingShelf();
    const second = await runPushGrade(
      makeCtx(),
      {},
      { now: () => NOW, fetchImpl: up.fetchImpl, ...transcripts },
    );
    expect(second.data).toMatchObject({
      graded: { used: 0, rejected: 0, unobserved: 0, open: 0 },
      posted: 1,
    });

    const third = await runPushGrade(
      makeCtx(),
      {},
      { now: () => NOW, fetchImpl: up.fetchImpl, ...transcripts },
    );
    expect(third.data).toMatchObject({ posted: 0, postFailed: 0 });
    expect(up.calls).toHaveLength(1);
  });

  it('--label sets a verdict by hand and posts it', async () => {
    seedFires([
      {
        id: 'f-1',
        at: NOW - 1000,
        arm: 'failure',
        reason: 'hit',
        session: 's1',
        delivered: `inject:${RES}`,
        legs: [{ shelf: 'public', url: URL, searchId: SEARCH }],
      },
      // An arm's decision NOT to show a piece. Nobody saw it, so nobody used it.
      {
        id: 'f-logonly',
        at: NOW - 1000,
        arm: 'failure',
        reason: 'hit',
        session: 's1',
        delivered: `log:${RES}`,
        legs: [{ shelf: 'public', url: URL, searchId: SEARCH }],
      },
    ]);
    const { fetchImpl, calls } = acceptingShelf();

    const result = await runPushGrade(
      makeCtx(),
      { label: ['f-1', 'used'] },
      { now: () => NOW, fetchImpl, ...transcriptDeps({}) },
    );
    expect(result.data).toMatchObject({
      graded: { used: 1, byTier: { read: 0, span: 0, likely: 0, hand: 1 } },
      posted: 1,
    });
    expect(result.humanLines?.join('\n')).toContain('used=1 (read=0 span=0 likely=0 hand=1)');
    expect((JSON.parse(String(calls[0]?.init.body)) as { status: string }).status).toBe('used');

    await expect(
      runPushGrade(makeCtx(), { label: ['f-1', 'regenerated'] }, { now: () => NOW, fetchImpl }),
    ).rejects.toMatchObject({ code: 'USAGE' });
    await expect(
      runPushGrade(makeCtx(), { label: ['f-missing', 'used'] }, { now: () => NOW, fetchImpl }),
    ).rejects.toMatchObject({ code: 'USAGE' });
    // A fire that showed nothing is not labellable: a verdict is a report about
    // a piece the agent was SHOWN, and posting one for a log-only decision would
    // tell the shelf a story about a piece it never served.
    await expect(
      runPushGrade(makeCtx(), { label: ['f-logonly', 'used'] }, { now: () => NOW, fetchImpl }),
    ).rejects.toMatchObject({ code: 'USAGE' });
    await expect(
      runPushGrade(makeCtx(), { label: ['f-1'] }, { now: () => NOW, fetchImpl }),
    ).rejects.toMatchObject({ code: 'USAGE' });
    expect(gradedLegs()).toEqual([
      { fire_id: 'f-1', graded: 'used:hand', posted_at: NOW },
      { fire_id: 'f-logonly', graded: null, posted_at: null },
    ]);
  });

  /**
   * `--since` chooses what this run GRADES, and nothing else. A hand verdict is
   * a report the shelf is owed whenever the fire happened, so the post step
   * takes no window: a `--label` on a month-old fire reaches the shelf on the
   * same run rather than sitting at `posted_at NULL` forever.
   */
  it('posts a --label verdict on a fire older than --since', async () => {
    const old = NOW - 30 * 24 * 60 * 60 * 1000;
    seedFires([
      {
        id: 'f-old',
        at: old,
        arm: 'failure',
        reason: 'hit',
        session: 's1',
        delivered: `inject:${RES}`,
        legs: [{ shelf: 'public', url: URL, searchId: SEARCH }],
      },
    ]);
    const { fetchImpl, calls } = acceptingShelf();

    const result = await runPushGrade(
      makeCtx(),
      { label: ['f-old', 'used'], since: '1d' },
      { now: () => NOW, fetchImpl, ...transcriptDeps({}) },
    );
    expect(result.data).toMatchObject({ posted: 1 });
    expect(calls).toHaveLength(1);
    expect(gradedLegs()).toEqual([{ fire_id: 'f-old', graded: 'used:hand', posted_at: NOW }]);
  });

  it('--explain names the anchor line and the evidence behind each verdict', async () => {
    seedFires([
      {
        id: 'f-1',
        at: NOW - 1000,
        arm: 'failure',
        reason: 'hit',
        session: 's1',
        delivered: `inject:${RES}`,
        legs: [{ shelf: 'public', url: URL, searchId: SEARCH }],
      },
    ]);
    const { fetchImpl } = acceptingShelf();

    const result = await runPushGrade(
      makeCtx(),
      { explain: true },
      {
        now: () => NOW,
        fetchImpl,
        ...transcriptDeps({
          s1: [
            toolUse({ command: 'pnpm test' }),
            contextRow(SHOWN),
            toolUse({ command: `tenjin read ${RES}` }),
          ].join('\n'),
        }),
      },
    );
    const text = result.humanLines?.join('\n') ?? '';
    expect(text).toContain('f-1 failure/public');
    expect(text).toContain('used (read) anchor line 2');
    expect(text).toContain(`tenjin read ${RES}`);
  });

  it('refuses a --since window it cannot read, before touching the ledger', async () => {
    await expect(runPushGrade(makeCtx(), { since: 'a while' })).rejects.toMatchObject({
      code: 'USAGE',
    });
  });

  it('grades one session only when asked, and leaves a fire older than the window alone', async () => {
    seedFires([
      {
        id: 'f-1',
        at: NOW - 1000,
        arm: 'prompt',
        reason: 'hit',
        session: 's1',
        delivered: 'inject:res-a',
        legs: [{ shelf: 'public' }],
      },
      {
        id: 'f-2',
        at: NOW - 1000,
        arm: 'prompt',
        reason: 'hit',
        session: 's2',
        delivered: 'inject:res-b',
        legs: [{ shelf: 'public' }],
      },
      {
        id: 'f-old',
        at: NOW - 8 * 24 * 60 * 60 * 1000,
        arm: 'prompt',
        reason: 'hit',
        session: 's2',
        delivered: 'inject:res-c',
        legs: [{ shelf: 'public' }],
      },
    ]);
    const result = await runPushGrade(
      makeCtx(),
      { session: 's2' },
      { now: () => NOW, ...transcriptDeps({}) },
    );
    expect((result.data as { rows: { fire: string }[] }).rows.map((r) => r.fire)).toEqual(['f-2']);
  });
});

describe('runPushStatus: the graded rollup and the shelf stats', () => {
  const NOW = Date.parse('2026-08-22T00:00:00Z');

  const STATS = {
    windowDays: 7,
    triggers: [
      {
        trigger: 'failure',
        lookups: 12,
        hits: 3,
        candidates: 7,
        used: 1,
        wrong: 2,
        useRate: 1 / 3,
      },
    ],
  };

  it('rolls the verdicts per arm x shelf and renders each shelf under it', async () => {
    seedFires([
      {
        id: 'g-1',
        at: NOW - 1000,
        arm: 'failure',
        reason: 'hit',
        delivered: 'inject:res-a',
        legs: [{ shelf: 'public', graded: 'used:read', postedAt: NOW }],
      },
      {
        id: 'g-2',
        at: NOW - 1000,
        arm: 'failure',
        reason: 'hit',
        delivered: 'inject:res-b',
        legs: [{ shelf: 'public', graded: 'rejected:none' }],
      },
      {
        id: 'g-3',
        at: NOW - 1000,
        arm: 'failure',
        reason: 'hit',
        delivered: 'inject:res-c',
        legs: [{ shelf: 'team' }],
      },
      // Never shown, so it is not a verdict anybody owes.
      {
        id: 'g-4',
        at: NOW - 1000,
        arm: 'prompt',
        reason: 'seen',
        delivered: null,
        legs: [{ shelf: 'public', outcome: 'miss' }],
      },
    ]);

    const result = await runPushStatus(makeCtx(), {
      homeDir: home,
      now: () => NOW,
      lookupStats: async () => STATS,
    });
    expect(result.data).toMatchObject({
      ledger: {
        graded: {
          failure: {
            public: { used: 1, rejected: 1, unobserved: 0, ungraded: 0, posted: 1 },
            team: { used: 0, rejected: 0, unobserved: 0, ungraded: 1, posted: 0 },
          },
        },
      },
      server: { public: STATS },
    });
    const human = result.humanLines?.join('\n') ?? '';
    expect(human).not.toContain('prompt: public used=');
    expect(human).toContain('failure: public used=1 rejected=1 unobserved=0 ungraded=0 posted=1');
    expect(human).toContain('server public (7d):');
    expect(human).toContain('failure: lookups=12 hits=3 candidates=7 used=1 wrong=2 useRate=0.33');
  });

  /** An unreachable shelf and a shelf with no demand are different facts. */
  it('prints server: unavailable and still shows the local counts', async () => {
    seedFires([
      {
        id: 'g-1',
        at: NOW - 1000,
        arm: 'failure',
        reason: 'hit',
        delivered: 'inject:res-a',
        legs: [{ shelf: 'public' }],
      },
    ]);
    const result = await runPushStatus(makeCtx(), {
      homeDir: home,
      now: () => NOW,
      lookupStats: shelfDown,
    });
    expect(result.data).toMatchObject({ server: { public: null } });
    const human = result.humanLines?.join('\n') ?? '';
    expect(human).toContain('server public: unavailable');
    expect(human).toContain('failure: public used=0 rejected=0 unobserved=0 ungraded=1 posted=0');
  });

  /**
   * tenjin-agent#252: `GET /api/lookups/stats` is cached server-side for
   * several minutes, so a `used` count that has not moved since `push grade`
   * ran is routinely the cache, not proof grading never reached the shelf.
   * `Age` is what tells the two apart, surfaced right on the header line.
   */
  it('renders "shelf stats as of ~Ns ago" when the response carried an Age header', async () => {
    const result = await runPushStatus(makeCtx(), {
      homeDir: home,
      now: () => NOW,
      lookupStats: async () => ({ ...STATS, ageSeconds: 137 }),
    });
    expect(result.humanLines?.join('\n')).toContain(
      'server public (7d) — shelf stats as of ~137s ago:',
    );
  });

  /** No `Age` header, no claim about freshness — the header line reads exactly
   *  as it did before this field existed. */
  it('omits the as-of clause with no Age header', async () => {
    const result = await runPushStatus(makeCtx(), {
      homeDir: home,
      now: () => NOW,
      lookupStats: async () => STATS,
    });
    const human = result.humanLines?.join('\n') ?? '';
    expect(human).toContain('server public (7d):');
    expect(human).not.toContain('shelf stats as of');
  });

  /**
   * The trigger name is the shelf's text, and this line is the only place it is
   * drawn. The response schema bounds it and this strips it: a length bound is
   * not an escape-sequence bound, and the two layers fail differently.
   */
  it('strips terminal escapes out of a trigger name before drawing it', async () => {
    const result = await runPushStatus(makeCtx(), {
      homeDir: home,
      now: () => NOW,
      lookupStats: async () => ({
        windowDays: 7,
        triggers: [
          {
            trigger: '\u001b[2K\u001b[1Gfailure',
            lookups: 1,
            hits: 0,
            candidates: 0,
            used: 0,
            wrong: 0,
            useRate: null,
          },
        ],
      }),
    });
    const human = result.humanLines?.join('\n') ?? '';
    expect(human).toContain('  failure: lookups=1');
    expect(human).not.toContain('\u001b');
  });
});
