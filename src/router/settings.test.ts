import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PROJECT_ROUTER_KEYS, RouterLayerSchema, parseRouterLayer } from '../lib/config';
import { CliError } from '../lib/errors';
import { projectRouterPath, routerSettings } from './settings';

/**
 * `router.enabled` and `router.context` across the four layers: the default,
 * the global file, the nearest project file walking up to the git root, and
 * the personal file beside it. Nearest wins, and no layer loosens an outer one.
 */

let root: string;
let home: string;
let data: string;
let repo: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'router-settings-'));
  home = join(root, 'home');
  data = join(root, 'data');
  repo = join(home, 'code', 'repo');
  await mkdir(join(repo, '.git'), { recursive: true });
  await mkdir(data, { recursive: true });
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function put(path: string, body: unknown): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, JSON.stringify(body));
}

const project = (dir: string) => join(dir, '.tenjin', 'config.json');
const local = (dir: string) => join(dir, '.tenjin', 'config.local.json');
const resolve = (cwd: string, extra: Parameters<typeof routerSettings>[1] = {}) =>
  routerSettings({ cwd, dataDir: data }, { homeDir: home, warn: () => undefined, ...extra });

describe('routerSettings', () => {
  it('is on, with the session packet, when no file names a router key', async () => {
    expect(await resolve(repo)).toEqual({
      enabled: { value: true, source: 'default' },
      context: { value: 'session', source: 'default' },
      policy: { status: 'none', path: join(data, 'config.json') },
      sources: { status: 'ok', saved: [], connected: [] },
      nativeReplacement: { mode: 'off' },
    });
  });

  it('reads the global file', async () => {
    await put(join(data, 'config.json'), { maxAutoSpend: '1', router: { enabled: false } });
    const s = await resolve(repo);
    expect(s.enabled).toEqual({ value: false, source: 'file', path: join(data, 'config.json') });
    expect(s.context.source).toBe('default');
  });

  it('finds the project file from a nested directory, up to the git root', async () => {
    await put(project(repo), { router: { enabled: false, context: 'turn' } });
    const nested = join(repo, 'src', 'deep');
    await mkdir(nested, { recursive: true });
    const s = await resolve(nested);
    expect(s.enabled).toEqual({ value: false, source: 'project', path: project(repo) });
    expect(s.context).toEqual({ value: 'turn', source: 'project', path: project(repo) });
  });

  it('reads the personal file over the project file beside it', async () => {
    await put(project(repo), { router: { enabled: true, context: 'session' } });
    await put(local(repo), { router: { enabled: false, context: 'turn' } });
    const s = await resolve(repo);
    expect(s.enabled).toEqual({ value: false, source: 'local', path: local(repo) });
    expect(s.context).toEqual({ value: 'turn', source: 'local', path: local(repo) });
  });

  it('reads a personal file alone', async () => {
    await put(local(repo), { router: { enabled: false } });
    expect((await resolve(repo)).enabled).toEqual({
      value: false,
      source: 'local',
      path: local(repo),
    });
  });

  it('applies every ancestor up to the git root as a floor', async () => {
    const pkg = join(repo, 'packages', 'app');
    await put(project(repo), { router: { enabled: false } });
    await put(project(pkg), { router: { context: 'turn' } });
    const s = await resolve(pkg);
    // The package narrows the packet; the root's off switch still holds.
    expect(s.enabled).toEqual({ value: false, source: 'project', path: project(repo) });
    expect(s.context).toEqual({ value: 'turn', source: 'project', path: project(pkg) });
  });

  it('keeps a root off switch under an empty nested file', async () => {
    const pkg = join(repo, 'packages', 'app');
    await put(project(repo), { router: { enabled: false } });
    await put(project(pkg), {});
    await put(local(pkg), { router: {} });
    expect((await resolve(pkg)).enabled).toEqual({
      value: false,
      source: 'project',
      path: project(repo),
    });
  });

  it('does not let a nested file enable a router its root turned off', async () => {
    const pkg = join(repo, 'packages', 'app');
    await put(project(repo), { router: { enabled: false, context: 'turn' } });
    await put(project(pkg), { router: { enabled: true, context: 'session' } });
    await put(local(pkg), { router: { enabled: true } });
    const s = await resolve(pkg);
    expect(s.enabled).toEqual({ value: false, source: 'project', path: project(repo) });
    expect(s.context).toEqual({ value: 'turn', source: 'project', path: project(repo) });
  });

  it('lets a nested file tighten a root that says nothing', async () => {
    const pkg = join(repo, 'packages', 'app');
    await put(project(repo), { router: { context: 'turn' } });
    await put(local(pkg), { router: { enabled: false } });
    const s = await resolve(pkg);
    expect(s.enabled).toEqual({ value: false, source: 'local', path: local(pkg) });
    expect(s.context).toEqual({ value: 'turn', source: 'project', path: project(repo) });
    // From the root itself, the package's file is not in the walk.
    expect((await resolve(repo)).enabled.value).toBe(true);
  });

  it('never lets a nearer file loosen an outer one', async () => {
    await put(join(data, 'config.json'), { router: { enabled: false, context: 'turn' } });
    await put(project(repo), { router: { enabled: true, context: 'session' } });
    const s = await resolve(repo);
    expect(s.enabled).toMatchObject({ value: false, source: 'file' });
    expect(s.context).toMatchObject({ value: 'turn', source: 'file' });

    await put(join(data, 'config.json'), {});
    await put(project(repo), { router: { enabled: false } });
    await put(local(repo), { router: { enabled: true } });
    expect((await resolve(repo)).enabled).toMatchObject({ value: false, source: 'project' });
  });

  it('stops at the git root', async () => {
    await put(project(join(home, 'code')), { router: { enabled: false } });
    expect((await resolve(repo)).enabled.value).toBe(true);
  });

  it('never reads $HOME/.tenjin as a project', async () => {
    const loose = join(home, 'notes');
    await mkdir(loose, { recursive: true });
    await put(project(home), { router: { enabled: false } });
    expect((await resolve(loose)).enabled.value).toBe(true);
  });

  it('skips a file another user owns and keeps walking', async () => {
    const nested = join(repo, 'vendor');
    await put(project(nested), { router: { enabled: false } });
    await put(project(repo), { router: { context: 'turn' } });
    const warned: string[] = [];
    const s = await resolve(nested, {
      isForeignOwned: async (path) => path === project(nested),
      warn: (line) => warned.push(line),
    });
    expect(s.enabled).toEqual({ value: true, source: 'default' });
    expect(s.context).toEqual({ value: 'turn', source: 'project', path: project(repo) });
    expect(warned).toEqual([`Ignoring ${project(nested)}: not owned by the current user.`]);
  });

  it('honours a planted personal file only when its project is the cwd', async () => {
    await put(local(repo), { router: { enabled: false } });
    const sibling = join(home, 'code', 'other');
    await mkdir(join(sibling, '.git'), { recursive: true });

    expect((await resolve(repo)).enabled).toEqual({
      value: false,
      source: 'local',
      path: local(repo),
    });
    expect((await resolve(join(repo, 'src'))).enabled.value).toBe(false);
    // Anywhere else, the file is not in the walk: not a sibling, not a parent.
    expect((await resolve(sibling)).enabled).toEqual({ value: true, source: 'default' });
    expect((await resolve(join(home, 'code'))).enabled).toEqual({
      value: true,
      source: 'default',
    });
  });

  it.each([
    ['not JSON', '{ nope'],
    ['a string enabled', JSON.stringify({ router: { enabled: 'no' } })],
    ['an unknown context', JSON.stringify({ router: { context: 'all' } })],
  ])('refuses a project file with %s', async (_label, body) => {
    await mkdir(join(repo, '.tenjin'), { recursive: true });
    await writeFile(project(repo), body);
    const err = await resolve(repo).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).code).toBe('CONFIG_INVALID');
    expect((err as CliError).message).toContain(project(repo));
  });
});

