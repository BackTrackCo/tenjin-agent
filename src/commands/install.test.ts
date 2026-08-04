import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * Arms the one failure the filesystem will not produce on demand: the lock
 * directory refusing to be removed. Inert unless a test sets it, so production
 * carries no test-only branch.
 */
const fsHooks = vi.hoisted(() => ({
  failLockRelease: false,
  settingsInterleave: '',
  /** Which settings.json read to land the interleave after (1-based). */
  settingsInterleaveOnRead: 1,
  settingsReads: 0,
  /** Swap this path for a FIFO the moment it is renamed into place. */
  fifoAfterRename: '',
}));
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    rename: async (...args: Parameters<typeof actual.rename>) => {
      const out = await actual.rename(...args);
      // An external writer swapping the just-landed file for a pipe, which is the
      // window between the guarded write and the invocability readback.
      if (fsHooks.fifoAfterRename !== '' && String(args[1]) === fsHooks.fifoAfterRename) {
        const target = fsHooks.fifoAfterRename;
        fsHooks.fifoAfterRename = '';
        await actual.rm(target, { force: true });
        const { execFileSync } = await import('node:child_process');
        execFileSync('mkfifo', [target]);
      }
      return out;
    },
    readFile: async (...args: Parameters<typeof actual.readFile>) => {
      const out = await actual.readFile(...args);
      // A competing writer lands the instant the permissions read returns, which
      // is the top of that writer's read-to-rename window.
      if (fsHooks.settingsInterleave !== '' && String(args[0]).endsWith('settings.json')) {
        fsHooks.settingsReads += 1;
        if (fsHooks.settingsReads === fsHooks.settingsInterleaveOnRead) {
          const bytes = fsHooks.settingsInterleave;
          fsHooks.settingsInterleave = '';
          await actual.writeFile(String(args[0]), bytes);
        }
      }
      return out;
    },
  };
});
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    rmSync: (...args: Parameters<typeof actual.rmSync>) => {
      if (fsHooks.failLockRelease && String(args[0]).endsWith('skills-sync.lock')) {
        throw Object.assign(new Error('EPERM'), { code: 'EPERM' });
      }
      return actual.rmSync(...args);
    },
  };
});
import {
  chmod,
  lstat,
  mkdtemp,
  mkdir,
  readdir,
  realpath,
  rm,
  readFile,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInstall, PERMISSIONS_QUESTION, PUBLISH_MODE_CHOICES } from './install';
import type { InstallDeps, PromptPublishModeFn } from './install';
import { resolveSkillsSource, SKILL_NAMES } from '../lib/skills-source';
import { ALWAYS_SAFE_ALLOWLIST, NEVER_ALLOWLISTED } from '../lib/permissions';
import {
  claudeSettingsPath,
  FREE_VERB_RULES,
  inspectFreeVerbRules,
} from '../lib/harness-permissions';
import { CliError } from '../lib/errors';
import type { DoctorChecks } from './doctor';
import type { CommandContext, GlobalFlags } from '../context';

// Real packaged skills, resolved once from this test's location. Using the real
// source (not a fixture) also proves the copy lands byte-identical content.
const SKILLS_SRC = resolveSkillsSource(fileURLToPath(new URL('.', import.meta.url)));
const MARKER = 'tenjin-cli:skills';

let home: string;
let data: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'tenjin-install-home-'));
  data = await mkdtemp(join(tmpdir(), 'tenjin-install-data-'));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
  await rm(data, { recursive: true, force: true });
});

function makeCtx(flags: Partial<GlobalFlags> = {}): CommandContext {
  const sink = () => ({ write: () => true }) as unknown as NodeJS.WritableStream;
  return {
    flags: { json: false, timeout: 10000, ...flags },
    dataDir: data,
    io: { stdout: sink(), stderr: sink(), isTTY: false },
  };
}

// Default doctor stub: one passing check, no network. Overridden per-test.
const okChecks: DoctorChecks = {
  checks: [{ name: 'stub', status: 'ok', required: true, detail: 'ok' }],
};

function deps(over: Partial<InstallDeps> = {}): InstallDeps {
  return {
    homeDir: home,
    skillsSourceDir: SKILLS_SRC,
    which: () => false,
    collectChecks: async () => okChecks,
    // Every prompt seam is answered in-process, so no test renders a prompt or
    // loads the clack chunk. The defaults are the "changed nothing" answers;
    // decision-specific tests override them.
    walletExists: async () => false,
    confirmWallet: async () => false,
    promptPublishMode: async () => null,
    confirmPermissions: async () => false,
    intro: async () => {},
    outro: async () => {},
    ...over,
  };
}

async function caught<T>(fn: () => Promise<T>): Promise<CliError> {
  try {
    await fn();
  } catch (e) {
    return e as CliError;
  }
  throw new Error('expected the call to throw');
}

type Harnesses = Array<{
  harness: string;
  detected: boolean;
  detectedBy: string[];
  skillsDir: string;
  skills: Array<{
    name: string;
    status: string;
    preexisting: boolean;
    cli: boolean;
    modelInvocable: boolean;
  }>;
  hostedPreexisting: boolean;
  hostedArrivedFirst: boolean;
  agentsMd?: { path: string; status: string };
  claudeMd?: { path: string; status: string };
  codexNetworkRule?: string;
  warnings: string[];
  notes: string[];
}>;
type Data = { dryRun: boolean; skillsSource: string; harnesses: Harnesses; doctor: unknown };

const asData = (d: unknown) => d as Data;

describe('runInstall: harness override', () => {
  it('installs only Claude when --harness claude, no AGENTS.md wiring', async () => {
    const { data: d } = await runInstall({ harness: ['claude'] }, makeCtx(), deps());
    const out = asData(d);
    expect(out.harnesses).toHaveLength(1);
    const h = out.harnesses[0]!;
    expect(h.harness).toBe('claude');
    expect(h.detectedBy).toEqual(['override']);
    expect(h.skillsDir).toBe(join(home, '.claude', 'skills'));
    expect(h.agentsMd).toBeUndefined();
    expect(h.codexNetworkRule).toBeUndefined();
    expect(h.skills.map((s) => s.status)).toEqual(SKILL_NAMES.map(() => 'installed'));
    for (const name of SKILL_NAMES) {
      expect(existsSync(join(home, '.claude', 'skills', name, 'SKILL.md'))).toBe(true);
    }
  });

  it('installs Codex to ~/.agents/skills, wires AGENTS.md, and carries the config.toml rule', async () => {
    const { data: d } = await runInstall({ harness: ['codex'] }, makeCtx(), deps());
    const h = asData(d).harnesses[0]!;
    expect(h.harness).toBe('codex');
    expect(h.skillsDir).toBe(join(home, '.agents', 'skills'));
    expect(h.agentsMd?.status).toBe('appended');
    expect(h.agentsMd?.path).toBe(join(home, '.agents', 'AGENTS.md'));
    expect(h.codexNetworkRule).toBe('[sandbox_workspace_write]\nnetwork_access = true');
    expect(existsSync(join(home, '.agents', 'skills', 'tenjin', 'SKILL.md'))).toBe(true);
  });

  it('dedupes codex + shared onto the one ~/.agents/skills target', async () => {
    const { data: d } = await runInstall({ harness: ['codex', 'shared'] }, makeCtx(), deps());
    expect(asData(d).harnesses).toHaveLength(1);
  });

  it('rejects an unknown harness as USAGE / exit 2', async () => {
    const err = await caught(() => runInstall({ harness: ['cursor'] }, makeCtx(), deps()));
    expect(err.code).toBe('USAGE');
    expect(err.exitCode).toBe(2);
  });
});

describe('runInstall: detection', () => {
  it('detects Claude from ~/.claude and Codex from ~/.codex directories', async () => {
    await mkdir(join(home, '.claude'), { recursive: true });
    await mkdir(join(home, '.codex'), { recursive: true });
    const { data: d } = await runInstall({}, makeCtx(), deps());
    const byName = Object.fromEntries(asData(d).harnesses.map((h) => [h.harness, h]));
    expect(byName.claude!.detectedBy).toEqual(['home-dir']);
    expect(byName.codex!.detectedBy).toEqual(['home-dir']);
  });

  it('detects a harness from a binary on PATH', async () => {
    const { data: d } = await runInstall({}, makeCtx(), deps({ which: (bin) => bin === 'claude' }));
    const out = asData(d);
    expect(out.harnesses).toHaveLength(1);
    expect(out.harnesses[0]!.harness).toBe('claude');
    expect(out.harnesses[0]!.detectedBy).toEqual(['binary']);
  });

  it('falls back to the shared Agent Skills location when nothing is detected', async () => {
    const { data: d } = await runInstall({}, makeCtx(), deps());
    const out = asData(d);
    expect(out.harnesses).toHaveLength(1);
    const h = out.harnesses[0]!;
    expect(h.harness).toBe('shared');
    expect(h.detected).toBe(false);
    expect(h.detectedBy).toEqual(['fallback']);
    expect(h.skillsDir).toBe(join(home, '.agents', 'skills'));
    expect(existsSync(join(home, '.agents', 'skills', 'tenjin', 'SKILL.md'))).toBe(true);
  });

  it('resolves the packaged skills itself when no source is injected', async () => {
    // Omit skillsSourceDir so runInstall resolves it from import.meta.url. Proves
    // the global-install / repo-run resolution path, not just the injected one.
    const { data: d } = await runInstall(
      { harness: ['claude'] },
      makeCtx(),
      deps({ skillsSourceDir: undefined }),
    );
    expect(asData(d).skillsSource.endsWith('skills')).toBe(true);
    expect(existsSync(join(home, '.claude', 'skills', 'tenjin', 'SKILL.md'))).toBe(true);
  });
});

describe('runInstall: dry run', () => {
  it('writes nothing and reports would-* statuses', async () => {
    const { data: d } = await runInstall(
      { harness: ['claude', 'codex'], dryRun: true },
      makeCtx(),
      deps(),
    );
    const out = asData(d);
    expect(out.dryRun).toBe(true);
    for (const h of out.harnesses) {
      expect(h.skills.every((s) => s.status === 'would-install')).toBe(true);
    }
    const codex = out.harnesses.find((h) => h.harness === 'codex');
    expect(codex?.agentsMd?.status).toBe('would-append');
    // Nothing on disk.
    expect(existsSync(join(home, '.claude', 'skills'))).toBe(false);
    expect(existsSync(join(home, '.agents', 'skills'))).toBe(false);
    expect(existsSync(join(home, '.agents', 'AGENTS.md'))).toBe(false);
  });
});

describe('runInstall: idempotency', () => {
  it('re-run reports up-to-date and already-present, with identical files', async () => {
    const first = await runInstall({ harness: ['claude', 'codex'] }, makeCtx(), deps());
    const firstCodex = asData(first.data).harnesses.find((h) => h.harness === 'codex');
    expect(firstCodex?.agentsMd?.status).toBe('appended');

    const before = await readFile(join(home, '.claude', 'skills', 'tenjin', 'SKILL.md'), 'utf8');

    const second = await runInstall({ harness: ['claude', 'codex'] }, makeCtx(), deps());
    const out = asData(second.data);
    for (const h of out.harnesses) {
      expect(h.skills.every((s) => s.status === 'up-to-date')).toBe(true);
    }
    const codex = out.harnesses.find((h) => h.harness === 'codex');
    expect(codex?.agentsMd?.status).toBe('already-present');

    const after = await readFile(join(home, '.claude', 'skills', 'tenjin', 'SKILL.md'), 'utf8');
    expect(after).toBe(before);
  });

  it('appends the AGENTS.md pointer line exactly once across re-runs', async () => {
    await runInstall({ harness: ['codex'] }, makeCtx(), deps());
    await runInstall({ harness: ['codex'] }, makeCtx(), deps());
    const agents = await readFile(join(home, '.agents', 'AGENTS.md'), 'utf8');
    const count = agents.split(MARKER).length - 1;
    expect(count).toBe(1);
  });

  it('preserves pre-existing AGENTS.md content when appending', async () => {
    await mkdir(join(home, '.agents'), { recursive: true });
    await writeFile(join(home, '.agents', 'AGENTS.md'), '# My notes\n');
    await runInstall({ harness: ['codex'] }, makeCtx(), deps());
    const agents = await readFile(join(home, '.agents', 'AGENTS.md'), 'utf8');
    expect(agents.startsWith('# My notes\n')).toBe(true);
    expect(agents.split(MARKER).length - 1).toBe(1);
  });

  // The nudge writers follow the same rule as the skill files: a dotfiles-managed
  // AGENTS.md is written THROUGH its link. Committing with `rename` on the link's
  // path would replace the link with a regular file and strand its target.
  it('writes through a symlinked AGENTS.md, keeping the link and updating its target', async () => {
    if (process.platform === 'win32') return;
    const managed = join(home, 'dotfiles', 'AGENTS.md');
    await mkdir(dirname(managed), { recursive: true });
    await writeFile(managed, '# My notes\n');
    await mkdir(join(home, '.agents'), { recursive: true });
    const link = join(home, '.agents', 'AGENTS.md');
    await symlink(managed, link);

    await runInstall({ harness: ['codex'] }, makeCtx(), deps());
    expect((await lstat(link)).isSymbolicLink()).toBe(true);
    const text = await readFile(managed, 'utf8');
    expect(text.startsWith('# My notes\n')).toBe(true);
    expect(text.split(MARKER).length - 1).toBe(1);
  });

  // A directory (or any non-regular file) at the AGENTS.md path is a typed error
  // naming the path, not a raw EISDIR under INTERNAL.
  it('fails a non-regular AGENTS.md with a typed error instead of a raw errno', async () => {
    await mkdir(join(home, '.agents', 'AGENTS.md'), { recursive: true });
    const err = (await runInstall({ harness: ['codex'] }, makeCtx(), deps()).catch(
      (e) => e,
    )) as CliError;
    expect(err).toBeInstanceOf(CliError);
    expect(err.message).toContain('not a regular file');
    expect(err.message).not.toContain('EISDIR');
    expect(err.fix).toContain('ls -l');
  });

  // The probe is lazy: once ~/.agents/AGENTS.md owns the marker (the steady state
  // of a re-run), a broken ~/.codex/AGENTS.md this run would never write must not
  // fail the install.
  it('ignores a broken ~/.codex/AGENTS.md when the shared file already owns the marker', async () => {
    await runInstall({ harness: ['codex'] }, makeCtx(), deps());
    await mkdir(join(home, '.codex', 'AGENTS.md'), { recursive: true });
    const { data: d } = await runInstall({ harness: ['codex'] }, makeCtx(), deps());
    expect(asData(d).harnesses[0]!.agentsMd?.status).toBe('already-present');
  });
});

