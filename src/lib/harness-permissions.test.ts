import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * A seam for the one property that only exists BETWEEN two reads: the writer
 * re-reads the file it based its edit on, immediately before committing. Inert
 * unless a test arms it, so every other test here runs against the real fs.
 */
const fsHooks = vi.hoisted(() => ({ afterRead: null as null | ((path: string) => Promise<void>) }));
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    readFile: async (...args: Parameters<typeof actual.readFile>) => {
      const out = await actual.readFile(...args);
      if (fsHooks.afterRead !== null) await fsHooks.afterRead(String(args[0]));
      return out;
    },
  };
});
import {
  chmod,
  lstat,
  mkdtemp,
  mkdir,
  realpath,
  rm,
  readFile,
  symlink,
  writeFile,
  stat,
} from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  claudeSettingsPath,
  FORBIDDEN_VERB_FRAGMENTS,
  FREE_VERB_RULES,
  inspectFreeVerbRules,
  permissionsSkipped,
  wireFreeVerbAllowlist,
} from './harness-permissions';
import { ALWAYS_SAFE_ALLOWLIST, NEVER_ALLOWLISTED, OPT_IN_ALLOWLIST } from './permissions';

let home: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'tenjin-perms-home-'));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

const settingsPath = (): string => claudeSettingsPath(home);

async function readSettings(): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(settingsPath(), 'utf8')) as Record<string, unknown>;
}

async function seedSettings(value: unknown): Promise<void> {
  await mkdir(join(home, '.claude'), { recursive: true });
  await writeFile(
    settingsPath(),
    typeof value === 'string' ? value : JSON.stringify(value, null, 2),
  );
}

const allowOf = (s: Record<string, unknown>): unknown[] =>
  (s.permissions as { allow: unknown[] }).allow;

describe('FREE_VERB_RULES: what the writer is allowed to write', () => {
  it('is exactly the ten free-verb rules, in the README/doctor order', () => {
    expect([...FREE_VERB_RULES]).toEqual([
      'Bash(tenjin search:*)',
      'Bash(tenjin fund:*)',
      'Bash(tenjin inspect:*)',
      'Bash(tenjin read:*)',
      'Bash(tenjin outcome:*)',
      'Bash(tenjin doctor:*)',
      'Bash(tenjin wallet show:*)',
      'Bash(tenjin wallet balance:*)',
      'Bash(tenjin config get:*)',
      'Bash(tenjin candidate list:*)',
    ]);
  });

  it('matches the always-safe tier doctor prints, so the two never drift', () => {
    expect([...FREE_VERB_RULES]).toEqual(ALWAYS_SAFE_ALLOWLIST.map((e) => e.rule));
  });

  it('contains no verb that spends, signs, or changes state', () => {
    for (const rule of FREE_VERB_RULES) {
      for (const fragment of FORBIDDEN_VERB_FRAGMENTS) {
        expect(rule).not.toContain(fragment);
      }
    }
  });

  it('never carries an opt-in or excluded verb, whatever those lists grow to', () => {
    const forbidden = [
      ...OPT_IN_ALLOWLIST.map((e) => e.command),
      ...NEVER_ALLOWLISTED.flatMap((e) => e.command.split(' / ')),
    ];
    for (const rule of FREE_VERB_RULES) {
      for (const command of forbidden) expect(rule).not.toContain(command);
    }
  });

  it('is never a broad wildcard over the whole CLI', () => {
    expect(FREE_VERB_RULES).not.toContain('Bash(tenjin:*)');
    expect(FREE_VERB_RULES.every((r) => r.startsWith('Bash(tenjin '))).toBe(true);
  });
});

describe('wireFreeVerbAllowlist: fresh file', () => {
  it('creates ~/.claude/settings.json with exactly the free-verb allowlist', async () => {
    const result = await wireFreeVerbAllowlist(home);
    expect(result.harness).toBe('claude');
    expect(result.path).toBe(settingsPath());
    expect(result.added).toEqual([...FREE_VERB_RULES]);
    expect(result.alreadyPresent).toEqual([]);
    expect(result.skipped).toBeUndefined();

    const settings = await readSettings();
    expect(Object.keys(settings)).toEqual(['permissions']);
    expect(allowOf(settings)).toEqual([...FREE_VERB_RULES]);
  });

  it('writes 2-space JSON with a trailing newline', async () => {
    await wireFreeVerbAllowlist(home);
    const raw = await readFile(settingsPath(), 'utf8');
    expect(raw.endsWith('\n')).toBe(true);
    expect(raw).toContain('\n  "permissions": {');
    expect(raw).toContain('\n      "Bash(tenjin search:*)"');
  });

  it('leaves no temp file behind (the write is atomic)', async () => {
    await wireFreeVerbAllowlist(home);
    const { readdir } = await import('node:fs/promises');
    const entries = await readdir(join(home, '.claude'));
    expect(entries).toEqual(['settings.json']);
  });

  it('writes a normal-mode file, not one only root can read', async () => {
    await wireFreeVerbAllowlist(home);
    if (process.platform === 'win32') return; // fs modes are a no-op there
    expect((await stat(settingsPath())).mode & 0o777).toBe(0o644);
  });
});

