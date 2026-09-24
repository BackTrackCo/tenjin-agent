import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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

  it('takes the nearest directory only, with no merge of its ancestors', async () => {
    const pkg = join(repo, 'packages', 'app');
    await put(project(repo), { router: { enabled: false } });
    await put(project(pkg), { router: { context: 'turn' } });
    const s = await resolve(pkg);
    expect(s.enabled).toEqual({ value: true, source: 'default' });
    expect(s.context).toEqual({ value: 'turn', source: 'project', path: project(pkg) });
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
    await put(project(nested), { router: { enabled: true, context: 'session' } });
    await put(project(repo), { router: { enabled: false } });
    const warned: string[] = [];
    const s = await resolve(nested, {
      isForeignOwned: async (path) => path === project(nested),
      warn: (line) => warned.push(line),
    });
    expect(s.enabled).toEqual({ value: false, source: 'project', path: project(repo) });
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
