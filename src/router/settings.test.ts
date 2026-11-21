import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RouterLayerSchema, parseRouterLayer } from '../lib/config';
import { CliError } from '../lib/errors';
import { personalSettings, projectRouterPath, routerSettings } from './settings';

/** sha256 of `{"policy":{},"sources":["tenjin"],"version":1}`: a user with no rules. */
const DEFAULT_HASH = 'sha256:4e470b2e578b39c57a9df360011bba9316663a352baa05d458e3fcd618dd58ca';

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
      improve: { value: false, source: 'default' },
      subagents: { value: false, source: 'default' },
      policy: { status: 'none' },
      nativeReplacement: { mode: 'off' },
      wire: {
        status: 'ok',
        hasRules: false,
        settings: {
          version: 1,
          policy: {},
          sources: ['tenjin'],
          hash: DEFAULT_HASH,
        },
      },
      accounts: { saved: [], connected: [] },
    });
  });

  /** Help improve routing is the person's own consent: only the global file
   *  carries it, so a repository's file cannot turn it on for anyone. */
  it('reads router.improve from the global file alone', async () => {
    await put(project(repo), { router: { improve: true } });
    expect((await resolve(repo)).improve).toEqual({ value: false, source: 'default' });
    await put(join(data, 'config.json'), { router: { improve: true } });
    expect((await resolve(repo)).improve).toEqual({
      value: true,
      source: 'file',
      path: join(data, 'config.json'),
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

describe('the project layer parser', () => {
  it('accepts the restrictive router project keys, and reads nothing else', () => {
    expect(Object.keys(RouterLayerSchema.shape).sort()).toEqual([
      'context',
      'enabled',
      'subagents',
    ]);
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

/**
 * THE PERSONAL SETTINGS (plan 36): the routing rules and automatic use, from
 * the global file alone, sent on every routing call with their hash. A
 * project file can never add a rule or turn automatic use on.
 */
describe('the personal settings', () => {
  const global = () => join(data, 'config.json');
  const rule = {
    scope: { kind: 'task', id: 'web research' },
    targets: [{ kind: 'provider', id: 'exa' }],
  };

  it('reads them from the global file and never from a project file', async () => {
    const policy = { version: 1, block: [{ kind: 'provider', id: 'firecrawl' }] };
    await put(project(repo), {
      router: { policy, nativeReplacement: 'when-routed' },
    });
    await put(local(repo), { router: { policy, nativeReplacement: 'when-routed' } });
    const fromProject = await resolve(repo);
    expect(fromProject.policy).toEqual({ status: 'none' });
    expect(fromProject.nativeReplacement).toEqual({ mode: 'off' });
    expect(fromProject.wire).toMatchObject({ status: 'ok', hasRules: false });
    await put(global(), { router: { policy } });
    const fromGlobal = await resolve(repo);
    expect(fromGlobal.policy).toEqual({ status: 'ok', saved: policy });
    expect(fromGlobal.wire).toMatchObject({
      status: 'ok',
      hasRules: true,
      settings: { policy: { block: [{ kind: 'provider', id: 'firecrawl' }] } },
    });
  });

  it('drops emptied collections and a false speed switch from what is sent', () => {
    const { wire } = personalSettings({
      policy: { version: 1, block: [], only: [], prefer: [], preferSpeed: false },
    });
    expect(wire).toEqual({
      status: 'ok',
      hasRules: false,
      settings: { version: 1, policy: {}, sources: ['tenjin'], hash: DEFAULT_HASH },
    });
  });

  it('sends automatic use only when it is on, and hashes it with the rules', () => {
    const off = personalSettings({
      nativeReplacement: 'off',
      nativeReplacementProviders: [{ kind: 'provider', id: 'exa' }],
    });
    const all = personalSettings({ nativeReplacement: 'when-routed' });
    const exa = personalSettings({
      nativeReplacement: 'when-routed',
      nativeReplacementProviders: [{ kind: 'provider', id: 'exa' }],
    });
    const settings = (p: ReturnType<typeof personalSettings>) =>
      p.wire.status === 'ok' ? p.wire.settings : undefined;
    expect(settings(off)).toEqual(settings(personalSettings({})));
    expect(off.nativeReplacement).toEqual({
      mode: 'off',
      providers: [{ kind: 'provider', id: 'exa' }],
    });
    expect(settings(all)?.replacement).toEqual({ mode: 'when-routed' });
    expect(settings(exa)?.replacement).toEqual({
      mode: 'when-routed',
      providers: [{ kind: 'provider', id: 'exa' }],
    });
    const hashes = new Set([off, all, exa].map((p) => settings(p)?.hash));
    expect(hashes.size).toBe(3);
    // Automatic use is not a rule: it never makes a server's missing hash a refusal.
    expect(all.wire).toMatchObject({ hasRules: false });
  });

  it('changes the hash when any rule changes, and never with key order', () => {
    const a = personalSettings({ policy: { version: 1, prefer: [rule] } });
    const b = personalSettings({
      policy: { prefer: [{ targets: rule.targets, scope: rule.scope }], version: 1 },
    });
    const c = personalSettings({ policy: { version: 1, prefer: [rule], preferSpeed: true } });
    const hash = (p: ReturnType<typeof personalSettings>) =>
      p.wire.status === 'ok' ? p.wire.settings.hash : '';
    expect(hash(a)).toBe(hash(b));
    expect(hash(a)).not.toBe(hash(c));
    expect(hash(a)).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it.each([
    ['a version this build does not read', { version: 2 }],
    ['an empty target list', { version: 1, prefer: [{ scope: { kind: 'global' }, targets: [] }] }],
    [
      'a block named twice',
      {
        version: 1,
        block: [
          { kind: 'provider', id: 'exa' },
          { kind: 'provider', id: 'exa' },
        ],
      },
    ],
    ['two preferences for one scope', { version: 1, prefer: [rule, rule] }],
    [
      'two only rules for one scope and dimension',
      {
        version: 1,
        only: [
          {
            scope: { kind: 'task', id: 'web research' },
            dimension: 'provider',
            targets: [{ kind: 'provider', id: 'exa' }],
          },
          {
            scope: { kind: 'task', id: 'web research' },
            dimension: 'provider',
            targets: [{ kind: 'provider', id: 'tavily' }],
          },
        ],
      },
    ],
    [
      'an every-task preference for a provider',
      {
        version: 1,
        prefer: [{ scope: { kind: 'global' }, targets: [{ kind: 'provider', id: 'exa' }] }],
      },
    ],
    [
      'a preference mixing kinds',
      {
        version: 1,
        prefer: [
          {
            scope: { kind: 'task', id: 'web research' },
            targets: [
              { kind: 'provider', id: 'exa' },
              { kind: 'service', id: 'exa-search' },
            ],
          },
        ],
      },
    ],
    [
      'an only rule for accounts',
      {
        version: 1,
        only: [
          {
            scope: { kind: 'global' },
            dimension: 'provider',
            targets: [{ kind: 'source', id: 'fal' }],
          },
        ],
      },
    ],
    ['an unknown key', { version: 1, include: [] }],
  ])('refuses %s, and sends nothing in its place', (_name, policy) => {
    const read = personalSettings({ policy });
    expect(read.policy.status).toBe('invalid');
    expect(read.wire.status).toBe('invalid');
  });

  it('reads an unreadable automatic-use value as off, with why', () => {
    const empty = personalSettings({
      nativeReplacement: 'when-routed',
      nativeReplacementProviders: [],
    });
    expect(empty.nativeReplacement.mode).toBe('off');
    expect(empty.nativeReplacement.problem).toContain('router.nativeReplacementProviders');
    const odd = personalSettings({ nativeReplacement: 'always' });
    expect(odd.nativeReplacement).toMatchObject({ mode: 'off' });
    expect(odd.wire).toMatchObject({ status: 'ok' });
  });
});