describe('wireFreeVerbAllowlist: merging into an existing file', () => {
  it('preserves every other key and every existing allow entry, verbatim and in order', async () => {
    await seedSettings({
      $schema: 'https://json.schemastore.org/claude-code-settings.json',
      model: 'opus',
      permissions: {
        deny: ['Bash(rm:*)'],
        allow: ['Bash(git status:*)', 'Read(//tmp/**)'],
      },
      hooks: { PreToolUse: [] },
    });

    const result = await wireFreeVerbAllowlist(home);
    expect(result.added).toEqual([...FREE_VERB_RULES]);

    const settings = await readSettings();
    expect(settings.$schema).toBe('https://json.schemastore.org/claude-code-settings.json');
    expect(settings.model).toBe('opus');
    expect(settings.hooks).toEqual({ PreToolUse: [] });
    expect((settings.permissions as { deny: string[] }).deny).toEqual(['Bash(rm:*)']);
    // Existing entries keep their positions; ours are appended after them.
    expect(allowOf(settings)).toEqual(['Bash(git status:*)', 'Read(//tmp/**)', ...FREE_VERB_RULES]);
    // Key order is preserved too, so a diff shows only the appended rules.
    expect(Object.keys(settings)).toEqual(['$schema', 'model', 'permissions', 'hooks']);
  });

  it('adds only the missing rules when some are already there', async () => {
    await seedSettings({
      permissions: { allow: ['Bash(tenjin search:*)', 'Bash(tenjin doctor:*)'] },
    });

    const result = await wireFreeVerbAllowlist(home);
    expect(result.alreadyPresent).toEqual(['Bash(tenjin search:*)', 'Bash(tenjin doctor:*)']);
    expect(result.added).not.toContain('Bash(tenjin search:*)');
    expect(result.added).toHaveLength(FREE_VERB_RULES.length - 2);

    const allow = allowOf(await readSettings());
    expect(allow).toHaveLength(FREE_VERB_RULES.length);
    for (const rule of FREE_VERB_RULES) {
      expect(allow.filter((e) => e === rule)).toHaveLength(1);
    }
  });

  it('creates permissions.allow when the file exists without it', async () => {
    await seedSettings({ model: 'opus' });
    await wireFreeVerbAllowlist(home);
    const settings = await readSettings();
    expect(settings.model).toBe('opus');
    expect(allowOf(settings)).toEqual([...FREE_VERB_RULES]);
  });

  it('creates allow when permissions exists with only a deny list', async () => {
    await seedSettings({ permissions: { deny: ['Bash(curl:*)'] } });
    await wireFreeVerbAllowlist(home);
    const settings = await readSettings();
    expect((settings.permissions as { deny: string[] }).deny).toEqual(['Bash(curl:*)']);
    expect(allowOf(settings)).toEqual([...FREE_VERB_RULES]);
  });

  it('keeps non-string allow entries it does not understand', async () => {
    await seedSettings({ permissions: { allow: [{ tool: 'Bash' }, 'Bash(ls:*)'] } });
    await wireFreeVerbAllowlist(home);
    expect(allowOf(await readSettings())).toEqual([
      { tool: 'Bash' },
      'Bash(ls:*)',
      ...FREE_VERB_RULES,
    ]);
  });
});

describe('wireFreeVerbAllowlist: idempotency', () => {
  it('a re-run adds nothing, reports everything as already present, and does not rewrite the file', async () => {
    await wireFreeVerbAllowlist(home);
    const before = await readFile(settingsPath(), 'utf8');
    const beforeMtime = (await stat(settingsPath())).mtimeMs;

    const second = await wireFreeVerbAllowlist(home);
    expect(second.added).toEqual([]);
    expect(second.alreadyPresent).toEqual([...FREE_VERB_RULES]);
    expect(second.skipped).toBeUndefined();
    expect(await readFile(settingsPath(), 'utf8')).toBe(before);
    expect((await stat(settingsPath())).mtimeMs).toBe(beforeMtime);
  });

  it('never duplicates a rule across three runs', async () => {
    await wireFreeVerbAllowlist(home);
    await wireFreeVerbAllowlist(home);
    await wireFreeVerbAllowlist(home);
    expect(allowOf(await readSettings())).toEqual([...FREE_VERB_RULES]);
  });
});

