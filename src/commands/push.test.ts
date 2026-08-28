import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runPushGrade, runPushOff, runPushOn, runPushStatus } from './push';
import { loadRawConfig } from '../lib/config';
import { claudeSettingsPath } from '../lib/harness-permissions';
import { hooksDir } from '../lib/paths';
import { openStore, recordSearch, STORE_SQL } from '../lib/state-store';
import {
  PUSH_CONTEXT_HOOK_FILE,
  PUSH_FAILURE_HOOK_FILE,
  PUSH_PROMPT_HOOK_FILE,
  PUSH_SUBAGENT_HOOK_FILE,
} from '../lib/push-scripts';
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

/** One decision row, as an arm would have written it. */
interface SeedRow {
  at: number;
  trigger: string;
  shelf: string;
  action: string;
  reason?: string;
  resourceId?: string;
  tokens?: number;
  uid?: string;
  session?: string;
  searchId?: string | null;
  title?: string;
  url?: string;
}

/** Write `rows` into the store's `injections` table. */
async function seedRows(dir: string, rows: SeedRow[]): Promise<void> {
  const store = await openStore(dir);
  if (store === null) throw new Error('no store');
  try {
    rows.forEach((row, i) => {
      store.run(STORE_SQL.insertInjection, [
        row.uid ?? `seed-${i}`,
        null,
        row.at,
        row.session ?? 'sess',
        null,
        'machine',
        row.trigger,
        row.shelf,
        row.resourceId ?? null,
        row.title ?? null,
        row.url ?? null,
        null,
        row.searchId === undefined ? 'search-id' : row.searchId,
        null,
        null,
        null,
        null,
        null,
        row.action,
        row.reason ?? null,
        null,
        0,
        row.tokens ?? null,
      ]);
    });
  } finally {
    store.close();
  }
}

/** The `searches` row an arm writes beside its injection, carrying the base URL
 *  it asked — the only record of which shelf minted the search id. */
async function seedSearch(dir: string, searchId: string, shelfBaseUrl: string): Promise<void> {
  await recordSearch(dir, {
    searchId,
    at: new Date().toISOString(),
    question: 'q',
    decision: 'CANDIDATES',
    candidates: [],
    source: 'push-hook',
    shelfBaseUrl,
  });
}

/** A `sessions` row, so `grade` can tell a session that ended from one that is
 *  still running without touching the transcript's mtime. */
async function seedSession(dir: string, session: string, ended: boolean): Promise<void> {
  const store = await openStore(dir);
  if (store === null) throw new Error('no store');
  try {
    store.run(STORE_SQL.touchSession, [session, null, '/repo', 0, 'machine']);
    if (ended) store.run(STORE_SQL.endSession, [session, 0, 1, 'machine']);
  } finally {
    store.close();
  }
}

const PUSH_SCRIPT_FILES = [
  PUSH_PROMPT_HOOK_FILE,
  PUSH_FAILURE_HOOK_FILE,
  PUSH_SUBAGENT_HOOK_FILE,
  PUSH_CONTEXT_HOOK_FILE,
];

describe('runPushOn', () => {
  it('persists hooks.push=on and wires the four push scripts', async () => {
    const result = await runPushOn(makeCtx(), { homeDir: home });

    expect((await loadRawConfig(dir)).hooks?.push).toBe('on');
    expect(result.data).toMatchObject({ mode: 'on' });
    for (const file of PUSH_SCRIPT_FILES) {
      expect(await readFile(join(hooksDir(dir), file), 'utf8').catch(() => null)).not.toBeNull();
    }
    const settings = JSON.parse(await readFile(claudeSettingsPath(home), 'utf8')) as Record<
      string,
      unknown
    >;
    const hooks = settings.hooks as Record<string, unknown>;
    expect(hooks.UserPromptSubmit).toBeDefined();
    expect(hooks.SubagentStart).toBeDefined();
    expect(result.humanLines?.join('\n')).toContain('tenjin push off');
  });

  it('is idempotent: a second run wires nothing new', async () => {
    await runPushOn(makeCtx(), { homeDir: home });
    const first = await readFile(claudeSettingsPath(home), 'utf8');

    const result = await runPushOn(makeCtx(), { homeDir: home });
    expect((result.data as { hooks: { added: string[]; updated: string[] } }).hooks.added).toEqual(
      [],
    );
    expect(await readFile(claudeSettingsPath(home), 'utf8')).toBe(first);
  });

  it('keeps the currently configured hooks.webSearch rather than forcing auto', async () => {
    await writeFile(join(dir, 'config.json'), JSON.stringify({ hooks: { webSearch: 'remind' } }));
    await runPushOn(makeCtx(), { homeDir: home });
    const settings = JSON.parse(await readFile(claudeSettingsPath(home), 'utf8')) as Record<
      string,
      unknown
    >;
    expect((settings.hooks as Record<string, unknown>).UserPromptSubmit).toBeDefined();
    // webSearch itself is read at run time by the generated scripts, not baked
    // into settings.json, so this asserts the CALL succeeded under a non-default
    // mode rather than asserting anything is literally 'remind' in the file.
    expect((await loadRawConfig(dir)).hooks?.webSearch).toBe('remind');
  });

  /**
   * `install` refuses to write a single hook entry when `hooks.webSearch` is
   * `off` — that is what the kill switch means. This command called
   * `wireSearchHooks` directly and so wired six entries straight past it, which
   * made `off` mean two different things depending on which verb you typed.
   */
  it('refuses when hooks.webSearch is off, and leaves the key as it was', async () => {
    await writeFile(join(dir, 'config.json'), JSON.stringify({ hooks: { webSearch: 'off' } }));
    await expect(runPushOn(makeCtx(), { homeDir: home })).rejects.toMatchObject({
      code: 'USAGE',
      exitCode: 2,
      fix: 'tenjin config set hooks.webSearch auto, then tenjin push on',
    });
    // Nothing written: not the mode, not a script, not settings.json.
    expect((await loadRawConfig(dir)).hooks?.push).toBeUndefined();
    expect(
      await readFile(join(hooksDir(dir), PUSH_PROMPT_HOOK_FILE), 'utf8').catch(() => null),
    ).toBeNull();
    expect(await readFile(claudeSettingsPath(home), 'utf8').catch(() => null)).toBeNull();
  });

  /**
   * A recorded `--harness` set without Claude Code is the operator saying their
   * harness is not the one these arms hook. `install` skips there out loud, and
   * so must this — silence would look like it worked.
   */
  it('skips with a reason when the recorded harness is not Claude Code', async () => {
    await writeFile(join(dir, 'config.json'), JSON.stringify({ install: { harness: ['hermes'] } }));
    const result = await runPushOn(makeCtx(), { homeDir: home });

    expect(result.data).toMatchObject({ mode: 'on', skipped: 'harness-not-claude' });
    const text = result.humanLines?.join('\n') ?? '';
    expect(text).toContain('nothing was wired (harness-not-claude)');
    expect(text).toContain('tenjin install --harness claude');
    expect(await readFile(claudeSettingsPath(home), 'utf8').catch(() => null)).toBeNull();
    // The preference is still durable, so a later install on a Claude machine
    // wires the arms with no second command.
    expect((await loadRawConfig(dir)).hooks?.push).toBe('on');
  });

  /** An EMPTY record means no past install passed `--harness`. That is the
   *  common case, and it must not read as "no Claude Code". */
  it('wires as normal when no harness was ever recorded', async () => {
    await writeFile(join(dir, 'config.json'), JSON.stringify({ install: { harness: [] } }));
    const result = await runPushOn(makeCtx(), { homeDir: home });
    expect(result.data).toMatchObject({ mode: 'on' });
    expect((result.data as { skipped?: string }).skipped).toBeUndefined();
  });

  /**
   * Six entries into the operator's home, written by a verb that is not
   * `install`, owe the same disclosure `install` gives — including the sentence
   * `install` only says with push on.
   */
  it("discloses what the arms do, in install's words, above the undo line", async () => {
    const result = await runPushOn(makeCtx(), { homeDir: home });
    const lines = result.humanLines ?? [];
    const text = lines.join('\n');
    expect(text).toContain(
      'The push experiment is on, so 6 more hook entries are wired and the WebSearch entry above is widened to cover WebFetch and becomes one of the arms itself',
    );
    expect(text).toContain(
      'Every arm only adds context beside the call; none can block or change it.',
    );
    expect(text).not.toContain('They can never block or change the tool call.');
    const disclosure = lines.findIndex((l) => l.includes('The push experiment is on'));
    const undo = lines.findIndex((l) => l.startsWith('Undo anytime:'));
    expect(disclosure).toBeGreaterThanOrEqual(0);
    expect(undo).toBeGreaterThan(disclosure);
  });
});

