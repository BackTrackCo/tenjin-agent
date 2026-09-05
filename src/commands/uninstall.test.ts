import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runUninstall } from './uninstall';
import { STATE_DB_FILE, openStore } from '../lib/state-store';
import { claudeSettingsPath, FREE_VERB_RULES, PUBLISH_MODE_RULE } from '../lib/harness-permissions';
import { RETIRED_HOOK_FILES, writeClaudeHooks } from '../lib/harness-hooks';
import type { DaemonStart } from '../daemon/control';
import { daemonPidPath, daemonTokenPath, hooksDir, shimBundlePath } from '../lib/paths';
import type { UninstallReport } from '../lib/uninstall';
import type { CommandContext } from '../context';

let home: string;
let data: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'tenjin-uninstall-home-'));
  data = await mkdtemp(join(tmpdir(), 'tenjin-uninstall-data-'));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
  await rm(data, { recursive: true, force: true });
});

function makeCtx(): CommandContext {
  const sink = () => ({ write: () => true }) as unknown as NodeJS.WritableStream;
  return {
    flags: { json: true, timeout: 5000 },
    dataDir: data,
    io: { stdout: sink(), stderr: sink(), isTTY: false },
  };
}

const MARKER = '<!-- tenjin-cli:skills -->';

const run = async (): Promise<{ report: UninstallReport; text: string }> => {
  // Never the real one: uninstall must not signal a process this suite did not
  // start, and there is no daemon behind these fixtures anyway.
  const res = await runUninstall(makeCtx(), {
    home,
    stop: () => Promise.resolve({ state: 'not-running' as const }),
  });
  return { report: res.data as UninstallReport, text: (res.humanLines ?? []).join('\n') };
};