describe('inspectFreeVerbRules: a probe that cannot write', () => {
  it('reports every rule on a machine with no settings file, and creates nothing', async () => {
    expect((await inspectFreeVerbRules(home)).pending).toEqual([...FREE_VERB_RULES]);
    expect(existsSync(settingsPath())).toBe(false);
  });

  it('reports none once the rules are wired, without rewriting the file', async () => {
    await wireFreeVerbAllowlist(home);
    const before = await readFile(settingsPath(), 'utf8');
    const beforeMtime = (await stat(settingsPath())).mtimeMs;

    expect((await inspectFreeVerbRules(home)).pending).toEqual([]);
    expect(await readFile(settingsPath(), 'utf8')).toBe(before);
    expect((await stat(settingsPath())).mtimeMs).toBe(beforeMtime);
  });

  it('reports only the missing subset', async () => {
    await seedSettings({ permissions: { allow: [FREE_VERB_RULES[0], 'Bash(ls:*)'] } });
    expect((await inspectFreeVerbRules(home)).pending).toEqual(FREE_VERB_RULES.slice(1));
  });

  // Null is "unknown", which the caller must not read as "nothing to do": a file
  // we cannot understand is exactly when the consent question still has to be asked.
  it.each([
    ['malformed JSON', '{ nope'],
    ['a non-object document', '[1, 2, 3]'],
    ['a foreign permissions shape', JSON.stringify({ permissions: 'yes' })],
    ['a foreign allow shape', JSON.stringify({ permissions: { allow: 'everything' } })],
  ])('returns null for %s', async (_name, contents) => {
    await seedSettings(contents);
    expect((await inspectFreeVerbRules(home)).pending).toBeNull();
  });
});

describe('wireFreeVerbAllowlist: refuses to touch what it cannot understand', () => {
  it('skips malformed JSON and leaves the bytes exactly as they were', async () => {
    const broken = '{ "permissions": { "allow": [ // a comment\n] }\n';
    await seedSettings(broken);

    const result = await wireFreeVerbAllowlist(home);
    expect(result.skipped).toBe('unparsable');
    expect(result.added).toEqual([]);
    expect(result.warning).toContain('not valid JSON');
    expect(await readFile(settingsPath(), 'utf8')).toBe(broken);
  });

  it('skips a settings file that is not a JSON object', async () => {
    await seedSettings('[1, 2, 3]');
    const result = await wireFreeVerbAllowlist(home);
    expect(result.skipped).toBe('unexpected-shape');
    expect(await readFile(settingsPath(), 'utf8')).toBe('[1, 2, 3]');
  });

  it('skips when permissions is not an object', async () => {
    await seedSettings({ permissions: 'all' });
    const result = await wireFreeVerbAllowlist(home);
    expect(result.skipped).toBe('unexpected-shape');
    expect(result.warning).toContain('"permissions"');
    expect((await readSettings()).permissions).toBe('all');
  });

  it('skips when permissions.allow is not an array', async () => {
    await seedSettings({ permissions: { allow: 'everything' } });
    const result = await wireFreeVerbAllowlist(home);
    expect(result.skipped).toBe('unexpected-shape');
    expect((await readSettings()).permissions).toEqual({ allow: 'everything' });
  });

  it('leaves an unparsable file byte-identical', async () => {
    await seedSettings('nonsense');
    await wireFreeVerbAllowlist(home);
    expect(await readFile(settingsPath(), 'utf8')).toBe('nonsense');
  });

  it('skips an unreadable file rather than replacing it', async () => {
    if (process.platform === 'win32' || process.getuid?.() === 0) return; // mode 0 is not a barrier
    await seedSettings({ permissions: { allow: [] } });
    await chmod(settingsPath(), 0o000);
    try {
      const result = await wireFreeVerbAllowlist(home);
      expect(result.skipped).toBe('unreadable');
      expect(result.added).toEqual([]);
      expect(result.warning).toContain('could not be read');
    } finally {
      await chmod(settingsPath(), 0o600);
    }
  });
});

