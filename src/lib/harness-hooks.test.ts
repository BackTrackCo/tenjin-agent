import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * Arms the one interleave the filesystem will not produce on demand: another
 * writer landing between this module's settings read and its commit. Inert unless
 * a test sets it, so production carries no test-only branch.
 */
const fsHooks = vi.hoisted(() => ({ settingsInterleave: '' }));
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    readFile: async (...args: Parameters<typeof actual.readFile>) => {
      const out = await actual.readFile(...args);
      if (fsHooks.settingsInterleave !== '' && String(args[0]).endsWith('settings.json')) {
        const bytes = fsHooks.settingsInterleave;
        fsHooks.settingsInterleave = '';
        await actual.writeFile(String(args[0]), bytes);
      }
      return out;
    },
  };
});
import { chmod, mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { platform, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { DaemonStart } from '../daemon/control';
import { HARNESS_MS } from '../hooks/constants';
import { claudeSettingsPath } from './harness-permissions';
import {
  hasClaudeHooks,
  hookBundlesPresent,
  ownsHookEntry,
  pruneOurHandlers,
  registeredHookPort,
  RETIRED_HOOK_FILES,
  writeClaudeHooks,
} from './harness-hooks';
import { daemonPidPath, daemonTokenPath, hooksDir, shimBundlePath } from './paths';

let home: string;
let data: string;
/** Every step the fake daemon start ran, in order, so ordering can be asserted. */
let calls: string[];

const PORT = 34_567;
const TOKEN = 'a'.repeat(64);

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'tenjin-hooks-home-'));
  data = await mkdtemp(join(tmpdir(), 'tenjin-hooks-data-'));
  calls = [];
});
afterEach(async () => {
  fsHooks.settingsInterleave = '';
  // A test that made ~/.claude read-only has to hand it back before the rm.
  await chmod(dirname(settingsPath()), 0o700).catch(() => undefined);
  await rm(home, { recursive: true, force: true });
  await rm(data, { recursive: true, force: true });
});

const settingsPath = (): string => claudeSettingsPath(home);

async function readSettings(): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(settingsPath(), 'utf8')) as Record<string, unknown>;
}

async function writeSettings(contents: unknown): Promise<void> {
  await mkdir(dirname(settingsPath()), { recursive: true });
  await writeFile(
    settingsPath(),
    typeof contents === 'string' ? contents : JSON.stringify(contents, null, 2),
  );
}

/**
 * Steps 1-3, without a process: it writes exactly what a real start leaves
 * behind — the bundles, the token and the pid file — and records that it ran
 * BEFORE the settings write, which is the ordering §4a fixes.
 */
async function fakeStart(dataDir: string, port = PORT): Promise<DaemonStart> {
  await mkdir(hooksDir(dataDir), { recursive: true });
  await writeFile(shimBundlePath(dataDir), '// shim');
  await writeFile(join(hooksDir(dataDir), 'tenjin-daemon.mjs'), '// daemon');
  await writeFile(daemonTokenPath(dataDir), TOKEN, { mode: 0o600 });
  await writeFile(
    daemonPidPath(dataDir),
    JSON.stringify({ pid: 4242, port, started_at: 1, data_dir: dataDir }),
  );
  calls.push('daemon-healthy');
  return {
    health: {
      version: '9.9.9',
      pid: 4242,
      port,
      uptime_ms: 1,
      idle_ms: 0,
      data_dir: dataDir,
      rss: 1,
    },
    spawned: true,
    replaced: null,
    unconfirmed: null,
    written: [],
  };
}

function write(overrides: { start?: (d: string) => Promise<DaemonStart> } = {}) {
  return writeClaudeHooks({
    homeDir: home,
    dataDir: data,
    mode: 'auto',
    start: overrides.start ?? ((d) => fakeStart(d)),
  });
}

interface Handler {
  type: string;
  url?: string;
  command?: string;
  timeout?: number;
  headers?: Record<string, string>;
}
interface Entry {
  matcher?: string;
  hooks: Handler[];
}

function allEntries(s: Record<string, unknown>): [string, Entry][] {
  const out: [string, Entry][] = [];
  for (const [event, list] of Object.entries((s.hooks ?? {}) as Record<string, Entry[]>)) {
    for (const entry of list) out.push([event, entry]);
  }
  return out;
}