/** Steps 1-3 of the real writer, without a process behind them. */
async function fakeStart(dataDir: string): Promise<DaemonStart> {
  await mkdir(hooksDir(dataDir), { recursive: true });
  await writeFile(shimBundlePath(dataDir), '// shim');
  await writeFile(join(hooksDir(dataDir), 'tenjin-daemon.mjs'), '// daemon');
  await writeFile(daemonTokenPath(dataDir), 'a'.repeat(64), { mode: 0o600 });
  await writeFile(
    daemonPidPath(dataDir),
    JSON.stringify({ pid: 4242, port: 34567, started_at: 1, data_dir: dataDir }),
  );
  return {
    health: {
      version: '9.9.9',
      pid: 4242,
      port: 34567,
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

const wire = (): Promise<unknown> =>
  writeClaudeHooks({ homeDir: home, dataDir: data, mode: 'auto', start: fakeStart });

/** A settings.json holding every hook entry we write and our rules, plus a
 *  stranger's on two of the same events. */
async function seedSettings(extra: Record<string, unknown> = {}): Promise<string> {
  const path = claudeSettingsPath(home);
  await mkdir(join(home, '.claude'), { recursive: true });
  const settings = {
    hooks: {
      PreToolUse: [
        {
          matcher: 'WebSearch',
          hooks: [{ type: 'command', command: `node 'tenjin-websearch-hook.mjs'` }],
        },
        { matcher: 'Bash', hooks: [{ type: 'command', command: 'node /someone/else.mjs' }] },
        {
          matcher: 'Agent|Task',
          hooks: [{ type: 'command', command: `node 'tenjin-dispatch-hook.mjs'` }],
        },
      ],
      SessionStart: [
        {
          matcher: 'startup|clear|compact',
          hooks: [{ type: 'command', command: `node 'tenjin-sessionstart-hook.mjs'` }],
        },
      ],
      Stop: [{ hooks: [{ type: 'command', command: `node 'tenjin-stop-hook.mjs'` }] }],
    },
    permissions: { allow: [...FREE_VERB_RULES, 'Bash(ls:*)'] },
    ...extra,
  };
  await writeFile(path, `${JSON.stringify(settings, null, 2)}\n`);
  return path;
}

async function seedSkill(dir: string, name: string, frontmatterName = name): Promise<string> {
  const skillDir = join(home, dir, name);
  await mkdir(skillDir, { recursive: true });
  await writeFile(
    join(skillDir, 'SKILL.md'),
    `---\nname: ${frontmatterName}\ndescription: d\n---\n\nbody\n`,
  );
  return skillDir;
}

/** What a machine that upgraded but never re-installed still carries. */
async function seedHookScripts(): Promise<void> {
  await mkdir(hooksDir(data), { recursive: true });
  for (const f of RETIRED_HOOK_FILES) await writeFile(join(hooksDir(data), f), '// generated\n');
}

describe('runUninstall — a fully installed machine', () => {
  it('removes the skills, the scripts, the hook entries and the rules', async () => {
    const path = await seedSettings();
    await seedSkill('.claude/skills', 'tenjin-search');
    await seedSkill('.claude/skills', 'tenjin-publish');
    await seedHookScripts();

    const { report } = await run();

    expect(report.skills).toHaveLength(2);
    expect(existsSync(join(home, '.claude', 'skills', 'tenjin-search'))).toBe(false);
    expect(report.scripts).toHaveLength(RETIRED_HOOK_FILES.length);
    for (const f of RETIRED_HOOK_FILES) {
      expect(existsSync(join(hooksDir(data), f)), f).toBe(false);
    }
    expect(report.settings.hooks.sort()).toEqual(['PreToolUse', 'SessionStart', 'Stop']);
    expect(report.settings.rules.sort()).toEqual([...FREE_VERB_RULES].sort());

    const after = JSON.parse(await readFile(path, 'utf8')) as Record<string, never>;
    expect(after).toEqual({
      // The stranger's PreToolUse entry survives, and Stop is gone entirely
      // because ours was the only entry in it.
      hooks: {
        PreToolUse: [
          { matcher: 'Bash', hooks: [{ type: 'command', command: 'node /someone/else.mjs' }] },
        ],
      },
      permissions: { allow: ['Bash(ls:*)'] },
    });
  });

  // Ownership, not position: a rule or entry we did not write keeps its place even
  // when one of ours is removed from in front of it.
  it('leaves another tool’s hook entry and allow rule exactly where they were', async () => {
    const path = await seedSettings();
    await run();
    const after = JSON.parse(await readFile(path, 'utf8')) as {
      hooks: { PreToolUse: { matcher: string }[] };
      permissions: { allow: string[] };
    };
    expect(after.hooks.PreToolUse).toHaveLength(1);
    expect(after.hooks.PreToolUse[0]?.matcher).toBe('Bash');
    expect(after.permissions.allow).toEqual(['Bash(ls:*)']);
  });

  it('keeps every key it does not own in settings.json', async () => {
    const path = await seedSettings({ model: 'opus', env: { FOO: '1' } });
    await run();
    const after = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
    expect(after.model).toBe('opus');
    expect(after.env).toEqual({ FOO: '1' });
  });

  it('keeps everything under the data dir but the hook scripts it generated', async () => {
    await seedSettings();
    await seedHookScripts();
    const keep = {
      'wallet.json': '{"wallet":true}',
      // With a door key, because the receipt line asserted below is conditional
      // on this machine actually holding one.
      'config.json': '{"baseUrl":"https://shelf.example","shelfBypassSecret":"door-key"}',
      'library.json': '{"receipts":[]}',
    };
    for (const [file, body] of Object.entries(keep)) await writeFile(join(data, file), body);

    const { report, text } = await run();

    for (const [file, body] of Object.entries(keep)) {
      expect(await readFile(join(data, file), 'utf8'), file).toBe(body);
    }
    // And it SAYS so, every run: the boundary is the point of the command.
    expect(report.kept.length).toBeGreaterThan(0);
    expect(text).toContain('Kept:');
    expect(text).toContain('wallet');
    /**
     * The exception, stated. The hook scripts live under the same directory the
     * kept list is about, this run just deleted them, and the same payload lists
     * them under `scripts` — so a blanket "never touches anything under ~/.tenjin"
     * was contradicted by the receipt printed directly above it.
     */
    expect(report.scripts.length).toBeGreaterThan(0);
    expect(text).toContain('Removed from ~/.tenjin:');
    expect(text).toContain('~/.tenjin/hooks');
    /**
     * The kept config includes `publish.mode`, which is the one kept value that
     * GRANTS something on the next `install`: the mode-gated rules come back under
     * it. That is the intended model, but an operator uninstalling to revoke has
     * to be told, and the receipt is where they are looking.
     */
    expect(text).toContain('publish.mode included');
    /**
     * And the one kept value that is not the operator's own: the team shelf's
     * door key is shared with everyone else behind that deployment, so an
     * uninstall that reads as "handing this machine on" has to name it and say
     * how to clear it. Clearing it FOR them is not on: the key is not ours to
     * revoke, and a teammate's shelf must not go dark over an uninstall.
     */
    expect(text).toContain('shelfBypassSecret');
    expect(text).toContain('tenjin config set shelfBypassSecret ""');
    for (const item of report.kept) {
      expect(item, item).not.toMatch(/everything under/i);
    }
  });

  /**
   * And NOT on the machines that have no such key, which is most of them:
   * `shelfBypassSecret` defaults to `''`. An imperative to clear a credential
   * that is not there is a receipt line an operator can check and find false, and
   * a receipt whose only job is to be read cannot afford one.
   */
  it('does not name the shelf key on a public-mode machine', async () => {
    await seedSettings();
    await writeFile(join(data, 'config.json'), '{"baseUrl":"https://tenjin.blog"}');

    const { report, text } = await run();

    expect(text).not.toContain('shelfBypassSecret');
    expect(report.kept.some((item) => item.includes('shelfBypassSecret'))).toBe(false);
    // Everything else it keeps is still named, so this is a conditional line and
    // not a quieter receipt.
    expect(text).toContain('publish.mode included');
  });

  /** An empty string is the default, and defaults are not credentials. */
  it('does not name the shelf key when the config holds an empty one', async () => {
    await seedSettings();
    await writeFile(join(data, 'config.json'), '{"shelfBypassSecret":""}');

    const { text } = await run();
    expect(text).not.toContain('shelfBypassSecret');
  });
});

describe('runUninstall — rules a prior version wrote', () => {
  // install is append-only, so a rule retired from the recommended set survives
  // on every machine that ever had it. uninstall is the reverse of install, and
  // that includes reversing versions of install the operator ran before.
  it('reclaims the retired candidate allow-rule an older install left behind', async () => {
    const path = claudeSettingsPath(home);
    await mkdir(join(home, '.claude'), { recursive: true });
    await writeFile(
      path,
      JSON.stringify({
        permissions: {
          allow: [...FREE_VERB_RULES, 'Bash(tenjin candidate list:*)', 'Bash(ls:*)'],
        },
      }),
    );

    const { report } = await run();

    expect(report.settings.rules).toContain('Bash(tenjin candidate list:*)');
    const after = JSON.parse(await readFile(path, 'utf8')) as {
      permissions: { allow: string[] };
    };
    // Only the operator's own rule is left.
    expect(after.permissions.allow).toEqual(['Bash(ls:*)']);
  });

  // `buy` is an OPT-IN line: the operator pastes it themselves and this CLI has
  // no path that writes it, so it is not ours to take away.
  it('leaves an unrelated tenjin-shaped rule the CLI never wrote', async () => {
    const path = claudeSettingsPath(home);
    await mkdir(join(home, '.claude'), { recursive: true });
    await writeFile(path, JSON.stringify({ permissions: { allow: ['Bash(tenjin buy:*)'] } }));
    await run();
    const after = JSON.parse(await readFile(path, 'utf8')) as {
      permissions: { allow: string[] };
    };
    expect(after.permissions.allow).toEqual(['Bash(tenjin buy:*)']);
  });

  // The publish rule IS ours: `install` writes it whenever publish.mode is auto
  // or full-auto, so uninstall reclaims it like every other rule this CLI wrote,
  // whatever the mode says on the way out.
  it('reclaims the publish rule the publish modes write', async () => {
    const path = claudeSettingsPath(home);
    await mkdir(join(home, '.claude'), { recursive: true });
    await writeFile(
      path,
      JSON.stringify({ permissions: { allow: [PUBLISH_MODE_RULE, 'Bash(ls:*)'] } }),
    );
    const { report } = await run();
    expect(report.settings.rules).toContain(PUBLISH_MODE_RULE);
    const after = JSON.parse(await readFile(path, 'utf8')) as {
      permissions: { allow: string[] };
    };
    expect(after.permissions.allow).toEqual(['Bash(ls:*)']);
  });
});

/**
 * tenjin-search ships a `references/` subdirectory. Uninstall reclaims exactly
 * the declared files and prunes only what it empties.
 */
describe('runUninstall — a skill that ships more than SKILL.md', () => {
  it('removes the shipped reference file and the directory it emptied', async () => {
    const dir = await seedSkill('.claude/skills', 'tenjin-search');
    await mkdir(join(dir, 'references'), { recursive: true });
    await writeFile(join(dir, 'references', 'permissions.md'), 'shipped');

    const { report } = await run();
    expect(report.skills).toContain(dir);
    expect(existsSync(join(dir, 'references', 'permissions.md'))).toBe(false);
    expect(existsSync(join(dir, 'references'))).toBe(false);
    expect(existsSync(dir)).toBe(false);
  });

  // The operator's own file in the same subdirectory keeps itself, its
  // directory, and the skill directory above it.
  it("keeps a user's file in the shipped subdirectory, and both directories", async () => {
    const dir = await seedSkill('.claude/skills', 'tenjin-search');
    await mkdir(join(dir, 'references'), { recursive: true });
    await writeFile(join(dir, 'references', 'permissions.md'), 'shipped');
    await writeFile(join(dir, 'references', 'notes.md'), 'mine');

    await run();
    expect(existsSync(join(dir, 'references', 'permissions.md'))).toBe(false);
    expect(await readFile(join(dir, 'references', 'notes.md'), 'utf8')).toBe('mine');
    expect(existsSync(dir)).toBe(true);
  });

  // Ownership is proven by SKILL.md's frontmatter, so a directory that is not
  // ours keeps its reference file too.
  it('leaves the reference file when the SKILL.md is not ours', async () => {
    const dir = await seedSkill('.claude/skills', 'tenjin-search', 'someone-elses-skill');
    await mkdir(join(dir, 'references'), { recursive: true });
    await writeFile(join(dir, 'references', 'permissions.md'), 'shipped');

    const { report } = await run();
    expect(report.skills).toEqual([]);
    expect(existsSync(join(dir, 'references', 'permissions.md'))).toBe(true);
  });

  it('is fine when the reference file was already gone', async () => {
    const dir = await seedSkill('.claude/skills', 'tenjin-search');
    const { report } = await run();
    expect(report.skills).toContain(dir);
    expect(existsSync(dir)).toBe(false);
  });
});

describe('runUninstall — ownership gates', () => {
  // Somebody else's skill is not ours to delete just for sitting at our path.
  it('leaves a skill directory whose frontmatter names something else', async () => {
    const dir = await seedSkill('.claude/skills', 'tenjin-search', 'someone-elses-skill');
    const { report } = await run();
    expect(report.skills).toEqual([]);
    expect(existsSync(dir)).toBe(true);
  });

  it('leaves a hook entry whose command is not one of our scripts', async () => {
    const path = claudeSettingsPath(home);
    await mkdir(join(home, '.claude'), { recursive: true });
    await writeFile(
      path,
      JSON.stringify({
        hooks: { Stop: [{ hooks: [{ type: 'command', command: 'node /other/stop.mjs' }] }] },
      }),
    );
    const { report } = await run();
    expect(report.settings.hooks).toEqual([]);
    const after = JSON.parse(await readFile(path, 'utf8')) as { hooks: { Stop: unknown[] } };
    expect(after.hooks.Stop).toHaveLength(1);
  });

  it('leaves a file someone else parked in the hooks directory, and the directory', async () => {
    await seedHookScripts();
    await writeFile(join(hooksDir(data), 'theirs.mjs'), '// not ours\n');
    const { report } = await run();
    expect(report.scripts).toHaveLength(RETIRED_HOOK_FILES.length);
    expect(report.hooksDir).toBeUndefined();
    expect(existsSync(join(hooksDir(data), 'theirs.mjs'))).toBe(true);
  });

  it('removes the hooks directory when our scripts were all that was in it', async () => {
    await seedHookScripts();
    const { report } = await run();
    expect(report.hooksDir).toBe(hooksDir(data));
    expect(existsSync(hooksDir(data))).toBe(false);
  });
});

describe('runUninstall — operator files in our directories', () => {
  // The data-loss shape this repo already unlearned on the write side: our file
  // is ours, the directory it sits in is not.
  it('removes SKILL.md but keeps an operator file beside it, and the directory', async () => {
    const skillDir = await seedSkill('.claude/skills', 'tenjin-search');
    const notes = join(skillDir, 'notes.md');
    await writeFile(notes, '# my own notes\n');

    const { report } = await run();

    expect(existsSync(join(skillDir, 'SKILL.md'))).toBe(false);
    expect(existsSync(notes)).toBe(true);
    expect(await readFile(notes, 'utf8')).toBe('# my own notes\n');
    expect(existsSync(skillDir)).toBe(true);
    // Still reported as removed: our file is gone, which is what the caller asked.
    expect(report.skills).toEqual([skillDir]);
  });

  it('removes the directory when our file was the only thing in it', async () => {
    const skillDir = await seedSkill('.claude/skills', 'tenjin-publish');
    const { report } = await run();
    expect(existsSync(skillDir)).toBe(false);
    expect(report.skills).toEqual([skillDir]);
  });
});

describe('runUninstall — legacy pointer line', () => {
  it('removes the marker line and preserves the operator’s own text', async () => {
    const path = join(home, '.claude', 'CLAUDE.md');
    await mkdir(join(home, '.claude'), { recursive: true });
    await writeFile(path, `# Notes\n${MARKER} Tenjin: search first\nkeep me\n`);
    const { report } = await run();
    expect(report.markers).toEqual([path]);
    const after = await readFile(path, 'utf8');
    expect(after).not.toContain(MARKER);
    expect(after).toContain('# Notes');
    expect(after).toContain('keep me');
  });

  // The marker only ever began a line. A user quoting it inside their own
  // sentence keeps that sentence.
  it('keeps a line that merely mentions the marker mid-sentence', async () => {
    const path = join(home, '.claude', 'CLAUDE.md');
    await mkdir(join(home, '.claude'), { recursive: true });
    const prose = `I removed the ${MARKER} line by hand last week.`;
    await writeFile(path, `${prose}\n`);
    const { report } = await run();
    expect(report.markers).toEqual([]);
    expect(await readFile(path, 'utf8')).toBe(`${prose}\n`);
  });

  it('removes a line that starts with the marker, keeping the rest', async () => {
    const path = join(home, '.claude', 'CLAUDE.md');
    await mkdir(join(home, '.claude'), { recursive: true });
    const prose = `Note: the ${MARKER} token is what install used to write.`;
    await writeFile(path, `# Notes\n${MARKER} Tenjin: search first\n${prose}\n`);
    const { report } = await run();
    expect(report.markers).toEqual([path]);
    const after = await readFile(path, 'utf8');
    expect(after).toContain('# Notes');
    expect(after).toContain(prose);
    expect(after).not.toContain(`${MARKER} Tenjin: search first`);
  });

  it('finds a drifted line by its marker, not by exact text', async () => {
    const path = join(home, '.agents', 'AGENTS.md');
    await mkdir(join(home, '.agents'), { recursive: true });
    await writeFile(path, `${MARKER} some much older wording nobody ships any more\n`);
    await run();
    expect(await readFile(path, 'utf8')).not.toContain(MARKER);
  });
});

describe('runUninstall — partial and repeat states', () => {
  it('reports nothing to remove on a machine that never installed', async () => {
    const { report, text } = await run();
    expect(report.skills).toEqual([]);
    expect(report.scripts).toEqual([]);
    expect(report.settings.skipped).toBe('absent');
    expect(text).toContain('Nothing to remove');
    // The kept list still shows, because that is the reassurance being sought.
    expect(text).toContain('Kept:');
  });

  it('is idempotent: a second run removes nothing and still exits cleanly', async () => {
    await seedSettings();
    await seedSkill('.claude/skills', 'tenjin-search');
    await seedHookScripts();
    await run();

    const { report, text } = await run();
    expect(report.skills).toEqual([]);
    expect(report.scripts).toEqual([]);
    expect(report.settings.hooks).toEqual([]);
    expect(report.settings.rules).toEqual([]);
    expect(text).toContain('Nothing to remove');
  });

  it('handles a half-installed machine: scripts but no settings, skills but no scripts', async () => {
    await seedHookScripts();
    await seedSkill('.claude/skills', 'tenjin-publish');
    const { report } = await run();
    expect(report.scripts).toHaveLength(RETIRED_HOOK_FILES.length);
    expect(report.skills).toHaveLength(1);
    expect(report.settings.skipped).toBe('absent');
  });

  // Unreadable settings must not fail the command or lose the other steps.
  it('reports an unparsable settings.json and still removes the rest', async () => {
    await mkdir(join(home, '.claude'), { recursive: true });
    await writeFile(claudeSettingsPath(home), '{ not json');
    await seedHookScripts();
    const { report, text } = await run();
    expect(report.settings.skipped).toBe('unparsable');
    expect(report.scripts).toHaveLength(RETIRED_HOOK_FILES.length);
    expect(text).toContain('not valid JSON');
  });
});

/**
 * The daemon entries, wired by the REAL writer rather than by a hand-written
 * fixture: uninstall's whole claim is that it is the exact reverse of what
 * install wrote, and a fixture typed here would go stale the day a twelfth entry
 * is added, silently passing while the real machine keeps one forever.
 */
describe('runUninstall — the loop daemon', () => {
  it('removes every entry the writer registered and every file it installed', async () => {
    await mkdir(join(home, '.claude'), { recursive: true });
    await writeFile(claudeSettingsPath(home), '{}\n');
    await wire();
    expect(existsSync(shimBundlePath(data))).toBe(true);
    expect(existsSync(daemonTokenPath(data))).toBe(true);

    const { report } = await run();

    expect(existsSync(shimBundlePath(data))).toBe(false);
    expect(existsSync(daemonTokenPath(data))).toBe(false);
    expect(existsSync(daemonPidPath(data))).toBe(false);
    // Every event the entries were registered under is reported as cleared.
    expect(report.settings.hooks.sort()).toEqual(
      [
        'PostToolUse',
        'PostToolUseFailure',
        'PreToolUse',
        'SessionStart',
        'Stop',
        'SubagentStart',
        'SubagentStop',
        'UserPromptSubmit',
      ].sort(),
    );
    // Nothing of ours is left anywhere in the file.
    expect(JSON.parse(await readFile(claudeSettingsPath(home), 'utf8'))).toEqual({});
  });

  it('KEEPS both state stores, whatever hooks.push says', async () => {
    await mkdir(join(home, '.claude'), { recursive: true });
    await writeFile(claudeSettingsPath(home), '{}\n');
    await wire();
    await writeFile(join(data, 'config.json'), JSON.stringify({ hooks: { push: 'off' } }));
    // A real store, with its WAL sidecars, as a machine that has run the hooks
    // would have.
    const store = await openStore(data);
    store?.run('INSERT INTO session_state (session, key, value, at) VALUES (?, ?, ?, ?)', [
      's',
      'k',
      '"v"',
      Date.now(),
    ]);
    store?.close();
    await writeFile(join(data, 'loop.db'), 'not really sqlite, but it is the operator’s');

    const { report, text } = await run();

    expect(report.settings.hooks).toContain('UserPromptSubmit');
    // The stores hold the operator's own record — the pairings this machine
    // worked out, the outcome history, the open loops — so they are kept for the
    // same reason the wallet and the config are, and a later install picks them
    // up as they are.
    expect(existsSync(join(data, STATE_DB_FILE))).toBe(true);
    expect(existsSync(join(data, 'loop.db'))).toBe(true);
    expect(existsSync(join(data, 'config.json'))).toBe(true);
    // And SAID so: the receipt names them under Kept, never under Removed.
    const kept = text.slice(text.indexOf('Kept:'));
    expect(kept).toContain('~/.tenjin/state.db');
    expect(kept).toContain('~/.tenjin/loop.db');
    const removed = text.slice(0, text.indexOf('Kept:'));
    expect(removed).not.toContain('state.db');
  });

  it('leaves a stranger’s entry on one of our events alone', async () => {
    await mkdir(join(home, '.claude'), { recursive: true });
    await writeFile(
      claudeSettingsPath(home),
      `${JSON.stringify({
        hooks: {
          UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'node /someone/else.mjs' }] }],
        },
      })}\n`,
    );
    await wire();
    await run();
    const after = JSON.parse(await readFile(claudeSettingsPath(home), 'utf8')) as {
      hooks: { UserPromptSubmit: unknown[] };
    };
    expect(after.hooks.UserPromptSubmit).toEqual([
      { hooks: [{ type: 'command', command: 'node /someone/else.mjs' }] },
    ]);
  });
});