describe('wireFreeVerbAllowlist: a symlinked settings file', () => {
  it('edits the link target and leaves the link in place', async () => {
    // The dotfiles shape: ~/.claude/settings.json is a symlink into a repo the
    // operator maintains. writeFileAtomic commits with a rename, which would
    // replace the link with a regular file and strand the dotfiles copy.
    const dotfiles = await mkdtemp(join(tmpdir(), 'tenjin-dotfiles-'));
    const target = join(dotfiles, 'claude-settings.json');
    try {
      await writeFile(target, JSON.stringify({ model: 'opus' }, null, 2));
      await mkdir(join(home, '.claude'), { recursive: true });
      await symlink(target, settingsPath());

      const result = await wireFreeVerbAllowlist(home);
      expect(result.added).toEqual([...FREE_VERB_RULES]);
      // Reported at the file that was actually written.
      expect(result.path).toBe(await realpath(target));

      // The link survives, and the operator's own file is what changed.
      expect((await lstat(settingsPath())).isSymbolicLink()).toBe(true);
      const written = JSON.parse(await readFile(target, 'utf8')) as {
        model: string;
        permissions: { allow: string[] };
      };
      expect(written.model).toBe('opus');
      expect(written.permissions.allow).toEqual([...FREE_VERB_RULES]);
    } finally {
      await rm(dotfiles, { recursive: true, force: true });
    }
  });

  it('skips a broken symlink instead of writing a regular file over it', async () => {
    await mkdir(join(home, '.claude'), { recursive: true });
    await symlink(join(home, 'nowhere', 'settings.json'), settingsPath());
    const result = await wireFreeVerbAllowlist(home);
    expect(result.skipped).toBe('unresolvable');
    expect(result.added).toEqual([]);
    expect(result.path).toBe(settingsPath());
    expect((await lstat(settingsPath())).isSymbolicLink()).toBe(true);
  });
});

describe('permissionsSkipped', () => {
  it('shapes a non-write decision like a write outcome, naming the file it did not touch', () => {
    const result = permissionsSkipped('claude', home, 'declined');
    expect(result).toEqual({
      harness: 'claude',
      path: settingsPath(),
      added: [],
      alreadyPresent: [],
      skipped: 'declined',
      // Every skipped state names the command that changes it, so a machine
      // consumer reads the remedy as a field rather than parsing prose.
      fix: 'Add them with `tenjin install --allow-free-verbs`.',
    });
    expect(existsSync(settingsPath())).toBe(false);
  });

  it('carries a fix on every skip reason there is', async () => {
    const reasons = [
      'harness-not-claude',
      'not-requested',
      'declined',
      'dry-run',
      'unresolvable',
      'unreadable',
      'unparsable',
      'unexpected-shape',
      'changed-since-read',
    ] as const;
    for (const reason of reasons) {
      const result = permissionsSkipped('claude', home, reason);
      expect(result.fix, reason).toBeTruthy();
      expect(result.fix, reason).toMatch(/tenjin (install|doctor)/);
    }
  });

  it('names no path for a harness that has no such file', () => {
    // A Codex-only install has no ~/.claude/settings.json in play, so the
    // envelope must not point its reader at one.
    for (const harness of ['codex', 'shared']) {
      const result = permissionsSkipped(harness, home, 'harness-not-claude');
      expect(result.harness).toBe(harness);
      expect(result.path).toBeUndefined();
      expect(result).not.toHaveProperty('path');
    }
  });
});

describe('wireFreeVerbAllowlist: refuses to clobber a concurrent write', () => {
  // Whole-file read-modify-write, so a change landing in the read-to-rename window
  // would be erased entirely, including keys with nothing to do with permissions.
  // Claude Code writes this file too, so the competing writer is not hypothetical.
  // The interleave is real: the file is rewritten from inside the first read, which
  // is exactly where a competing writer would land.
  it('writes nothing when the file changed since the snapshot it edited', async () => {
    await seedSettings({ model: 'opus', permissions: { allow: [] } });
    const theirs = `${JSON.stringify({ model: 'opus', theirKey: 1, permissions: { allow: [] } }, null, 2)}\n`;

    // A competing writer lands the instant our first read returns, which is the
    // top of the read-to-rename window.
    let armed = true;
    fsHooks.afterRead = async (path) => {
      // Matched by basename: the writer reads the REALPATH, which on macOS differs
      // from the declared path (/var vs /private/var).
      if (!armed || !path.endsWith('settings.json')) return;
      armed = false;
      await writeFile(settingsPath(), theirs);
    };
    try {
      const result = await wireFreeVerbAllowlist(home);
      expect(result.skipped).toBe('changed-since-read');
      expect(result.added).toEqual([]);
      expect(result.warning).toContain('changed while it was being updated');
    } finally {
      fsHooks.afterRead = null;
    }
    // Their write survives in full, including the key we would have erased.
    expect(await readFile(settingsPath(), 'utf8')).toBe(theirs);
  });

  it('writes normally when nothing else touches the file', async () => {
    await seedSettings({ model: 'opus', permissions: { allow: [] } });
    const result = await wireFreeVerbAllowlist(home);
    expect(result.skipped).toBeUndefined();
    expect(result.added).toEqual([...FREE_VERB_RULES]);
  });
});