describe('runInstall: AGENTS.md instinct nudge', () => {
  const OLD_LINE = `<!-- tenjin-cli:skills --> Tenjin agent skills are installed at /somewhere (tenjin-search, tenjin-publish, tenjin). Read the relevant SKILL.md before using the tenjin CLI.`;

  it('appends a search-first nudge that points at the skills dir', async () => {
    await runInstall({ harness: ['codex'] }, makeCtx(), deps());
    const agents = await readFile(join(home, '.agents', 'AGENTS.md'), 'utf8');
    expect(agents).toContain(`'tenjin search "<question>" --json'`);
    expect(agents).toContain('before regenerating public research');
    expect(agents).toContain('sends the generalized question text to tenjin.blog');
    expect(agents).toContain(join(home, '.agents', 'skills'));
    expect(agents).not.toContain('—'); // no em dashes
  });

  it('replaces an older marker line in place instead of appending a duplicate', async () => {
    await mkdir(join(home, '.agents'), { recursive: true });
    await writeFile(join(home, '.agents', 'AGENTS.md'), `# notes\n${OLD_LINE}\nmore\n`);

    const { data: d } = await runInstall({ harness: ['codex'] }, makeCtx(), deps());
    const h = asData(d).harnesses[0]!;
    expect(h.agentsMd?.status).toBe('updated');

    const agents = await readFile(join(home, '.agents', 'AGENTS.md'), 'utf8');
    expect(agents.split(MARKER).length - 1).toBe(1); // still exactly one marker
    expect(agents).not.toContain('installed at /somewhere'); // old text gone
    expect(agents).toContain(`'tenjin search "<question>" --json'`); // new text in
    expect(agents.startsWith('# notes\n')).toBe(true); // surrounding lines preserved
    expect(agents.trimEnd().endsWith('more')).toBe(true);
  });

  it('leaves a matching nudge line untouched (already-present)', async () => {
    await runInstall({ harness: ['codex'] }, makeCtx(), deps());
    const before = await readFile(join(home, '.agents', 'AGENTS.md'), 'utf8');
    const { data: d } = await runInstall({ harness: ['codex'] }, makeCtx(), deps());
    expect(asData(d).harnesses[0]!.agentsMd?.status).toBe('already-present');
    expect(await readFile(join(home, '.agents', 'AGENTS.md'), 'utf8')).toBe(before);
  });

  it('dry-run over a drifted line reports would-update and writes nothing', async () => {
    await mkdir(join(home, '.agents'), { recursive: true });
    await writeFile(join(home, '.agents', 'AGENTS.md'), `${OLD_LINE}\n`);
    const { data: d } = await runInstall({ harness: ['codex'], dryRun: true }, makeCtx(), deps());
    expect(asData(d).harnesses[0]!.agentsMd?.status).toBe('would-update');
    expect(await readFile(join(home, '.agents', 'AGENTS.md'), 'utf8')).toBe(`${OLD_LINE}\n`);
  });
});

describe('runInstall: CLAUDE.md nudge', () => {
  const claudeMdPath = () => join(home, '.claude', 'CLAUDE.md');

  // Same contract as the symlinked AGENTS.md: written through the link.
  it('writes through a symlinked CLAUDE.md, keeping the link and updating its target', async () => {
    if (process.platform === 'win32') return;
    const managed = join(home, 'dotfiles', 'CLAUDE.md');
    await mkdir(dirname(managed), { recursive: true });
    await writeFile(managed, '# Mine\n');
    await mkdir(join(home, '.claude'), { recursive: true });
    await symlink(managed, claudeMdPath());

    await runInstall({ harness: ['claude'], claudeMd: true }, makeCtx(), deps());
    expect((await lstat(claudeMdPath())).isSymbolicLink()).toBe(true);
    const text = await readFile(managed, 'utf8');
    expect(text.startsWith('# Mine\n')).toBe(true);
    expect(text.split(MARKER).length - 1).toBe(1);
  });
  const OLD_LINE = `<!-- tenjin-cli:skills --> Tenjin agent skills are installed at /old (tenjin-search, tenjin-publish, tenjin). Read the relevant SKILL.md before using the tenjin CLI.`;

  it('skips CLAUDE.md by default on a non-interactive run (no flag, no file)', async () => {
    const { data: d } = await runInstall({ harness: ['claude'] }, makeCtx(), deps());
    expect(asData(d).harnesses[0]!.claudeMd?.status).toBe('skipped');
    expect(existsSync(claudeMdPath())).toBe(false);
  });

  it('--claude-md writes the nudge pointing at ~/.claude/skills', async () => {
    const { data: d } = await runInstall(
      { harness: ['claude'], claudeMd: true },
      makeCtx(),
      deps(),
    );
    expect(asData(d).harnesses[0]!.claudeMd?.status).toBe('written');
    const md = await readFile(claudeMdPath(), 'utf8');
    expect(md).toContain(`'tenjin search "<question>" --json'`);
    expect(md).toContain('sends the generalized question text to tenjin.blog');
    expect(md).toContain(join(home, '.claude', 'skills'));
    expect(md.split(MARKER).length - 1).toBe(1);
  });

  it('re-running --claude-md is idempotent (up-to-date, file unchanged)', async () => {
    await runInstall({ harness: ['claude'], claudeMd: true }, makeCtx(), deps());
    const before = await readFile(claudeMdPath(), 'utf8');
    const { data: d } = await runInstall(
      { harness: ['claude'], claudeMd: true },
      makeCtx(),
      deps(),
    );
    expect(asData(d).harnesses[0]!.claudeMd?.status).toBe('up-to-date');
    expect(await readFile(claudeMdPath(), 'utf8')).toBe(before);
  });

  it('replaces an older marker line in CLAUDE.md in place', async () => {
    await mkdir(join(home, '.claude'), { recursive: true });
    await writeFile(claudeMdPath(), `# my rules\n${OLD_LINE}\n`);
    const { data: d } = await runInstall(
      { harness: ['claude'], claudeMd: true },
      makeCtx(),
      deps(),
    );
    expect(asData(d).harnesses[0]!.claudeMd?.status).toBe('updated');
    const md = await readFile(claudeMdPath(), 'utf8');
    expect(md.split(MARKER).length - 1).toBe(1);
    expect(md).not.toContain('installed at /old');
    expect(md.startsWith('# my rules\n')).toBe(true);
  });

  it('--dry-run with --claude-md is would-write and writes nothing', async () => {
    const { data: d } = await runInstall(
      { harness: ['claude'], claudeMd: true, dryRun: true },
      makeCtx(),
      deps(),
    );
    expect(asData(d).harnesses[0]!.claudeMd?.status).toBe('would-write');
    expect(existsSync(claudeMdPath())).toBe(false);
  });

  it('--no-claude-md skips, interactive or not', async () => {
    const { data: d } = await runInstall(
      { harness: ['claude'], claudeMd: false },
      makeCtx(),
      deps({ isInteractive: true }),
    );
    expect(asData(d).harnesses[0]!.claudeMd?.status).toBe('skipped');
    expect(existsSync(claudeMdPath())).toBe(false);
  });

  // The walkthrough is capped at three decisions, so the nudge is never a fourth
  // question: an interactive run without the flag behaves like a headless one.
  it('is never asked about interactively; an absent flag skips it', async () => {
    const res = await runInstall({ harness: ['claude'] }, makeCtx(), deps({ isInteractive: true }));
    expect(asData(res.data).harnesses[0]!.claudeMd?.status).toBe('skipped');
    expect(existsSync(claudeMdPath())).toBe(false);
  });

  it('--claude-md writes it on an interactive run too', async () => {
    const res = await runInstall(
      { harness: ['claude'], claudeMd: true },
      makeCtx(),
      deps({ isInteractive: true }),
    );
    expect(asData(res.data).harnesses[0]!.claudeMd?.status).toBe('written');
    expect(existsSync(claudeMdPath())).toBe(true);
  });
});

describe('runInstall: nudge disclosure + undo hint in the walkthrough', () => {
  const human = (res: { humanLines?: string[] }): string =>
    (res.humanLines ?? []).join('\n').replace(/\x1b\[[0-9;]*m/g, ''); // eslint-disable-line no-control-regex

  it('discloses what a freshly written AGENTS.md nudge does + how to undo it', async () => {
    const res = await runInstall({ harness: ['codex'] }, makeCtx(), deps({ isInteractive: true }));
    const text = human(res);
    expect(text).toContain('the generalized question text is sent to tenjin.blog');
    expect(text).toContain('Undo anytime: delete the');
    expect(text).toContain(join(home, '.agents', 'AGENTS.md'));
  });

  it('discloses + undo for a CLAUDE.md nudge written by --claude-md', async () => {
    const res = await runInstall(
      { harness: ['claude'], claudeMd: true },
      makeCtx(),
      deps({ isInteractive: true }),
    );
    const text = human(res);
    expect(text).toContain('CLAUDE.md nudge');
    expect(text).toContain('the generalized question text is sent to tenjin.blog');
    expect(text).toContain(join(home, '.claude', 'CLAUDE.md'));
  });

  it('does NOT disclose on an untouched re-run (already-present)', async () => {
    await runInstall({ harness: ['codex'] }, makeCtx(), deps());
    const res = await runInstall({ harness: ['codex'] }, makeCtx(), deps({ isInteractive: true }));
    const text = human(res);
    expect(text).not.toContain('Undo anytime');
    expect(text).not.toContain('the generalized question text is sent to tenjin.blog');
  });

  it('discloses a silent in-place upgrade of an older AGENTS.md pointer line', async () => {
    const OLD = `<!-- tenjin-cli:skills --> Tenjin agent skills are installed at /old (tenjin-search, tenjin-publish, tenjin). Read the relevant SKILL.md before using the tenjin CLI.`;
    await mkdir(join(home, '.agents'), { recursive: true });
    await writeFile(join(home, '.agents', 'AGENTS.md'), `${OLD}\n`);
    const res = await runInstall({ harness: ['codex'] }, makeCtx(), deps({ isInteractive: true }));
    const text = human(res);
    expect(text).toContain('Undo anytime');
    expect(text).toContain('the generalized question text is sent to tenjin.blog');
  });
});

describe('runInstall: canonical overwrite', () => {
  it('overwrites a locally modified skill copy and warns', async () => {
    const dest = join(home, '.claude', 'skills', 'tenjin');
    await mkdir(dest, { recursive: true });
    await writeFile(join(dest, 'SKILL.md'), 'stale local edit\n');

    const { data: d } = await runInstall({ harness: ['claude'] }, makeCtx(), deps());
    const h = asData(d).harnesses[0]!;
    const tenjin = h.skills.find((s) => s.name === 'tenjin');
    expect(tenjin?.status).toBe('updated');
    expect(h.warnings.length).toBeGreaterThan(0);

    const source = await readFile(join(SKILLS_SRC, 'tenjin', 'SKILL.md'), 'utf8');
    const written = await readFile(join(dest, 'SKILL.md'), 'utf8');
    expect(written).toBe(source);
  });

  // install owns the files it ships, not the directory they live in. Anything else
  // there is the operator's and is never read, listed, or removed.
  it('writes the packaged files and leaves everything else in the directory alone', async () => {
    const dest = join(home, '.claude', 'skills', 'tenjin');
    await mkdir(dest, { recursive: true });
    await writeFile(join(dest, 'SKILL.md'), 'stale\n');
    await writeFile(join(dest, 'stray.txt'), 'orphan\n');

    await runInstall({ harness: ['claude'] }, makeCtx(), deps());
    expect(await readFile(join(dest, 'stray.txt'), 'utf8')).toBe('orphan\n');
    expect(await readFile(join(dest, 'SKILL.md'), 'utf8')).not.toBe('stale\n');
  });

  it('dry-run over a drifted copy reports would-update and warns, writing nothing', async () => {
    const dest = join(home, '.claude', 'skills', 'tenjin');
    await mkdir(dest, { recursive: true });
    await writeFile(join(dest, 'SKILL.md'), 'stale\n');

    const { data: d } = await runInstall({ harness: ['claude'], dryRun: true }, makeCtx(), deps());
    const h = asData(d).harnesses[0]!;
    expect(h.skills.find((s) => s.name === 'tenjin')?.status).toBe('would-update');
    expect(h.warnings.length).toBeGreaterThan(0);
    expect(await readFile(join(dest, 'SKILL.md'), 'utf8')).toBe('stale\n');
  });
});

describe('runInstall: binary skill assets', () => {
  it('round-trips a non-UTF-8 file byte-for-byte and reports it up-to-date on re-run', async () => {
    // A future skill could ship a non-text asset. Bytes below are not valid UTF-8
    // (a lone continuation byte, a lone leading byte with no continuation): decoding
    // then re-encoding via 'utf8' replaces them with U+FFFD, corrupting the file and
    // making two different corrupted binaries falsely compare equal.
    const src = await mkdtemp(join(tmpdir(), 'tenjin-install-src-'));
    for (const name of SKILL_NAMES) {
      await mkdir(join(src, name), { recursive: true });
      await writeFile(join(src, name, 'SKILL.md'), `# ${name}\n`);
    }
    const binary = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xff, 0xfe, 0x80, 0x00, 0x01]);
    await writeFile(join(src, 'tenjin', 'asset.bin'), binary);

    try {
      const { data: d } = await runInstall(
        { harness: ['claude'] },
        makeCtx(),
        deps({ skillsSourceDir: src }),
      );
      const h = asData(d).harnesses[0]!;
      expect(h.skills.find((s) => s.name === 'tenjin')?.status).toBe('installed');

      const written = await readFile(join(home, '.claude', 'skills', 'tenjin', 'asset.bin'));
      expect(written.equals(binary)).toBe(true);

      const second = await runInstall(
        { harness: ['claude'] },
        makeCtx(),
        deps({ skillsSourceDir: src }),
      );
      const h2 = asData(second.data).harnesses[0]!;
      expect(h2.skills.find((s) => s.name === 'tenjin')?.status).toBe('up-to-date');
    } finally {
      await rm(src, { recursive: true, force: true });
    }
  });
});