/**
 * THE PROJECT LAYER ONLY TIGHTENS, and that holds only while it carries these
 * two keys. A key that loosens (spend, allowlist, enabling, base URL) must not
 * enter it; adding one means deleting this test first.
 */
/**
 * A LINKED WORKTREE carries the main checkout's layers too: its `.git` is a
 * file naming a gitdir, whose `commondir` names the main repository's `.git`.
 */
describe('routerSettings in a git worktree', () => {
  async function worktree(mainDir: string, commonGit = join(mainDir, '.git')): Promise<string> {
    const wt = join(home, 'code', 'wt');
    const gitdir = join(commonGit, 'worktrees', 'wt');
    await mkdir(gitdir, { recursive: true });
    await writeFile(join(gitdir, 'commondir'), '../..\n');
    await mkdir(wt, { recursive: true });
    await writeFile(join(wt, '.git'), `gitdir: ${gitdir}\n`);
    return wt;
  }

  it("applies the main checkout's personal file as one more floor", async () => {
    await put(local(repo), { router: { enabled: false } });
    const wt = await worktree(repo);
    await put(project(wt), { router: { context: 'turn' } });
    const s = await resolve(join(wt, 'src'));
    expect(s.enabled).toEqual({ value: false, source: 'local', path: local(repo) });
    expect(s.context).toEqual({ value: 'turn', source: 'project', path: project(wt) });
  });

  it('skips a bare common dir, one outside $HOME, a submodule, and a foreign file', async () => {
    // Bare: the common dir is not a `.git` inside a working tree.
    // Its parent is no working tree, so a file there must not be read.
    const bare = join(home, 'code', 'bare.git');
    await put(local(join(home, 'code')), { router: { enabled: false } });
    let wt = await worktree(bare, bare);
    expect((await resolve(wt)).enabled.value).toBe(true);
    await rm(join(home, 'code', 'wt'), { recursive: true, force: true });
    await rm(join(home, 'code', '.tenjin'), { recursive: true, force: true });

    // Outside $HOME.
    const outside = join(root, 'elsewhere');
    await mkdir(join(outside, '.git'), { recursive: true });
    await put(local(outside), { router: { enabled: false } });
    wt = await worktree(outside);
    expect((await resolve(wt)).enabled.value).toBe(true);
    await rm(join(home, 'code', 'wt'), { recursive: true, force: true });

    // A submodule: its gitdir has no commondir.
    await put(local(repo), { router: { enabled: false } });
    const sub = join(home, 'code', 'sub');
    await mkdir(join(repo, '.git', 'modules', 'sub'), { recursive: true });
    await mkdir(sub, { recursive: true });
    await writeFile(join(sub, '.git'), `gitdir: ${join(repo, '.git', 'modules', 'sub')}\n`);
    expect((await resolve(sub)).enabled.value).toBe(true);

    // The main checkout's file owned by someone else.
    wt = await worktree(repo);
    expect((await resolve(wt)).enabled.value).toBe(false);
    expect(
      (await resolve(wt, { isForeignOwned: async (path) => path === local(repo) })).enabled.value,
    ).toBe(true);
  });
});

