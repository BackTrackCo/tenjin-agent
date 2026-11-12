import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readEffortSettings } from '../../hosts/claude/tenjin/hooks/effort-rules';
import { routerSettings } from './settings';

/**
 * MAIN-AGENT EFFORT'S SWITCH: `router.effort` is off unless the global file
 * raises it, a project file can only lower it, and `router.enabled false`
 * anywhere is off. The Claude mod reads the same files by the same rule
 * (`effort-rules.ts`), since it cannot run this code; every case here holds the
 * two to one answer.
 */

let root: string;
let home: string;
let data: string;
let repo: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'effort-settings-'));
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
const global = (router: Record<string, unknown>) => put(join(data, 'config.json'), { router });
const project = (dir: string, router: Record<string, unknown>) =>
  put(join(dir, '.tenjin', 'config.json'), { router });
const local = (dir: string, router: Record<string, unknown>) =>
  put(join(dir, '.tenjin', 'config.local.json'), { router });

/** The CLI's answer, folded as the mod folds it: `router.enabled false` is off. */
async function cli(cwd: string) {
  const s = await routerSettings({ cwd, dataDir: data }, { homeDir: home, warn: () => undefined });
  const mode = s.enabled.value ? s.effort.value : 'off';
  return mode === 'off'
    ? { mode: 'off', classes: [], ...DEFAULTS }
    : {
        mode,
        classes: s.effortClasses.value,
        cap: s.effortCap.value,
        steps: s.effortSteps.value,
        floor: s.effortFloor.value,
      };
}

/** The cap, the steps and the floor when no file names them. */
const DEFAULTS = { cap: 'xhigh', steps: { notification: 1, ack: 1 }, floor: 'medium' };

/** The mod's answer, over the real files. */
function mod(cwd: string) {
  return readEffortSettings(
    {
      read: async (path) => (existsSync(path) ? readFile(path, 'utf8') : undefined),
      exists: async (path) => existsSync(path),
    },
    { dataDir: data, cwd, home },
  );
}

async function both(cwd: string) {
  const [a, b] = await Promise.all([cli(cwd), mod(cwd)]);
  expect(b).toEqual(a);
  return a;
}

describe('router.effort', () => {
  it('is off by default, with the two lowering classes and the xhigh cap', async () => {
    expect(await both(repo)).toEqual({ mode: 'off', classes: [], ...DEFAULTS });
    await global({ effort: 'apply' });
    expect(await both(repo)).toEqual({
      mode: 'apply',
      classes: ['notification', 'ack'],
      ...DEFAULTS,
    });
  });

  it('cannot be raised by a project or a personal project file', async () => {
    await project(repo, { effort: 'apply', effortClasses: ['correction'], effortCap: 'max' });
    await local(repo, { effort: 'apply' });
    expect((await both(repo)).mode).toBe('off');
    await global({ effort: 'shadow' });
    expect(await both(repo)).toEqual({ mode: 'shadow', classes: [], ...DEFAULTS });
  });

  it('is lowered by any project layer, nearest or outer, the main checkout included', async () => {
    await global({ effort: 'apply', effortClasses: ['notification', 'ack', 'correction'] });
    const nested = join(repo, 'pkg', 'app');
    await mkdir(nested, { recursive: true });
    await project(repo, { effort: 'shadow', effortCap: 'high' });
    await local(nested, { effortClasses: ['ack', 'correction'] });
    expect(await both(nested)).toEqual({
      ...DEFAULTS,
      mode: 'shadow',
      classes: ['ack', 'correction'],
      cap: 'high',
    });
    await local(nested, { effort: 'off' });
    expect((await both(nested)).mode).toBe('off');
  });

  it('takes max as the cap, and a project layer can only lower it', async () => {
    await global({ effort: 'apply', effortCap: 'max' });
    expect((await both(repo)).cap).toBe('max');
    await project(repo, { effortCap: 'high' });
    expect((await both(repo)).cap).toBe('high');
  });

  it('takes deeper steps and the low floor from the global file; a project layer only shrinks and raises them', async () => {
    await global({ effort: 'apply', effortSteps: { notification: 2 }, effortFloor: 'low' });
    expect(await both(repo)).toMatchObject({ steps: { notification: 2, ack: 1 }, floor: 'low' });
    await project(repo, { effortSteps: { notification: 4, ack: 1 }, effortFloor: 'low' });
    expect(await both(repo)).toMatchObject({ steps: { notification: 2, ack: 1 }, floor: 'low' });
    await local(repo, { effortSteps: { notification: 1 }, effortFloor: 'medium' });
    expect(await both(repo)).toMatchObject({ steps: { notification: 1, ack: 1 }, floor: 'medium' });
  });

  it('cannot be deepened or floored lower by a project file', async () => {
    await global({ effort: 'apply' });
    await project(repo, { effortSteps: { notification: 3, ack: 2 }, effortFloor: 'low' });
    expect(await both(repo)).toMatchObject(DEFAULTS);
  });

  it('is off wherever router.enabled is false', async () => {
    await global({ effort: 'apply' });
    await project(repo, { enabled: false });
    expect((await both(repo)).mode).toBe('off');
  });

  it('is off in the mod when a project file is not JSON', async () => {
    await global({ effort: 'apply' });
    await mkdir(join(repo, '.tenjin'), { recursive: true });
    await writeFile(join(repo, '.tenjin', 'config.json'), '{ not json');
    await expect(routerSettings({ cwd: repo, dataDir: data }, { homeDir: home })).rejects.toThrow();
    expect((await mod(repo)).mode).toBe('off');
  });
});