describe('runInstall: Codex AGENTS.md target', () => {
  it('writes to ~/.codex/AGENTS.md when the codex home exists and ~/.agents/AGENTS.md does not', async () => {
    await mkdir(join(home, '.codex'), { recursive: true });

    const { data: d } = await runInstall({ harness: ['codex'] }, makeCtx(), deps());
    const h = asData(d).harnesses[0]!;
    expect(h.agentsMd?.path).toBe(join(home, '.codex', 'AGENTS.md'));
    expect(h.agentsMd?.status).toBe('appended');
    const codexAgents = await readFile(join(home, '.codex', 'AGENTS.md'), 'utf8');
    expect(codexAgents.split(MARKER).length - 1).toBe(1);
    // The shared file was never touched.
    expect(existsSync(join(home, '.agents', 'AGENTS.md'))).toBe(false);

    // Re-run dedupes in ~/.codex/AGENTS.md.
    const again = await runInstall({ harness: ['codex'] }, makeCtx(), deps());
    expect(asData(again.data).harnesses[0]!.agentsMd?.status).toBe('already-present');
    const after = await readFile(join(home, '.codex', 'AGENTS.md'), 'utf8');
    expect(after.split(MARKER).length - 1).toBe(1);
  });

  it('prefers an existing ~/.agents/AGENTS.md over ~/.codex/AGENTS.md', async () => {
    await mkdir(join(home, '.codex'), { recursive: true });
    await mkdir(join(home, '.agents'), { recursive: true });
    await writeFile(join(home, '.agents', 'AGENTS.md'), '# shared\n');

    const { data: d } = await runInstall({ harness: ['codex'] }, makeCtx(), deps());
    const h = asData(d).harnesses[0]!;
    expect(h.agentsMd?.path).toBe(join(home, '.agents', 'AGENTS.md'));
    expect(existsSync(join(home, '.codex', 'AGENTS.md'))).toBe(false);
    const shared = await readFile(join(home, '.agents', 'AGENTS.md'), 'utf8');
    expect(shared.startsWith('# shared\n')).toBe(true);
    expect(shared.split(MARKER).length - 1).toBe(1);
  });

  it('does not duplicate the pointer across locations: a marker in ~/.codex stops a later ~/.agents append', async () => {
    // First install with only ~/.codex present lands the marker there.
    await mkdir(join(home, '.codex'), { recursive: true });
    await runInstall({ harness: ['codex'] }, makeCtx(), deps());
    expect(existsSync(join(home, '.codex', 'AGENTS.md'))).toBe(true);

    // Now ~/.agents/AGENTS.md appears (empty). The global append-once check must
    // see the marker already in ~/.codex and NOT append a second copy anywhere.
    await mkdir(join(home, '.agents'), { recursive: true });
    await writeFile(join(home, '.agents', 'AGENTS.md'), '# later\n');
    const { data: d } = await runInstall({ harness: ['codex'] }, makeCtx(), deps());
    expect(asData(d).harnesses[0]!.agentsMd?.status).toBe('already-present');

    const shared = await readFile(join(home, '.agents', 'AGENTS.md'), 'utf8');
    expect(shared.split(MARKER).length - 1).toBe(0);
    const codex = await readFile(join(home, '.codex', 'AGENTS.md'), 'utf8');
    expect(codex.split(MARKER).length - 1).toBe(1);
  });
});

describe('runInstall: default PATH binary probe', () => {
  it('detects a real file on PATH but ignores a same-named directory', async () => {
    const bin = await mkdtemp(join(tmpdir(), 'tenjin-bin-'));
    try {
      // A DIRECTORY named claude on PATH must not count as the binary.
      await mkdir(join(bin, 'claude'), { recursive: true });
      const notDetected = await runInstall(
        {},
        makeCtx(),
        deps({ which: undefined, env: { PATH: bin } }),
      );
      expect(asData(notDetected.data).harnesses[0]!.harness).toBe('shared');

      // A real FILE named codex does count.
      await writeFile(join(bin, 'codex'), '#!/bin/sh\n');
      const detected = await runInstall(
        {},
        makeCtx(),
        deps({ which: undefined, env: { PATH: bin } }),
      );
      const names = asData(detected.data).harnesses.map((h) => h.harness);
      expect(names).toContain('codex');
      expect(names).not.toContain('claude');
    } finally {
      await rm(bin, { recursive: true, force: true });
    }
  });
});

describe('runInstall: doctor as the final step', () => {
  it('embeds the doctor summary and never throws on a doctor failure', async () => {
    const failing: DoctorChecks = {
      checks: [{ name: 'api-contract', status: 'fail', required: true, detail: 'down' }],
      failure: {
        code: 'API_UNREACHABLE',
        result: { name: 'api-contract', status: 'fail', required: true, detail: 'down' },
      },
    };
    const { data: d } = await runInstall(
      { harness: ['claude'] },
      makeCtx(),
      deps({ collectChecks: async () => failing }),
    );
    const out = asData(d) as Data & { doctor: { status: string; checks: unknown[] } };
    // Wiring still succeeded (skills on disk); doctor problem is reported, not thrown.
    expect(existsSync(join(home, '.claude', 'skills', 'tenjin', 'SKILL.md'))).toBe(true);
    expect(out.doctor.status).toBe('fail');
    expect(out.doctor.checks).toHaveLength(1);
  });

  it('passes the doctor summary through on success', async () => {
    const { data: d } = await runInstall({ harness: ['claude'] }, makeCtx(), deps());
    const out = asData(d) as Data & { doctor: { status: string } };
    expect(out.doctor.status).toBe('pass');
  });
});

// An explicit --harness is the user telling the CLI which directory they use.
// Detection cannot see a harness Tenjin does not probe for, so the choice is recorded
// and `doctor` keeps judging that directory on later runs (#39 review).
describe('runInstall: recording an explicit --harness', () => {
  async function recorded(): Promise<string[] | undefined> {
    const raw = await readFile(join(data, 'config.json'), 'utf8').catch(() => null);
    if (raw === null) return undefined;
    return (JSON.parse(raw) as { install?: { harness?: string[] } }).install?.harness;
  }

  it('records the requested targets', async () => {
    await runInstall({ harness: ['shared'] }, makeCtx(), deps());
    expect(await recorded()).toEqual(['shared']);
  });

  it('records the DE-DUPED target set, matching what was written', async () => {
    // codex + shared are one directory, so one recorded entry, like one install target.
    await runInstall({ harness: ['codex', 'shared'] }, makeCtx(), deps());
    expect(await recorded()).toEqual(['codex']);
  });

  it('a later explicit run REPLACES the record rather than unioning', async () => {
    await runInstall({ harness: ['shared'] }, makeCtx(), deps());
    await runInstall({ harness: ['claude'] }, makeCtx(), deps());
    // The way out of a mistaken --harness is re-running install with the right one.
    expect(await recorded()).toEqual(['claude']);
  });

  it('a bare install records nothing: detection is re-probed every time', async () => {
    await mkdir(join(home, '.claude'), { recursive: true });
    await runInstall({}, makeCtx(), deps());
    expect(await recorded()).toBeUndefined();
  });

  it('a bare install leaves an earlier explicit record alone', async () => {
    await runInstall({ harness: ['shared'] }, makeCtx(), deps());
    await mkdir(join(home, '.claude'), { recursive: true });
    await runInstall({}, makeCtx(), deps());
    expect(await recorded()).toEqual(['shared']);
  });

  it('--dry-run records nothing, like the publish-mode write', async () => {
    await runInstall({ harness: ['shared'], dryRun: true }, makeCtx(), deps());
    expect(await recorded()).toBeUndefined();
  });

  it('the record is merged, never an overwrite of a sibling block', async () => {
    await writeFile(
      join(data, 'config.json'),
      JSON.stringify({ publish: { mode: 'auto' }, evalCohort: true }),
    );
    await runInstall({ harness: ['shared'] }, makeCtx(), deps());
    const json = JSON.parse(await readFile(join(data, 'config.json'), 'utf8')) as {
      install?: { harness?: string[] };
      publish?: { mode?: string };
      evalCohort?: boolean;
    };
    expect(json.install?.harness).toEqual(['shared']);
    expect(json.publish?.mode).toBe('auto');
    expect(json.evalCohort).toBe(true);
  });
});