/**
 * THE PERSONAL SETTINGS ARE THE GLOBAL FILE'S ALONE: routing rules, saved
 * accounts and automatic replacement. A repository's files cannot add a rule
 * or turn replacement on, and a rule this build cannot read fails closed for
 * what reads rules without making anything else unreadable.
 */
describe('the personal settings', () => {
  const rules = {
    version: 1,
    block: [{ kind: 'provider', id: 'firecrawl' }],
    prefer: [
      { scope: { kind: 'task', id: 'web research' }, targets: [{ kind: 'provider', id: 'exa' }] },
    ],
  };

  it('reads the saved rules and the policy sent for them, revision included', async () => {
    await put(join(data, 'config.json'), { router: { policy: rules } });
    const { policy } = await resolve(repo);
    expect(policy).toMatchObject({ status: 'ok', saved: rules });
    if (policy.status !== 'ok') throw new Error('expected ok');
    expect(policy.wire).toEqual({
      version: 1,
      revision: policy.revision,
      block: rules.block,
      prefer: rules.prefer,
    });
    expect(policy.revision).toMatch(/^[0-9a-f]{16}$/);
  });

  it('sends nothing for a policy with no rules left in it', async () => {
    await put(join(data, 'config.json'), {
      router: { policy: { version: 1, block: [], prefer: [] } },
    });
    const { policy } = await resolve(repo);
    expect(policy.status).toBe('ok');
    expect(policy).not.toHaveProperty('wire');
  });

  it('ignores every personal key in a project or personal project file', async () => {
    const planted = {
      router: {
        policy: rules,
        sources: [{ id: 'apify' }],
        nativeReplacement: 'when-routed',
        nativeReplacementProviders: [{ kind: 'provider', id: 'exa' }],
      },
    };
    await put(project(repo), planted);
    await put(local(repo), planted);
    const s = await resolve(repo);
    expect(s.policy.status).toBe('none');
    expect(s.sources).toEqual({ status: 'ok', saved: [], connected: [] });
    expect(s.nativeReplacement).toEqual({ mode: 'off' });
  });

  it('fails closed on a policy it cannot read, and still reads the rest', async () => {
    await put(join(data, 'config.json'), {
      router: {
        enabled: false,
        policy: {
          version: 1,
          only: [
            {
              scope: { kind: 'task', id: 'web research' },
              dimension: 'capability',
              targets: [{ kind: 'category', id: 'images' }],
            },
          ],
        },
      },
    });
    const s = await resolve(repo);
    expect(s.enabled.value).toBe(false);
    expect(s.policy).toMatchObject({ status: 'invalid' });
    expect(s.policy.status === 'invalid' && s.policy.problem).toContain(
      'a capability rule is global',
    );
  });

  it('refuses a policy of another version, and one past the wire bound', async () => {
    await put(join(data, 'config.json'), { router: { policy: { ...rules, version: 2 } } });
    expect((await resolve(repo)).policy.status).toBe('invalid');
    const huge = {
      version: 1,
      block: Array.from({ length: 128 }, (_, i) => ({
        kind: 'task',
        id: `${String(i).padStart(3, '0')} ${'x'.repeat(60)}`,
      })),
      only: Array.from({ length: 8 }, (_, i) => ({
        scope: { kind: 'task', id: `t${i}` },
        dimension: 'service',
        targets: Array.from({ length: 16 }, (_, j) => ({
          kind: 'service',
          id: `${i}-${j}-${'y'.repeat(50)}`,
        })),
      })),
    };
    await put(join(data, 'config.json'), { router: { policy: huge } });
    const s = await resolve(repo);
    expect(s.policy.status === 'invalid' && s.policy.problem).toContain('16384 bytes');
  });

  it('makes the rules unreadable when the saved accounts are, and lists none as connected', async () => {
    await put(join(data, 'config.json'), {
      router: { policy: rules, sources: [{ id: 'tenjin' }] },
    });
    const s = await resolve(repo);
    expect(s.sources.status).toBe('invalid');
    expect(s.policy.status).toBe('invalid');
    await put(join(data, 'config.json'), { router: { policy: rules, sources: [{ id: 'apify' }] } });
    const ok = await resolve(repo);
    expect(ok.sources).toEqual({ status: 'ok', saved: [{ id: 'apify' }], connected: [] });
    // A descriptor connects nothing, so no source rides in the policy.
    expect(ok.policy.status === 'ok' && ok.policy.wire).not.toHaveProperty('sources');
  });

  it('names only connected accounts the router has jobs for, never one connected by its address', async () => {
    const internal = {
      id: 'mcp-internal-acme-com',
      label: 'mcp.internal-acme.com',
      mcpUrl: 'https://mcp.internal-acme.com/mcp',
    };
    const apify = { id: 'apify', label: 'Apify', mcpUrl: 'https://mcp.apify.com', mapped: true };
    // Both signed in on this machine.
    await put(join(data, 'sources', 'apify.json'), {});
    await put(join(data, 'sources', 'mcp-internal-acme-com.json'), {});
    await put(join(data, 'config.json'), { router: { sources: [internal] } });
    const alone = await resolve(repo);
    expect(alone.sources).toMatchObject({ connected: ['mcp-internal-acme-com'] });
    // The private hostname's id never rides on a lookup.
    expect(alone.policy).toEqual({ status: 'none', path: join(data, 'config.json') });
    await put(join(data, 'config.json'), { router: { sources: [internal, apify], policy: rules } });
    const both = await resolve(repo);
    expect(both.sources).toMatchObject({ connected: ['mcp-internal-acme-com', 'apify'] });
    expect(both.policy.status === 'ok' && both.policy.wire?.sources).toEqual(['apify']);
  });

  it('reads replacement off unless the global file says when-routed, and an odd value as off', async () => {
    await put(join(data, 'config.json'), {
      router: {
        nativeReplacement: 'when-routed',
        nativeReplacementProviders: [{ kind: 'provider', id: 'exa' }],
      },
    });
    expect((await resolve(repo)).nativeReplacement).toEqual({
      mode: 'when-routed',
      providers: [{ kind: 'provider', id: 'exa' }],
    });
    await put(join(data, 'config.json'), {
      router: { nativeReplacement: 'when-routed', nativeReplacementProviders: [] },
    });
    expect((await resolve(repo)).nativeReplacement).toMatchObject({ mode: 'off' });
    await put(join(data, 'config.json'), { router: { nativeReplacement: 'always' } });
    expect((await resolve(repo)).nativeReplacement).toMatchObject({ mode: 'off' });
  });
});

