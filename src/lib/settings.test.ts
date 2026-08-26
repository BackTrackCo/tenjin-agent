import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { loadProjectConfig, resolvePublishSettings } from './settings';
import { CliError } from './errors';

const run = promisify(execFile);

let dataDir: string;
let projectDir: string;
beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'tenjin-pub-data-'));
  projectDir = await mkdtemp(join(tmpdir(), 'tenjin-pub-proj-'));
});
afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
  await rm(projectDir, { recursive: true, force: true });
});

async function writeGlobal(publish: Record<string, unknown>): Promise<void> {
  await writeFile(join(dataDir, 'config.json'), JSON.stringify({ publish }));
}
async function writeProject(json: unknown, dir = projectDir): Promise<void> {
  await writeFile(join(dir, '.tenjin.json'), JSON.stringify(json));
}

/** A git-check-ignore seam with a fixed answer, so precedence tests are offline. */
const ignored = { isGitignored: async () => true };
const committed = { isGitignored: async () => false };

function input(
  over: Partial<{ dataDir: string; cwd: string; flag: string; env: NodeJS.ProcessEnv }> = {},
) {
  return { dataDir, cwd: projectDir, env: {} as NodeJS.ProcessEnv, ...over };
}

describe('resolvePublishSettings — precedence', () => {
  it('falls back to the built-in defaults when nothing is set', async () => {
    const r = await resolvePublishSettings(input(), committed);
    expect(r).toMatchObject({
      mode: 'review',
      modeSource: 'default',
      defaultPriceAtomic: '100000',
      defaultPriceSource: 'default',
      warnings: [],
    });
  });

  it('global config sets mode and price (file source)', async () => {
    await writeGlobal({ mode: 'review', defaultPrice: '200000' });
    const r = await resolvePublishSettings(input(), committed);
    expect(r.mode).toBe('review');
    expect(r.modeSource).toBe('file');
    expect(r.defaultPriceAtomic).toBe('200000');
    expect(r.defaultPriceSource).toBe('file');
  });

  it('project .tenjin.json overrides global config (project source), decimal USD', async () => {
    await writeGlobal({ mode: 'review', defaultPrice: '200000' });
    // .tenjin.json price is DECIMAL USD (human edge, O1); converted to atomic.
    await writeProject({ publish: { mode: 'auto', defaultPrice: '0.05' } });
    const r = await resolvePublishSettings(input(), committed);
    expect(r.mode).toBe('auto');
    expect(r.modeSource).toBe('project');
    expect(r.defaultPriceAtomic).toBe('50000');
    expect(r.defaultPriceSource).toBe('project');
    expect(r.projectConfigPath).toBe(join(projectDir, '.tenjin.json'));
  });

  it('env TENJIN_PUBLISH_MODE overrides the project layer (env source)', async () => {
    await writeProject({ publish: { mode: 'auto' } });
    const r = await resolvePublishSettings(
      input({ env: { TENJIN_PUBLISH_MODE: 'review' } }),
      committed,
    );
    expect(r.mode).toBe('review');
    expect(r.modeSource).toBe('env');
  });

  it('the --mode flag overrides env (flag source)', async () => {
    const r = await resolvePublishSettings(
      input({ flag: 'review', env: { TENJIN_PUBLISH_MODE: 'auto' } }),
      committed,
    );
    expect(r.mode).toBe('review');
    expect(r.modeSource).toBe('flag');
  });

  it('ignores an invalid env value and falls to the lower layer', async () => {
    await writeGlobal({ mode: 'review', defaultPrice: '100000' });
    const r = await resolvePublishSettings(
      input({ env: { TENJIN_PUBLISH_MODE: 'nonsense' } }),
      committed,
    );
    expect(r.mode).toBe('review');
    expect(r.modeSource).toBe('file');
  });
});

describe('resolvePublishSettings — full-auto loosening gate', () => {
  it('honors full-auto from a gitignored .tenjin.json', async () => {
    await writeProject({ publish: { mode: 'full-auto' } });
    const r = await resolvePublishSettings(input(), ignored);
    expect(r.mode).toBe('full-auto');
    expect(r.modeSource).toBe('project');
    expect(r.warnings).toEqual([]);
  });

  it('downgrades full-auto from a committed .tenjin.json to auto with a warning', async () => {
    await writeProject({ publish: { mode: 'full-auto' } });
    const r = await resolvePublishSettings(input(), committed);
    expect(r.mode).toBe('auto');
    expect(r.modeSource).toBe('project');
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toContain('full-auto');
    expect(r.warnings[0]).toContain('.gitignore');
  });

  it('honors full-auto from env regardless of any project file', async () => {
    await writeProject({ publish: { mode: 'auto' } });
    const r = await resolvePublishSettings(
      input({ env: { TENJIN_PUBLISH_MODE: 'full-auto' } }),
      committed,
    );
    expect(r.mode).toBe('full-auto');
    expect(r.modeSource).toBe('env');
    expect(r.warnings).toEqual([]);
  });

  it('honors full-auto from the flag', async () => {
    const r = await resolvePublishSettings(input({ flag: 'full-auto' }), committed);
    expect(r.mode).toBe('full-auto');
    expect(r.modeSource).toBe('flag');
  });

  it('does not warn when a committed full-auto is overridden by env anyway', async () => {
    await writeProject({ publish: { mode: 'full-auto' } });
    const r = await resolvePublishSettings(
      input({ env: { TENJIN_PUBLISH_MODE: 'review' } }),
      committed,
    );
    expect(r.mode).toBe('review');
    expect(r.warnings).toEqual([]);
  });
});