describe('runInstall: publish-mode selection', () => {
  type ModeData = { publishMode: { value: string; source: string } };
  const modeOf = (d: unknown) => (d as ModeData).publishMode;

  async function persistedMode(): Promise<string | undefined> {
    const raw = await readFile(join(data, 'config.json'), 'utf8').catch(() => null);
    if (raw === null) return undefined;
    return (JSON.parse(raw) as { publish?: { mode?: string } }).publish?.mode;
  }

  function promptSpy(answers: (string | null)[]): {
    fn: PromptPublishModeFn;
    calls: () => number;
  } {
    let i = 0;
    let n = 0;
    return {
      calls: () => n,
      fn: async () => {
        n++;
        return (answers[i++] ?? null) as Awaited<ReturnType<PromptPublishModeFn>>;
      },
    };
  }

  it('offers auto first, as the recommended answer, with one line of consequence', () => {
    expect(PUBLISH_MODE_CHOICES.map((c) => c.value)).toEqual(['auto', 'review', 'full-auto']);
    expect(PUBLISH_MODE_CHOICES[0]!.label).toBe('Auto (recommended)');
    expect(PUBLISH_MODE_CHOICES[0]!.hint).toBe(
      'your agent publishes clean pieces on its own; your harness still shows each command for approval',
    );
    expect(PUBLISH_MODE_CHOICES[1]!.label).toBe('Ask me in chat first');
    expect(PUBLISH_MODE_CHOICES[2]!.label).toBe('Fully unattended');
  });

  it('persists the recommended auto when it is chosen (source prompt)', async () => {
    const spy = promptSpy(['auto']);
    const { data: d } = await runInstall(
      { harness: ['claude'] },
      makeCtx(),
      deps({ isInteractive: true, promptPublishMode: spy.fn }),
    );
    expect(spy.calls()).toBe(1);
    expect(modeOf(d)).toEqual({ value: 'auto', source: 'prompt' });
    expect(await persistedMode()).toBe('auto');
  });

  it('persists review when it is chosen', async () => {
    const { data: d } = await runInstall(
      { harness: ['claude'] },
      makeCtx(),
      deps({ isInteractive: true, promptPublishMode: async () => 'review' }),
    );
    expect(modeOf(d)).toEqual({ value: 'review', source: 'prompt' });
    expect(await persistedMode()).toBe('review');
  });

  it('persists full-auto when it is chosen', async () => {
    const { data: d } = await runInstall(
      { harness: ['claude'] },
      makeCtx(),
      deps({ isInteractive: true, promptPublishMode: async () => 'full-auto' }),
    );
    expect(modeOf(d)).toEqual({ value: 'full-auto', source: 'prompt' });
    expect(await persistedMode()).toBe('full-auto');
  });

  it('a cancelled select keeps review WITHOUT writing (provenance stays default)', async () => {
    const spy = promptSpy([null]); // ctrl-C / escape
    const { data: d } = await runInstall(
      { harness: ['claude'] },
      makeCtx(),
      deps({ isInteractive: true, promptPublishMode: spy.fn }),
    );
    expect(spy.calls()).toBe(1);
    expect(modeOf(d)).toEqual({ value: 'review', source: 'default-skipped' });
    expect(await persistedMode()).toBeUndefined(); // no config write
  });

  it('never writes an answer it cannot parse', async () => {
    const spy = promptSpy(['someday']);
    const { data: d } = await runInstall(
      { harness: ['claude'] },
      makeCtx(),
      deps({ isInteractive: true, promptPublishMode: spy.fn }),
    );
    expect(modeOf(d)).toEqual({ value: 'review', source: 'default-skipped' });
    expect(await persistedMode()).toBeUndefined();
  });

  it('does not prompt or write on a non-interactive run: the STORED default stays review', async () => {
    const spy = promptSpy(['auto']);
    const { data: d } = await runInstall(
      { harness: ['claude'] },
      makeCtx(),
      deps({ isInteractive: false, promptPublishMode: spy.fn }),
    );
    expect(spy.calls()).toBe(0);
    expect(modeOf(d)).toEqual({ value: 'review', source: 'default-skipped' });
    expect(await persistedMode()).toBeUndefined();
  });

  it('does not prompt when a global mode is already configured (source existing)', async () => {
    await writeFile(join(data, 'config.json'), JSON.stringify({ publish: { mode: 'review' } }));
    const spy = promptSpy(['full-auto']);
    const { data: d } = await runInstall(
      { harness: ['claude'] },
      makeCtx(),
      deps({ isInteractive: true, promptPublishMode: spy.fn }),
    );
    expect(spy.calls()).toBe(0);
    expect(modeOf(d)).toEqual({ value: 'review', source: 'existing' });
    expect(await persistedMode()).toBe('review'); // untouched
  });

  it('--publish-mode sets it non-interactively and suppresses the prompt', async () => {
    const spy = promptSpy(['review']);
    const { data: d } = await runInstall(
      { harness: ['claude'], publishMode: 'full-auto' },
      makeCtx(),
      deps({ isInteractive: true, promptPublishMode: spy.fn }),
    );
    expect(spy.calls()).toBe(0);
    expect(modeOf(d)).toEqual({ value: 'full-auto', source: 'flag' });
    expect(await persistedMode()).toBe('full-auto');
  });

  it('--publish-mode rejects a bad value as USAGE', async () => {
    const err = await caught(() =>
      runInstall({ harness: ['claude'], publishMode: 'someday' }, makeCtx(), deps()),
    );
    expect(err.code).toBe('USAGE');
  });

  it('--dry-run with --publish-mode is would-set (no write)', async () => {
    const { data: d } = await runInstall(
      { harness: ['claude'], dryRun: true, publishMode: 'review' },
      makeCtx(),
      deps(),
    );
    expect(modeOf(d)).toEqual({ value: 'review', source: 'flag' });
    expect(await persistedMode()).toBeUndefined(); // dry run wrote nothing
  });

  it('--dry-run does not prompt', async () => {
    const spy = promptSpy(['review']);
    const { data: d } = await runInstall(
      { harness: ['claude'], dryRun: true },
      makeCtx(),
      deps({ isInteractive: true, promptPublishMode: spy.fn }),
    );
    expect(spy.calls()).toBe(0);
    expect(modeOf(d)).toEqual({ value: 'review', source: 'default-skipped' });
    expect(await persistedMode()).toBeUndefined();
  });

  it('--json implies non-interactive: no prompt even on a TTY', async () => {
    const spy = promptSpy(['review']);
    const { data: d } = await runInstall(
      { harness: ['claude'] },
      makeCtx({ json: true }),
      deps({ isInteractive: true, promptPublishMode: spy.fn }), // json overrides isInteractive
    );
    expect(spy.calls()).toBe(0);
    expect(modeOf(d)).toEqual({ value: 'review', source: 'default-skipped' });
    expect(await persistedMode()).toBeUndefined();
  });

  it('--json still honors --publish-mode', async () => {
    const { data: d } = await runInstall(
      { harness: ['claude'], publishMode: 'review' },
      makeCtx({ json: true }),
      deps(),
    );
    expect(modeOf(d)).toEqual({ value: 'review', source: 'flag' });
    expect(await persistedMode()).toBe('review');
  });
});

