import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInstall } from './install';
import type { InstallDeps, PromptFn } from './install';
import { resolveSkillsSource, SKILL_NAMES } from '../lib/skills-source';
import { ALWAYS_SAFE_ALLOWLIST, NEVER_ALLOWLISTED } from '../lib/permissions';
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
    // Default wallet seams so an interactive test never blocks on a real prompt or
    // writes a real key; wallet-specific tests override these.
    walletExists: async () => false,
    confirmWallet: async () => false,
    // Default the CLAUDE.md prompt to no so interactive tests don't block on stdin;
    // CLAUDE.md-specific tests override this or pass the --claude-md flag.
    confirmClaudeMd: async () => false,
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

  it('--no-claude-md skips without prompting even when interactive', async () => {
    const confirm = vi.fn(async () => true);
    const { data: d } = await runInstall(
      { harness: ['claude'], claudeMd: false },
      makeCtx(),
      deps({ isInteractive: true, promptMode: async () => '', confirmClaudeMd: confirm }),
    );
    expect(confirm).not.toHaveBeenCalled();
    expect(asData(d).harnesses[0]!.claudeMd?.status).toBe('skipped');
    expect(existsSync(claudeMdPath())).toBe(false);
  });

  it('interactive yes writes CLAUDE.md; no skips it', async () => {
    const yes = await runInstall(
      { harness: ['claude'] },
      makeCtx(),
      deps({ isInteractive: true, promptMode: async () => '', confirmClaudeMd: async () => true }),
    );
    expect(asData(yes.data).harnesses[0]!.claudeMd?.status).toBe('written');
    expect(existsSync(claudeMdPath())).toBe(true);

    // Fresh home for the "no" case.
    await rm(claudeMdPath(), { force: true });
    const no = await runInstall(
      { harness: ['claude'] },
      makeCtx(),
      deps({ isInteractive: true, promptMode: async () => '', confirmClaudeMd: async () => false }),
    );
    expect(asData(no.data).harnesses[0]!.claudeMd?.status).toBe('skipped');
  });

  it('--dry-run does not prompt for CLAUDE.md', async () => {
    const confirm = vi.fn(async () => true);
    const { data: d } = await runInstall(
      { harness: ['claude'], dryRun: true },
      makeCtx(),
      deps({ isInteractive: true, promptMode: async () => '', confirmClaudeMd: confirm }),
    );
    expect(confirm).not.toHaveBeenCalled();
    expect(asData(d).harnesses[0]!.claudeMd?.status).toBe('skipped');
  });

  it('non-interactive skip mentions how to add the nudge later', async () => {
    const sink = () => ({ write: () => true }) as unknown as NodeJS.WritableStream;
    const ttyCtx: CommandContext = {
      flags: { json: false, timeout: 10000 },
      dataDir: data,
      io: { stdout: sink(), stderr: sink(), isTTY: true },
    };
    // TTY output but no stdin (canPrompt false), no flag: skipped, with a hint.
    const res = await runInstall({ harness: ['claude'] }, ttyCtx, deps());
    const text = (res.humanLines ?? []).join('\n').replace(/\x1b\[[0-9;]*m/g, ''); // eslint-disable-line no-control-regex
    expect(text).toContain('--claude-md');
    expect(text).toContain('CLAUDE.md');
  });
});

