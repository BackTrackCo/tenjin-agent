import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * Arms the one interleave the filesystem will not produce on demand: another
 * writer landing between this module's settings read and its commit. Inert unless
 * a test sets it, so production carries no test-only branch.
 */
const fsHooks = vi.hoisted(() => ({
  settingsInterleave: '',
  /** Bytes another writer lands in settings.json the moment a SCRIPT is renamed
   *  into place, i.e. squarely inside the writeScripts window. */
  settingsInterleaveOnScriptWrite: '',
  settingsPath: '',
}));
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
    rename: async (...args: Parameters<typeof actual.rename>) => {
      const out = await actual.rename(...args);
      if (
        fsHooks.settingsInterleaveOnScriptWrite !== '' &&
        String(args[1]).endsWith('.mjs') &&
        fsHooks.settingsPath !== ''
      ) {
        const bytes = fsHooks.settingsInterleaveOnScriptWrite;
        fsHooks.settingsInterleaveOnScriptWrite = '';
        await actual.writeFile(fsHooks.settingsPath, bytes);
      }
      return out;
    },
  };
});
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  HOOK_EVENTS,
  detectHookOwners,
  quoteForShell,
  refreshHooks,
  wireSearchHooks,
  hooksSkipped,
  PUSH_CONTEXT_EDIT_MATCHER,
  PUSH_CONTEXT_READ_MATCHER,
  PUSH_FAILURE_MATCHER,
} from './harness-hooks';
import { claudeSettingsPath } from './harness-permissions';
import {
  DISPATCH_HOOK_FILE,
  SESSIONSTART_HOOK_FILE,
  STOP_HOOK_FILE,
  WEBSEARCH_HOOK_FILE,
} from './hook-scripts';
import {
  PUSH_CONTEXT_HOOK_FILE,
  PUSH_FAILURE_HOOK_FILE,
  PUSH_HOOK_TIMEOUT_SECONDS,
  PUSH_PROMPT_HOOK_FILE,
  PUSH_SUBAGENT_HOOK_FILE,
} from './push-scripts';