describe('runPushOff', () => {
  it('persists hooks.push=off and touches nothing else', async () => {
    await writeFile(join(dir, 'config.json'), JSON.stringify({ hooks: { push: 'on' } }));
    const result = await runPushOff(makeCtx());
    expect((await loadRawConfig(dir)).hooks?.push).toBe('off');
    expect(result.data).toEqual({ mode: 'off' });
    expect(result.humanLines?.join('\n')).toContain('exit instantly');
  });

  it('leaves already-wired scripts on disk (nothing to unwire)', async () => {
    await runPushOn(makeCtx(), { homeDir: home });
    await runPushOff(makeCtx());
    for (const file of PUSH_SCRIPT_FILES) {
      expect(await readFile(join(hooksDir(dir), file), 'utf8').catch(() => null)).not.toBeNull();
    }
  });
});

describe('runPushStatus', () => {
  it('reports off/off/not-wired/empty-ledger on a fresh dir', async () => {
    const result = await runPushStatus(makeCtx(), { homeDir: home, lookupStats: shelfDown });
    expect(result.data).toEqual({
      mode: 'off',
      captureMode: 'off',
      scriptsWired: false,
      hookEntries: { planned: 6, present: 0, path: null },
      ledger: {
        windowDays: 7,
        rows: 0,
        byTriggerAction: {},
        byShelf: {},
        byReason: {},
        candidates: 0,
        injectedTokens: 0,
        pairings: { opened: 0, closed: 0, verified: 0, scope: {}, byHead: {} },
        graded: {},
      },
      // Public mode is one shelf, and it is unreachable in this test.
      server: { public: null },
    });
    expect(result.humanLines?.join('\n')).toContain(
      'pairings, last 7d: 0 opened, 0 closed, 0 verified',
    );
  });

  it('reflects the persisted modes and whether the scripts are actually on disk', async () => {
    await writeFile(
      join(dir, 'config.json'),
      JSON.stringify({ hooks: { push: 'on', capture: 'block' } }),
    );
    const before = await runPushStatus(makeCtx(), { homeDir: home, lookupStats: shelfDown });
    expect(before.data).toMatchObject({ mode: 'on', captureMode: 'block', scriptsWired: false });
    // The verb that actually wires them. `tenjin install` only does so when
    // hooks.push is already on, so it is not the one-command fix.
    expect(before.humanLines?.join('\n')).toContain('not fully wired yet; run `tenjin push on`');

    await mkdir(hooksDir(dir), { recursive: true });
    for (const file of PUSH_SCRIPT_FILES) {
      await writeFile(join(hooksDir(dir), file), '// stub\n');
    }
    const after = await runPushStatus(makeCtx(), { homeDir: home, lookupStats: shelfDown });
    expect(after.data).toMatchObject({ scriptsWired: true });
  });

  it('scriptsWired is false when even one of the five files is missing', async () => {
    await mkdir(hooksDir(dir), { recursive: true });
    for (const file of PUSH_SCRIPT_FILES.slice(1)) {
      await writeFile(join(hooksDir(dir), file), '// stub\n');
    }
    const result = await runPushStatus(makeCtx(), { homeDir: home, lookupStats: shelfDown });
    expect(result.data).toMatchObject({ scriptsWired: false });
  });

  /**
   * "Wired" used to mean four files on disk and nothing else — its own comment
   * said so, while `push status`'s help promised the arms were actually wired.
   * Files with no settings entries pointing at them never run, so that reported
   * a healthy sidecar for a machine where nothing fires. Both halves, counted
   * by the same ownership predicate the writer uses.
   */
  it('counts the settings.json entries, not just the files on disk', async () => {
    await writeFile(join(dir, 'config.json'), JSON.stringify({ hooks: { push: 'on' } }));
    await mkdir(hooksDir(dir), { recursive: true });
    for (const file of PUSH_SCRIPT_FILES) {
      await writeFile(join(hooksDir(dir), file), '// stub\n');
    }

    // Scripts present, settings.json absent: the half that used to read healthy.
    const halfWired = await runPushStatus(makeCtx(), { homeDir: home, lookupStats: shelfDown });
    expect(halfWired.data).toMatchObject({
      scriptsWired: true,
      hookEntries: { planned: 6, present: 0, path: null },
    });
    const lines = halfWired.humanLines?.join('\n') ?? '';
    expect(lines).toContain('not fully wired yet; run `tenjin push on`');
    expect(lines).toContain('hook entries: 0/6');

    // A real wiring run registers all six.
    await runPushOn(makeCtx(), { homeDir: home });
    const wired = await runPushStatus(makeCtx(), { homeDir: home, lookupStats: shelfDown });
    expect(wired.data).toMatchObject({
      scriptsWired: true,
      hookEntries: { planned: 6, present: 6 },
    });
    expect(wired.humanLines?.join('\n')).toContain('hook entries: 6/6');
    expect(wired.humanLines?.join('\n')).not.toContain('not fully wired yet');

    // Entries removed behind its back — a half-finished uninstall.
    const settingsPath = claudeSettingsPath(home);
    const settings = JSON.parse(await readFile(settingsPath, 'utf8')) as {
      hooks: Record<string, unknown>;
    };
    delete settings.hooks.UserPromptSubmit;
    await writeFile(settingsPath, JSON.stringify(settings));
    const gone = await runPushStatus(makeCtx(), { homeDir: home, lookupStats: shelfDown });
    expect(gone.data).toMatchObject({
      scriptsWired: true,
      hookEntries: { planned: 6, present: 5 },
    });
    expect(gone.humanLines?.join('\n')).toContain('not fully wired yet');
  });

  /** One pairing row, as the failure arm opens it, then closed as asked. */
  async function seedPairing(
    dir: string,
    at: number,
    head: string,
    close?: { sessions: string[]; scope: string },
  ): Promise<void> {
    const store = await openStore(dir);
    if (store === null) throw new Error('no store');
    try {
      const uid = `pair-${at}-${head}-${Math.random().toString(36).slice(2)}`;
      store.run(STORE_SQL.insertPairing, [
        uid,
        at,
        'sess',
        'proj',
        'machine',
        'sig_v1',
        `key-${uid}`,
        null,
        head,
        `${head} test`,
        'Error: ENOENT',
        '["a.ts"]',
        '{}',
        'ambiguous',
      ]);
      if (close === undefined) return;
      const id = (store.get('SELECT id FROM pairings WHERE uid = ?', [uid]) as { id: number }).id;
      for (const session of close.sessions) {
        store.run(STORE_SQL.claimClose, [
          id,
          session,
          at + 1,
          `${head} test`,
          '["a.ts"]',
          close.scope,
        ]);
      }
      store.run(STORE_SQL.syncPairing, [
        close.sessions.length,
        close.sessions.length,
        at + 1,
        `${head} test`,
        '["a.ts"]',
        close.scope,
        id,
      ]);
    } finally {
      store.close();
    }
  }

  /**
   * Plan 05 rows 9 and 11 (tenjin-agent#212): how many pairings the machine
   * opened, how many a later pass closed and verified, what scope the closed
   * ones landed in, and which heads opened them.
   */
  it('reports the pairings opened in the window: closed, verified, scope, heads', async () => {
    const now = Date.parse('2026-08-22T00:00:00Z');
    const recent = now - 60_000;
    const stale = now - 8 * 24 * 60 * 60 * 1000;
    await seedPairing(dir, recent, 'pnpm');
    await seedPairing(dir, recent, 'pnpm', { sessions: ['s1'], scope: 'code' });
    await seedPairing(dir, recent, 'pytest', { sessions: ['s1', 's2'], scope: 'code' });
    await seedPairing(dir, recent, 'tsc', { sessions: ['s1'], scope: 'user' });
    await seedPairing(dir, stale, 'cargo', { sessions: ['s1'], scope: 'code' });

    const result = await runPushStatus(makeCtx(), { homeDir: home, now: () => now });
    expect(result.data).toMatchObject({
      ledger: {
        pairings: {
          opened: 4,
          closed: 3,
          verified: 1,
          scope: { code: 2, user: 1 },
          byHead: { pnpm: 2, pytest: 1, tsc: 1 },
        },
      },
    });
    const human = result.humanLines?.join('\n') ?? '';
    expect(human).toContain(
      'pairings, last 7d: 4 opened, 3 closed, 1 verified; scope: code=2, user=1; heads: pnpm=2, pytest=1, tsc=1',
    );
  });

  it('tallies the last 7 days of ledger rows by trigger x action, shelf, and tokens', async () => {
    const now = Date.parse('2026-08-22T00:00:00Z');
    const recent = now - 60_000;
    const stale = now - 8 * 24 * 60 * 60 * 1000;
    await seedRows(dir, [
      {
        at: recent,
        trigger: 'failure',
        shelf: 'public',
        action: 'injected',
        resourceId: 'res-1',
        tokens: 120,
      },
      {
        at: recent,
        trigger: 'failure',
        shelf: 'public',
        action: 'skipped',
        resourceId: 'res-1',
        reason: 'weak',
      },
      { at: recent, trigger: 'read', shelf: 'team', action: 'logged' },
      // Outside the 7-day window: must not be counted.
      {
        at: stale,
        trigger: 'failure',
        shelf: 'public',
        action: 'injected',
        resourceId: 'res-stale',
        reason: 'weak',
        tokens: 999,
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
        rows: 3,
        byTriggerAction: {
          failure: { injected: 1, skipped: 1 },
          read: { logged: 1 },
        },
        byShelf: { public: 2, team: 1 },
        byReason: { weak: 1 },
        // Two rows about the same piece are one finding; the third row reached
        // no candidate at all; the stale row is outside the window.
        candidates: 1,
        injectedTokens: 120,
      },
    });
    const human = result.humanLines?.join('\n') ?? '';
    expect(human).toContain('3 row(s)');
    expect(human).toContain('1 finding(s)');
    expect(human).toContain('failure: injected=1, skipped=1');
    expect(human).toContain('shelf: public=2, team=1');
    expect(human).toContain('reasons: weak=1');
  });

  it('counts a note and a marketplace piece as separate findings, and sorts reasons by count', async () => {
    const now = Date.parse('2026-08-22T00:00:00Z');
    const recent = now - 60_000;
    await seedRows(dir, [
      // A note is keyed by `candidate.id` and a marketplace piece by
      // `candidate.resourceId`; both land in the same column.
      {
        at: recent,
        trigger: 'failure',
        shelf: 'team',
        action: 'injected',
        resourceId: '20260822-k3x9q2',
        tokens: 40,
      },
      {
        at: recent,
        trigger: 'prompt',
        shelf: 'public',
        action: 'injected',
        resourceId: 'res-9',
        tokens: 60,
      },
      { at: recent, trigger: 'prompt', shelf: 'public', action: 'skipped', reason: 'lookup-cap' },
      { at: recent, trigger: 'read', shelf: 'public', action: 'skipped', reason: 'lookup-cap' },
      // A row that reached no candidate at all.
      { at: recent, trigger: 'churn', shelf: 'public', action: 'skipped', reason: 'miss' },
      // An empty reason is not a reason.
      { at: recent, trigger: 'read', shelf: 'team', action: 'logged', reason: '' },
    ]);

    const result = await runPushStatus(makeCtx(), {
      homeDir: home,
      now: () => now,
      lookupStats: shelfDown,
    });
    expect(result.data).toMatchObject({
      ledger: {
        rows: 6,
        byReason: { 'lookup-cap': 2, miss: 1 },
        candidates: 2,
        injectedTokens: 100,
      },
    });
    const human = result.humanLines?.join('\n') ?? '';
    expect(human).toContain('2 finding(s)');
    // Sorted by count, so the dominant brake reads first.
    expect(human).toContain('reasons: lookup-cap=2, miss=1');
    // Complete, so nothing is a floor and the line does not say otherwise.
    expect(human).not.toContain('retained tail');
  });

  /**
   * The tail is gone with the file.
   *
   * `push-ledger.jsonl` was append-only and never rotated, so `status` read its
   * last 256 KB and reported `tail: true` with a human line saying the counts an
   * operator was reading as totals were floors. The rows are indexed now, so a
   * large store answers the same window completely — which is what this asserts
   * with more rows than the old tail could hold.
   */
  it('counts the whole window on a large store, with no floor and no caveat', async () => {
    const now = Date.parse('2026-08-22T00:00:00Z');
    await seedRows(
      dir,
      Array.from({ length: 2000 }, (_, i) => ({
        at: now - 60_000 - i,
        trigger: 'prompt',
        shelf: 'public',
        action: 'skipped',
        reason: 'miss',
      })),
    );
    const result = await runPushStatus(makeCtx(), {
      homeDir: home,
      now: () => now,
      lookupStats: shelfDown,
    });
    expect((result.data as { ledger: { rows: number } }).ledger.rows).toBe(2000);
    expect(result.humanLines?.join('\n')).not.toContain('retained tail');
  });
});