describe('writeClaudeHooks: the eleven entries, whole', () => {
  it('registers nine http and two command entries and nothing else', async () => {
    const result = await write();
    expect(result.skipped).toBeUndefined();
    expect(result.entries).toBe(11);

    const entries = allEntries(await readSettings());
    expect(entries).toHaveLength(11);
    const http = entries.filter(([, e]) => e.hooks[0]?.type === 'http');
    const command = entries.filter(([, e]) => e.hooks[0]?.type === 'command');
    expect(http).toHaveLength(9);
    expect(command).toHaveLength(2);
    // The two `command` entries are the ones that must start the daemon, so they
    // are the ones every turn begins with.
    expect(command.map(([event]) => event).sort()).toEqual(['SessionStart', 'UserPromptSubmit']);
    for (const [, entry] of command) {
      expect(entry.hooks[0]?.command).toContain(shimBundlePath(data));
      expect(entry.hooks[0]?.command).toContain('--harness claude');
    }
    for (const [, entry] of http) {
      expect(entry.hooks[0]?.headers).toEqual({ Authorization: `Bearer ${TOKEN}` });
      expect(entry.hooks[0]?.timeout).toBe(HARNESS_MS / 1000);
    }
  });

  it('takes the URL port from daemon.pid, never from the derived port', async () => {
    // A pinned or race-lost port is exactly the case a derived port gets wrong:
    // the daemon is the only thing that knows what it actually bound.
    const result = await write({ start: (d) => fakeStart(d, 45_001) });
    expect(result.url).toBe('http://127.0.0.1:45001/hook/claude');
    const urls = allEntries(await readSettings())
      .map(([, e]) => e.hooks[0]?.url)
      .filter((u): u is string => u !== undefined);
    expect(new Set(urls)).toEqual(new Set(['http://127.0.0.1:45001/hook/claude']));
  });

  it('writes settings only AFTER the daemon is healthy', async () => {
    // Claude Code re-reads settings.json through a file watcher, so an entry
    // naming a daemon that is not up turns every live session's next tool call
    // into an HTTP hook error.
    await write({
      start: async (d) => {
        expect(existsSync(settingsPath())).toBe(false);
        return await fakeStart(d);
      },
    });
    calls.push('settings-written');
    expect(calls).toEqual(['daemon-healthy', 'settings-written']);
  });

  it('writes the settings file 0600, because it now carries the token', async () => {
    if (platform() === 'win32') return;
    await write();
    expect((await stat(settingsPath())).mode & 0o777).toBe(0o600);
  });

  it('a second run is byte-identical and does not rewrite the file', async () => {
    await write();
    const first = await readFile(settingsPath(), 'utf8');
    const before = (await stat(settingsPath())).mtimeMs;
    const second = await write();
    expect(second.wrote).toBe(false);
    expect(await readFile(settingsPath(), 'utf8')).toBe(first);
    expect((await stat(settingsPath())).mtimeMs).toBe(before);
  });

  it('converges the MODE even when the bytes already match', async () => {
    if (platform() === 'win32') return;
    await write();
    // A dotfiles sync, a stray chmod, another tool's rewrite: the entries are
    // still right, and the daemon token in them is now world-readable.
    await chmod(settingsPath(), 0o644);
    const second = await write();
    expect(second.wrote).toBe(false);
    expect((await stat(settingsPath())).mode & 0o777).toBe(0o600);
  });

  it('drops only OUR handler out of an entry someone hand-merged theirs into', async () => {
    const theirs = { type: 'command', command: 'node /elsewhere/theirs.mjs' };
    await writeSettings({
      hooks: {
        Stop: [
          {
            matcher: '*',
            hooks: [
              { type: 'command', command: `node ${join(hooksDir(data), 'tenjin-shim.mjs')}` },
              theirs,
            ],
          },
        ],
      },
    });
    await write();
    const after = JSON.parse(await readFile(settingsPath(), 'utf8')) as {
      hooks: Record<string, Array<{ hooks: unknown[] }>>;
    };
    const survivors = (after.hooks.Stop ?? []).flatMap((e) => e.hooks);
    expect(survivors).toContainEqual(theirs);
  });

  it('leaves entries and keys that are not ours exactly where they were', async () => {
    const theirs = { hooks: [{ type: 'command', command: 'node /elsewhere/theirs.mjs' }] };
    await writeSettings({
      model: 'opus',
      hooks: { PreToolUse: [theirs], Notification: [theirs] },
    });
    await write();
    const settings = await readSettings();
    expect(settings.model).toBe('opus');
    const hooks = settings.hooks as Record<string, Entry[]>;
    expect(hooks.Notification).toEqual([theirs]);
    expect(hooks.PreToolUse?.[0]).toEqual(theirs);
    expect(hooks.PreToolUse).toHaveLength(4);
  });
});