let home: string;
let data: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'tenjin-hooks-home-'));
  data = await mkdtemp(join(tmpdir(), 'tenjin-hooks-data-'));
});
afterEach(async () => {
  fsHooks.settingsInterleave = '';
  fsHooks.settingsInterleaveOnScriptWrite = '';
  fsHooks.settingsPath = '';
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
  it('writes every script and registers every event', async () => {
    const result = await wireSearchHooks({ homeDir: home, dataDir: data, mode: 'auto' });

    expect(result.skipped).toBeUndefined();
    // One event carries two entries, and an event is reported once either way.
    expect(result.added).toEqual(['PreToolUse', 'SessionStart', 'Stop']);
    expect(result.alreadyPresent).toEqual([]);
    for (const file of [
      WEBSEARCH_HOOK_FILE,
      DISPATCH_HOOK_FILE,
      SESSIONSTART_HOOK_FILE,
      STOP_HOOK_FILE,
    ]) {
      expect(existsSync(join(data, 'hooks', file)), file).toBe(true);
    }

    const settings = await readSettings();
    const pre = entriesFor(settings, 'PreToolUse');
    expect(pre).toHaveLength(2);
    expect(pre[0]!.matcher).toBe('WebSearch');
    expect(pre[0]!.hooks[0]!.type).toBe('command');
    expect(pre[0]!.hooks[0]!.command).toContain(WEBSEARCH_HOOK_FILE);
    expect(pre[1]!.matcher).toBe('Agent|Task');
    expect(pre[1]!.hooks[0]!.command).toContain(DISPATCH_HOOK_FILE);

    const start = entriesFor(settings, 'SessionStart');
    expect(start).toHaveLength(1);
    expect(start[0]!.matcher).toBe('startup|clear|compact');
    expect(start[0]!.hooks[0]!.command).toContain(SESSIONSTART_HOOK_FILE);

    const stop = entriesFor(settings, 'Stop');
    expect(stop).toHaveLength(1);
    // Stop fires on every occurrence; the harness has no matcher for it, so
    // inventing one would be a key the schema does not define.
    expect(stop[0]!.matcher).toBeUndefined();
    expect(stop[0]!.hooks[0]!.command).toContain(STOP_HOOK_FILE);
  });

  // Neither reaches a wildcard, and the dispatch entry stays exactly as narrow
  // as it was.
  it('matches WebSearch and the two dispatch names, never a wildcard', async () => {
    await wireSearchHooks({ homeDir: home, dataDir: data, mode: 'auto' });
    const pre = entriesFor(await readSettings(), 'PreToolUse');
    expect(pre[0]!.matcher).toBe('WebSearch');
    expect(pre[1]!.matcher).toBe('Agent|Task');
    expect(pre.some((e) => e.matcher === '*')).toBe(false);
  });

  /**
   * WebFetch is the push experiment's widening, and the script's first act on a
   * WebFetch is to read the config key and exit when push is not on. Registering
   * it on a machine that never opted in bought a process spawn and a config read
   * per WebFetch for a hook that provably says nothing.
   */
  it('widens the WebSearch entry to WebFetch only when push is planned', async () => {
    await wireSearchHooks({ homeDir: home, dataDir: data, mode: 'auto' });
    expect(entriesFor(await readSettings(), 'PreToolUse')[0]!.matcher).toBe('WebSearch');

    // `push on` rewrites the entry in place rather than adding a second one.
    await wireSearchHooks({ homeDir: home, dataDir: data, mode: 'auto', push: true });
    const wide = entriesFor(await readSettings(), 'PreToolUse');
    expect(wide[0]!.matcher).toBe('WebSearch|WebFetch');
    expect(wide.filter((e) => e.hooks[0]!.command.includes(WEBSEARCH_HOOK_FILE))).toHaveLength(1);
  });

  // Ownership is by script filename, so two entries naming one script would be
  // collapsed into one by the idempotent rewrite.
  it('gives each script exactly one entry', async () => {
    await wireSearchHooks({ homeDir: home, dataDir: data, mode: 'auto' });
    const settings = await readSettings();
    const commands = ['PreToolUse', 'SessionStart', 'Stop'].flatMap((event) =>
      entriesFor(settings, event).flatMap((e) => e.hooks.map((h) => h.command)),
    );
    expect(new Set(commands).size).toBe(commands.length);
  });

  it('runs the scripts through node, from inside the Tenjin data dir', async () => {
    const result = await wireSearchHooks({ homeDir: home, dataDir: data, mode: 'auto' });
    for (const event of ['PreToolUse', 'SessionStart', 'Stop']) {
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

describe('wireSearchHooks: push experiment entries', () => {
  it('wires nothing extra when push is left off (the default)', async () => {
    const result = await wireSearchHooks({ homeDir: home, dataDir: data, mode: 'auto' });
    expect(result.added).toEqual(['PreToolUse', 'SessionStart', 'Stop']);
    const settings = await readSettings();
    expect((settings.hooks as Record<string, unknown>).UserPromptSubmit).toBeUndefined();
    expect((settings.hooks as Record<string, unknown>).PostToolUse).toBeUndefined();
    expect((settings.hooks as Record<string, unknown>).PostToolUseFailure).toBeUndefined();
    expect((settings.hooks as Record<string, unknown>).SubagentStart).toBeUndefined();
    // The BODIES are written unconditionally, and only the entries are gated:
    // `push off` never unwires, so bodies that follow the entry plan freeze at
    // whatever version was on disk when push was last on. An unregistered body
    // is inert; a registered stale one is not.
    for (const file of [
      PUSH_PROMPT_HOOK_FILE,
      PUSH_FAILURE_HOOK_FILE,
      PUSH_SUBAGENT_HOOK_FILE,
      PUSH_CONTEXT_HOOK_FILE,
    ]) {
      expect(existsSync(join(data, 'hooks', file)), file).toBe(true);
    }
  });

  /**
   * The sequence that used to leave six registered entries running pre-upgrade
   * code: wire push, turn it off (which unwires nothing), then upgrade.
   */
  it('refreshes the push bodies on a push:false run, entries still registered', async () => {
    await wireSearchHooks({ homeDir: home, dataDir: data, mode: 'auto', push: true });
    const path = join(data, 'hooks', PUSH_PROMPT_HOOK_FILE);
    await writeFile(path, '// an older version of this arm\n');

    const result = await wireSearchHooks({ homeDir: home, dataDir: data, mode: 'auto' });
    expect(result.scripts).toContain(path);
    expect(await readFile(path, 'utf8')).not.toContain('an older version');
    // Still registered, which is exactly why the body had to be brought forward.
    expect(entriesFor(await readSettings(), 'UserPromptSubmit')).toHaveLength(1);
  });

  it('wires all four push scripts across six entries when push is true', async () => {
    const result = await wireSearchHooks({
      homeDir: home,
      dataDir: data,
      mode: 'auto',
      push: true,
    });
    expect(result.added).toEqual([
      'PreToolUse',
      'SessionStart',
      'Stop',
      'UserPromptSubmit',
      'PostToolUse',
      'PostToolUseFailure',
      'SubagentStart',
    ]);
    const pushFiles = [
      PUSH_PROMPT_HOOK_FILE,
      PUSH_FAILURE_HOOK_FILE,
      PUSH_SUBAGENT_HOOK_FILE,
      PUSH_CONTEXT_HOOK_FILE,
    ];
    for (const file of pushFiles) {
      expect(existsSync(join(data, 'hooks', file)), file).toBe(true);
    }
    // The two numbers the docs, the help text and the disclosure all quote, held
    // here so a new arm cannot make every one of them wrong in silence: FOUR
    // scripts, SIX entries. Entries, not events — `added` above collapses the
    // three PreToolUse entries into one.
    expect(pushFiles).toHaveLength(4);
    expect(result.pushArms).toBe(6);
    // FIVE events, which is the number the prose kept getting wrong: the four
    // push-only ones plus PreToolUse, which the churn half shares with the base
    // bundle. PostToolUse carries two of the six on its own.
    expect(
      new Set([
        'UserPromptSubmit',
        'PostToolUse',
        'PostToolUseFailure',
        'SubagentStart',
        'PreToolUse',
      ]).size,
    ).toBe(5);
    const settingsNow = await readSettings();
    const pushEntryEvents = HOOK_EVENTS.filter((event) =>
      entriesFor(settingsNow, event).some((e) =>
        pushFiles.some((f) => e.hooks[0]!.command.includes(f)),
      ),
    );
    expect(pushEntryEvents).toHaveLength(5);
    // The base bundle's own events, uncounted by the push half.
    expect(result.searchWrote).toBe(3);

    const settings = await readSettings();

    // PreToolUse gains a third entry: the context arm's churn half.
    const pre = entriesFor(settings, 'PreToolUse');
    expect(pre).toHaveLength(3);
    expect(pre[2]!.matcher).toBe(PUSH_CONTEXT_EDIT_MATCHER);
    expect(pre[2]!.hooks[0]!.command).toContain(PUSH_CONTEXT_HOOK_FILE);

    // PostToolUse carries two DIFFERENT scripts: failure and the context arm's
    // read half. Neither collapses into the other.
    const post = entriesFor(settings, 'PostToolUse');
    expect(post).toHaveLength(2);
    expect(post[0]!.matcher).toBe(PUSH_FAILURE_MATCHER);
    expect(post[0]!.hooks[0]!.command).toContain(PUSH_FAILURE_HOOK_FILE);
    expect(post[1]!.matcher).toBe(PUSH_CONTEXT_READ_MATCHER);
    expect(post[1]!.hooks[0]!.command).toContain(PUSH_CONTEXT_HOOK_FILE);

    const postFailure = entriesFor(settings, 'PostToolUseFailure');
    expect(postFailure).toHaveLength(1);
    expect(postFailure[0]!.matcher).toBe(PUSH_FAILURE_MATCHER);
    expect(postFailure[0]!.hooks[0]!.command).toContain(PUSH_FAILURE_HOOK_FILE);

    const subagent = entriesFor(settings, 'SubagentStart');
    expect(subagent).toHaveLength(1);
    expect(subagent[0]!.matcher).toBeUndefined();
    expect(subagent[0]!.hooks[0]!.command).toContain(PUSH_SUBAGENT_HOOK_FILE);

    const prompt = entriesFor(settings, 'UserPromptSubmit');
    expect(prompt).toHaveLength(1);
    expect(prompt[0]!.matcher).toBeUndefined();
    expect(prompt[0]!.hooks[0]!.command).toContain(PUSH_PROMPT_HOOK_FILE);

    // Every push entry gets the longer push timeout, not the search hooks' one.
    for (const event of [
      'UserPromptSubmit',
      'PostToolUse',
      'PostToolUseFailure',
      'SubagentStart',
    ]) {
      for (const entry of entriesFor(settings, event)) {
        expect(entry.hooks[0]!.timeout).toBe(PUSH_HOOK_TIMEOUT_SECONDS);
      }
    }
  });

  it('a second push:true run registers nothing new and rewrites nothing', async () => {
    await wireSearchHooks({ homeDir: home, dataDir: data, mode: 'auto', push: true });
    const first = await readFile(settingsPath(), 'utf8');

    const result = await wireSearchHooks({
      homeDir: home,
      dataDir: data,
      mode: 'auto',
      push: true,
    });
    expect(result.added).toEqual([]);
    expect(result.updated).toEqual([]);
    expect(result.alreadyPresent).toEqual([
      'PreToolUse',
      'SessionStart',
      'Stop',
      'UserPromptSubmit',
      'PostToolUse',
      'PostToolUseFailure',
      'SubagentStart',
    ]);
    expect(await readFile(settingsPath(), 'utf8')).toBe(first);
  });

  /**
   * Once wired, push:false on a later call must not tear the six push entries
   * back out — `tenjin push off` is a config write, never a re-wire (see
   * commands/push.ts), and this path is the later `tenjin install`.
   *
   * The ONE thing it does put back is the WebSearch entry's matcher: WebFetch is
   * the push widening, it is in the base plan either way, and the ordinary
   * drift rewrite narrows it in place. Nothing is removed.
   */
  it('a later push:false run keeps the push entries and narrows the matcher back', async () => {
    await wireSearchHooks({ homeDir: home, dataDir: data, mode: 'auto', push: true });

    const result = await wireSearchHooks({ homeDir: home, dataDir: data, mode: 'auto' });
    expect(result.added).toEqual([]);
    expect(result.updated).toEqual(['PreToolUse']);

    const settings = await readSettings();
    expect(entriesFor(settings, 'PreToolUse')[0]!.matcher).toBe('WebSearch');
    // Every push entry is still registered, on all four of its events.
    for (const event of ['UserPromptSubmit', 'PostToolUseFailure', 'SubagentStart']) {
      expect(entriesFor(settings, event), event).toHaveLength(1);
    }
    expect(entriesFor(settings, 'PostToolUse')).toHaveLength(2);
    expect(entriesFor(settings, 'PreToolUse')).toHaveLength(3);
  });
});

describe('wireSearchHooks: idempotence', () => {
  it('a second run registers nothing and rewrites nothing', async () => {
    await wireSearchHooks({ homeDir: home, dataDir: data, mode: 'auto' });
    const first = await readFile(settingsPath(), 'utf8');

    const result = await wireSearchHooks({ homeDir: home, dataDir: data, mode: 'auto' });
    expect(result.added).toEqual([]);
    expect(result.updated).toEqual([]);
    expect(result.alreadyPresent).toEqual(['PreToolUse', 'SessionStart', 'Stop']);
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

    const pre = entriesFor(await readSettings(), 'PreToolUse');
    expect(pre).toHaveLength(3);
    // Position preserved, and the stranger's entry untouched.
    expect(pre[0]!.hooks[0]!.command).toBe('somebody-elses-hook');
    expect(pre[1]!.hooks[0]!.command).toContain(join(data, 'hooks', WEBSEARCH_HOOK_FILE));
    // The dispatch entry was absent, so it is appended rather than rewritten.
    expect(pre[2]!.hooks[0]!.command).toContain(join(data, 'hooks', DISPATCH_HOOK_FILE));
    // ONE list per event, by the strongest outcome: this run both rewrote a
    // drifted entry and appended a new one, and `added` is what it reports.
    expect(result.added).toContain('PreToolUse');
    expect(result.updated).not.toContain('PreToolUse');
    expect(result.alreadyPresent).not.toContain('PreToolUse');
  });

  it('reports an event in exactly one list, whatever mix of entries it carries', async () => {
    await wireSearchHooks({ homeDir: home, dataDir: data, mode: 'auto' });
    const settings = await readSettings();
    entriesFor(settings, 'PreToolUse')[0]!.hooks[0]!.command =
      `node /old/path/${WEBSEARCH_HOOK_FILE}`;
    await writeSettings(settings);

    const result = await wireSearchHooks({ homeDir: home, dataDir: data, mode: 'auto' });
    // Drifted WebSearch entry + untouched dispatch entry: updated beats
    // already-present, and the event appears once across all three lists.
    const appearances = [result.added, result.updated, result.alreadyPresent].filter((list) =>
      list.includes('PreToolUse'),
    );
    expect(appearances).toHaveLength(1);
    expect(result.updated).toContain('PreToolUse');
  });

  // Two entries land on one event in a single run; the second must append to the
  // list the first produced rather than to the list that was read from disk.
  it('keeps both PreToolUse entries when a second run rewrites a drifted one', async () => {
    await wireSearchHooks({ homeDir: home, dataDir: data, mode: 'auto' });
    const settings = await readSettings();
    const pre = entriesFor(settings, 'PreToolUse');
    pre[0]!.hooks[0]!.command = `node /old/path/${WEBSEARCH_HOOK_FILE}`;
    await writeSettings(settings);

    const result = await wireSearchHooks({ homeDir: home, dataDir: data, mode: 'auto' });
    expect(result.updated).toEqual(['PreToolUse']);
    const after = entriesFor(await readSettings(), 'PreToolUse');
    expect(after).toHaveLength(2);
    expect(after[0]!.hooks[0]!.command).toContain(join(data, 'hooks', WEBSEARCH_HOOK_FILE));
    expect(after[1]!.hooks[0]!.command).toContain(join(data, 'hooks', DISPATCH_HOOK_FILE));
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
    // Somebody else's SessionStart hook keeps its place ahead of ours.
    const start = entriesFor(settings, 'SessionStart');
    expect(start).toHaveLength(2);
    expect(start[0]!.hooks[0]!.command).toBe('greet.sh');
    const pre = entriesFor(settings, 'PreToolUse');
    expect(pre).toHaveLength(3);
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
    expect(result.added).toEqual(['PreToolUse', 'SessionStart', 'Stop']);
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

  // The window the FIRST compare cannot cover: another writer lands while the
  // scripts are being written, which is two read/write/rename sequences wide.
  // Without a compare adjacent to the commit, that edit is erased by a whole-file
  // replacement built from a snapshot taken before it.
  it('refuses when settings changes DURING writeScripts, and keeps the concurrent edit', async () => {
    await writeSettings({ model: 'original' });
    const theirs = JSON.stringify({ model: 'somebody-elses-edit' }, null, 2);
    fsHooks.settingsPath = settingsPath();
    fsHooks.settingsInterleaveOnScriptWrite = theirs;

    const result = await wireSearchHooks({ homeDir: home, dataDir: data, mode: 'auto' });

    expect(result.skipped).toBe('changed-since-read');
    // The other writer's bytes survive verbatim: nothing was clobbered.
    expect(await readFile(settingsPath(), 'utf8')).toBe(theirs);
    // And the report is accurate about the scripts that WERE refreshed, rather
    // than claiming nothing at all was touched.
    expect(result.scripts.length).toBeGreaterThan(0);
    for (const p of result.scripts) expect(existsSync(p)).toBe(true);
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

/**
 * The detector `tenjin update` uses to decide which profiles to re-materialize.
 * It reads paths, not script bodies, so it answers for hooks written by any
 * version. Everything it can meet in a real settings.json is data someone else
 * may have written, so nothing here may throw.
 */
describe('detectHookOwners', () => {
  const nodeCmd = (path: string): string => `node ${quoteForShell(path, 'linux')}`;

  it('finds the data dir behind each registered script', async () => {
    await wireSearchHooks({ homeDir: home, dataDir: data, mode: 'auto' });
    const owners = await detectHookOwners(home);
    expect(owners.map((o) => o.dataDir)).toEqual([data]);
    // Every base script is named, once each, however many events point at it.
    expect(owners[0]?.scripts.map((s) => s.replace(`${data}/hooks/`, '')).sort()).toEqual(
      [DISPATCH_HOOK_FILE, SESSIONSTART_HOOK_FILE, STOP_HOOK_FILE, WEBSEARCH_HOOK_FILE].sort(),
    );
  });

  /**
   * The whole reason the detector exists: a machine can carry hooks for a
   * profile that is not the one a bare `tenjin` resolves. Refreshing only the
   * invoking profile there leaves the scripts the harness actually fires stale.
   */
  it('finds every profile on a machine whose hooks are split across two', async () => {
    const shelf = await mkdtemp(join(tmpdir(), 'tenjin-hooks-shelf-'));
    try {
      await writeSettings({
        hooks: {
          PreToolUse: [
            {
              matcher: 'WebSearch',
              hooks: [
                { type: 'command', command: nodeCmd(join(data, 'hooks', WEBSEARCH_HOOK_FILE)) },
              ],
            },
          ],
          Stop: [
            {
              hooks: [{ type: 'command', command: nodeCmd(join(shelf, 'hooks', STOP_HOOK_FILE)) }],
            },
          ],
        },
      });
      const owners = await detectHookOwners(home);
      expect(owners.map((o) => o.dataDir).sort()).toEqual([data, shelf].sort());
    } finally {
      await rm(shelf, { recursive: true, force: true });
    }
  });

  it('claims nothing for entries that are not ours', async () => {
    await writeSettings({
      hooks: {
        PreToolUse: [
          // Someone else's hook, in a directory that happens to be called hooks.
          { hooks: [{ type: 'command', command: nodeCmd('/opt/other/hooks/lint.mjs') }] },
          // Our filename, but not under a `hooks/` dir, so the grandparent is
          // nothing in particular and must not be read as a data dir.
          { hooks: [{ type: 'command', command: nodeCmd(`/opt/${WEBSEARCH_HOOK_FILE}`) }] },
          // Not `node <path>` at all.
          { hooks: [{ type: 'command', command: `bash ${join(data, 'hooks', STOP_HOOK_FILE)}` }] },
          // A shape the harness allows and this module never writes.
          { hooks: [{ type: 'command' }] },
          { hooks: 'not an array' },
          'not an object',
        ],
      },
    });
    expect(await detectHookOwners(home)).toEqual([]);
  });

  it('answers empty on a missing, unreadable or malformed settings file', async () => {
    expect(await detectHookOwners(home)).toEqual([]);
    for (const contents of ['{ not json', '[]', '"a string"', JSON.stringify({ hooks: 7 })]) {
      await writeSettings(contents);
      expect(await detectHookOwners(home)).toEqual([]);
    }
    await writeSettings({ hooks: { PreToolUse: 'not an array' } });
    expect(await detectHookOwners(home)).toEqual([]);
  });
});

/**
 * `install --refresh`'s writer. The contract it has to keep, on every path, is
 * that it converges what exists and materializes nothing: an unattended `update`
 * runs it, and an upgrade that installs surfaces is not an upgrade.
 */
describe('refreshHooks', () => {
  it('brings drifted script bodies and entries up to date', async () => {
    await wireSearchHooks({ homeDir: home, dataDir: data, mode: 'auto' });
    const scriptPath = join(data, 'hooks', WEBSEARCH_HOOK_FILE);
    await writeFile(scriptPath, '// an older version wrote this\n');
    // And an entry whose timeout drifted, which only a rewrite can fix.
    const settings = await readSettings();
    const drifted = entriesFor(settings, 'Stop');
    drifted[0]!.hooks[0]!.timeout = 999;
    await writeSettings(settings);

    const result = await refreshHooks({ homeDir: home, dataDir: data, push: false });
    expect(result.scripts).toEqual([scriptPath]);
    expect(await readFile(scriptPath, 'utf8')).not.toBe('// an older version wrote this\n');
    expect(result.updated).toEqual(['Stop']);
    expect(entriesFor(await readSettings(), 'Stop')[0]?.hooks[0]?.timeout).not.toBe(999);
  });

  it('registers nothing on a machine that never installed', async () => {
    const result = await refreshHooks({ homeDir: home, dataDir: data, push: false });
    expect(result.scripts).toEqual([]);
    expect(result.updated).toEqual([]);
    expect(result.alreadyPresent).toEqual([]);
    expect(existsSync(settingsPath())).toBe(false);
    expect(existsSync(join(data, 'hooks'))).toBe(false);
  });

  /**
   * The narrower half of the same rule: surfaces exist, but not all of them.
   * A refresh must converge the ones that do and leave the gaps alone, because
   * filling a gap is what `tenjin install` is for.
   */
  it('adds no entry and no script the machine does not already have', async () => {
    await wireSearchHooks({ homeDir: home, dataDir: data, mode: 'auto' });
    // Drop one script and one event, as a half-finished uninstall would.
    await rm(join(data, 'hooks', STOP_HOOK_FILE));
    const settings = await readSettings();
    delete (settings.hooks as Record<string, unknown>).SessionStart;
    await writeSettings(settings);

    await refreshHooks({ homeDir: home, dataDir: data, push: false });
    expect(existsSync(join(data, 'hooks', STOP_HOOK_FILE))).toBe(false);
    expect(entriesFor(await readSettings(), 'SessionStart')).toEqual([]);
    // What was there is still there.
    expect(entriesFor(await readSettings(), 'Stop').length).toBe(1);
  });

  /**
   * The push arms are registered by `tenjin push on`, and the WebSearch entry's
   * matcher widens to WebSearch|WebFetch with them. A refresh that planned the
   * armed set on an unarmed machine would rewrite that entry and start firing
   * the hook on a tool the operator never armed it for.
   */
  it('does not widen the WebSearch matcher on a machine without push', async () => {
    await wireSearchHooks({ homeDir: home, dataDir: data, mode: 'auto' });
    await refreshHooks({ homeDir: home, dataDir: data, push: false });
    const entry = entriesFor(await readSettings(), 'PreToolUse').find((e) =>
      e.hooks[0]?.command.includes(WEBSEARCH_HOOK_FILE),
    );
    expect(entry?.matcher).toBe('WebSearch');
  });

  it('leaves an unreadable settings file alone and says so', async () => {
    await wireSearchHooks({ homeDir: home, dataDir: data, mode: 'auto' });
    await writeSettings('{ not json');
    const result = await refreshHooks({ homeDir: home, dataDir: data, push: false });
    expect(result.updated).toEqual([]);
    expect(result.warning).toContain('not valid JSON');
    expect(await readFile(settingsPath(), 'utf8')).toBe('{ not json');
    // The scripts are ours and were still brought up to date.
    expect(result.scriptsDir).toBe(join(data, 'hooks'));
  });

  it('refuses to commit over a settings file that changed underneath it', async () => {
    await wireSearchHooks({ homeDir: home, dataDir: data, mode: 'auto' });
    const settings = await readSettings();
    entriesFor(settings, 'Stop')[0]!.hooks[0]!.timeout = 999;
    await writeSettings(settings);
    const theirs = JSON.stringify({ hooks: {}, theirs: true }, null, 2);
    fsHooks.settingsInterleave = theirs;

    const result = await refreshHooks({ homeDir: home, dataDir: data, push: false });
    expect(result.updated).toEqual([]);
    expect(result.warning).toContain('changed while it was being refreshed');
    expect(await readFile(settingsPath(), 'utf8')).toBe(theirs);
  });
});