describe('runPushGrade', () => {
  const SEARCH = '0197aaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const RES = '0197aaaa-bbbb-cccc-dddd-ffffffffffff';
  const URL = 'https://tenjin.blog/p/the-collation-trap';
  const NOW = Date.parse('2026-08-22T00:00:00Z');
  const INJECTED = `Tenjin found "The collation trap". Read it free: tenjin read ${RES}. The fix is \`pnpm db:generate --force\`.`;

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

  /** Transcripts keyed by session; `findTranscript` hands the session id back as
   *  the path, so no home directory is involved. A session in `unreadable` is
   *  the projects directory this run could not read — which is not the same
   *  answer as a session that simply has no transcript. */
  function transcriptDeps(bySession: Record<string, string>, unreadable: string[] = []) {
    return {
      findTranscript: async (_home: string, session: string): Promise<TranscriptLookup> => {
        if (unreadable.includes(session)) return { kind: 'unreadable', reason: 'EACCES' };
        return session in bySession ? { kind: 'found', path: session } : { kind: 'absent' };
      },
      transcriptText: async (path: string): Promise<string> => bySession[path] ?? '',
      transcriptIdle: async (): Promise<boolean> => false,
    };
  }

  it('marks used by read, rejects an ended session, leaves a live one open, and never opens a subagent transcript', async () => {
    await seedRows(dir, [
      {
        uid: 'u-used',
        at: NOW - 1000,
        trigger: 'failure',
        shelf: 'public',
        action: 'injected',
        resourceId: RES,
        url: URL,
        session: 'ended',
        searchId: SEARCH,
      },
      {
        uid: 'u-rejected',
        at: NOW - 1000,
        trigger: 'prompt',
        shelf: 'public',
        action: 'injected',
        resourceId: 'res-b',
        session: 'ended',
        searchId: null,
      },
      {
        uid: 'u-open',
        at: NOW - 1000,
        trigger: 'prompt',
        shelf: 'public',
        action: 'injected',
        resourceId: 'res-c',
        session: 'live',
        searchId: null,
      },
      {
        uid: 'u-subagent',
        at: NOW - 1000,
        trigger: 'subagent',
        shelf: 'public',
        action: 'injected',
        resourceId: 'res-d',
        session: 'ended',
        searchId: null,
      },
      {
        uid: 'u-notranscript',
        at: NOW - 1000,
        trigger: 'prompt',
        shelf: 'public',
        action: 'injected',
        resourceId: 'res-e',
        session: 'gone',
        searchId: null,
      },
      // Not injected, so there is nothing to have used.
      {
        uid: 'u-skipped',
        at: NOW - 1000,
        trigger: 'prompt',
        shelf: 'public',
        action: 'skipped',
        resourceId: 'res-f',
        session: 'ended',
      },
    ]);
    await seedSession(dir, 'ended', true);
    await seedSession(dir, 'live', false);
    // Ended, so "no transcript" is settled rather than "not written yet".
    await seedSession(dir, 'gone', true);
    const { fetchImpl } = acceptingShelf();

    const result = await runPushGrade(
      makeCtx(),
      {},
      {
        now: () => NOW,
        fetchImpl,
        ...transcriptDeps({
          ended: [
            contextRow(INJECTED),
            toolUse({ command: `tenjin read ${RES}` }),
            contextRow('Tenjin found res-b here.'),
            toolUse({ command: 'ls' }),
          ].join('\n'),
          live: [contextRow('Tenjin found res-c here.'), toolUse({ command: 'ls' })].join('\n'),
        }),
      },
    );

    expect(result.data).toMatchObject({
      since: '7d',
      graded: { used: 1, rejected: 1, unobserved: 2, open: 1 },
    });
    const byUid = new Map(
      (result.data as { rows: { uid: string; outcome: string; by: string }[] }).rows.map((r) => [
        r.uid,
        r,
      ]),
    );
    expect(byUid.get('u-used')).toMatchObject({ outcome: 'used', by: 'read' });
    expect(byUid.get('u-rejected')).toMatchObject({ outcome: 'rejected', by: 'none' });
    expect(byUid.get('u-open')).toMatchObject({ outcome: 'open' });
    expect(byUid.get('u-subagent')).toMatchObject({ outcome: 'unobserved' });
    expect(byUid.get('u-notranscript')).toMatchObject({ outcome: 'unobserved' });
    expect(byUid.has('u-skipped')).toBe(false);

    // The open row stays NULL, so the next run can still answer it.
    const store = await openStore(dir);
    expect(store?.get('SELECT outcome FROM injections WHERE uid = ?', ['u-open'])).toEqual({
      outcome: null,
    });
    store?.close();
  });

  /**
   * `unobserved` IS A VERDICT, and a verdict is never re-graded. So it may only
   * be written from a fact about the SESSION — the projects directory was read
   * and holds no file for it — never from a fact about this run. One sweep on a
   * machine whose home was not mounted, or mid-permissions-change, would
   * otherwise close every open row as never-seen with no way back.
   */
  it('leaves a row ungraded when the transcript could not be looked for at all', async () => {
    await seedRows(dir, [
      {
        uid: 'u-unreadable',
        at: NOW - 10 * 60 * 60 * 1000,
        trigger: 'prompt',
        shelf: 'public',
        action: 'injected',
        resourceId: RES,
        url: URL,
        session: 'blocked',
        searchId: SEARCH,
      },
    ]);
    // Ended AND old: everything except the read itself says "settle this row".
    await seedSession(dir, 'blocked', true);
    const { fetchImpl, calls } = acceptingShelf();

    const result = await runPushGrade(
      makeCtx(),
      { explain: true },
      { now: () => NOW, fetchImpl, ...transcriptDeps({}, ['blocked']) },
    );

    expect(result.data).toMatchObject({ graded: { unobserved: 0, open: 1 } });
    expect(result.humanLines?.join('\n')).toContain('transcript unreadable (EACCES)');
    expect(calls).toEqual([]);
    const store = await openStore(dir);
    expect(store?.get('SELECT outcome FROM injections WHERE uid = ?', ['u-unreadable'])).toEqual({
      outcome: null,
    });
    store?.close();
  });

  /**
   * The harness writes the transcript as the session runs, so a row minted
   * seconds ago on a session that is still starting has no file YET. Only once
   * a transcript would have appeared — the session ended, or the row is older
   * than the idle window — is its absence the answer.
   */
  it('waits for a young row before calling an absent transcript unobserved', async () => {
    await seedRows(dir, [
      {
        uid: 'u-young',
        at: NOW - 60_000,
        trigger: 'prompt',
        shelf: 'public',
        action: 'injected',
        resourceId: 'res-young',
        session: 'starting',
        searchId: null,
      },
      {
        uid: 'u-old',
        at: NOW - 2 * 60 * 60 * 1000,
        trigger: 'prompt',
        shelf: 'public',
        action: 'injected',
        resourceId: 'res-old',
        session: 'long-gone',
        searchId: null,
      },
    ]);

    const result = await runPushGrade(
      makeCtx(),
      { explain: true },
      { now: () => NOW, ...transcriptDeps({}) },
    );

    const byUid = new Map(
      (result.data as { rows: { uid: string; outcome: string }[] }).rows.map((r) => [r.uid, r]),
    );
    expect(byUid.get('u-young')).toMatchObject({ outcome: 'open' });
    expect(byUid.get('u-old')).toMatchObject({ outcome: 'unobserved' });
    expect(result.humanLines?.join('\n')).toContain('no transcript for this session yet');
    const store = await openStore(dir);
    expect(store?.get('SELECT outcome FROM injections WHERE uid = ?', ['u-young'])).toEqual({
      outcome: null,
    });
    store?.close();
  });

  /** A session the store has stamped ended settles immediately: there is no
   *  later transcript coming for it. */
  it('settles an absent transcript as soon as the session has ended', async () => {
    await seedRows(dir, [
      {
        uid: 'u-ended',
        at: NOW - 60_000,
        trigger: 'prompt',
        shelf: 'public',
        action: 'injected',
        resourceId: 'res-ended',
        session: 'stopped',
        searchId: null,
      },
    ]);
    await seedSession(dir, 'stopped', true);

    const result = await runPushGrade(makeCtx(), {}, { now: () => NOW, ...transcriptDeps({}) });
    expect(result.data).toMatchObject({ graded: { unobserved: 1, open: 0 } });
  });

  it('posts used as used, a copied span as partially_used, and rejected as rejected', async () => {
    await seedRows(dir, [
      {
        uid: 'u-read',
        at: NOW - 1000,
        trigger: 'failure',
        shelf: 'public',
        action: 'injected',
        resourceId: RES,
        url: URL,
        session: 's1',
        searchId: SEARCH,
      },
      {
        uid: 'u-span',
        at: NOW - 900,
        trigger: 'prompt',
        shelf: 'public',
        action: 'injected',
        resourceId: 'res-span',
        title: 'span piece',
        url: 'https://tenjin.blog/p/span-piece',
        session: 's2',
        searchId: SEARCH,
      },
      {
        uid: 'u-no',
        at: NOW - 800,
        trigger: 'prompt',
        shelf: 'public',
        action: 'injected',
        resourceId: 'res-no',
        title: 'no piece',
        url: 'https://tenjin.blog/p/no-piece',
        session: 's3',
        searchId: SEARCH,
      },
    ]);
    for (const s of ['s1', 's2', 's3']) await seedSession(dir, s, true);
    const { fetchImpl, calls } = acceptingShelf();

    const result = await runPushGrade(
      makeCtx(),
      {},
      {
        now: () => NOW,
        fetchImpl,
        ...transcriptDeps({
          s1: [contextRow(INJECTED), toolUse({ command: `tenjin read ${RES}` })].join('\n'),
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
  });

  /**
   * A search id is minted by ONE shelf and means nothing on another, and the
   * row's url is the only record of which one served it. The key rides the
   * row's LABEL: a public-shelf verdict must not carry the team's bypass
   * secret, whatever origin it is bound for.
   */
  it('posts each verdict to the origin that served it, with the bypass only on the team shelf', async () => {
    await writeFile(
      join(dir, 'config.json'),
      JSON.stringify({ baseUrl: 'https://team.example', shelfBypassSecret: 'shh' }),
    );
    await seedRows(dir, [
      {
        uid: 'u-team',
        at: NOW - 1000,
        trigger: 'failure',
        shelf: 'team',
        action: 'injected',
        resourceId: RES,
        url: 'https://team.example/p/the-collation-trap',
        session: 's1',
        searchId: SEARCH,
      },
      {
        uid: 'u-public',
        at: NOW - 900,
        trigger: 'failure',
        shelf: 'public',
        action: 'injected',
        resourceId: RES,
        url: URL,
        session: 's2',
        searchId: SEARCH,
      },
      // A replayed local pairing has no shelf to tell.
      {
        uid: 'u-local',
        at: NOW - 800,
        trigger: 'failure',
        shelf: 'local',
        action: 'injected',
        resourceId: 'pairing:7',
        title: 'local pairing',
        session: 's3',
        searchId: SEARCH,
      },
    ]);
    for (const s of ['s1', 's2', 's3']) await seedSession(dir, s, true);
    const { fetchImpl, calls } = acceptingShelf();

    await runPushGrade(
      makeCtx(),
      {},
      {
        now: () => NOW,
        fetchImpl,
        ...transcriptDeps({
          s1: [contextRow(INJECTED), toolUse({ command: `tenjin read ${RES}` })].join('\n'),
          s2: [contextRow(INJECTED), toolUse({ command: `tenjin read ${RES}` })].join('\n'),
          s3: [contextRow('Tenjin replayed "local pairing".'), toolUse({ command: 'ls' })].join(
            '\n',
          ),
        }),
      },
    );

    expect(calls.map((c) => c.url)).toEqual([
      `https://team.example/api/searches/${SEARCH}/outcomes`,
      `https://tenjin.blog/api/searches/${SEARCH}/outcomes`,
    ]);
    const team = calls[0]?.init.headers as Record<string, string>;
    const pub = calls[1]?.init.headers as Record<string, string>;
    expect(Object.keys(team).some((k) => k.includes('bypass'))).toBe(true);
    expect(Object.keys(pub).some((k) => k.includes('bypass'))).toBe(false);
  });

  /**
   * The label on the row means whatever the config meant WHEN THE ARM RAN. A
   * team base URL that has moved since then would send the verdict to a shelf
   * that never minted the search id, where it lands as a 202 (no existence
   * oracle, by design) and the row is stamped posted with nothing recorded
   * anywhere. So the ADDRESS comes from the row.
   *
   * The SECRET does not: it belongs to the team, not to an address. Gating it
   * on the row's origin matching the configured team base URL meant a moved
   * team shelf retried every unposted team verdict unauthenticated — forever,
   * since a 401 halts the batch and only a success stamps the row.
   */
  it('sends a moved team shelf its own url and still its own secret', async () => {
    await writeFile(
      join(dir, 'config.json'),
      JSON.stringify({ baseUrl: 'https://new-team.example', shelfBypassSecret: 'shh' }),
    );
    await seedRows(dir, [
      {
        uid: 'u-team',
        at: NOW - 1000,
        trigger: 'failure',
        shelf: 'team',
        action: 'injected',
        resourceId: RES,
        url: 'https://old-team.example/p/the-collation-trap',
        session: 's1',
        searchId: SEARCH,
      },
    ]);
    await seedSearch(dir, SEARCH, 'https://old-team.example');
    await seedSession(dir, 's1', true);
    const { fetchImpl, calls } = acceptingShelf();

    await runPushGrade(
      makeCtx(),
      {},
      {
        now: () => NOW,
        fetchImpl,
        ...transcriptDeps({
          s1: [contextRow(INJECTED), toolUse({ command: `tenjin read ${RES}` })].join('\n'),
        }),
      },
    );

    expect(calls.map((c) => c.url)).toEqual([
      `https://old-team.example/api/searches/${SEARCH}/outcomes`,
    ]);
    // A team row, so the team's secret, authorized at the base the arm asked.
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(Object.keys(headers).some((k) => k.includes('bypass'))).toBe(true);
  });

  /**
   * The key is authorized at the shelf the arm ASKED, never at the candidate
   * url the shelf answered with. That url is server text, so a shelf that named
   * a candidate on another origin would otherwise be handed the team's shelf
   * key — which opens the whole private shelf — just by being answered.
   */
  it('never sends the key to an origin the answer named rather than the config', async () => {
    await writeFile(
      join(dir, 'config.json'),
      JSON.stringify({ baseUrl: 'https://team.example', shelfBypassSecret: 'shh' }),
    );
    await seedRows(dir, [
      {
        uid: 'u-team',
        at: NOW - 1000,
        trigger: 'failure',
        shelf: 'team',
        action: 'injected',
        resourceId: RES,
        url: 'https://evil.example/p/the-collation-trap',
        session: 's1',
        searchId: SEARCH,
      },
    ]);
    await seedSearch(dir, SEARCH, 'https://team.example');
    await seedSession(dir, 's1', true);
    const { fetchImpl, calls } = acceptingShelf();

    await runPushGrade(
      makeCtx(),
      {},
      {
        now: () => NOW,
        fetchImpl,
        ...transcriptDeps({
          s1: [contextRow(INJECTED), toolUse({ command: `tenjin read ${RES}` })].join('\n'),
        }),
      },
    );

    expect(calls.map((c) => c.url)).toEqual([
      `https://evil.example/api/searches/${SEARCH}/outcomes`,
    ]);
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(Object.keys(headers).some((k) => k.includes('bypass'))).toBe(false);
  });

  /**
   * The mirror of the case above, and the one an origin rule got right by
   * accident: a PUBLIC row whose url happens to sit on the configured team
   * origin — a team shelf re-pointed at the marketplace, or a public piece
   * surfaced before team mode was switched on. The label is what decides, so
   * the team's secret stays home.
   */
  it('withholds the secret from a public row even on the configured team origin', async () => {
    await writeFile(
      join(dir, 'config.json'),
      JSON.stringify({ baseUrl: 'https://team.example', shelfBypassSecret: 'shh' }),
    );
    await seedRows(dir, [
      {
        uid: 'u-public',
        at: NOW - 1000,
        trigger: 'failure',
        shelf: 'public',
        action: 'injected',
        resourceId: RES,
        url: 'https://team.example/p/the-collation-trap',
        session: 's1',
        searchId: SEARCH,
      },
    ]);
    await seedSearch(dir, SEARCH, 'https://team.example');
    await seedSession(dir, 's1', true);
    const { fetchImpl, calls } = acceptingShelf();

    await runPushGrade(
      makeCtx(),
      {},
      {
        now: () => NOW,
        fetchImpl,
        ...transcriptDeps({
          s1: [contextRow(INJECTED), toolUse({ command: `tenjin read ${RES}` })].join('\n'),
        }),
      },
    );

    expect(calls.map((c) => c.url)).toEqual([
      `https://team.example/api/searches/${SEARCH}/outcomes`,
    ]);
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(Object.keys(headers).some((k) => k.includes('bypass'))).toBe(false);
  });

  /** With no url there is no shelf to name, and a verdict sent to a guess is
   *  worse than one still owed: the row keeps its NULL stamp. */
  it('skips a row whose url cannot say which shelf served it, and leaves it unposted', async () => {
    await seedRows(dir, [
      {
        uid: 'u-nourl',
        at: NOW - 1000,
        trigger: 'failure',
        shelf: 'public',
        action: 'injected',
        resourceId: RES,
        session: 's1',
        searchId: SEARCH,
      },
      {
        uid: 'u-badurl',
        at: NOW - 900,
        trigger: 'failure',
        shelf: 'public',
        action: 'injected',
        resourceId: RES,
        url: 'not a url',
        title: 'bad url piece',
        session: 's2',
        searchId: SEARCH,
      },
    ]);
    for (const s of ['s1', 's2']) await seedSession(dir, s, true);
    const { fetchImpl, calls } = acceptingShelf();

    const result = await runPushGrade(
      makeCtx(),
      { explain: true },
      {
        now: () => NOW,
        fetchImpl,
        ...transcriptDeps({
          s1: [contextRow(INJECTED), toolUse({ command: `tenjin read ${RES}` })].join('\n'),
          s2: [contextRow('Tenjin found "bad url piece".'), toolUse({ command: 'ls' })].join('\n'),
        }),
      },
    );

    expect(calls).toEqual([]);
    expect(result.data).toMatchObject({ posted: 0, postFailed: 0, postSkipped: 2 });
    expect(result.humanLines?.join('\n')).toContain('not posted: u-nourl');

    // The verdicts stand locally; only the posted stamp is withheld.
    const store = await openStore(dir);
    expect(store?.all('SELECT uid, outcome, outcome_at FROM injections ORDER BY uid', [])).toEqual([
      { uid: 'u-badurl', outcome: 'rejected', outcome_at: null },
      { uid: 'u-nourl', outcome: 'used', outcome_at: null },
    ]);
    store?.close();
  });

  /**
   * `outcome_at` is the POSTED stamp, so it is both the idempotence and the
   * retry queue: a landed post is never repeated (the server keeps the first
   * verdict per lookup and post, so a second would be dropped rather than
   * corrected), and a failed one is still owed.
   */
  it('never re-posts a landed verdict, and retries a failed one on the next run', async () => {
    await seedRows(dir, [
      {
        uid: 'u-1',
        at: NOW - 1000,
        trigger: 'failure',
        shelf: 'public',
        action: 'injected',
        resourceId: RES,
        url: URL,
        session: 's1',
        searchId: SEARCH,
      },
    ]);
    await seedSession(dir, 's1', true);
    const transcripts = transcriptDeps({
      s1: [contextRow(INJECTED), toolUse({ command: `tenjin read ${RES}` })].join('\n'),
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
    await seedRows(dir, [
      {
        uid: 'u-1',
        at: NOW - 1000,
        trigger: 'failure',
        shelf: 'public',
        action: 'injected',
        resourceId: RES,
        url: URL,
        session: 's1',
        searchId: SEARCH,
      },
      // An arm's decision NOT to show a piece. Nobody saw it, so nobody used it.
      {
        uid: 'u-skipped',
        at: NOW - 1000,
        trigger: 'failure',
        shelf: 'public',
        action: 'skipped',
        resourceId: RES,
        url: URL,
        session: 's1',
        searchId: SEARCH,
      },
    ]);
    const { fetchImpl, calls } = acceptingShelf();

    const result = await runPushGrade(
      makeCtx(),
      { label: ['u-1', 'used'] },
      { now: () => NOW, fetchImpl, ...transcriptDeps({}) },
    );
    expect(result.data).toMatchObject({ graded: { used: 1 }, posted: 1 });
    expect((JSON.parse(String(calls[0]?.init.body)) as { status: string }).status).toBe('used');

    await expect(
      runPushGrade(makeCtx(), { label: ['u-1', 'regenerated'] }, { now: () => NOW, fetchImpl }),
    ).rejects.toMatchObject({ code: 'USAGE' });
    await expect(
      runPushGrade(makeCtx(), { label: ['u-missing', 'used'] }, { now: () => NOW, fetchImpl }),
    ).rejects.toMatchObject({ code: 'USAGE' });
    // A row the arm never injected is not labellable: an outcome is a report
    // about a piece the agent was SHOWN, and posting one for a skipped decision
    // would tell the shelf a story about a piece it never served.
    await expect(
      runPushGrade(makeCtx(), { label: ['u-skipped', 'used'] }, { now: () => NOW, fetchImpl }),
    ).rejects.toMatchObject({ code: 'USAGE' });
    const store = await openStore(dir);
    expect(store?.get('SELECT outcome FROM injections WHERE uid = ?', ['u-skipped'])).toEqual({
      outcome: null,
    });
    store?.close();
    await expect(
      runPushGrade(makeCtx(), { label: ['u-1'] }, { now: () => NOW, fetchImpl }),
    ).rejects.toMatchObject({ code: 'USAGE' });
  });

  it('--explain names the anchor line and the evidence behind each verdict', async () => {
    await seedRows(dir, [
      {
        uid: 'u-1',
        at: NOW - 1000,
        trigger: 'failure',
        shelf: 'public',
        action: 'injected',
        resourceId: RES,
        url: URL,
        session: 's1',
        searchId: SEARCH,
      },
    ]);
    await seedSession(dir, 's1', true);
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
            contextRow(INJECTED),
            toolUse({ command: `tenjin read ${RES}` }),
          ].join('\n'),
        }),
      },
    );
    const text = result.humanLines?.join('\n') ?? '';
    expect(text).toContain('u-1 failure/public');
    expect(text).toContain('used (read) anchor line 2');
    expect(text).toContain(`tenjin read ${RES}`);
  });

  it('refuses a --since window it cannot read, before touching the store', async () => {
    await expect(runPushGrade(makeCtx(), { since: 'a while' })).rejects.toMatchObject({
      code: 'USAGE',
    });
  });

  it('grades one session only when asked', async () => {
    await seedRows(dir, [
      {
        uid: 'u-1',
        at: NOW - 1000,
        trigger: 'prompt',
        shelf: 'public',
        action: 'injected',
        resourceId: 'res-a',
        session: 's1',
        searchId: null,
      },
      {
        uid: 'u-2',
        at: NOW - 1000,
        trigger: 'prompt',
        shelf: 'public',
        action: 'injected',
        resourceId: 'res-b',
        session: 's2',
        searchId: null,
      },
    ]);
    const result = await runPushGrade(
      makeCtx(),
      { session: 's2' },
      {
        now: () => NOW,
        ...transcriptDeps({}),
      },
    );
    const rows = (result.data as { rows: { uid: string }[] }).rows;
    expect(rows.map((r) => r.uid)).toEqual(['u-2']);
  });

  /** A window is a window: a verdict older than `--since` is not this run's to
   *  reach, however long it has been sitting there. */
  it('leaves a row older than the window alone', async () => {
    await seedRows(dir, [
      {
        uid: 'u-old',
        at: NOW - 8 * 24 * 60 * 60 * 1000,
        trigger: 'prompt',
        shelf: 'public',
        action: 'injected',
        resourceId: 'res-a',
        session: 's1',
        searchId: null,
      },
    ]);
    const result = await runPushGrade(makeCtx(), {}, { now: () => NOW, ...transcriptDeps({}) });
    expect((result.data as { rows: unknown[] }).rows).toEqual([]);
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

  it('rolls the verdicts per hook x shelf and renders each shelf under it', async () => {
    await seedRows(dir, [
      {
        uid: 'g-1',
        at: NOW - 1000,
        trigger: 'failure',
        shelf: 'public',
        action: 'injected',
        resourceId: 'res-a',
      },
      {
        uid: 'g-2',
        at: NOW - 1000,
        trigger: 'failure',
        shelf: 'public',
        action: 'injected',
        resourceId: 'res-b',
      },
      {
        uid: 'g-3',
        at: NOW - 1000,
        trigger: 'failure',
        shelf: 'team',
        action: 'injected',
        resourceId: 'res-c',
      },
      {
        uid: 'g-4',
        at: NOW - 1000,
        trigger: 'prompt',
        shelf: 'public',
        action: 'skipped',
        reason: 'weak',
      },
    ]);
    const store = await openStore(dir);
    store?.run(STORE_SQL.setOutcome, ['used', 'read', 'g-1']);
    store?.run(STORE_SQL.markPosted, [NOW, 'g-1']);
    store?.run(STORE_SQL.setOutcome, ['rejected', 'none', 'g-2']);
    store?.close();

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
    // A skipped row was never shown, so it is not a verdict anybody owes.
    expect(human).not.toContain('prompt: public used=');
    expect(human).toContain('failure: public used=1 rejected=1 unobserved=0 ungraded=0 posted=1');
    expect(human).toContain('server public (7d):');
    expect(human).toContain('failure: lookups=12 hits=3 candidates=7 used=1 wrong=2 useRate=0.33');
  });

  /** An unreachable shelf and a shelf with no demand are different facts. */
  it('prints server: unavailable and still shows the local counts', async () => {
    await seedRows(dir, [
      {
        uid: 'g-1',
        at: NOW - 1000,
        trigger: 'failure',
        shelf: 'public',
        action: 'injected',
        resourceId: 'res-a',
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