describe('writeClaudeHooks: the cutover', () => {
  it('replaces an old-style install rather than duplicating it', async () => {
    // What a pre-daemon machine carries: `command` entries naming the generated
    // scripts. They are ours by filename, so they are dropped, not doubled.
    const old = (file: string): Entry => ({
      hooks: [{ type: 'command', command: `node '${join(hooksDir(data), file)}'`, timeout: 5 }],
    });
    await writeSettings({
      hooks: {
        PreToolUse: [old('tenjin-websearch-hook.mjs'), old('tenjin-dispatch-hook.mjs')],
        Stop: [old('tenjin-stop-hook.mjs')],
        SessionStart: [old('tenjin-sessionstart-hook.mjs')],
      },
    });
    const result = await write();
    expect(result.entries).toBe(11);
    expect(allEntries(await readSettings())).toHaveLength(11);
    const stop = (await readSettings()).hooks as Record<string, Entry[]>;
    expect(stop.Stop).toHaveLength(1);
    expect(stop.Stop?.[0]?.hooks[0]?.type).toBe('http');
  });

  it('deletes the eight retired scripts from the hooks dir by name', async () => {
    await mkdir(hooksDir(data), { recursive: true });
    for (const file of RETIRED_HOOK_FILES) await writeFile(join(hooksDir(data), file), '// old');
    await writeFile(join(hooksDir(data), 'someone-elses.mjs'), '// theirs');
    const result = await write();
    expect(result.removed).toHaveLength(RETIRED_HOOK_FILES.length);
    for (const file of RETIRED_HOOK_FILES) {
      expect(existsSync(join(hooksDir(data), file))).toBe(false);
    }
    // Only ours, by name: a file someone else parked there stays.
    expect(existsSync(join(hooksDir(data), 'someone-elses.mjs'))).toBe(true);
    expect(await hookBundlesPresent(data)).toBe(true);
  });

  it('drops an entry of ours whose port has moved, and re-adds it on the new one', async () => {
    await write({ start: (d) => fakeStart(d, 40_001) });
    expect(await registeredHookPort(home, data)).toBe(40_001);
    await write({ start: (d) => fakeStart(d, 40_002) });
    expect(allEntries(await readSettings())).toHaveLength(11);
    expect(await registeredHookPort(home, data)).toBe(40_002);
  });
});

describe('writeClaudeHooks: refusals', () => {
  it('writes nothing when the daemon will not start', async () => {
    const result = await write({
      start: () => Promise.reject(new Error('Daemon did not start: spawn backoff')),
    });
    expect(result.skipped).toBe('daemon-down');
    expect(result.warning).toContain('spawn backoff');
    expect(result.fix).toContain('tenjin daemon start');
    expect(existsSync(settingsPath())).toBe(false);
  });

  it('refuses a settings file that changed underneath the read', async () => {
    await writeSettings({ model: 'opus' });
    fsHooks.settingsInterleave = JSON.stringify({ model: 'sonnet' }, null, 2);
    const result = await write();
    expect(result.skipped).toBe('changed-since-read');
    expect((await readSettings()).model).toBe('sonnet');
  });

  it('leaves a settings file it cannot parse exactly as it is', async () => {
    await writeSettings('{ not json');
    const result = await write();
    expect(result.skipped).toBe('unparsable');
    expect(await readFile(settingsPath(), 'utf8')).toBe('{ not json');
  });

  it('keeps the retired scripts when the settings write is refused', async () => {
    // They are deleted LAST for this: a refusal leaves settings.json naming
    // them, and a live session would then point at files that are gone.
    await writeSettings('{ not json');
    await mkdir(hooksDir(data), { recursive: true });
    for (const file of RETIRED_HOOK_FILES) await writeFile(join(hooksDir(data), file), '// old');
    const result = await write();
    expect(result.skipped).toBe('unparsable');
    expect(result.removed).toEqual([]);
    for (const file of RETIRED_HOOK_FILES) {
      expect(existsSync(join(hooksDir(data), file))).toBe(true);
    }
  });

  it('refuses an event whose entries are not a list, and names it', async () => {
    // Copied through, this event would silently swallow its share of the plan
    // while the receipt still said eleven.
    await writeSettings({ hooks: { PreToolUse: 'oops' } });
    const result = await write();
    expect(result.skipped).toBe('unexpected-shape');
    expect(result.warning).toContain('hooks.PreToolUse');
    expect(result.fix).toContain('tenjin install');
    expect(await readFile(settingsPath(), 'utf8')).toBe(
      JSON.stringify({ hooks: { PreToolUse: 'oops' } }, null, 2),
    );
  });

  it('reports a settings file it cannot write as a skip, not as an internal error', async () => {
    if (platform() === 'win32') return;
    // Everything above the write landed: the daemon is up, the bundles and the
    // skills are in place, and only this one file did not take.
    await mkdir(dirname(settingsPath()), { recursive: true });
    await chmod(dirname(settingsPath()), 0o500);
    const result = await write();
    expect(result.skipped).toBe('unwritable');
    expect(result.warning).toContain(settingsPath());
    expect(result.fix).toContain('already in place');
    expect(existsSync(settingsPath())).toBe(false);
  });
});

