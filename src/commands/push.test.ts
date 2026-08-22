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
        deny: true,
        tokens: 120,
      }),
      JSON.stringify({
        at: recent,
        trigger: 'failure',
        shelf: 'public',
        action: 'skipped',
        reason: 'weak',
      }),
      JSON.stringify({ at: recent, trigger: 'read', shelf: 'team', action: 'logged' }),
      // Outside the 7-day window: must not be counted.
      JSON.stringify({
        at: stale,
        trigger: 'failure',
        shelf: 'public',
        action: 'injected',
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
        denies: 1,
        injectedTokens: 120,
      },
    });
    const human = result.humanLines?.join('\n') ?? '';
    expect(human).toContain('3 row(s)');
    expect(human).toContain('failure: injected=1, skipped=1');
    expect(human).toContain('shelf: public=2, team=1');
  });
});
