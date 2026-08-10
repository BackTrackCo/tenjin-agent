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
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { quoteForShell, wireSearchHooks, hooksSkipped } from './harness-hooks';
import { claudeSettingsPath } from './harness-permissions';
import { STOP_HOOK_FILE, WEBSEARCH_HOOK_FILE } from './hook-scripts';

let home: string;
let data: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'tenjin-hooks-home-'));
  data = await mkdtemp(join(tmpdir(), 'tenjin-hooks-data-'));
});
afterEach(async () => {
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

interface Entry {
  matcher?: string;
  hooks: { type: string; command: string; timeout?: number }[];
}
const entriesFor = (s: Record<string, unknown>, event: string): Entry[] =>
  ((s.hooks as Record<string, unknown>)?.[event] ?? []) as Entry[];

describe('wireSearchHooks: what a fresh machine gets', () => {
  it('writes both scripts and registers both events', async () => {
    const result = await wireSearchHooks({ homeDir: home, dataDir: data, mode: 'auto' });

    expect(result.skipped).toBeUndefined();
    expect(result.added).toEqual(['PreToolUse', 'Stop']);
    expect(result.alreadyPresent).toEqual([]);
    expect(existsSync(join(data, 'hooks', WEBSEARCH_HOOK_FILE))).toBe(true);
    expect(existsSync(join(data, 'hooks', STOP_HOOK_FILE))).toBe(true);

    const settings = await readSettings();
    const pre = entriesFor(settings, 'PreToolUse');
    expect(pre).toHaveLength(1);
    expect(pre[0]!.matcher).toBe('WebSearch');
    expect(pre[0]!.hooks[0]!.type).toBe('command');
    expect(pre[0]!.hooks[0]!.command).toContain(WEBSEARCH_HOOK_FILE);

    const stop = entriesFor(settings, 'Stop');
    expect(stop).toHaveLength(1);
    // Stop fires on every occurrence; the harness has no matcher for it, so
    // inventing one would be a key the schema does not define.
    expect(stop[0]!.matcher).toBeUndefined();
    expect(stop[0]!.hooks[0]!.command).toContain(STOP_HOOK_FILE);
  });

  it('matches WebSearch exactly, never WebFetch and never a wildcard', async () => {
    await wireSearchHooks({ homeDir: home, dataDir: data, mode: 'auto' });
    const pre = entriesFor(await readSettings(), 'PreToolUse');
    expect(pre[0]!.matcher).toBe('WebSearch');
    expect(JSON.stringify(await readSettings())).not.toContain('WebFetch');
  });

  it('runs the scripts through node, from inside the Tenjin data dir', async () => {
    const result = await wireSearchHooks({ homeDir: home, dataDir: data, mode: 'auto' });
    for (const event of ['PreToolUse', 'Stop']) {
      const command = entriesFor(await readSettings(), event)[0]!.hooks[0]!.command;
      expect(command.startsWith('node ')).toBe(true);
      expect(command).toContain(join(data, 'hooks'));
    }
    expect(result.scriptsDir).toBe(join(data, 'hooks'));
  });

  it('makes the scripts executable', async () => {
    await wireSearchHooks({ homeDir: home, dataDir: data, mode: 'auto' });
    if (process.platform === 'win32') return; // fs modes are a no-op there
    const mode = (await stat(join(data, 'hooks', WEBSEARCH_HOOK_FILE))).mode & 0o777;
    expect(mode).toBe(0o755);
  });

  it('writes the scripts even in remind mode, since the mode is read at run time', async () => {
    const result = await wireSearchHooks({ homeDir: home, dataDir: data, mode: 'remind' });
    expect(result.mode).toBe('remind');
    expect(existsSync(join(data, 'hooks', WEBSEARCH_HOOK_FILE))).toBe(true);
  });
});

describe('wireSearchHooks: idempotence', () => {
  it('a second run registers nothing and rewrites nothing', async () => {
    await wireSearchHooks({ homeDir: home, dataDir: data, mode: 'auto' });
    const first = await readFile(settingsPath(), 'utf8');

    const result = await wireSearchHooks({ homeDir: home, dataDir: data, mode: 'auto' });
    expect(result.added).toEqual([]);
    expect(result.updated).toEqual([]);
    expect(result.alreadyPresent).toEqual(['PreToolUse', 'Stop']);
    expect(result.scripts).toEqual([]);
    expect(await readFile(settingsPath(), 'utf8')).toBe(first);
  });

  // An upgrade that moves the data dir must not leave two entries firing.
  it('rewrites our own drifted entry in place instead of duplicating it', async () => {
    await writeSettings({
      hooks: {
        PreToolUse: [
          { matcher: 'Bash', hooks: [{ type: 'command', command: 'somebody-elses-hook' }] },
          {
            matcher: 'WebSearch',
            hooks: [{ type: 'command', command: `node /old/path/${WEBSEARCH_HOOK_FILE}` }],
          },
        ],
      },
    });
    const result = await wireSearchHooks({ homeDir: home, dataDir: data, mode: 'auto' });

    expect(result.updated).toContain('PreToolUse');
    const pre = entriesFor(await readSettings(), 'PreToolUse');
    expect(pre).toHaveLength(2);
    // Position preserved, and the stranger's entry untouched.
    expect(pre[0]!.hooks[0]!.command).toBe('somebody-elses-hook');
    expect(pre[1]!.hooks[0]!.command).toContain(join(data, 'hooks', WEBSEARCH_HOOK_FILE));
  });

  it('appends beside entries that are not ours and copies every other key through', async () => {
    await writeSettings({
      model: 'opus',
      permissions: { allow: ['Bash(ls:*)'] },
      hooks: {
        PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'guard.sh' }] }],
        SessionStart: [{ hooks: [{ type: 'command', command: 'greet.sh' }] }],
      },
    });
    await wireSearchHooks({ homeDir: home, dataDir: data, mode: 'auto' });

    const settings = await readSettings();
    expect(settings.model).toBe('opus');
    expect(settings.permissions).toEqual({ allow: ['Bash(ls:*)'] });
    expect(entriesFor(settings, 'SessionStart')).toHaveLength(1);
    const pre = entriesFor(settings, 'PreToolUse');
    expect(pre).toHaveLength(2);
    expect(pre[0]!.hooks[0]!.command).toBe('guard.sh');
  });
});

