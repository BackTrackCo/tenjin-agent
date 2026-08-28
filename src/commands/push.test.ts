import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  runPushOff,
  runPushOn,
  runPushStatus,
  scoreSession,
  SCORE_RECENCY_MS,
  type ScoreEvent,
  type PushSessionScore,
} from './push';
import { loadRawConfig } from '../lib/config';
import { claudeSettingsPath } from '../lib/harness-permissions';
import { hooksDir } from '../lib/paths';
import { openStore, STORE_SQL } from '../lib/state-store';
import {
  PUSH_CONTEXT_HOOK_FILE,
  PUSH_FAILURE_HOOK_FILE,
  PUSH_PROMPT_HOOK_FILE,
  PUSH_SUBAGENT_HOOK_FILE,
} from '../lib/push-scripts';
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

function makeCtx(): CommandContext {
  const sink = () => ({ write: () => true }) as unknown as NodeJS.WritableStream;
  return {
    flags: { json: true, timeout: 5000 },
    dataDir: dir,
    io: { stdout: sink(), stderr: sink(), isTTY: false },
  };
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
    const result = await runPushStatus(makeCtx(), { homeDir: home });
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
      },
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
    const before = await runPushStatus(makeCtx(), { homeDir: home });
    expect(before.data).toMatchObject({ mode: 'on', captureMode: 'block', scriptsWired: false });
    // The verb that actually wires them. `tenjin install` only does so when
    // hooks.push is already on, so it is not the one-command fix.
    expect(before.humanLines?.join('\n')).toContain('not fully wired yet; run `tenjin push on`');

    await mkdir(hooksDir(dir), { recursive: true });
    for (const file of PUSH_SCRIPT_FILES) {
      await writeFile(join(hooksDir(dir), file), '// stub\n');
    }
    const after = await runPushStatus(makeCtx(), { homeDir: home });
    expect(after.data).toMatchObject({ scriptsWired: true });
  });

  it('scriptsWired is false when even one of the five files is missing', async () => {
    await mkdir(hooksDir(dir), { recursive: true });
    for (const file of PUSH_SCRIPT_FILES.slice(1)) {
      await writeFile(join(hooksDir(dir), file), '// stub\n');
    }
    const result = await runPushStatus(makeCtx(), { homeDir: home });
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
    const halfWired = await runPushStatus(makeCtx(), { homeDir: home });
    expect(halfWired.data).toMatchObject({
      scriptsWired: true,
      hookEntries: { planned: 6, present: 0, path: null },
    });
    const lines = halfWired.humanLines?.join('\n') ?? '';
    expect(lines).toContain('not fully wired yet; run `tenjin push on`');
    expect(lines).toContain('hook entries: 0/6');

    // A real wiring run registers all six.
    await runPushOn(makeCtx(), { homeDir: home });
    const wired = await runPushStatus(makeCtx(), { homeDir: home });
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
    const gone = await runPushStatus(makeCtx(), { homeDir: home });
    expect(gone.data).toMatchObject({
      scriptsWired: true,
      hookEntries: { planned: 6, present: 5 },
    });
    expect(gone.humanLines?.join('\n')).toContain('not fully wired yet');
  });

  /** One decision row, as an arm would have written it. */
  interface SeedRow {
    at: number;
    trigger: string;
    shelf: string;
    action: string;
    reason?: string;
    resourceId?: string;
    tokens?: number;
  }

  /** Write `rows` into the store's `injections` table. */
  async function seedRows(dir: string, rows: SeedRow[]): Promise<void> {
    const store = await openStore(dir);
    if (store === null) throw new Error('no store');
    try {
      rows.forEach((row, i) => {
        store.run(STORE_SQL.insertInjection, [
          `seed-${i}`,
          null,
          row.at,
          'sess',
          null,
          'machine',
          row.trigger,
          row.shelf,
          row.resourceId ?? null,
          null,
          null,
          null,
          'search-id',
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

    const result = await runPushStatus(makeCtx(), { homeDir: home, now: () => now });
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

    const result = await runPushStatus(makeCtx(), { homeDir: home, now: () => now });
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
    const result = await runPushStatus(makeCtx(), { homeDir: home, now: () => now });
    expect((result.data as { ledger: { rows: number } }).ledger.rows).toBe(2000);
    expect(result.humanLines?.join('\n')).not.toContain('retained tail');
  });
});

/**
 * The importance score (tenjin-agent#212, CommonTrace `detection.py` /
 * `scoring.py`), as a report. Pure fixtures per pattern first, then the store
 * read that puts capture_asked and published beside it.
 */
describe('scoreSession', () => {
  const T0 = Date.parse('2026-08-22T00:00:00Z');
  const ev = (offsetS: number, hook: string, over: Partial<ScoreEvent> = {}): ScoreEvent => ({
    at: T0 + offsetS * 1000,
    hook,
    tool: null,
    // The lead's own turn unless a fixture says otherwise: these are pure
    // fixtures for ONE worker, which is the unit scoreSession scores.
    agentId: null,
    files: [],
    command: null,
    head: null,
    ...over,
  });
  const edit = (offsetS: number, file: string, tool = 'Edit'): ScoreEvent =>
    ev(offsetS, 'edit', { tool, files: [file] });
  const score = (events: ScoreEvent[], over: Partial<Parameters<typeof scoreSession>[0]> = {}) =>
    scoreSession({ events, closes: [], searches: [], endedAt: null, ...over });

  it('scores nothing for a session of prompts and reads', () => {
    expect(score([ev(0, 'prompt'), ev(10, 'read'), ev(20, 'prompt')])).toEqual({
      score: 0,
      patterns: [],
      bonus: 1,
    });
  });

  it('error → edit → pass is 3.0', () => {
    const s = score(
      [
        ev(0, 'failure', { command: 'pnpm test' }),
        edit(10, 'a.test.ts'),
        ev(20, 'pass', { head: 'pnpm' }),
      ],
      {
        endedAt: T0 + 3600_000,
      },
    );
    // The pass closes a test-file edit: error-edit-resolved fires, fail-edit-pass
    // (which wants a non-test edit) does not.
    expect(s).toEqual({ score: 3, patterns: ['error-edit-resolved'], bonus: 1 });
  });

  it('a pass with no edit between resolves nothing', () => {
    expect(
      score([ev(0, 'failure', { command: 'pnpm test' }), ev(20, 'pass', { head: 'pnpm' })]).score,
    ).toBe(0);
  });

  it('a pairing close by this session counts as the resolution', () => {
    const s = score([ev(0, 'failure', { command: 'pnpm test' }), edit(10, 'a.ts')], {
      closes: [T0 + 15_000],
      endedAt: T0 + 3600_000,
    });
    expect(s.patterns).toEqual(['error-edit-resolved']);
  });

  it('the same file edited before and after a prompt is 2.5, markdown excluded', () => {
    expect(score([edit(0, 'a.ts'), ev(10, 'prompt'), edit(20, 'a.ts')])).toEqual({
      score: 2.5,
      patterns: ['edit-across-prompt'],
      bonus: 1,
    });
    expect(score([edit(0, 'notes.md'), ev(10, 'prompt'), edit(20, 'notes.md')]).score).toBe(0);
    expect(score([edit(0, 'a.ts'), ev(10, 'prompt'), edit(20, 'b.ts')]).score).toBe(0);
  });

  it('a Write over a file with three prior edits is 2.5; two is not', () => {
    const three = [edit(0, 'a.ts'), edit(1, 'a.ts'), edit(2, 'a.ts'), edit(3, 'a.ts', 'Write')];
    expect(score(three, { endedAt: T0 + 3600_000 })).toEqual({
      score: 2.5,
      patterns: ['write-over-edited'],
      bonus: 1,
    });
    expect(score(three.slice(1), { endedAt: T0 + 3600_000 }).score).toBe(0);
    // A fourth Edit is not a reversal.
    expect(score([...three.slice(0, 3), edit(3, 'a.ts')], { endedAt: T0 + 3600_000 }).score).toBe(
      0,
    );
  });

  it('fail → non-test edit → the same head passes is 2.0 on top of the resolution', () => {
    const s = score(
      [
        ev(0, 'failure', { command: 'pnpm vitest run x' }),
        edit(10, 'src/x.ts'),
        ev(20, 'pass', { head: 'pnpm' }),
      ],
      { endedAt: T0 + 3600_000 },
    );
    expect(s).toEqual({ score: 5, patterns: ['error-edit-resolved', 'fail-edit-pass'], bonus: 1 });
    // A different head passing is a different story.
    expect(
      score(
        [
          ev(0, 'failure', { command: 'pnpm test' }),
          edit(10, 'x.ts'),
          ev(20, 'pass', { head: 'cargo' }),
        ],
        {
          endedAt: T0 + 3600_000,
        },
      ).patterns,
    ).toEqual(['error-edit-resolved']);
  });

  it('research then edit with no error between is 2.0; an error between breaks it', () => {
    expect(score([ev(0, 'research'), edit(10, 'a.ts')])).toEqual({
      score: 2,
      patterns: ['research-then-edit'],
      bonus: 1,
    });
    expect(
      score([ev(0, 'research'), ev(5, 'failure', { command: 'pnpm test' }), edit(10, 'a.ts')])
        .score,
    ).toBe(0);
    // A search on record is the same signal (the research event is written on a hit only).
    expect(score([edit(10, 'a.ts')], { searches: [T0] }).patterns).toEqual(['research-then-edit']);
  });

  it('counts each pattern once per session', () => {
    const twice = [
      ev(0, 'failure', { command: 'pnpm test' }),
      edit(1, 'a.ts'),
      ev(2, 'pass', { head: 'pnpm' }),
      ev(10, 'failure', { command: 'pnpm test' }),
      edit(11, 'b.ts'),
      ev(12, 'pass', { head: 'pnpm' }),
    ];
    expect(score(twice, { endedAt: T0 + 3600_000 }).score).toBe(5);
  });

  it('adds up to 30% when the last resolution was within 300 s of the end', () => {
    const events = [
      ev(0, 'failure', { command: 'pnpm test' }),
      edit(10, 'a.ts'),
      ev(20, 'pass', { head: 'pnpm' }),
    ];
    // Resolved at t=20s, session ended at t=20s: the full bonus.
    expect(score(events, { endedAt: T0 + 20_000 })).toEqual({
      score: 6.5,
      patterns: ['error-edit-resolved', 'fail-edit-pass'],
      bonus: 1.3,
    });
    // Halfway through the window: half of it.
    expect(score(events, { endedAt: T0 + 20_000 + SCORE_RECENCY_MS / 2 }).bonus).toBe(1.15);
    // At the edge: none.
    expect(score(events, { endedAt: T0 + 20_000 + SCORE_RECENCY_MS }).bonus).toBe(1);
    // No end on record: the last event is the end, which here IS the resolution.
    expect(score(events).bonus).toBe(1.3);
  });

  it('a reversal earns the bonus too', () => {
    const events = [edit(0, 'a.ts'), edit(1, 'a.ts'), edit(2, 'a.ts'), edit(3, 'a.ts', 'Write')];
    expect(score(events, { endedAt: T0 + 3_000 }).bonus).toBe(1.3);
  });
});

describe('runPushStatus --sessions', () => {
  /** Rows as the hooks write them, for one session. */
  async function seedSession(
    dir: string,
    session: string,
    startedAt: number,
    events: Array<{ at: number; hook: string; tool?: string; files?: string[]; data?: unknown }>,
    extra: { endedAt?: number; captureAskedAt?: number; closesAt?: number[] } = {},
  ): Promise<void> {
    const store = await openStore(dir);
    if (store === null) throw new Error('no store');
    try {
      store.run(STORE_SQL.touchSession, [session, 'proj', '/w', startedAt, 'machine']);
      if (extra.endedAt !== undefined) {
        store.run(STORE_SQL.endSession, [session, extra.endedAt, extra.endedAt, 'machine']);
      }
      events.forEach((e, i) => {
        store.run(STORE_SQL.insertEvent, [
          `${session}-ev-${i}`,
          e.at,
          session,
          'proj',
          'machine',
          e.hook,
          e.tool ?? null,
          null,
          e.files === undefined ? null : JSON.stringify(e.files),
          e.data === undefined ? null : JSON.stringify(e.data),
        ]);
      });
      if (extra.captureAskedAt !== undefined) {
        store.run(STORE_SQL.setState, [
          session,
          'capture_asked',
          JSON.stringify(new Date(extra.captureAskedAt).toISOString()),
          extra.captureAskedAt,
        ]);
      }
      for (const at of extra.closesAt ?? []) {
        store.run(STORE_SQL.claimClose, [1, session, at, 'pnpm test', '["a.ts"]', 'code']);
      }
    } finally {
      store.close();
    }
  }

  async function seedPublished(dir: string, at: number, hash: string): Promise<void> {
    const store = await openStore(dir);
    if (store === null) throw new Error('no store');
    try {
      store.run(STORE_SQL.setState, ['', `published:${hash}`, JSON.stringify('https://x/p'), at]);
    } finally {
      store.close();
    }
  }

  it('is absent without the flag', async () => {
    const result = await runPushStatus(makeCtx(), { homeDir: home });
    expect(result.data).not.toHaveProperty('sessions');
    expect(result.humanLines?.join('\n')).not.toContain('sessions, last');
  });

  it('scores each session in the window beside capture_asked and published', async () => {
    const now = Date.parse('2026-08-22T00:00:00Z');
    const s1 = now - 3600_000;
    // s1: fail → edit → same head passes, capture asked, a publish while open.
    await seedSession(
      dir,
      'sess-fixed',
      s1,
      [
        { at: s1 + 1000, hook: 'prompt', data: { event: 'UserPromptSubmit', query: 'q' } },
        { at: s1 + 2000, hook: 'failure', tool: 'Bash', data: { command: 'pnpm test' } },
        { at: s1 + 3000, hook: 'edit', tool: 'Edit', files: ['x.ts'] },
        { at: s1 + 4000, hook: 'pass', tool: 'Bash', data: { command: 'pnpm test', head: 'pnpm' } },
      ],
      { endedAt: s1 + 600_000, captureAskedAt: s1 + 600_000 },
    );
    await seedPublished(dir, s1 + 500_000, 'abc');
    // s2: prompts only, capture asked, nothing published.
    const s2 = now - 1800_000;
    await seedSession(
      dir,
      'sess-chat',
      s2,
      [
        { at: s2 + 1000, hook: 'prompt' },
        { at: s2 + 2000, hook: 'prompt' },
      ],
      { captureAskedAt: s2 + 3000 },
    );
    // s3: out of the window.
    const s3 = now - 8 * 24 * 3600_000;
    await seedSession(dir, 'sess-old', s3, [{ at: s3 + 1000, hook: 'prompt' }]);
    // The machine bucket is never a session.
    await seedSession(dir, '', s2, [{ at: s2 + 1000, hook: 'prompt' }]);

    const result = await runPushStatus(
      makeCtx(),
      { homeDir: home, now: () => now },
      { sessions: true },
    );
    expect(result.data).toMatchObject({
      sessions: [
        {
          session: 'sess-fixed',
          agent: null,
          score: 5,
          patterns: ['error-edit-resolved', 'fail-edit-pass'],
          bonus: 1,
          events: 4,
          captureAsked: true,
          published: 1,
        },
        {
          session: 'sess-chat',
          agent: null,
          score: 0,
          patterns: [],
          events: 2,
          captureAsked: true,
          published: 0,
        },
      ],
    });
    const human = result.humanLines?.join('\n') ?? '';
    expect(human).toContain('sessions, last 7d: 2 scored');
    expect(human).toContain(
      "sess-fixed   agent=''           score=5.0 events=4 capture_asked=yes published=1 [error-edit-resolved, fail-edit-pass]",
    );
    expect(human).toContain(
      "sess-chat    agent=''           score=0.0 events=2 capture_asked=yes published=0",
    );
  });

  /**
   * THE PARTITION, against the store (audit fix 2). Parallel subagents share
   * their parent's session id and are told apart only by `data.agentId`, so
   * a session-wide scan stitched a failure, an edit and a pass that belonged to
   * three different workers into one "fix". Both halves are asserted here: the
   * spliced sequence must not fire, and the identical sequence within one
   * worker must.
   */
  it('never spans agents: parent failure + child edit + parent pass is not a fix', async () => {
    const now = Date.parse('2026-08-22T00:00:00Z');
    const s1 = now - 3600_000;
    await seedSession(dir, 'sess-split', s1, [
      // The parent fails and later passes; the only edit between them belongs
      // to a child that was working on something else.
      { at: s1 + 1000, hook: 'failure', tool: 'Bash', data: { command: 'pnpm test' } },
      { at: s1 + 2000, hook: 'edit', tool: 'Edit', files: ['x.ts'], data: { agentId: 'a1' } },
      { at: s1 + 3000, hook: 'pass', tool: 'Bash', data: { command: 'pnpm test', head: 'pnpm' } },
    ]);

    const result = await runPushStatus(
      makeCtx(),
      { homeDir: home, now: () => now },
      { sessions: true },
    );
    const rows = (result.data as { sessions: PushSessionScore[] }).sessions;

    // Two workers, two lines, and NEITHER has a fix: the parent never edited,
    // the child never failed or passed.
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.agent).sort()).toEqual(['a1', null]);
    for (const row of rows) {
      expect(row.patterns, `agent ${String(row.agent)}`).toEqual([]);
      expect(row.score, `agent ${String(row.agent)}`).toBe(0);
    }
    // The events are split, not dropped: 2 for the parent, 1 for the child.
    expect(rows.find((r) => r.agent === null)?.events).toBe(2);
    expect(rows.find((r) => r.agent === 'a1')?.events).toBe(1);
  });

  it('scores the same sequence when one worker did all three', async () => {
    const now = Date.parse('2026-08-22T00:00:00Z');
    const s1 = now - 3600_000;
    // Byte for byte the rows above, minus the agent stamp on the edit.
    await seedSession(dir, 'sess-whole', s1, [
      { at: s1 + 1000, hook: 'failure', tool: 'Bash', data: { command: 'pnpm test' } },
      { at: s1 + 2000, hook: 'edit', tool: 'Edit', files: ['x.ts'] },
      { at: s1 + 3000, hook: 'pass', tool: 'Bash', data: { command: 'pnpm test', head: 'pnpm' } },
    ]);

    const result = await runPushStatus(
      makeCtx(),
      { homeDir: home, now: () => now },
      { sessions: true },
    );
    const rows = (result.data as { sessions: PushSessionScore[] }).sessions;

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      session: 'sess-whole',
      agent: null,
      patterns: ['error-edit-resolved', 'fail-edit-pass'],
      events: 3,
    });
  });

  it('scores a child on its own rows, and keeps capture_asked on the parent', async () => {
    const now = Date.parse('2026-08-22T00:00:00Z');
    const s1 = now - 3600_000;
    await seedSession(
      dir,
      'sess-child',
      s1,
      [
        { at: s1 + 1000, hook: 'prompt', data: { event: 'UserPromptSubmit', query: 'q' } },
        {
          at: s1 + 2000,
          hook: 'failure',
          tool: 'Bash',
          data: { command: 'pnpm test', agentId: 'a1' },
        },
        { at: s1 + 3000, hook: 'edit', tool: 'Edit', files: ['x.ts'], data: { agentId: 'a1' } },
        {
          at: s1 + 4000,
          hook: 'pass',
          tool: 'Bash',
          data: { command: 'pnpm test', head: 'pnpm', agentId: 'a1' },
        },
      ],
      { endedAt: s1 + 600_000, captureAskedAt: s1 + 600_000 },
    );

    const result = await runPushStatus(
      makeCtx(),
      { homeDir: home, now: () => now },
      { sessions: true },
    );
    const rows = (result.data as { sessions: PushSessionScore[] }).sessions;

    const child = rows.find((r) => r.agent === 'a1');
    const parent = rows.find((r) => r.agent === null);
    expect(child).toMatchObject({
      session: 'sess-child',
      patterns: ['error-edit-resolved', 'fail-edit-pass'],
      events: 3,
      // The ask is the SESSION's, and it is reported once, on the parent.
      captureAsked: false,
    });
    expect(parent).toMatchObject({ session: 'sess-child', events: 1, captureAsked: true });
    // The child is the one that did the work, so it sorts above its parent.
    expect(rows[0]!.agent).toBe('a1');
    const human = result.humanLines?.join('\n') ?? '';
    expect(human).toContain('agent=a1');
  });

  it("counts a child's own agent_published mark as a publish (#237)", async () => {
    const now = Date.parse('2026-08-22T00:00:00Z');
    const s1 = now - 3600_000;
    await seedSession(dir, 'sess-pub', s1, [{ at: s1 + 1000, hook: 'prompt' }], {
      endedAt: s1 + 600_000,
    });
    // What a child's own `tenjin publish` leaves behind. `LIKE 'published:%'`
    // is anchored, so this row was invisible to the report until it was named.
    const store = await openStore(dir);
    if (store === null) throw new Error('no store');
    store.run(STORE_SQL.setState, [
      '',
      'agent_published:a1@ffff',
      JSON.stringify({ url: 'https://x/p' }),
      s1 + 500_000,
    ]);
    store.close();

    const result = await runPushStatus(
      makeCtx(),
      { homeDir: home, now: () => now },
      { sessions: true },
    );
    const rows = (result.data as { sessions: PushSessionScore[] }).sessions;
    expect(rows.find((r) => r.session === 'sess-pub')?.published).toBe(1);
  });

  it('reads closes and searches into the score, and the recency bonus from ended_at', async () => {
    const now = Date.parse('2026-08-22T00:00:00Z');
    const s1 = now - 3600_000;
    await seedSession(
      dir,
      'sess-closed',
      s1,
      [
        { at: s1 + 2000, hook: 'failure', tool: 'Bash', data: { command: 'pnpm test' } },
        { at: s1 + 3000, hook: 'edit', tool: 'Edit', files: ['x.ts'] },
      ],
      { endedAt: s1 + 4000, closesAt: [s1 + 4000] },
    );
    const result = await runPushStatus(
      makeCtx(),
      { homeDir: home, now: () => now },
      { sessions: true },
    );
    expect(result.data).toMatchObject({
      sessions: [
        { session: 'sess-closed', score: 3.9, patterns: ['error-edit-resolved'], bonus: 1.3 },
      ],
    });
    expect(result.humanLines?.join('\n')).toContain('score=3.9 (x1.30 recency)');
  });
});