describe('loadProjectConfig — discovery and validation', () => {
  it('walks up from a nested cwd to find .tenjin.json', async () => {
    await writeProject({ publish: { mode: 'review' } });
    const nested = join(projectDir, 'a', 'b', 'c');
    await mkdir(nested, { recursive: true });
    const loaded = await loadProjectConfig(nested, committed);
    expect(loaded?.path).toBe(join(projectDir, '.tenjin.json'));
    expect(loaded?.layer.publish?.mode).toBe('review');
  });

  it('stops at the repo root (a .git dir) and finds no file above it', async () => {
    // .tenjin.json lives ABOVE the repo root; discovery must not escape the repo.
    await writeProject({ publish: { mode: 'review' } }, projectDir);
    const repo = join(projectDir, 'repo');
    await mkdir(join(repo, '.git'), { recursive: true });
    const loaded = await loadProjectConfig(repo, committed);
    expect(loaded).toBeNull();
  });

  it('returns null when no .tenjin.json exists', async () => {
    expect(await loadProjectConfig(projectDir, committed)).toBeNull();
  });

  it('throws CONFIG_INVALID on malformed JSON', async () => {
    await writeFile(join(projectDir, '.tenjin.json'), '{ not json');
    await expect(loadProjectConfig(projectDir, committed)).rejects.toBeInstanceOf(CliError);
  });

  it('throws CONFIG_INVALID on a bad publish mode', async () => {
    await writeProject({ publish: { mode: 'sometimes' } });
    const err = await loadProjectConfig(projectDir, committed).catch((e: unknown) => e);
    expect((err as CliError).code).toBe('CONFIG_INVALID');
  });

  it('converts a decimal defaultPrice to atomic and rejects an invalid one', async () => {
    await writeProject({ publish: { defaultPrice: '0.25' } });
    const ok = await loadProjectConfig(projectDir, committed);
    expect(ok?.layer.publish?.defaultPrice).toBe('250000');

    await writeProject({ publish: { defaultPrice: 'free' } });
    const err = await loadProjectConfig(projectDir, committed).catch((e: unknown) => e);
    expect((err as CliError).code).toBe('CONFIG_INVALID');
    expect((err as CliError).message).toContain('.tenjin.json');
  });

  it('surfaces an unreadable project file (a directory named .tenjin.json) as CONFIG_INVALID', async () => {
    await mkdir(join(projectDir, '.tenjin.json'));
    const err = await loadProjectConfig(projectDir, committed).catch((e: unknown) => e);
    expect((err as CliError).code).toBe('CONFIG_INVALID');
  });
});

describe('loadProjectConfig — walk-up trust boundary', () => {
  it('never walks above $HOME, so a config outside home is not honored', async () => {
    const base = await mkdtemp(join(tmpdir(), 'tenjin-home-'));
    try {
      const home = join(base, 'home');
      const cwd = join(home, 'proj', 'sub');
      await mkdir(cwd, { recursive: true });
      // Planted above $HOME — must never be discovered.
      await writeFile(
        join(base, '.tenjin.json'),
        JSON.stringify({ publish: { mode: 'full-auto' } }),
      );
      expect(await loadProjectConfig(cwd, { ...committed, homeDir: home })).toBeNull();
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it('ignores a .tenjin.json not owned by the current user, with a stderr warning', async () => {
    await writeProject({ publish: { mode: 'full-auto' } });
    const warnings: string[] = [];
    const loaded = await loadProjectConfig(projectDir, {
      isGitignored: async () => true,
      isForeignOwned: async () => true,
      warn: (m) => warnings.push(m),
      homeDir: projectDir, // bound the walk so it stops instead of wandering tmp
    });
    expect(loaded).toBeNull();
    expect(warnings.some((w) => w.includes('.tenjin.json') && w.includes('not owned'))).toBe(true);
  });
});

describe('loadProjectConfig — real git check-ignore seam', () => {
  it('reports a gitignored .tenjin.json as gitignored, a committed one as not', async () => {
    await run('git', ['init', '-q'], { cwd: projectDir });
    await writeProject({ publish: { mode: 'full-auto' } });

    const committedLoad = await loadProjectConfig(projectDir);
    expect(committedLoad?.layer.gitignored).toBe(false);

    await writeFile(join(projectDir, '.gitignore'), '.tenjin.json\n');
    const ignoredLoad = await loadProjectConfig(projectDir);
    expect(ignoredLoad?.layer.gitignored).toBe(true);
  });
});