describe('wireSearchHooks: never clobbers a file it does not understand', () => {
  it('refuses unparsable JSON and leaves the bytes exactly as they are', async () => {
    await writeSettings('{ not json at all');
    const result = await wireSearchHooks({ homeDir: home, dataDir: data, mode: 'auto' });
    expect(result.skipped).toBe('unparsable');
    expect(result.warning).toContain('left exactly as it is');
    expect(result.fix).toContain('tenjin install');
    expect(await readFile(settingsPath(), 'utf8')).toBe('{ not json at all');
  });

  it('refuses a hooks key that is not an object', async () => {
    await writeSettings({ hooks: 'nope' });
    const result = await wireSearchHooks({ homeDir: home, dataDir: data, mode: 'auto' });
    expect(result.skipped).toBe('unexpected-shape');
    expect((await readSettings()).hooks).toBe('nope');
  });

  it('refuses a per-event key that is not an array', async () => {
    await writeSettings({ hooks: { Stop: { not: 'an array' } } });
    const result = await wireSearchHooks({ homeDir: home, dataDir: data, mode: 'auto' });
    expect(result.skipped).toBe('unexpected-shape');
    expect(result.warning).toContain('hooks.Stop');
    // Refusing is all-or-nothing: the PreToolUse half must not have landed either.
    expect((await readSettings()).hooks).toEqual({ Stop: { not: 'an array' } });
  });

  it('refuses a settings.json that is not a JSON object', async () => {
    await writeSettings('[1, 2, 3]');
    const result = await wireSearchHooks({ homeDir: home, dataDir: data, mode: 'auto' });
    expect(result.skipped).toBe('unexpected-shape');
  });

  // A dotfiles-managed settings.json is a link; committing with a rename over it
  // would replace the link with a regular file and strand its target.
  it('writes through a symlink rather than severing it', async () => {
    const real = join(home, 'dotfiles-settings.json');
    await writeFile(real, JSON.stringify({ model: 'opus' }, null, 2));
    await mkdir(dirname(settingsPath()), { recursive: true });
    await symlink(real, settingsPath());

    const result = await wireSearchHooks({ homeDir: home, dataDir: data, mode: 'auto' });
    expect(result.added).toEqual(['PreToolUse', 'Stop']);
    const parsed = JSON.parse(await readFile(real, 'utf8')) as Record<string, unknown>;
    expect(parsed.model).toBe('opus');
    expect(parsed.hooks).toBeDefined();
  });
});