describe('the project layer parser', () => {
  it('accepts exactly router.enabled and router.context, and reads nothing else', () => {
    expect(Object.keys(RouterLayerSchema.shape).sort()).toEqual(['context', 'enabled']);
    // The scope registry names the same two as the only keys a project may carry.
    expect([...PROJECT_ROUTER_KEYS].sort()).toEqual(['context', 'enabled']);
    const planted = {
      maxAutoSpend: '100000000',
      baseUrl: 'https://attacker.example',
      router: {
        enabled: false,
        context: 'turn',
        maxAutoSpend: '100000000',
        baseUrl: 'https://attacker.example',
        allowlistCreators: ['anyone'],
      },
    };
    expect(parseRouterLayer(planted, 'p')).toEqual({ enabled: false, context: 'turn' });
  });
});

describe('projectRouterPath', () => {
  it('writes at the git root when no project file exists yet', async () => {
    const nested = join(repo, 'src');
    await mkdir(nested, { recursive: true });
    expect(await projectRouterPath({ cwd: nested, local: false }, { homeDir: home })).toBe(
      project(repo),
    );
    expect(await projectRouterPath({ cwd: nested, local: true }, { homeDir: home })).toBe(
      local(repo),
    );
  });

  it('writes beside the layer the resolver reads from here', async () => {
    const pkg = join(repo, 'packages', 'app');
    await put(project(pkg), { router: { context: 'turn' } });
    expect(await projectRouterPath({ cwd: pkg, local: true }, { homeDir: home })).toBe(local(pkg));
  });

  it('refuses $HOME, whose .tenjin is the global config', async () => {
    const err = await projectRouterPath({ cwd: home, local: false }, { homeDir: home }).catch(
      (e: unknown) => e,
    );
    expect((err as CliError).code).toBe('USAGE');
  });
});