describe('ownership', () => {
  it('claims a loopback hook URL on any port, and no other URL', () => {
    const url = (u: string): unknown => ({ hooks: [{ type: 'http', url: u }] });
    expect(ownsHookEntry(url('http://127.0.0.1:1/hook/claude'), data)).toBe(true);
    expect(ownsHookEntry(url('http://127.0.0.1:65000/hook/claude'), data)).toBe(true);
    expect(ownsHookEntry(url('http://127.0.0.1:1/hook/other'), data)).toBe(false);
    expect(ownsHookEntry(url('http://example.com/hook/claude'), data)).toBe(false);
    expect(ownsHookEntry(url('http://127.0.0.1:1/hook/claude/extra'), data)).toBe(false);
  });

  it('claims a command naming one of our files, or any path under our hooks dir', () => {
    const cmd = (c: string): unknown => ({ hooks: [{ type: 'command', command: c }] });
    expect(ownsHookEntry(cmd(`node '${shimBundlePath(data)}' --harness claude`), data)).toBe(true);
    // A data dir that MOVED: the filename still says it is ours.
    expect(ownsHookEntry(cmd(`node /old/place/hooks/tenjin-stop-hook.mjs`), data)).toBe(true);
    // A file under our hooks dir we no longer have a name for.
    expect(ownsHookEntry(cmd(`node ${join(hooksDir(data), 'whatever.mjs')}`), data)).toBe(true);
    expect(ownsHookEntry(cmd('node /elsewhere/theirs.mjs'), data)).toBe(false);
    expect(ownsHookEntry({ hooks: 'not-an-array' }, data)).toBe(false);
    expect(ownsHookEntry(null, data)).toBe(false);
  });

  it('pruneOurHandlers removes handlers, not entries', () => {
    const ours = { type: 'http', url: 'http://127.0.0.1:1/hook/claude' };
    const theirs = { type: 'command', command: 'node /elsewhere/theirs.mjs' };
    // An entry that is only ours goes whole; one that is shared keeps theirs.
    expect(pruneOurHandlers({ matcher: '*', hooks: [ours] }, data)).toBeNull();
    expect(pruneOurHandlers({ matcher: '*', hooks: [ours, theirs] }, data)).toEqual({
      matcher: '*',
      hooks: [theirs],
    });
    // Nothing of ours in it: returned untouched, by identity.
    const foreign = { matcher: '*', hooks: [theirs] };
    expect(pruneOurHandlers(foreign, data)).toBe(foreign);
  });

  it('registeredHookPort reads past a foreign handler with an unparsable url', async () => {
    // Someone hand-merged their own handler into our entry, and theirs carries
    // a relative url. `new URL` on it would throw ERR_INVALID_URL out of doctor.
    await write({ start: (d) => fakeStart(d, 41_234) });
    const settings = (await readSettings()) as { hooks: Record<string, Entry[]> };
    const entry = settings.hooks.PreToolUse?.[0];
    entry?.hooks.unshift({ type: 'http', url: 'hooks/x' });
    await writeSettings(settings);
    expect(await registeredHookPort(home, data)).toBe(41_234);
  });

  it('hasClaudeHooks answers no for a missing, unreadable or foreign settings file', async () => {
    expect(await hasClaudeHooks(home, data)).toBe(false);
    await writeSettings('{ not json');
    expect(await hasClaudeHooks(home, data)).toBe(false);
    await writeSettings({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'node x' }] }] } });
    expect(await hasClaudeHooks(home, data)).toBe(false);
    await write();
    expect(await hasClaudeHooks(home, data)).toBe(true);
  });
});