describe('quoteForShell', () => {
  // A home directory with a space is the ordinary case this gets wrong.
  it('single-quotes for a POSIX shell', () => {
    expect(quoteForShell('/Users/a b/.tenjin/hooks/x.mjs', 'darwin')).toBe(
      "'/Users/a b/.tenjin/hooks/x.mjs'",
    );
  });

  it('escapes an embedded single quote the POSIX way', () => {
    expect(quoteForShell("/Users/o'brien/x.mjs", 'linux')).toBe(`'/Users/o'\\''brien/x.mjs'`);
  });

  // cmd.exe does not understand single quotes at all, so the branch is real.
  it('double-quotes for cmd', () => {
    expect(quoteForShell('C:\\Users\\a b\\x.mjs', 'win32')).toBe('"C:\\Users\\a b\\x.mjs"');
  });
});

describe('hooksSkipped', () => {
  it('names a fix for every skip reason, and no settings path off Claude Code', () => {
    const reasons = [
      'harness-not-claude',
      'mode-off',
      'declined',
      'dry-run',
      'unresolvable',
      'unreadable',
      'unparsable',
      'unexpected-shape',
      'changed-since-read',
    ] as const;
    for (const reason of reasons) {
      const result = hooksSkipped('claude', home, data, 'auto', reason);
      expect(result.fix, reason).toBeTruthy();
      expect(result.path, reason).toBe(settingsPath());
    }
    expect(hooksSkipped('codex', home, data, 'auto', 'harness-not-claude').path).toBeUndefined();
  });
});

describe('wireSearchHooks: a refusal changes nothing at all', () => {
  // The scripts used to be written BEFORE the compare-and-swap, so a
  // `changed-since-read` refusal had already replaced the bodies that existing
  // entries were running while reporting that nothing was registered.
  it('does not touch live scripts when the settings guard refuses', async () => {
    await writeSettings({
      hooks: {
        PreToolUse: [
          {
            matcher: 'WebSearch',
            hooks: [{ type: 'command', command: `node /old/${WEBSEARCH_HOOK_FILE}` }],
          },
        ],
      },
    });
    // A live script body an existing entry is already running, which a refusal
    // must leave exactly as it is.
    const scriptPath = join(data, 'hooks', WEBSEARCH_HOOK_FILE);
    await mkdir(join(data, 'hooks'), { recursive: true });
    await writeFile(scriptPath, '// an older install wrote this\n');

    // Another writer lands the instant the read returns.
    fsHooks.settingsInterleave = JSON.stringify({ model: 'somebody-elses-edit' }, null, 2);
    const result = await wireSearchHooks({ homeDir: home, dataDir: data, mode: 'auto' });

    expect(result.skipped).toBe('changed-since-read');
    expect(result.scripts).toEqual([]);
    expect(await readFile(scriptPath, 'utf8')).toBe('// an older install wrote this\n');
  });

  it('still refreshes a drifted script when no entry needs registering', async () => {
    // The other path: nothing to add or update in settings, so no guard applies
    // and a stale script body is simply brought up to date.
    await wireSearchHooks({ homeDir: home, dataDir: data, mode: 'auto' });
    const scriptPath = join(data, 'hooks', WEBSEARCH_HOOK_FILE);
    await writeFile(scriptPath, '// stale\n');

    const result = await wireSearchHooks({ homeDir: home, dataDir: data, mode: 'auto' });
    expect(result.added).toEqual([]);
    expect(result.scripts).toEqual([scriptPath]);
    expect(await readFile(scriptPath, 'utf8')).not.toBe('// stale\n');
  });
});