describe('runInstall: interactive walkthrough', () => {
  const ADDR = '0x1234567890abcdef1234567890abcdef12345678';

  // install is human-first: it returns the walkthrough as humanLines (the
  // dispatcher prints them at a TTY). Read them here, ANSI-stripped.
  const human = (res: { humanLines?: string[] }): string =>
    (res.humanLines ?? []).join('\n').replace(/\x1b\[[0-9;]*m/g, ''); // eslint-disable-line no-control-regex

  it('is a five-line summary on a clean install: skills, publishing, permissions, wallet, next', async () => {
    const res = await runInstall({ harness: ['claude'] }, makeCtx(), deps({ isInteractive: true }));
    const lines = human(res).split('\n');
    expect(lines).toHaveLength(5);
    expect(lines[0]).toContain('Claude Code: 3 skills installed');
    expect(lines[0]).toContain('tenjin-search, tenjin-publish (CLI)');
    expect(lines[1]).toContain('Publishing: review');
    expect(lines[2]).toContain('Permissions:');
    expect(lines[3]).toContain('Wallet:');
    expect(lines[4]).toContain('Next: tenjin search');
  });

  it('no longer prints the allowlist block or the security essays that went with it', async () => {
    const res = await runInstall({ harness: ['claude'] }, makeCtx(), deps({ isInteractive: true }));
    const text = human(res);
    // The rules and their caveats are reference material: `doctor` prints them,
    // the README documents them, and a setup flow does not recite them.
    for (const e of ALWAYS_SAFE_ALLOWLIST) expect(text).not.toContain(e.rule);
    expect(text).not.toContain('Bash(tenjin buy:*)');
    expect(text).not.toContain('Bash(tenjin session start:*)');
    expect(text).not.toContain('mcp__tenjin__tenjin_publish');
    expect(text).not.toContain('maxAutoSpend');
    // And no rule for a money-moving or state-changing verb, in any form.
    for (const e of NEVER_ALLOWLISTED) {
      const verb = (e.command.split(' / ')[0] ?? e.command).replace(/^tenjin /, '');
      expect(text).not.toMatch(new RegExp(`Bash\\(tenjin ${verb}[^)]*\\)`));
    }
  });

  // The wording pin the old allowlist block carried, kept alive now that the
  // block itself is gone. lib/permissions.ts refuses to call this tier
  // read-only, and the consent surface must not claim what the module it draws
  // from will not: `search` and `outcome` POST off-machine, `read` writes to the
  // library and can present a wallet-derived delegation, and two of the nine
  // rules are `wallet show` / `wallet balance`.
  it('never calls the free tier read-only, and never claims it cannot touch your wallet', async () => {
    const res = await runInstall(
      { harness: ['claude'], allowFreeVerbs: true },
      makeCtx(),
      deps({ isInteractive: true }),
    );
    const surfaces = [human(res), PERMISSIONS_QUESTION];
    for (const text of surfaces) {
      expect(text).not.toMatch(/read-only/i);
      expect(text).not.toMatch(/touch your wallet/i);
      expect(text).not.toMatch(/free, read-only verbs/i);
    }
  });

  it('the consent question says what is true of the tier, and points at doctor', async () => {
    // Cannot spend and cannot open the keystore is the honest whole-tier claim;
    // the three that send or store data are named rather than papered over.
    expect(PERMISSIONS_QUESTION).toContain('None can spend USDC or open your wallet keystore');
    expect(PERMISSIONS_QUESTION).toContain('three send or store data (search, outcome, read)');
    // FLAG_CAVEAT is "printed with the rules everywhere they are printed". The
    // walkthrough prints neither, so the consent moment names the command that
    // prints both in full.
    expect(PERMISSIONS_QUESTION).toContain('tenjin doctor');
  });

  it('the line reporting a write also points at doctor for the caveats', async () => {
    const res = await runInstall(
      { harness: ['claude'], allowFreeVerbs: true },
      makeCtx(),
      deps({ isInteractive: true }),
    );
    const line = human(res)
      .split('\n')
      .find((l) => l.includes('Permissions:'));
    expect(line).toContain(`${FREE_VERB_RULES.length} free tenjin commands added to`);
    expect(line).toContain('Full caveats: tenjin doctor');
  });

  it('--json carries the same three tiers in the machine payload', async () => {
    const res = await runInstall(
      { harness: ['claude'] },
      makeCtx({ json: true }),
      deps({ isInteractive: true }),
    );
    const d = asData(res.data) as Data & {
      permissions: { alwaysSafe: { rule: string }[]; optIn: { rule: string }[] };
    };
    expect(d.permissions.alwaysSafe.map((e) => e.rule)).toEqual(
      ALWAYS_SAFE_ALLOWLIST.map((e) => e.rule),
    );
    expect(d.permissions.optIn.map((e) => e.rule)).toEqual([
      'Bash(tenjin buy:*)',
      'Bash(tenjin session start:*)',
    ]);
  });

  it('--json returns the envelope data and never prompts the wallet', async () => {
    const confirm = vi.fn(async () => true);
    const res = await runInstall(
      { harness: ['claude'] },
      makeCtx({ json: true }),
      deps({ isInteractive: true, confirmWallet: confirm, walletExists: async () => false }),
    );
    expect(res.humanLines ?? []).toHaveLength(0); // machine path: no walkthrough
    const d = asData(res.data) as Data & { publishMode: unknown };
    expect(d.harnesses[0]!.harness).toBe('claude');
    expect(d.publishMode).toBeDefined();
    expect(confirm).not.toHaveBeenCalled();
  });

  it('creates a wallet on yes and shows the address + funding lines', async () => {
    const create = vi.fn(async () => ADDR);
    const res = await runInstall(
      { harness: ['claude'] },
      makeCtx(),
      deps({
        isInteractive: true,
        walletExists: async () => false,
        confirmWallet: async () => true,
        createWallet: create,
      }),
    );
    expect(create).toHaveBeenCalledOnce();
    const text = human(res);
    expect(text).toContain(ADDR);
    expect(text).toContain('Fund it with a few dollars of USDC on Base');
    expect(text).toContain('tenjin wallet balance');
  });

  it('declining the wallet prompt shows the create-later line, no create', async () => {
    const create = vi.fn(async () => ADDR);
    const res = await runInstall(
      { harness: ['claude'] },
      makeCtx(),
      deps({
        isInteractive: true,
        walletExists: async () => false,
        confirmWallet: async () => false,
        createWallet: create,
      }),
    );
    expect(create).not.toHaveBeenCalled();
    expect(human(res)).toContain('Create one later with: tenjin wallet create');
  });

  it('--no-wallet skips the wallet prompt entirely', async () => {
    const confirm = vi.fn(async () => true);
    const res = await runInstall(
      { harness: ['claude'], noWallet: true },
      makeCtx(),
      deps({ isInteractive: true, confirmWallet: confirm }),
    );
    expect(confirm).not.toHaveBeenCalled();
    expect(human(res)).toContain('Create one later with: tenjin wallet create');
  });

  it('shows an existing wallet address without prompting', async () => {
    const confirm = vi.fn(async () => true);
    const res = await runInstall(
      { harness: ['claude'] },
      makeCtx(),
      deps({
        isInteractive: true,
        walletExists: async () => true,
        walletAddress: async () => ADDR,
        confirmWallet: confirm,
      }),
    );
    expect(confirm).not.toHaveBeenCalled();
    expect(human(res)).toContain(`Wallet: ${ADDR} (existing)`);
  });

  it('a TTY with no stdin renders the walkthrough with defaults, no prompt', async () => {
    // humanOutput true (io.isTTY, no --json), but canPrompt false (stdin is not a
    // TTY in the test runner and no isInteractive override): default mode, no
    // wallet prompt, still a full walkthrough.
    const sink = () => ({ write: () => true }) as unknown as NodeJS.WritableStream;
    const ttyCtx: CommandContext = {
      flags: { json: false, timeout: 10000 },
      dataDir: data,
      io: { stdout: sink(), stderr: sink(), isTTY: true },
    };
    const prompt = vi.fn(async () => 'review' as const);
    const confirm = vi.fn(async () => true);
    const permissions = vi.fn(async () => true);
    const res = await runInstall(
      { harness: ['claude'] },
      ttyCtx,
      deps({
        promptPublishMode: prompt,
        confirmWallet: confirm,
        confirmPermissions: permissions,
        walletExists: async () => false,
      }),
    );
    expect(prompt).not.toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();
    expect(permissions).not.toHaveBeenCalled();
    expect(human(res)).toContain('Publishing: review');
    expect(human(res)).toContain('Create one later with: tenjin wallet create');
  });

  it('a green doctor says nothing; a failure surfaces with its fix', async () => {
    const okRes = await runInstall(
      { harness: ['claude'] },
      makeCtx(),
      deps({ isInteractive: true }),
    );
    expect(human(okRes)).not.toContain('need attention');
    expect(human(okRes).split('\n')).toHaveLength(5);

    const failing: DoctorChecks = {
      checks: [
        {
          name: 'api',
          status: 'fail',
          required: true,
          detail: 'unreachable',
          fix: 'check the base URL',
        },
      ],
      failure: {
        code: 'API_UNREACHABLE',
        result: { name: 'api', status: 'fail', required: true, detail: 'unreachable' },
      },
    };
    const failRes = await runInstall(
      { harness: ['claude'] },
      makeCtx(),
      deps({ isInteractive: true, collectChecks: async () => failing }),
    );
    const text = human(failRes);
    expect(text).toContain('need attention');
    expect(text).toContain('api: unreachable');
    expect(text).toContain('fix: check the base URL');
  });

  it('emits no internal jargon (no "roadmap") in the data or walkthrough', async () => {
    await mkdir(join(home, '.claude'), { recursive: true });
    const res = await runInstall({ harness: ['claude'] }, makeCtx({ json: true }), deps());
    expect(JSON.stringify(res.data).toLowerCase()).not.toContain('roadmap');
  });
});

// --- Decision 2: the harness permission allowlist ---------------------------------

describe('runInstall: permissions decision', () => {
  type WiredData = {
    permissions: {
      alwaysSafe: { rule: string }[];
      wired: {
        harness: string;
        path?: string;
        added: string[];
        alreadyPresent: string[];
        skipped?: string;
        warning?: string;
      };
    };
  };
  const wiredOf = (d: unknown) => (d as WiredData).permissions.wired;
  const human = (res: { humanLines?: string[] }): string =>
    (res.humanLines ?? []).join('\n').replace(/\x1b\[[0-9;]*m/g, ''); // eslint-disable-line no-control-regex

  async function allowList(): Promise<unknown[] | undefined> {
    const raw = await readFile(claudeSettingsPath(home), 'utf8').catch(() => null);
    if (raw === null) return undefined;
    return (JSON.parse(raw) as { permissions?: { allow?: unknown[] } }).permissions?.allow;
  }

  /** Seed ~/.claude/settings.json; a string is written verbatim (malformed cases). */
  async function writeSettings(contents: unknown): Promise<void> {
    const path = claudeSettingsPath(home);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(
      path,
      typeof contents === 'string' ? contents : JSON.stringify(contents, null, 2),
    );
  }

  it('writes the allowlist on an interactive yes and says so in one line', async () => {
    const confirm = vi.fn(async (_label: string) => true);
    const res = await runInstall(
      { harness: ['claude'] },
      makeCtx(),
      deps({ isInteractive: true, confirmPermissions: confirm }),
    );
    expect(confirm).toHaveBeenCalledOnce();
    expect(confirm.mock.calls[0]![0]).toContain('without permission popups');
    expect(wiredOf(res.data).added).toEqual([...FREE_VERB_RULES]);
    expect(await allowList()).toEqual([...FREE_VERB_RULES]);
    expect(human(res)).toContain(
      `${FREE_VERB_RULES.length} free tenjin commands added to ${claudeSettingsPath(home)}`,
    );
  });

  it('writes nothing on an interactive no and offers the flag instead', async () => {
    const res = await runInstall(
      { harness: ['claude'] },
      makeCtx(),
      deps({ isInteractive: true, confirmPermissions: async () => false }),
    );
    expect(wiredOf(res.data)).toMatchObject({ skipped: 'declined', added: [] });
    expect(await allowList()).toBeUndefined();
    expect(human(res)).toContain('tenjin install --allow-free-verbs');
  });

  it('--allow-free-verbs wires it headlessly, with no prompt', async () => {
    const confirm = vi.fn(async () => false);
    const res = await runInstall(
      { harness: ['claude'], allowFreeVerbs: true },
      makeCtx(),
      deps({ confirmPermissions: confirm }),
    );
    expect(confirm).not.toHaveBeenCalled();
    expect(wiredOf(res.data).added).toEqual([...FREE_VERB_RULES]);
    expect(await allowList()).toEqual([...FREE_VERB_RULES]);
  });

  it('--allow-free-verbs works under --json and reports the write in the envelope', async () => {
    const res = await runInstall(
      { harness: ['claude'], allowFreeVerbs: true },
      makeCtx({ json: true }),
      deps({ isInteractive: true }),
    );
    expect(res.humanLines ?? []).toHaveLength(0);
    const wired = wiredOf(res.data);
    expect(wired.harness).toBe('claude');
    expect(wired.path).toBe(claudeSettingsPath(home));
    expect(wired.added).toEqual([...FREE_VERB_RULES]);
    expect(await allowList()).toEqual([...FREE_VERB_RULES]);
  });

  it('a non-interactive run without the flag changes nothing and notes the flag', async () => {
    const res = await runInstall({ harness: ['claude'] }, makeCtx({ json: true }), deps());
    expect(wiredOf(res.data)).toMatchObject({ skipped: 'not-requested', added: [] });
    expect(await allowList()).toBeUndefined();
  });

  it('is idempotent: a second run adds nothing and reports already-present', async () => {
    await runInstall({ harness: ['claude'], allowFreeVerbs: true }, makeCtx(), deps());
    const res = await runInstall(
      { harness: ['claude'], allowFreeVerbs: true },
      makeCtx(),
      deps({ isInteractive: true }),
    );
    expect(wiredOf(res.data).added).toEqual([]);
    expect(wiredOf(res.data).alreadyPresent).toEqual([...FREE_VERB_RULES]);
    expect(await allowList()).toEqual([...FREE_VERB_RULES]);
    expect(human(res)).toContain('were already allowed');
  });

  // Re-running install is the advice for refreshing a stale setup, so this is the
  // ordinary second-run path, not an edge case.
  it('does not re-ask once every rule is already allowed', async () => {
    await runInstall({ harness: ['claude'], allowFreeVerbs: true }, makeCtx(), deps());
    const confirm = vi.fn(async () => true);
    const res = await runInstall(
      { harness: ['claude'] },
      makeCtx(),
      deps({ isInteractive: true, confirmPermissions: confirm }),
    );
    expect(confirm).not.toHaveBeenCalled();
    expect(wiredOf(res.data)).toMatchObject({ added: [], alreadyPresent: [...FREE_VERB_RULES] });
    expect(human(res)).toContain('were already allowed');
  });

  // The no-prompt path must not perform a SECOND read. Re-reading meant a rule
  // revoked between probe and write was silently re-added without a prompt, which
  // is the one thing a consent gate cannot do.
  it('reports the probe snapshot and writes nothing if a rule is revoked mid-run', async () => {
    await runInstall({ harness: ['claude'], allowFreeVerbs: true }, makeCtx(), deps());
    const confirm = vi.fn(async () => true);
    const res = await runInstall(
      { harness: ['claude'] },
      makeCtx(),
      deps({
        isInteractive: true,
        confirmPermissions: confirm,
        // Probe says satisfied; the file loses a rule immediately afterwards.
        inspectPermissions: async (h) => {
          const out = await inspectFreeVerbRules(h);
          await writeSettings({ permissions: { allow: [...FREE_VERB_RULES.slice(1)] } });
          return out;
        },
      }),
    );
    expect(confirm).not.toHaveBeenCalled();
    expect(wiredOf(res.data).added).toEqual([]);
    // The revoked rule stays revoked: no unprompted re-grant.
    expect(await allowList()).toEqual([...FREE_VERB_RULES.slice(1)]);
  });

  // The summary must not tell the operator to fix a healthy file, or to re-run with
  // a flag that is not the remedy. The warning beside it already says the right
  // thing, so the two lines used to disagree.
  it('says what to do when the settings file moved under the write', async () => {
    await writeSettings({ model: 'opus', permissions: { allow: [] } });
    // Read 1 is the consent probe; read 2 is the writer's own snapshot, and only a
    // change after THAT one is the window the guard exists for.
    fsHooks.settingsInterleave = `${JSON.stringify({ model: 'opus', theirs: 1 }, null, 2)}\n`;
    fsHooks.settingsInterleaveOnRead = 2;
    fsHooks.settingsReads = 0;
    let res;
    try {
      res = await runInstall(
        { harness: ['claude'] },
        makeCtx(),
        deps({ isInteractive: true, confirmPermissions: async () => true }),
      );
    } finally {
      fsHooks.settingsInterleave = '';
      fsHooks.settingsReads = 0;
      fsHooks.settingsInterleaveOnRead = 1;
    }
    expect(wiredOf(res.data).skipped).toBe('changed-since-read');
    const text = (res.humanLines ?? []).join('\n').replace(/\x1b\[[0-9;]*m/g, ''); // eslint-disable-line no-control-regex
    expect(text).toContain('changed while it was being updated');
    expect(text).toContain('Re-run: tenjin install');
    expect(text).not.toContain('Fix it, then');
  });

  it('still asks when only SOME of the rules are allowed', async () => {
    await writeSettings({ permissions: { allow: [FREE_VERB_RULES[0]] } });
    const confirm = vi.fn(async () => true);
    const res = await runInstall(
      { harness: ['claude'] },
      makeCtx(),
      deps({ isInteractive: true, confirmPermissions: confirm }),
    );
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(wiredOf(res.data).added).toEqual(FREE_VERB_RULES.slice(1));
  });

  // A file we cannot read is not "already allowed": the probe returns null and the
  // question is still asked, so the writer gets to report why nothing was written.
  it('still asks when the settings file cannot be parsed', async () => {
    await writeSettings('not json at all');
    const confirm = vi.fn(async () => true);
    const res = await runInstall(
      { harness: ['claude'] },
      makeCtx(),
      deps({ isInteractive: true, confirmPermissions: confirm }),
    );
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(wiredOf(res.data)).toMatchObject({ skipped: 'unparsable' });
  });

  it('--dry-run neither prompts nor writes', async () => {
    const confirm = vi.fn(async () => true);
    const res = await runInstall(
      { harness: ['claude'], dryRun: true, allowFreeVerbs: true },
      makeCtx(),
      deps({ isInteractive: true, confirmPermissions: confirm }),
    );
    expect(confirm).not.toHaveBeenCalled();
    expect(wiredOf(res.data)).toMatchObject({ skipped: 'dry-run' });
    expect(await allowList()).toBeUndefined();
  });

  it('skips a codex-only install without asking, and says why', async () => {
    const confirm = vi.fn(async () => true);
    const res = await runInstall(
      { harness: ['codex'] },
      makeCtx(),
      deps({ isInteractive: true, confirmPermissions: confirm }),
    );
    expect(confirm).not.toHaveBeenCalled();
    expect(wiredOf(res.data)).toMatchObject({ harness: 'codex', skipped: 'harness-not-claude' });
    expect(await allowList()).toBeUndefined();
    expect(human(res)).toContain('Claude Code only');
  });

  it('sanitizes the warning, which quotes bytes out of the file', async () => {
    // V8's JSON parse errors quote the offending input, so ~20 attacker-chosen
    // bytes of settings.json reach the terminal at the moment we tell the
    // operator we left their file alone. Escapes there could overwrite the very
    // line reporting the skip.
    await mkdir(join(home, '.claude'), { recursive: true });
    // The escapes lead, so V8 fails on the FIRST token and takes the
    // "Unexpected token X, "<excerpt>" is not valid JSON" branch, which is the
    // one that echoes the file. A payload that fails later gets a positional
    // message with no excerpt and would test nothing.
    await writeFile(claudeSettingsPath(home), '\x1b[2K\x1b[1G\x1b[32m OK: safe\x1b[0m{"a":1}');
    const res = await runInstall(
      { harness: ['claude'], allowFreeVerbs: true },
      makeCtx(),
      deps({ isInteractive: true }),
    );
    const wired = wiredOf(res.data);
    expect(wired.skipped).toBe('unparsable');
    // The escapes really do reach the warning: V8 quotes the input it choked on.
    // eslint-disable-next-line no-control-regex
    expect(wired.warning).toMatch(/\x1b/);
    // They survive into the machine envelope, where bytes are data, and are
    // stripped from the line a human reads.
    const line = (res.humanLines ?? []).find((l) => l.includes('not valid JSON'));
    expect(line).toBeDefined();
    // eslint-disable-next-line no-control-regex
    expect(line).not.toMatch(/\x1b/);
  });

  it('warns and writes nothing when settings.json is unparsable', async () => {
    await mkdir(join(home, '.claude'), { recursive: true });
    await writeFile(claudeSettingsPath(home), '{ not json');
    const res = await runInstall(
      { harness: ['claude'], allowFreeVerbs: true },
      makeCtx(),
      deps({ isInteractive: true }),
    );
    expect(wiredOf(res.data).skipped).toBe('unparsable');
    expect(await readFile(claudeSettingsPath(home), 'utf8')).toBe('{ not json');
    const text = human(res);
    expect(text).toContain('not valid JSON');
    expect(text).toContain('was left untouched');
  });

  it('preserves an existing settings file while adding the rules', async () => {
    await mkdir(join(home, '.claude'), { recursive: true });
    await writeFile(
      claudeSettingsPath(home),
      JSON.stringify({ model: 'opus', permissions: { allow: ['Bash(git status:*)'] } }, null, 2),
    );
    await runInstall({ harness: ['claude'], allowFreeVerbs: true }, makeCtx(), deps());
    const settings = JSON.parse(await readFile(claudeSettingsPath(home), 'utf8')) as {
      model: string;
      permissions: { allow: string[] };
    };
    expect(settings.model).toBe('opus');
    expect(settings.permissions.allow).toEqual(['Bash(git status:*)', ...FREE_VERB_RULES]);
  });

  it('keeps the three recommendation tiers beside the write outcome', async () => {
    const res = await runInstall(
      { harness: ['claude'], allowFreeVerbs: true },
      makeCtx({ json: true }),
      deps(),
    );
    const d = res.data as WiredData;
    expect(d.permissions.alwaysSafe.map((e) => e.rule)).toEqual(
      ALWAYS_SAFE_ALLOWLIST.map((e) => e.rule),
    );
    expect(d.permissions.wired.added).toEqual([...FREE_VERB_RULES]);
  });
});

// --- The three decisions, in order, and nothing else ------------------------------

describe('runInstall: at most three questions', () => {
  it('asks publishing, then permissions, then wallet, and stops there', async () => {
    const asked: string[] = [];
    await runInstall(
      { harness: ['claude'] },
      makeCtx(),
      deps({
        isInteractive: true,
        promptPublishMode: async () => {
          asked.push('publishing');
          return 'auto';
        },
        confirmPermissions: async () => {
          asked.push('permissions');
          return true;
        },
        walletExists: async () => false,
        confirmWallet: async () => {
          asked.push('wallet');
          return false;
        },
      }),
    );
    expect(asked).toEqual(['publishing', 'permissions', 'wallet']);
  });

  it('asks nothing at all on a machine run', async () => {
    const asked: string[] = [];
    await runInstall(
      { harness: ['claude'] },
      makeCtx({ json: true }),
      deps({
        isInteractive: true, // --json wins
        promptPublishMode: async () => {
          asked.push('publishing');
          return 'auto';
        },
        confirmPermissions: async () => {
          asked.push('permissions');
          return true;
        },
        confirmWallet: async () => {
          asked.push('wallet');
          return true;
        },
      }),
    );
    expect(asked).toEqual([]);
  });
});

// --- #35: install on a machine that already has the hosted Tenjin skill ------------
//
// The reported shape: `tenjin install` on a machine carrying the hosted zero-install
// `tenjin` skill (from tenjin.blog/skills.md) left publish unavailable — search
// worked, publish was simply absent. Install on such a machine is the UPGRADE path,
// never a no-op: both CLI adapter skills get wired, the hosted mirror is kept, and
// nothing about a pre-existing skill may make the wiring conditional.

/** Simulate a machine that already carries the hand-installed hosted `tenjin` skill. */
async function seedHostedSkill(dir: string): Promise<void> {
  const hosted = join(dir, 'tenjin');
  await mkdir(hosted, { recursive: true });
  await writeFile(
    join(hosted, 'SKILL.md'),
    '---\nname: tenjin\ndescription: hosted zero-install curriculum\n---\n\n# Tenjin (hosted copy)\n',
  );
}

const isDisabled = (text: string): boolean =>
  /^disable-model-invocation:\s*true\s*$/m.test(text.split('\n---')[0] ?? '');

describe('runInstall: hosted skill already present (#35)', () => {
  it('wires BOTH CLI skills next to a pre-existing hosted skill, model-invocable', async () => {
    const claudeSkills = join(home, '.claude', 'skills');
    await seedHostedSkill(claudeSkills);

    const { data: d } = await runInstall({ harness: ['claude'] }, makeCtx(), deps());
    const h = asData(d).harnesses[0]!;

    // The regression itself: publish is installed, not skipped.
    const publish = h.skills.find((s) => s.name === 'tenjin-publish');
    expect(publish?.status).toBe('installed');
    expect(publish?.preexisting).toBe(false);
    expect(h.skills.find((s) => s.name === 'tenjin-search')?.status).toBe('installed');

    for (const name of SKILL_NAMES) {
      expect(existsSync(join(claudeSkills, name, 'SKILL.md'))).toBe(true);
    }
    // On disk is not enough: a disable-model-invocation skill is installed but
    // never surfaced to the model, which is how publish went missing.
    for (const name of ['tenjin-search', 'tenjin-publish']) {
      const text = await readFile(join(claudeSkills, name, 'SKILL.md'), 'utf8');
      expect(isDisabled(text)).toBe(false);
    }
  });

  it('keeps the hosted skill (never removes it) and reports it as pre-existing', async () => {
    const claudeSkills = join(home, '.claude', 'skills');
    await seedHostedSkill(claudeSkills);

    const { data: d } = await runInstall({ harness: ['claude'] }, makeCtx(), deps());
    const h = asData(d).harnesses[0]!;

    expect(h.hostedPreexisting).toBe(true);
    const hosted = h.skills.find((s) => s.name === 'tenjin');
    expect(hosted?.preexisting).toBe(true);
    expect(hosted?.status).toBe('updated'); // refreshed from the packaged mirror
    expect(existsSync(join(claudeSkills, 'tenjin', 'SKILL.md'))).toBe(true);
    // The mirror is permanent, so its refresh reads as a refresh, not skill drift.
    expect(h.warnings.join('\n')).toContain('stays as the zero-install fallback');
    expect(h.notes.join('\n')).toContain('take precedence');
  });

  it('tells the human that publish is wired and the hosted skill was superseded', async () => {
    await seedHostedSkill(join(home, '.claude', 'skills'));
    const res = await runInstall({ harness: ['claude'] }, makeCtx(), deps({ isInteractive: true }));
    const text = (res.humanLines ?? []).join('\n').replace(/\x1b\[[0-9;]*m/g, ''); // eslint-disable-line no-control-regex
    expect(text).toContain('tenjin-search, tenjin-publish (CLI)');
    expect(text).toContain('zero-install fallback');
    expect(text).toContain('take precedence');
  });

  // The notice is about arriving through the hosted skill. After run 1 the mirror on
  // disk is one the CLI wrote, so claiming it "was already here" reports our own
  // footprint back to the user as something they did.
  it('does not claim a pre-existing hosted skill on a re-run of its own install', async () => {
    await runInstall({ harness: ['claude'] }, makeCtx(), deps());
    const res = await runInstall({ harness: ['claude'] }, makeCtx(), deps({ isInteractive: true }));
    const h = asData(res.data).harnesses[0]!;
    // The raw fact stays true (a SKILL.md was on disk); only the notice gate narrows.
    expect(h.hostedPreexisting).toBe(true);
    expect(h.hostedArrivedFirst).toBe(false);
    expect(h.notes.join('\n')).not.toContain('was already here');
    const text = (res.humanLines ?? []).join('\n').replace(/\x1b\[[0-9;]*m/g, ''); // eslint-disable-line no-control-regex
    expect(text).not.toContain('kept as the zero-install fallback');
  });

  it('still notices the genuine hosted-first funnel', async () => {
    await seedHostedSkill(join(home, '.claude', 'skills'));
    const res = await runInstall({ harness: ['claude'] }, makeCtx(), deps({ isInteractive: true }));
    const h = asData(res.data).harnesses[0]!;
    expect(h.hostedArrivedFirst).toBe(true);
    expect(h.notes.join('\n')).toContain('was already here');
  });

  // The hosted-skill-first funnel puts the mirror in BOTH targets, and the notice
  // is emitted once per harness. Without the directory the two lines are byte
  // identical and read as the CLI stuttering.
  it('names the directory, so a two-harness machine gets two distinguishable lines', async () => {
    const claudeSkills = join(home, '.claude', 'skills');
    const sharedSkills = join(home, '.agents', 'skills');
    await seedHostedSkill(claudeSkills);
    await seedHostedSkill(sharedSkills);

    const res = await runInstall(
      { harness: ['claude', 'codex'] },
      makeCtx(),
      deps({ isInteractive: true }),
    );
    const lines = (res.humanLines ?? [])
      .map((l) => l.replace(/\x1b\[[0-9;]*m/g, '')) // eslint-disable-line no-control-regex
      // The notice's own phrase: the per-harness warning says "stays as", and the
      // summary's skill list says "(hosted, zero-install fallback)".
      .filter((l) => l.includes('kept as the zero-install fallback'));
    expect(lines).toHaveLength(2);
    expect(new Set(lines).size).toBe(2);
    expect(lines.some((l) => l.includes(claudeSkills))).toBe(true);
    expect(lines.some((l) => l.includes(sharedSkills))).toBe(true);
  });

  it('re-running on top of a hosted-skill machine is idempotent', async () => {
    const claudeSkills = join(home, '.claude', 'skills');
    await seedHostedSkill(claudeSkills);

    await runInstall({ harness: ['claude'] }, makeCtx(), deps());
    const before = await Promise.all(
      SKILL_NAMES.map((n) => readFile(join(claudeSkills, n, 'SKILL.md'), 'utf8')),
    );

    const { data: d } = await runInstall({ harness: ['claude'] }, makeCtx(), deps());
    const h = asData(d).harnesses[0]!;
    expect(h.skills.every((s) => s.status === 'up-to-date')).toBe(true);
    expect(h.skills.every((s) => s.preexisting)).toBe(true);
    expect(h.hostedPreexisting).toBe(true);
    expect(h.warnings).toEqual([]); // nothing changed, so nothing to warn about

    const after = await Promise.all(
      SKILL_NAMES.map((n) => readFile(join(claudeSkills, n, 'SKILL.md'), 'utf8')),
    );
    expect(after).toEqual(before);
  });

  // A user's own files beside the SKILL.md are not ours. The old wipe took them and
  // called it "overwritten"; nothing removes them now.
  it("leaves a user's files beside the skill untouched", async () => {
    const dir = join(home, '.claude', 'skills', 'tenjin-search');
    await mkdir(join(dir, 'references'), { recursive: true });
    await writeFile(
      join(dir, 'SKILL.md'),
      await readFile(join(SKILLS_SRC, 'tenjin-search', 'SKILL.md')),
    );
    await writeFile(join(dir, 'references', 'notes.md'), 'my private notes');

    const { data } = await runInstall({ harness: ['claude'] }, makeCtx(), deps());
    const skill = asData(data).harnesses[0]!.skills.find((x) => x.name === 'tenjin-search')!;
    // The packaged file was already identical, so nothing changed at all.
    expect(skill.status).toBe('up-to-date');
    expect(asData(data).harnesses[0]!.warnings.filter((w) => w.includes('tenjin-search'))).toEqual(
      [],
    );
    expect(await readFile(join(dir, 'references', 'notes.md'), 'utf8')).toBe('my private notes');
  });

  it('still warns when it overwrites local edits to a SKILL.md it owns', async () => {
    const dir = join(home, '.claude', 'skills', 'tenjin-search');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'SKILL.md'), '---\nname: tenjin-search\n---\n\nmy edits\n');

    const { data } = await runInstall({ harness: ['claude'] }, makeCtx(), deps());
    const warning = asData(data).harnesses[0]!.warnings.find((w) => w.includes('tenjin-search'));
    expect(warning).toContain('overwritten');
  });

  // An unwritable HOME is an environment problem. It reached the envelope as a raw
  // `EACCES: permission denied, mkdir ...` under INTERNAL with no fix, which reads
  // as a CLI bug and leaves the operator nothing to do.
  it('turns an unwritable skills directory into a typed error with a fix', async () => {
    // root ignores mode bits, so the chmod would not deny anything.
    if (process.platform === 'win32' || process.getuid?.() === 0) return;
    const skills = join(home, '.claude', 'skills');
    await mkdir(skills, { recursive: true });
    await chmod(skills, 0o500);
    try {
      const err = (await runInstall({ harness: ['claude'] }, makeCtx(), deps()).catch(
        (e) => e,
      )) as CliError;
      expect(err).toBeInstanceOf(CliError);
      expect(err.fix).toContain('Permission denied');
      // The child could not be created, so the culprit is the ancestor that
      // refused: the skills root, the deepest directory that exists (resolved,
      // hence realpath: the macOS tmpdir lives behind /var -> /private/var).
      expect(err.fix).toContain(`ls -ld ${await realpath(skills)}`);
      expect(err.fix).toContain('tenjin install');
      expect(err.message).not.toContain('EACCES'); // the raw errno is the cause, not the message
    } finally {
      await chmod(skills, 0o700);
    }
  });

  // The inverse of the missing-child case: the skill directory EXISTS and is
  // itself what refuses the temp-file write. Its parent is writable and innocent,
  // so a fix pointing one directory up sends the operator to chmod the wrong thing.
  it('names the skill directory itself when it exists and refuses the write', async () => {
    if (process.platform === 'win32' || process.getuid?.() === 0) return;
    const dir = join(home, '.claude', 'skills', 'tenjin-search');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'SKILL.md'), '---\nname: tenjin-search\n---\n\nstale\n');
    await chmod(dir, 0o500);
    try {
      const err = (await runInstall({ harness: ['claude'] }, makeCtx(), deps()).catch(
        (e) => e,
      )) as CliError;
      expect(err).toBeInstanceOf(CliError);
      expect(err.fix).toContain('Permission denied');
      expect(err.fix).toContain(`ls -ld ${await realpath(dir)}`);
    } finally {
      await chmod(dir, 0o700);
    }
  });

  // A symlinked SKILL.md is written through to its target, so a denied write
  // happens in the link's TARGET directory, which no path under the skills tree
  // names. The fix must name that directory or the operator has nothing to check.
  it('names the link target directory when a symlinked SKILL.md cannot be written', async () => {
    if (process.platform === 'win32' || process.getuid?.() === 0) return;
    const dotfiles = join(home, 'dotfiles');
    const managed = join(dotfiles, 'search.md');
    await mkdir(dotfiles, { recursive: true });
    await writeFile(managed, 'my managed copy\n');
    const dir = join(home, '.claude', 'skills', 'tenjin-search');
    await mkdir(dir, { recursive: true });
    await symlink(managed, join(dir, 'SKILL.md'));
    await chmod(dotfiles, 0o500);
    try {
      const err = (await runInstall({ harness: ['claude'] }, makeCtx(), deps()).catch(
        (e) => e,
      )) as CliError;
      expect(err).toBeInstanceOf(CliError);
      expect(err.fix).toContain('Permission denied');
      // realpath, because the write goes through the link: on macOS the tmpdir is
      // itself behind a symlink (/var -> /private/var), and the resolved directory
      // is the one whose mode actually decides.
      expect(err.fix).toContain(`ls -ld ${await realpath(dotfiles)}`);
      expect((await lstat(join(dir, 'SKILL.md'))).isSymbolicLink()).toBe(true);
      expect(await readFile(managed, 'utf8')).toBe('my managed copy\n');
    } finally {
      await chmod(dotfiles, 0o700);
    }
  });

  // The directory variant of the case above: the skill directory is itself a
  // symlink, and the mode that denied the write lives on its TARGET. Naming the
  // link's path tells the operator to chmod a healthy link.
  it('names the resolved directory when a symlinked skill directory refuses the write', async () => {
    if (process.platform === 'win32' || process.getuid?.() === 0) return;
    const real = join(home, 'dotfiles', 'tenjin-search');
    await mkdir(real, { recursive: true });
    await writeFile(join(real, 'SKILL.md'), '---\nname: tenjin-search\n---\n\nstale\n');
    const link = join(home, '.claude', 'skills', 'tenjin-search');
    await mkdir(dirname(link), { recursive: true });
    await symlink(real, link);
    await chmod(real, 0o500);
    try {
      const err = (await runInstall({ harness: ['claude'] }, makeCtx(), deps()).catch(
        (e) => e,
      )) as CliError;
      expect(err).toBeInstanceOf(CliError);
      expect(err.fix).toContain('Permission denied');
      expect(err.fix).toContain(`ls -ld ${await realpath(real)}`);
      expect((await lstat(link)).isSymbolicLink()).toBe(true);
    } finally {
      await chmod(real, 0o700);
    }
  });

  // Writing through the link is what the operator asked for by making it. Nothing
  // is removed, so the dotfiles tree keeps both its link and its own files.
  it('writes through a symlinked skill directory, keeping the link and their files', async () => {
    if (process.platform === 'win32') return;
    const real = join(home, 'dotfiles', 'tenjin-search');
    await mkdir(join(real, 'references'), { recursive: true });
    await writeFile(join(real, 'SKILL.md'), '---\nname: tenjin-search\n---\n\nstale\n');
    await writeFile(join(real, 'references', 'notes.md'), 'my private notes');
    const link = join(home, '.claude', 'skills', 'tenjin-search');
    await mkdir(dirname(link), { recursive: true });
    await symlink(real, link);

    await runInstall({ harness: ['claude'] }, makeCtx(), deps());
    expect((await lstat(link)).isSymbolicLink()).toBe(true);
    expect(await readFile(join(real, 'SKILL.md'))).toEqual(
      await readFile(join(SKILLS_SRC, 'tenjin-search', 'SKILL.md')),
    );
    expect(await readFile(join(real, 'references', 'notes.md'), 'utf8')).toBe('my private notes');
  });

  // A broken link cannot be written through. It must fail saying so, and must not
  // quietly become a real directory.
  it('fails a dangling symlink with a fix naming it, and leaves it a link', async () => {
    if (process.platform === 'win32') return;
    const link = join(home, '.claude', 'skills', 'tenjin-search');
    await mkdir(dirname(link), { recursive: true });
    await symlink(join(home, 'nowhere', 'tenjin-search'), link);

    const err = (await runInstall({ harness: ['claude'] }, makeCtx(), deps()).catch(
      (e) => e,
    )) as CliError;
    expect(err).toBeInstanceOf(CliError);
    expect(err.message).toContain('broken symlink');
    expect(err.message).not.toContain('ENOENT');
    expect(err.fix).toContain('ls -ld');
    expect((await lstat(link)).isSymbolicLink()).toBe(true);
  });

  // The write commits with `rename`, which replaces a symlink at the destination
  // PATH with a regular file. A file the operator manages through a link has to be
  // written through it, like the directory case and like settings.json.
  it('writes through a symlinked SKILL.md, keeping the link and updating its target', async () => {
    if (process.platform === 'win32') return;
    const managed = join(home, 'dotfiles', 'search.md');
    await mkdir(dirname(managed), { recursive: true });
    await writeFile(managed, 'my managed copy\n');
    const dir = join(home, '.claude', 'skills', 'tenjin-search');
    await mkdir(dir, { recursive: true });
    await symlink(managed, join(dir, 'SKILL.md'));

    await runInstall({ harness: ['claude'] }, makeCtx(), deps());
    expect((await lstat(join(dir, 'SKILL.md'))).isSymbolicLink()).toBe(true);
    expect(await readFile(managed)).toEqual(
      await readFile(join(SKILLS_SRC, 'tenjin-search', 'SKILL.md')),
    );
  });

  // Treating every read failure as "absent" classified an unreadable skill as a
  // fresh install and then replaced it, because the atomic rename needs DIRECTORY
  // permission, not file permission.
  it('refuses an unreadable SKILL.md instead of replacing it', async () => {
    if (process.platform === 'win32' || process.getuid?.() === 0) return;
    const dir = join(home, '.claude', 'skills', 'tenjin-search');
    await mkdir(dir, { recursive: true });
    const file = join(dir, 'SKILL.md');
    await writeFile(file, 'secret');
    await chmod(file, 0o000);
    try {
      const err = (await runInstall({ harness: ['claude'] }, makeCtx(), deps()).catch(
        (e) => e,
      )) as CliError;
      expect(err).toBeInstanceOf(CliError);
      expect(err.fix).toContain('Permission denied');
      await chmod(file, 0o644);
      expect(await readFile(file, 'utf8')).toBe('secret');
    } finally {
      await chmod(file, 0o644).catch(() => undefined);
    }
  });

  // A dry run must reach the same verdict as the real run.
  it('fails a broken destination link on --dry-run too, matching the real run', async () => {
    if (process.platform === 'win32') return;
    const link = join(home, '.claude', 'skills', 'tenjin-search');
    await mkdir(dirname(link), { recursive: true });
    await symlink(join(home, 'nowhere', 'tenjin-search'), link);

    const dry = (await runInstall({ harness: ['claude'], dryRun: true }, makeCtx(), deps()).catch(
      (e) => e,
    )) as CliError;
    const real = (await runInstall({ harness: ['claude'] }, makeCtx(), deps()).catch(
      (e) => e,
    )) as CliError;
    expect(dry).toBeInstanceOf(CliError);
    expect(real).toBeInstanceOf(CliError);
    expect(dry.fix).toBe(real.fix);
  });

  // `readFile` on a FIFO blocks until a writer appears, so a pipe left at a
  // SKILL.md path hung install past SIGTERM until it was SIGKILLed. An errno
  // mapping cannot help: the call does not fail, it never returns.
  it('refuses a non-regular file at a shipped path instead of reading it', async () => {
    if (process.platform === 'win32') return;
    const dir = join(home, '.claude', 'skills', 'tenjin-search');
    await mkdir(dir, { recursive: true });
    const { execFileSync } = await import('node:child_process');
    execFileSync('mkfifo', [join(dir, 'SKILL.md')]);

    const err = (await runInstall({ harness: ['claude'] }, makeCtx(), deps()).catch(
      (e) => e,
    )) as CliError;
    expect(err).toBeInstanceOf(CliError);
    expect(err.message).toContain('not a regular file');
    expect(err.fix).toContain('ls -l');
  }, 10000);

  // A SKILL.md that is itself a dangling link: resolveThroughLink's throw, which
  // is a different path from a dangling skill DIRECTORY (that one is assertReachable).
  it('fails a SKILL.md that is itself a broken symlink', async () => {
    if (process.platform === 'win32') return;
    const dir = join(home, '.claude', 'skills', 'tenjin-search');
    await mkdir(dir, { recursive: true });
    await symlink(join(home, 'nowhere.md'), join(dir, 'SKILL.md'));

    const err = (await runInstall({ harness: ['claude'] }, makeCtx(), deps()).catch(
      (e) => e,
    )) as CliError;
    expect(err).toBeInstanceOf(CliError);
    expect(err.message).toContain('broken symlink');
    expect(err.fix).toContain('ls -ld');
  });

  // The permission error must name the FILE. Naming its parent sent operators to
  // chmod a directory that was fine, which is the same defect this PR removed from
  // the skills-not-written error.
  it('names the unreadable file, not its writable parent directory', async () => {
    if (process.platform === 'win32' || process.getuid?.() === 0) return;
    const dir = join(home, '.claude', 'skills', 'tenjin-search');
    await mkdir(dir, { recursive: true });
    const file = join(dir, 'SKILL.md');
    await writeFile(file, 'secret');
    await chmod(file, 0o000);
    try {
      const err = (await runInstall({ harness: ['claude'] }, makeCtx(), deps()).catch(
        (e) => e,
      )) as CliError;
      expect(err.fix).toContain(file);
      expect(err.fix).not.toContain(`ls -ld ${dirname(dir)}\``);
    } finally {
      await chmod(file, 0o644).catch(() => undefined);
    }
  });

  // An unwritable data dir fails at lock acquisition, before any skill is touched.
  it('gives an unwritable data directory a typed error with a fix', async () => {
    if (process.platform === 'win32' || process.getuid?.() === 0) return;
    await mkdir(data, { recursive: true });
    await chmod(data, 0o500);
    try {
      const err = (await runInstall({ harness: ['claude'] }, makeCtx(), deps()).catch(
        (e) => e,
      )) as CliError;
      expect(err).toBeInstanceOf(CliError);
      expect(err.fix).toContain('Permission denied');
      expect(err.message).not.toContain('EACCES');
    } finally {
      await chmod(data, 0o700).catch(() => undefined);
    }
  });

  // The whole point of the release-failure callback: the operator is told, on both
  // surfaces, while the command still reports the success it actually had.
  it('reports a lock it could not remove, without failing the run', async () => {
    fsHooks.failLockRelease = true;
    let res;
    try {
      res = await runInstall(
        { harness: ['claude'], allowFreeVerbs: true },
        makeCtx(),
        deps({ isInteractive: true }),
      );
    } finally {
      fsHooks.failLockRelease = false;
    }
    const d = res.data as { lockLeftBehind?: string };
    expect(d.lockLeftBehind).toBe(join(data, 'skills-sync.lock'));
    const text = (res.humanLines ?? []).join('\n').replace(/\x1b\[[0-9;]*m/g, ''); // eslint-disable-line no-control-regex
    expect(text).toContain('could not be removed');
  });

  // The invocability readback happens AFTER the write, so the path can have been
  // swapped for a pipe in between. A raw read there hangs the command that has
  // already done its work.
  it('does not hang when a landed SKILL.md is swapped for a pipe before the readback', async () => {
    if (process.platform === 'win32') return;
    fsHooks.fifoAfterRename = join(home, '.claude', 'skills', 'tenjin-search', 'SKILL.md');
    try {
      const { data } = await runInstall({ harness: ['claude'] }, makeCtx(), deps());
      const skill = asData(data).harnesses[0]!.skills.find((x) => x.name === 'tenjin-search')!;
      // Reaching here at all is the assertion; a pipe is not model-invocable.
      expect(skill.modelInvocable).toBe(false);
    } finally {
      fsHooks.fifoAfterRename = '';
    }
  }, 15000);

  it('leaves a nested symlink in the skill directory alone', async () => {
    if (process.platform === 'win32') return;
    const dir = join(home, '.claude', 'skills', 'tenjin-search');
    await mkdir(dir, { recursive: true });
    await writeFile(join(home, 'real-notes.md'), 'my private notes');
    await symlink(join(home, 'real-notes.md'), join(dir, 'notes.md'));

    await runInstall({ harness: ['claude'] }, makeCtx(), deps());
    expect((await lstat(join(dir, 'notes.md'))).isSymbolicLink()).toBe(true);
    expect(await readFile(join(dir, 'notes.md'), 'utf8')).toBe('my private notes');
  });

  it('a stale disable-model-invocation publish skill is overwritten and re-wired', async () => {
    // What an older CLI left behind: the file is there, the harness ignores it.
    const claudeSkills = join(home, '.claude', 'skills');
    const stale = join(claudeSkills, 'tenjin-publish');
    await mkdir(stale, { recursive: true });
    await writeFile(
      join(stale, 'SKILL.md'),
      '---\nname: tenjin-publish\ndescription: old\ndisable-model-invocation: true\n---\n\n# old\n',
    );

    const { data: d } = await runInstall({ harness: ['claude'] }, makeCtx(), deps());
    const h = asData(d).harnesses[0]!;
    expect(h.skills.find((s) => s.name === 'tenjin-publish')?.status).toBe('updated');
    const text = await readFile(join(stale, 'SKILL.md'), 'utf8');
    expect(isDisabled(text)).toBe(false);
  });

  it('the packaged CLI skills are model-invocable (guards the frontmatter)', async () => {
    for (const name of ['tenjin-search', 'tenjin-publish']) {
      const text = await readFile(join(SKILLS_SRC, name, 'SKILL.md'), 'utf8');
      expect(isDisabled(text)).toBe(false);
    }
  });

  it('wires the shared ~/.agents/skills target the same way', async () => {
    const shared = join(home, '.agents', 'skills');
    await seedHostedSkill(shared);
    const { data: d } = await runInstall({ harness: ['codex'] }, makeCtx(), deps());
    const h = asData(d).harnesses[0]!;
    expect(h.hostedPreexisting).toBe(true);
    expect(h.skills.find((s) => s.name === 'tenjin-publish')?.status).toBe('installed');
    expect(existsSync(join(shared, 'tenjin-publish', 'SKILL.md'))).toBe(true);
  });
});

describe('runInstall: packaged-source wiring guard (#35)', () => {
  /** A throwaway skills source with all three skills, so a test can corrupt exactly one. */
  async function fixtureSource(): Promise<string> {
    const src = await mkdtemp(join(tmpdir(), 'tenjin-install-src-'));
    for (const name of SKILL_NAMES) {
      await mkdir(join(src, name), { recursive: true });
      await writeFile(join(src, name, 'SKILL.md'), `---\nname: ${name}\n---\n\n# ${name}\n`);
    }
    return src;
  }

  it('a packaged CLI skill carrying the flag fails INTERNAL before anything is written', async () => {
    const src = await fixtureSource();
    await writeFile(
      join(src, 'tenjin-publish', 'SKILL.md'),
      '---\nname: tenjin-publish\ndisable-model-invocation: true\n---\n',
    );
    try {
      const err = await caught(() =>
        runInstall({ harness: ['claude'] }, makeCtx(), deps({ skillsSourceDir: src })),
      );
      expect(err.code).toBe('INTERNAL');
      expect(err.message).toContain('tenjin-publish');
      expect(err.message).toContain('disable-model-invocation');
      // Nothing is written: the guard runs before the plan loop, so a bad package
      // can never leave one target rewritten and the next untouched.
      expect(existsSync(join(home, '.claude', 'skills'))).toBe(false);
    } finally {
      await rm(src, { recursive: true, force: true });
    }
  });

  it('the hosted mirror carrying the flag is NOT fatal; install still wires the CLI skills', async () => {
    // The mirror's frontmatter comes verbatim from tenjin.blog/skills.md, so
    // upstream adding the flag must not hard-fail every install.
    const src = await fixtureSource();
    await writeFile(
      join(src, 'tenjin', 'SKILL.md'),
      '---\nname: tenjin\ndisable-model-invocation: true\n---\n',
    );
    try {
      const { data: d } = await runInstall(
        { harness: ['claude'] },
        makeCtx(),
        deps({ skillsSourceDir: src }),
      );
      const h = asData(d).harnesses[0]!;
      expect(h.skills.find((s) => s.name === 'tenjin-publish')?.modelInvocable).toBe(true);
      expect(h.skills.find((s) => s.name === 'tenjin')?.modelInvocable).toBe(false);
    } finally {
      await rm(src, { recursive: true, force: true });
    }
  });

  it('reports modelInvocable per skill, read back from what actually landed', async () => {
    const { data: d } = await runInstall({ harness: ['claude'] }, makeCtx(), deps());
    const h = asData(d).harnesses[0]!;
    expect(h.skills.filter((s) => s.cli).every((s) => s.modelInvocable)).toBe(true);
  });

  it('--dry-run answers for the PACKAGED source, not a hardcoded true', async () => {
    // The mirror is the one skill whose value can legitimately be false (the guard
    // exempts it), and the dry run used to be the one place that always said true.
    const src = await fixtureSource();
    await writeFile(
      join(src, 'tenjin', 'SKILL.md'),
      '---\nname: tenjin\ndisable-model-invocation: true\n---\n',
    );
    try {
      const { data: d } = await runInstall(
        { harness: ['claude'], dryRun: true },
        makeCtx(),
        deps({ skillsSourceDir: src }),
      );
      const h = asData(d).harnesses[0]!;
      expect(h.skills.find((s) => s.name === 'tenjin')?.modelInvocable).toBe(false);
      expect(h.skills.find((s) => s.name === 'tenjin-publish')?.modelInvocable).toBe(true);
      expect(existsSync(join(home, '.claude', 'skills'))).toBe(false); // still wrote nothing
    } finally {
      await rm(src, { recursive: true, force: true });
    }
  });
});

describe('runInstall: preexisting means a real prior copy', () => {
  it('a bare empty skill directory is not "already here"', async () => {
    // `mkdir ~/.claude/skills/tenjin` with no SKILL.md used to report
    // preexisting/hostedPreexisting true and claim the mirror was refreshed.
    await mkdir(join(home, '.claude', 'skills', 'tenjin'), { recursive: true });
    const { data: d } = await runInstall({ harness: ['claude'] }, makeCtx(), deps());
    const h = asData(d).harnesses[0]!;
    expect(h.skills.find((s) => s.name === 'tenjin')?.preexisting).toBe(false);
    expect(h.skills.find((s) => s.name === 'tenjin')?.status).toBe('installed');
    expect(h.hostedPreexisting).toBe(false);
    expect(h.warnings).toEqual([]);
  });

  it('an interrupted write (stray file, no SKILL.md) is not "already here" either', async () => {
    const dir = join(home, '.claude', 'skills', 'tenjin');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'asset.bin'), 'partial');
    const { data: d } = await runInstall({ harness: ['claude'] }, makeCtx(), deps());
    const h = asData(d).harnesses[0]!;
    expect(h.skills.find((s) => s.name === 'tenjin')?.preexisting).toBe(false);
    expect(h.hostedPreexisting).toBe(false);
    // The stray file is the operator's; nothing removes it, so this is a plain
    // install of a skill that was not here, with nothing to warn about.
    expect(await readFile(join(dir, 'asset.bin'), 'utf8')).toBe('partial');
    expect(h.skills.find((s) => s.name === 'tenjin')?.status).toBe('installed');
    expect(h.warnings.filter((w) => w.includes(dir))).toEqual([]);
  });

  it('installs alongside the user OWN files without touching any of them', async () => {
    // ~/.claude/skills/tenjin/skills.md is what `curl tenjin.blog/skills.md -o`
    // leaves behind, and NOTES.md is the user's. The old rm(recursive) deleted
    // both; the skill is now written beside them.
    const searchDir = join(home, '.claude', 'skills', 'tenjin-search');
    await mkdir(join(searchDir, 'references'), { recursive: true });
    await writeFile(join(searchDir, 'NOTES.md'), 'mine');
    await writeFile(join(searchDir, 'references', 'mine.md'), 'also mine');
    const hostedDir = join(home, '.claude', 'skills', 'tenjin');
    await mkdir(hostedDir, { recursive: true });
    await writeFile(join(hostedDir, 'skills.md'), '# a hand-saved hosted skill');

    const { data: d } = await runInstall({ harness: ['claude'] }, makeCtx(), deps());
    const h = asData(d).harnesses[0]!;
    expect(await readFile(join(searchDir, 'NOTES.md'), 'utf8')).toBe('mine');
    expect(await readFile(join(searchDir, 'references', 'mine.md'), 'utf8')).toBe('also mine');
    expect(await readFile(join(hostedDir, 'skills.md'), 'utf8')).toBe(
      '# a hand-saved hosted skill',
    );
    // Neither directory held a SKILL.md, so both are installs and neither is a
    // copy that "was already here".
    expect(h.skills.find((s) => s.name === 'tenjin-search')?.status).toBe('installed');
    expect(h.skills.find((s) => s.name === 'tenjin')?.preexisting).toBe(false);
    expect(h.hostedPreexisting).toBe(false);
    expect(h.warnings).toEqual([]);
  });

  it('the mirror-replacement warning claims no direction about which copy is newer', async () => {
    const dir = join(home, '.claude', 'skills', 'tenjin');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'SKILL.md'), '---\nname: tenjin\n---\n\n# a newer fetch\n');
    const { data: d } = await runInstall({ harness: ['claude'] }, makeCtx(), deps());
    const warnings = asData(d).harnesses[0]!.warnings.join('\n');
    expect(warnings).toContain('may be older');
    expect(warnings).not.toContain('was would be');
  });
});

