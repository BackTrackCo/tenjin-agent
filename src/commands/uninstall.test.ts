import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runUninstall } from './uninstall';
import { claudeSettingsPath, FREE_VERB_RULES, PUBLISH_MODE_RULE } from '../lib/harness-permissions';
import { STOP_HOOK_FILE, WEBSEARCH_HOOK_FILE } from '../lib/hook-scripts';
import { hooksDir } from '../lib/paths';
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
  const res = await runUninstall(makeCtx(), { home });
  return { report: res.data as UninstallReport, text: (res.humanLines ?? []).join('\n') };
};

/** A settings.json holding our two hook entries and our rules, plus a stranger's. */
async function seedSettings(extra: Record<string, unknown> = {}): Promise<string> {
  const path = claudeSettingsPath(home);
  await mkdir(join(home, '.claude'), { recursive: true });
  const settings = {
    hooks: {
      PreToolUse: [
        {
          matcher: 'WebSearch',
          hooks: [{ type: 'command', command: `node '${WEBSEARCH_HOOK_FILE}'` }],
        },
        { matcher: 'Bash', hooks: [{ type: 'command', command: 'node /someone/else.mjs' }] },
      ],
      Stop: [{ hooks: [{ type: 'command', command: `node '${STOP_HOOK_FILE}'` }] }],
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

async function seedHookScripts(): Promise<void> {
  await mkdir(hooksDir(data), { recursive: true });
  for (const f of [WEBSEARCH_HOOK_FILE, STOP_HOOK_FILE]) {
    await writeFile(join(hooksDir(data), f), '// generated\n');
  }
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
    expect(report.scripts).toHaveLength(2);
    expect(existsSync(join(hooksDir(data), STOP_HOOK_FILE))).toBe(false);
    expect(report.settings.hooks.sort()).toEqual(['PreToolUse', 'Stop']);
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

  it('never touches anything under the data dir', async () => {
    await seedSettings();
    await seedHookScripts();
    const keep = {
      'wallet.json': '{"wallet":true}',
      'config.json': '{"baseUrl":"https://tenjin.blog"}',
      'searches.json': '{"schemaVersion":1,"searches":[]}',
    };
    for (const [file, body] of Object.entries(keep)) await writeFile(join(data, file), body);
    await mkdir(join(data, 'candidates', 'abc'), { recursive: true });
    await writeFile(join(data, 'candidates', 'abc', 'draft.md'), '# parked\n');

    const { report, text } = await run();

    for (const [file, body] of Object.entries(keep)) {
      expect(await readFile(join(data, file), 'utf8'), file).toBe(body);
    }
    expect(await readFile(join(data, 'candidates', 'abc', 'draft.md'), 'utf8')).toBe('# parked\n');
    // And it SAYS so, every run: the boundary is the point of the command.
    expect(report.kept.length).toBeGreaterThan(0);
    expect(text).toContain('Kept (uninstall never touches these)');
    expect(text).toContain('wallet');
    // The pen is gone as a feature, but an older version's files are still the
    // operator's, so the promise names that path explicitly.
    expect(text).toContain('~/.tenjin/candidates');
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
    expect(report.scripts).toHaveLength(2);
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
    expect(text).toContain('Kept (uninstall never touches these)');
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
    expect(report.scripts).toHaveLength(2);
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
    expect(report.scripts).toHaveLength(2);
    expect(text).toContain('not valid JSON');
  });
});
