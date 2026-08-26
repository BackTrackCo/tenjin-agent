import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
  hookFallthroughAsked,
  isTeamModeConfig,
  loadProjectConfig,
  resolvePublishSettings,
  resolveShelfBypass,
} from './settings';
import { resolveSettings } from './config';
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

  /**
   * The key is global-only because it can only widen what a yes covers, so a
   * `.tenjin.json` a cloned repo carries must not set it. Failing closed is the
   * point; failing closed SILENTLY is not, because an operator then believes a
   * consent setting is in force that is not.
   */
  it('ignores publish.ackServerWarnings in a project file, and says so', async () => {
    await writeProject({ publish: { ackServerWarnings: 'on' } });
    const r = await resolvePublishSettings(input(), committed);
    expect(r.ackServerWarnings).toBe('mode');
    expect(r.warnings.join('\n')).toContain('Ignoring publish.ackServerWarnings');
    expect(r.warnings.join('\n')).toContain('.tenjin.json');
  });

  it('reads publish.ackServerWarnings from the global config, silently', async () => {
    await writeGlobal({ ackServerWarnings: 'off' });
    const r = await resolvePublishSettings(input(), committed);
    expect(r.ackServerWarnings).toBe('off');
    expect(r.warnings).toEqual([]);
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

/**
 * WHO THE KEY IS PAIRED WITH. `shelfBypassSecret` is file-only, but `baseUrl` is
 * not: `--base-url` and `TENJIN_BASE_URL` outrank the file. Pairing the secret
 * with the resolved base URL therefore made one command enough to send the
 * team's door key anywhere — and the transport's origin test agreed, because the
 * pair it compares against had been built from the named host. The pair is now
 * built from the CONFIGURED origin, so a re-pointed run gets no key at all.
 */
describe('resolveShelfBypass — the key follows the configured shelf, not the flag', () => {
  const TEAM = 'https://backtrack.tenjin.sh';
  const SECRET = 'shelf-secret-abc123';
  const config = { baseUrl: TEAM, shelfBypassSecret: SECRET };

  const pairFor = (flags: { baseUrl?: string }, env: NodeJS.ProcessEnv = {}) =>
    resolveShelfBypass(config, resolveSettings({ config, flags, env }));

  it('issues the key when the run is still pointed at the configured shelf', () => {
    expect(pairFor({})).toEqual({ origin: TEAM, secret: SECRET });
    // An explicit flag naming the SAME origin is the same run, path and all.
    expect(pairFor({ baseUrl: `${TEAM}/` })).toEqual({ origin: TEAM, secret: SECRET });
  });

  it('issues nothing when --base-url re-points the run', () => {
    expect(pairFor({ baseUrl: 'https://attacker.example' })).toBeUndefined();
    // Including at the public marketplace: consulting it deliberately must not
    // put the team deployment's key in a request to it.
    expect(pairFor({ baseUrl: 'https://tenjin.blog' })).toBeUndefined();
  });

  it('issues nothing when TENJIN_BASE_URL re-points the run', () => {
    expect(pairFor({}, { TENJIN_BASE_URL: 'https://attacker.example' })).toBeUndefined();
  });

  it('issues nothing without a secret, whatever the base URL', () => {
    const noSecret = { baseUrl: TEAM };
    expect(
      resolveShelfBypass(noSecret, resolveSettings({ config: noSecret, flags: {}, env: {} })),
    ).toBeUndefined();
  });
});

/**
 * TEAM MODE NEEDS A SHELF, NOT JUST A SECRET. Both `baseUrl` and
 * `publicShelfUrl` default to the marketplace, and the day-0 setup is two
 * independent commands, so the reachable wrong state is a secret with no
 * private deployment behind it. Team mode is the mode that skips the publish
 * scan, skips the confirm cascade and prices at 0, so calling that state "team
 * mode" would auto-publish internal notes to tenjin.blog under full-auto. It
 * fails safe to public mode instead.
 */
describe('resolveShelfBypass — a secret with no private shelf is public mode', () => {
  const SECRET = 'shelf-secret-abc123';
  const pairFor = (config: Record<string, unknown>) =>
    resolveShelfBypass(config, resolveSettings({ config, flags: {}, env: {} }));

  it('issues nothing when baseUrl was never pointed off the marketplace', () => {
    expect(pairFor({ shelfBypassSecret: SECRET })).toBeUndefined();
    expect(pairFor({ baseUrl: 'https://tenjin.blog', shelfBypassSecret: SECRET })).toBeUndefined();
    // An alias of the same production deployment is not a loophole.
    expect(pairFor({ baseUrl: 'https://tenjin.sh', shelfBypassSecret: SECRET })).toBeUndefined();
  });

  it('issues nothing when baseUrl and publicShelfUrl are the same origin', () => {
    expect(
      pairFor({
        baseUrl: 'https://shelf.example',
        publicShelfUrl: 'https://shelf.example',
        shelfBypassSecret: SECRET,
      }),
    ).toBeUndefined();
  });

  it("issues the key for a deployment of the team's own", () => {
    expect(pairFor({ baseUrl: 'https://backtrack.tenjin.sh', shelfBypassSecret: SECRET })).toEqual({
      origin: 'https://backtrack.tenjin.sh',
      secret: SECRET,
    });
  });
});

/**
 * The machine-level team-mode predicate, which is what shapes the installed skill
 * text and the install-time hook disclosure. It has to answer the same question
 * `resolveShelfBypass` does — both halves, not just a non-empty secret — off the
 * RAW config, because the two things it feeds outlive the invocation: a written
 * SKILL.md is read by every later session, and the generated hook scripts read
 * `config.baseUrl` with no flag layer at all.
 */
describe('isTeamModeConfig — the machine mode, not the invocation', () => {
  const SECRET = 'shelf-secret-abc123';
  const TEAM = 'https://backtrack.tenjin.sh';

  it("is true only with both halves: a shelf of the team's own and the key", () => {
    expect(isTeamModeConfig({ baseUrl: TEAM, shelfBypassSecret: SECRET })).toBe(true);
  });

  it('is false for either half alone', () => {
    expect(isTeamModeConfig({ baseUrl: TEAM })).toBe(false);
    expect(isTeamModeConfig({ shelfBypassSecret: SECRET })).toBe(false);
    expect(isTeamModeConfig({})).toBe(false);
  });

  it('is false for an empty secret, which is how `config set` clears it', () => {
    expect(isTeamModeConfig({ baseUrl: TEAM, shelfBypassSecret: '' })).toBe(false);
  });

  // The half-set state docs/command-reference.md#team-shelf documents: a secret
  // landed before the baseUrl did. Team mode there would render team guidance on a
  // machine still publishing to the public marketplace.
  it('is false for a secret with baseUrl still on the marketplace, alias included', () => {
    expect(isTeamModeConfig({ baseUrl: 'https://tenjin.blog', shelfBypassSecret: SECRET })).toBe(
      false,
    );
    expect(isTeamModeConfig({ baseUrl: 'https://tenjin.sh', shelfBypassSecret: SECRET })).toBe(
      false,
    );
  });

  it('is false when baseUrl and publicShelfUrl name the same origin', () => {
    expect(
      isTeamModeConfig({
        baseUrl: 'https://shelf.example',
        publicShelfUrl: 'https://shelf.example',
        shelfBypassSecret: SECRET,
      }),
    ).toBe(false);
  });

  it('is false on an unparseable baseUrl rather than throwing', () => {
    expect(isTeamModeConfig({ baseUrl: 'not a url', shelfBypassSecret: SECRET })).toBe(false);
  });

  /**
   * One rule, two names. The disclosure of what the hooks ask and the guidance the
   * skills render must never disagree about which mode the machine is in, so this
   * pins them to the same function rather than to two copies that drift.
   */
  it('agrees with hookFallthroughAsked on every shape above', () => {
    const shapes: Record<string, unknown>[] = [
      { baseUrl: TEAM, shelfBypassSecret: SECRET },
      { baseUrl: TEAM },
      { shelfBypassSecret: SECRET },
      {},
      { baseUrl: TEAM, shelfBypassSecret: '' },
      { baseUrl: 'https://tenjin.blog', shelfBypassSecret: SECRET },
      { baseUrl: 'not a url', shelfBypassSecret: SECRET },
    ];
    for (const config of shapes) {
      expect(hookFallthroughAsked(config), JSON.stringify(config)).toBe(isTeamModeConfig(config));
    }
  });

  /**
   * `resolveShelfBypass` is the INVOCATION's answer and this is the MACHINE's, so
   * they agree on a plain run and diverge on exactly one thing: a `--base-url` that
   * re-points this run does not change what mode the machine is configured in, and
   * so must not change the skill text on disk.
   */
  it('ignores a --base-url that re-points the run, unlike resolveShelfBypass', () => {
    const config = { baseUrl: TEAM, shelfBypassSecret: SECRET };
    const flags = { baseUrl: 'https://tenjin.blog' };
    expect(resolveShelfBypass(config, resolveSettings({ config, flags, env: {} }))).toBeUndefined();
    expect(isTeamModeConfig(config)).toBe(true);
  });
});