describe('runInstall: nudge disclosure + undo hint in the walkthrough', () => {
  const human = (res: { humanLines?: string[] }): string =>
    (res.humanLines ?? []).join('\n').replace(/\x1b\[[0-9;]*m/g, ''); // eslint-disable-line no-control-regex

  it('discloses what a freshly written AGENTS.md nudge does + how to undo it', async () => {
    const res = await runInstall(
      { harness: ['codex'] },
      makeCtx(),
      deps({ isInteractive: true, promptMode: async () => '' }),
    );
    const text = human(res);
    expect(text).toContain('the generalized question text is sent to tenjin.blog');
    expect(text).toContain('Undo anytime: delete the');
    expect(text).toContain(join(home, '.agents', 'AGENTS.md'));
  });

  it('discloses + undo for a CLAUDE.md nudge written on interactive yes', async () => {
    const res = await runInstall(
      { harness: ['claude'] },
      makeCtx(),
      deps({ isInteractive: true, promptMode: async () => '', confirmClaudeMd: async () => true }),
    );
    const text = human(res);
    expect(text).toContain('CLAUDE.md nudge');
    expect(text).toContain('the generalized question text is sent to tenjin.blog');
    expect(text).toContain(join(home, '.claude', 'CLAUDE.md'));
  });

  it('does NOT disclose on an untouched re-run (already-present)', async () => {
    await runInstall({ harness: ['codex'] }, makeCtx(), deps());
    const res = await runInstall(
      { harness: ['codex'] },
      makeCtx(),
      deps({ isInteractive: true, promptMode: async () => '' }),
    );
    const text = human(res);
    expect(text).not.toContain('Undo anytime');
    expect(text).not.toContain('the generalized question text is sent to tenjin.blog');
  });

  it('discloses a silent in-place upgrade of an older AGENTS.md pointer line', async () => {
    const OLD = `<!-- tenjin-cli:skills --> Tenjin agent skills are installed at /old (tenjin-search, tenjin-publish, tenjin). Read the relevant SKILL.md before using the tenjin CLI.`;
    await mkdir(join(home, '.agents'), { recursive: true });
    await writeFile(join(home, '.agents', 'AGENTS.md'), `${OLD}\n`);
    const res = await runInstall(
      { harness: ['codex'] },
      makeCtx(),
      deps({ isInteractive: true, promptMode: async () => '' }),
    );
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

  it('removes stray local files so the packaged copy is exactly what lands', async () => {
    const dest = join(home, '.claude', 'skills', 'tenjin');
    await mkdir(dest, { recursive: true });
    await writeFile(join(dest, 'SKILL.md'), 'stale\n');
    await writeFile(join(dest, 'stray.txt'), 'orphan\n');

    await runInstall({ harness: ['claude'] }, makeCtx(), deps());
    expect(existsSync(join(dest, 'stray.txt'))).toBe(false);
    expect(existsSync(join(dest, 'SKILL.md'))).toBe(true);
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

  function promptSpy(answers: string[]): { fn: PromptFn; calls: () => number } {
    let i = 0;
    let n = 0;
    return {
      calls: () => n,
      fn: async () => {
        n++;
        return answers[i++] ?? '';
      },
    };
  }

  it('an interactive prompt persists an explicit choice (source prompt)', async () => {
    const spy = promptSpy(['review']);
    const { data: d } = await runInstall(
      { harness: ['claude'] },
      makeCtx(),
      deps({ isInteractive: true, promptMode: spy.fn }),
    );
    expect(spy.calls()).toBe(1);
    expect(modeOf(d)).toEqual({ value: 'review', source: 'prompt' });
    expect(await persistedMode()).toBe('review');
  });

  it('a plain enter keeps review WITHOUT writing (provenance stays default)', async () => {
    const spy = promptSpy(['']); // enter
    const { data: d } = await runInstall(
      { harness: ['claude'] },
      makeCtx(),
      deps({ isInteractive: true, promptMode: spy.fn }),
    );
    expect(modeOf(d)).toEqual({ value: 'review', source: 'default-skipped' });
    expect(await persistedMode()).toBeUndefined(); // no config write
  });

  it('re-prompts once on an unrecognized answer, then persists the valid retry', async () => {
    const spy = promptSpy(['nope', 'full-auto']);
    const { data: d } = await runInstall(
      { harness: ['claude'] },
      makeCtx(),
      deps({ isInteractive: true, promptMode: spy.fn }),
    );
    expect(spy.calls()).toBe(2);
    expect(modeOf(d)).toEqual({ value: 'full-auto', source: 'prompt' });
    expect(await persistedMode()).toBe('full-auto');
  });

  it('falls back to review (no write) after two unrecognized answers', async () => {
    const spy = promptSpy(['nope', 'still-nope']);
    const { data: d } = await runInstall(
      { harness: ['claude'] },
      makeCtx(),
      deps({ isInteractive: true, promptMode: spy.fn }),
    );
    expect(spy.calls()).toBe(2);
    expect(modeOf(d)).toEqual({ value: 'review', source: 'default-skipped' });
    expect(await persistedMode()).toBeUndefined();
  });

  it('does not prompt or write on a non-interactive run', async () => {
    const spy = promptSpy(['review']);
    const { data: d } = await runInstall(
      { harness: ['claude'] },
      makeCtx(),
      deps({ isInteractive: false, promptMode: spy.fn }),
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
      deps({ isInteractive: true, promptMode: spy.fn }),
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
      deps({ isInteractive: true, promptMode: spy.fn }),
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
      deps({ isInteractive: true, promptMode: spy.fn }),
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
      deps({ isInteractive: true, promptMode: spy.fn }), // json overrides isInteractive
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

  it('returns the walkthrough as humanLines (no envelope path at a TTY)', async () => {
    const res = await runInstall(
      { harness: ['claude'] },
      makeCtx(),
      deps({ isInteractive: true, promptMode: async () => '' }),
    );
    const text = human(res);
    expect(text).toContain('Claude Code: 3 skills installed');
    expect(text).toContain('publish mode: review');
    expect(text).toContain('Done. Try: tenjin search');
  });

  it('prints the recommended auto-mode allowlist, buy separated, send never (#33)', async () => {
    const res = await runInstall(
      { harness: ['claude'] },
      makeCtx(),
      deps({ isInteractive: true, promptMode: async () => '' }),
    );
    const text = human(res);
    for (const e of ALWAYS_SAFE_ALLOWLIST) expect(text).toContain(e.rule);
    // buy appears only under the opt-in heading, never inside the safe block.
    expect(text).toContain('Opt in separately, only if you want unattended purchases:');
    expect(text).toContain('Bash(tenjin buy:*)');
    expect(text).toContain('maxAutoSpend');
    // No rule is ever offered for a money-moving or state-changing verb.
    for (const e of NEVER_ALLOWLISTED) {
      const verb = (e.command.split(' / ')[0] ?? e.command).replace(/^tenjin /, '');
      expect(text).not.toMatch(new RegExp(`Bash\\(tenjin ${verb}[^)]*\\)`));
    }
    expect(text).toContain('tenjin send');
    expect(text).toContain('.claude/settings.json');
    // The caveats qualify the rules, so they travel with them or the block lies.
    expect(text).toContain('--base-url');
    expect(text).toContain('mcp__tenjin__tenjin_publish');
    // And the corrected claims, not the ones the first cut shipped.
    expect(text).toMatch(/authorizes UNATTENDED purchases/);
    expect(text).not.toMatch(/still puts a human on every purchase/);
    expect(text).not.toContain('free, read-only verbs');
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
    expect(d.permissions.optIn.map((e) => e.rule)).toEqual(['Bash(tenjin buy:*)']);
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
        promptMode: async () => '',
        walletExists: async () => false,
        confirmWallet: async () => true,
        createWallet: create,
      }),
    );
    expect(create).toHaveBeenCalledOnce();
    const text = human(res);
    expect(text).toContain(ADDR);
    expect(text).toContain('Fund it: send a few dollars of USDC on Base');
    expect(text).toContain('Check with: tenjin wallet balance');
  });

  it('declining the wallet prompt shows the create-later line, no create', async () => {
    const create = vi.fn(async () => ADDR);
    const res = await runInstall(
      { harness: ['claude'] },
      makeCtx(),
      deps({
        isInteractive: true,
        promptMode: async () => '',
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
      deps({ isInteractive: true, promptMode: async () => '', confirmWallet: confirm }),
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
        promptMode: async () => '',
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
    const prompt = vi.fn(async () => 'review');
    const confirm = vi.fn(async () => true);
    const res = await runInstall(
      { harness: ['claude'] },
      ttyCtx,
      deps({ promptMode: prompt, confirmWallet: confirm, walletExists: async () => false }),
    );
    expect(prompt).not.toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();
    expect(human(res)).toContain('publish mode: review');
    expect(human(res)).toContain('Create one later with: tenjin wallet create');
  });

  it('a fully-green doctor is one line; a failure surfaces with its fix', async () => {
    const okRes = await runInstall(
      { harness: ['claude'] },
      makeCtx(),
      deps({ isInteractive: true, promptMode: async () => '' }),
    );
    expect(human(okRes)).toContain('Everything checks out');

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
      deps({ isInteractive: true, promptMode: async () => '', collectChecks: async () => failing }),
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
    const res = await runInstall(
      { harness: ['claude'] },
      makeCtx(),
      deps({ isInteractive: true, promptMode: async () => '' }),
    );
    const text = (res.humanLines ?? []).join('\n').replace(/\x1b\[[0-9;]*m/g, ''); // eslint-disable-line no-control-regex
    expect(text).toContain('tenjin-search, tenjin-publish (CLI)');
    expect(text).toContain('zero-install fallback');
    expect(text).toContain('take precedence');
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
    // The stray file is cleared by the wholesale overwrite.
    expect(existsSync(join(home, '.claude', 'skills', 'tenjin', 'asset.bin'))).toBe(false);
    // ...and because bytes were destroyed, the destruction is still reported:
    // `preexisting` answers "was a real copy here", `status`/`warnings` answer
    // "did this run delete anything", and they are different questions.
    expect(h.skills.find((s) => s.name === 'tenjin')?.status).toBe('updated');
    expect(h.warnings.join('\n')).toContain(dir);
  });

  it('a destination holding the user OWN files keeps the overwrite warning', async () => {
    // ~/.claude/skills/tenjin/skills.md is what `curl tenjin.blog/skills.md -o`
    // leaves behind, and NOTES.md is the user's. rm(recursive) deletes both, so a
    // silent `installed` with no warning was the only notice they ever got.
    const searchDir = join(home, '.claude', 'skills', 'tenjin-search');
    await mkdir(join(searchDir, 'references'), { recursive: true });
    await writeFile(join(searchDir, 'NOTES.md'), 'mine');
    await writeFile(join(searchDir, 'references', 'mine.md'), 'also mine');
    const hostedDir = join(home, '.claude', 'skills', 'tenjin');
    await mkdir(hostedDir, { recursive: true });
    await writeFile(join(hostedDir, 'skills.md'), '# a hand-saved hosted skill');

    const { data: d } = await runInstall({ harness: ['claude'] }, makeCtx(), deps());
    const h = asData(d).harnesses[0]!;
    const warnings = h.warnings.join('\n');
    expect(warnings).toContain(searchDir);
    expect(warnings).toContain(hostedDir);
    expect(h.skills.find((s) => s.name === 'tenjin-search')?.status).toBe('updated');
    // The `preexisting` semantics are unchanged: neither held a SKILL.md.
    expect(h.skills.find((s) => s.name === 'tenjin')?.preexisting).toBe(false);
    expect(h.hostedPreexisting).toBe(false);
    expect(existsSync(join(searchDir, 'NOTES.md'))).toBe(false);
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
