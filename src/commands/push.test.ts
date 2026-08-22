import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runPushOff, runPushOn, runPushStatus } from './push';
import { loadRawConfig } from '../lib/config';
import { claudeSettingsPath } from '../lib/harness-permissions';
import { hooksDir, pushLedgerPath } from '../lib/paths';
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
  it('persists hooks.push=on and wires the five push scripts', async () => {
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

  it('keeps the currently configured hooks.searchMode rather than forcing auto', async () => {
    await writeFile(join(dir, 'config.json'), JSON.stringify({ hooks: { searchMode: 'remind' } }));
    await runPushOn(makeCtx(), { homeDir: home });
    const settings = JSON.parse(await readFile(claudeSettingsPath(home), 'utf8')) as Record<
      string,
      unknown
    >;
    expect((settings.hooks as Record<string, unknown>).UserPromptSubmit).toBeDefined();
    // searchMode itself is read at run time by the generated scripts, not baked
    // into settings.json, so this asserts the CALL succeeded under a non-default
    // mode rather than asserting anything is literally 'remind' in the file.
    expect((await loadRawConfig(dir)).hooks?.searchMode).toBe('remind');
  });

  /**
   * `install` refuses to write a single hook entry when `hooks.searchMode` is
   * `off` — that is what the kill switch means. This command called
   * `wireSearchHooks` directly and so wired six entries straight past it, which
   * made `off` mean two different things depending on which verb you typed.
   */
  it('refuses when hooks.searchMode is off, and leaves the key as it was', async () => {
    await writeFile(join(dir, 'config.json'), JSON.stringify({ hooks: { searchMode: 'off' } }));
    await expect(runPushOn(makeCtx(), { homeDir: home })).rejects.toMatchObject({
      code: 'USAGE',
      exitCode: 2,
      fix: 'tenjin config set hooks.searchMode auto, then tenjin push on',
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
   * `install` only says with push on: one arm can deny a tool call.
   */
  it("discloses what the arms do, in install's words, above the undo line", async () => {
    const result = await runPushOn(makeCtx(), { homeDir: home });
    const lines = result.humanLines ?? [];
    const text = lines.join('\n');
    expect(text).toContain('The push experiment is on, so 6 more hook entries run beside these');
    expect(text).toContain(
      'the WebSearch and WebFetch hook may deny that call and hand the finding back',
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
    const result = await runPushStatus(makeCtx());
    expect(result.data).toEqual({
      mode: 'off',
      captureMode: 'off',
      scriptsWired: false,
      ledger: {
        windowDays: 7,
        rows: 0,
        byTriggerAction: {},
        byShelf: {},
        byReason: {},
        candidates: 0,
        denies: 0,
        injectedTokens: 0,
      },
    });
  });

  it('reflects the persisted modes and whether the scripts are actually on disk', async () => {
    await writeFile(
      join(dir, 'config.json'),
      JSON.stringify({ hooks: { push: 'on', capture: 'block' } }),
    );
    const before = await runPushStatus(makeCtx());
    expect(before.data).toMatchObject({ mode: 'on', captureMode: 'block', scriptsWired: false });
    expect(before.humanLines?.join('\n')).toContain('scripts not wired yet');

    await mkdir(hooksDir(dir), { recursive: true });
    for (const file of PUSH_SCRIPT_FILES) {
      await writeFile(join(hooksDir(dir), file), '// stub\n');
    }
    const after = await runPushStatus(makeCtx());
    expect(after.data).toMatchObject({ scriptsWired: true });
  });

  it('scriptsWired is false when even one of the five files is missing', async () => {
    await mkdir(hooksDir(dir), { recursive: true });
    for (const file of PUSH_SCRIPT_FILES.slice(1)) {
      await writeFile(join(hooksDir(dir), file), '// stub\n');
    }
    const result = await runPushStatus(makeCtx());
    expect(result.data).toMatchObject({ scriptsWired: false });
  });

  it('tallies the last 7 days of ledger rows by trigger x action, shelf, denies, and tokens', async () => {
    const now = Date.parse('2026-08-22T00:00:00Z');
    const recent = new Date(now - 60_000).toISOString();
    const stale = new Date(now - 8 * 24 * 60 * 60 * 1000).toISOString();
    const lines = [
      JSON.stringify({
        at: recent,
        trigger: 'failure',
        shelf: 'public',
        action: 'injected',
        candidate: { resourceId: 'res-1', title: 'a', price: '0.05' },
        deny: true,
        tokens: 120,
      }),
      JSON.stringify({
        at: recent,
        trigger: 'failure',
        shelf: 'public',
        action: 'skipped',
        candidate: { resourceId: 'res-1', title: 'a' },
        reason: 'weak',
      }),
      JSON.stringify({ at: recent, trigger: 'read', shelf: 'team', action: 'logged' }),
      // Outside the 7-day window: must not be counted.
      JSON.stringify({
        at: stale,
        trigger: 'failure',
        shelf: 'public',
        action: 'injected',
        candidate: { resourceId: 'res-stale' },
        reason: 'weak',
        tokens: 999,
      }),
      // Torn line: tolerated, never fatal.
      '{ not json',
      '',
    ].join('\n');
    await writeFile(pushLedgerPath(dir), `${lines}\n`);

    const result = await runPushStatus(makeCtx(), { now: () => now });
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
        denies: 1,
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
    const recent = new Date(now - 60_000).toISOString();
    const lines = [
      // Team shelf: a note carries `{id}`, never `{resourceId}`.
      JSON.stringify({
        at: recent,
        trigger: 'failure',
        shelf: 'team',
        action: 'injected',
        candidate: { id: '20260822-k3x9q2', title: 'note' },
        tokens: 40,
      }),
      JSON.stringify({
        at: recent,
        trigger: 'prompt',
        shelf: 'public',
        action: 'injected',
        candidate: { resourceId: 'res-9', title: 'piece' },
        tokens: 60,
      }),
      JSON.stringify({
        at: recent,
        trigger: 'prompt',
        shelf: 'public',
        action: 'skipped',
        reason: 'inject-cap',
      }),
      JSON.stringify({
        at: recent,
        trigger: 'read',
        shelf: 'public',
        action: 'skipped',
        reason: 'inject-cap',
      }),
      JSON.stringify({
        at: recent,
        trigger: 'churn',
        shelf: 'public',
        action: 'skipped',
        reason: 'miss',
        // A candidate with neither key is no candidate.
        candidate: { title: 'nameless' },
      }),
      // An empty reason is not a reason.
      JSON.stringify({ at: recent, trigger: 'read', shelf: 'team', action: 'logged', reason: '' }),
    ].join('\n');
    await writeFile(pushLedgerPath(dir), `${lines}\n`);

    const result = await runPushStatus(makeCtx(), { now: () => now });
    expect(result.data).toMatchObject({
      ledger: {
        rows: 6,
        byReason: { 'inject-cap': 2, miss: 1 },
        candidates: 2,
        injectedTokens: 100,
      },
    });
    const human = result.humanLines?.join('\n') ?? '';
    expect(human).toContain('2 finding(s)');
    // Sorted by count, so the dominant brake reads first.
    expect(human).toContain('reasons: inject-cap=2, miss=1');
  });
});