/** Writing the skill tree: locking, interrupts and destructive-write reporting. */
/**
 * The safety net under write-in-place. `installSkill` writes the files it ships and
 * removes nothing, which cannot orphan anything while each skill is a single file.
 * The day a skill ships a second file and a later release drops it, that file would
 * linger in every install forever, and the fix is a manifest of what the previous
 * version wrote. This fails first and says so.
 */
describe('the packaged skills are single-file, which is what makes write-in-place safe', () => {
  it('ships exactly one SKILL.md per skill and nothing else', async () => {
    for (const name of SKILL_NAMES) {
      const entries = await readdir(join(SKILLS_SRC, name), { recursive: true });
      expect(entries).toEqual(['SKILL.md']);
    }
  });
});

describe('runInstall: the skill-directory write', () => {
  // 5 concurrent runs used to fail 7 of 15 times on raw ENOENT/ENOTEMPTY renames,
  // when each skill was replaced by rm-then-write. Named for what these assertions
  // can actually see: the lock is NOT what this proves, and the tree surviving is
  // delivered by the per-file atomic renames (install.ts says the same).
  it('leaves concurrent installs neither failing nor corrupting the tree', async () => {
    const runs = await Promise.allSettled(
      Array.from({ length: 5 }, () =>
        runInstall({ harness: ['claude'], allowFreeVerbs: true }, makeCtx(), deps()),
      ),
    );
    expect(runs.filter((r) => r.status === 'rejected')).toEqual([]);
    for (const name of SKILL_NAMES) {
      expect(existsSync(join(home, '.claude', 'skills', name, 'SKILL.md'))).toBe(true);
    }
  });

  // A contended lock is a normal outcome, not an internal error: it used to escape
  // as an untyped LockTimeoutError under INTERNAL.
  it('reports a held lock as REFUSED, naming the lock to remove', async () => {
    await mkdir(join(data, 'skills-sync.lock'), { recursive: true });
    const err = (await runInstall(
      { harness: ['claude'] },
      makeCtx(),
      deps({ lockTimeoutMs: 50 }),
    ).catch((e) => e)) as CliError;
    expect(err).toBeInstanceOf(CliError);
    expect(err.code).toBe('REFUSED');
    expect(err.fix).toContain('skills-sync.lock');
  });

  // Pre-held, because asserting the lock is absent AFTER the run is true whether or
  // not the dry run took and released it. A dry run that took it would block here.
  it('takes no lock on a dry run, which writes nothing', async () => {
    await mkdir(join(data, 'skills-sync.lock'), { recursive: true });
    const res = await runInstall(
      { harness: ['claude'], dryRun: true },
      makeCtx(),
      deps({ lockTimeoutMs: 50 }),
    );
    expect(res).toBeDefined();
    expect(existsSync(join(data, 'skills-sync.lock'))).toBe(true); // still the holder's
    expect(existsSync(join(home, '.claude', 'skills', 'tenjin-search'))).toBe(false);
  });
});
