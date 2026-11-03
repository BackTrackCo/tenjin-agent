import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  handoffTarget,
  markLive,
  nodeBinPath,
  readRuntimeState,
  runtimeBuild,
  runtimeStatePath,
  versionDir,
  versionEntry,
} from './runtime-layout';

let home: string;
let root: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'runtime-layout-'));
  root = join(home, '.tenjin', 'runtime');
  mkdirSync(root, { recursive: true });
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

const writeState = (state: unknown): void => {
  writeFileSync(runtimeStatePath(root), JSON.stringify(state));
};

/** A runtime version on disk: its node binary and entry, both present. */
const place = (cli: string, node: string): void => {
  const bin = nodeBinPath(root, node);
  mkdirSync(dirname(bin), { recursive: true });
  writeFileSync(bin, '');
  const entry = versionEntry(root, cli);
  mkdirSync(dirname(entry), { recursive: true });
  writeFileSync(entry, '');
};

const NPM_MODULE = (): string =>
  pathToFileURL(join(home, 'npm', 'lib', 'node_modules', 'tenjin-cli', 'dist', 'index.js')).href;

describe('readRuntimeState', () => {
  const ok = { cli: '0.1.0-alpha.32', node: '24.14.1' };

  it('reads current, previous and pending', () => {
    writeState({ schemaVersion: 1, current: ok, previous: ok, pending: null });
    expect(readRuntimeState(root)).toEqual({ current: ok, previous: ok, pending: null });
  });

  it('is null with no file, junk JSON, or a current that is not a version pair', () => {
    expect(readRuntimeState(root)).toBeNull();
    writeFileSync(runtimeStatePath(root), '{not json');
    expect(readRuntimeState(root)).toBeNull();
    for (const current of [
      { cli: '../../etc', node: '24.14.1' },
      { cli: '0.1.0-alpha.32', node: '../24' },
      { cli: '0.1.0-alpha.32', node: '24.14.1/../../x' },
      { cli: '0.1.0-beta.1', node: '24.14.1' },
      { cli: 32, node: '24.14.1' },
      null,
    ]) {
      writeState({ schemaVersion: 1, current, previous: null, pending: null });
      expect(readRuntimeState(root), JSON.stringify(current)).toBeNull();
    }
  });

  it('reads a path-like previous or pending as null and keeps the current', () => {
    writeState({
      schemaVersion: 1,
      current: ok,
      previous: { cli: '/tmp/evil', node: '24.14.1' },
      pending: { cli: '0.1.0-alpha.33', node: 'C:\\x' },
    });
    expect(readRuntimeState(root)).toEqual({ current: ok, previous: null, pending: null });
  });
});

describe('paths', () => {
  it('put node under bin on POSIX and beside the folder on win32', () => {
    expect(nodeBinPath('/r', '24.1.0', 'linux')).toBe(join('/r', 'node', '24.1.0', 'bin', 'node'));
    expect(nodeBinPath('/r', '24.1.0', 'win32')).toBe(join('/r', 'node', '24.1.0', 'node.exe'));
    expect(versionDir('/r', '1.0.0')).toBe(join('/r', 'versions', '1.0.0'));
    expect(versionEntry('/r', '1.0.0')).toBe(join('/r', 'versions', '1.0.0', 'dist', 'index.js'));
  });
});

describe('runtimeBuild', () => {
  it('recognises <root>/versions/<cli>/dist and nothing else', () => {
    expect(runtimeBuild(join(root, 'versions', '0.1.0-alpha.32', 'dist'))).toEqual({
      root,
      cli: '0.1.0-alpha.32',
    });
    for (const dir of [
      join(root, 'versions', '0.1.0-alpha.32'),
      join(root, 'versions', 'latest', 'dist'),
      join(root, 'cli', '0.1.0-alpha.32', 'dist'),
      join(root, 'versions', '0.1.0-alpha.32', 'dist', 'hosts'),
      join(home, 'npm', 'lib', 'node_modules', 'tenjin-cli', 'dist'),
    ]) {
      expect(runtimeBuild(dir), dir).toBeNull();
    }
  });
});

describe('handoffTarget', () => {
  const current = { cli: '0.1.0-alpha.33', node: '24.14.1' };

  it('hands off to a strictly newer current whose node and entry exist', () => {
    writeState({ schemaVersion: 1, current, previous: null, pending: null });
    place(current.cli, current.node);
    expect(handoffTarget(NPM_MODULE(), '0.1.0-alpha.32', {}, home)).toEqual({
      node: nodeBinPath(root, current.node),
      entry: versionEntry(root, current.cli),
    });
  });

  it('uses the same version runtime, but leaves a newer npm build running', () => {
    writeState({ schemaVersion: 1, current, previous: null, pending: null });
    place(current.cli, current.node);
    expect(handoffTarget(NPM_MODULE(), '0.1.0-alpha.33', {}, home)).not.toBeNull();
    expect(handoffTarget(NPM_MODULE(), '0.1.0-alpha.34', {}, home)).toBeNull();
  });

  it('keeps the source build running when its version equals the installed runtime', () => {
    writeState({ schemaVersion: 1, current, previous: null, pending: null });
    place(current.cli, current.node);
    const checkout = pathToFileURL(join(home, 'checkout', 'dist', 'index.js')).href;
    expect(handoffTarget(checkout, current.cli, {}, home)).toBeNull();
  });

  it('is null when the node or the entry is missing, or there is no state', () => {
    expect(handoffTarget(NPM_MODULE(), '0.1.0-alpha.32', {}, home)).toBeNull();
    writeState({ schemaVersion: 1, current, previous: null, pending: null });
    mkdirSync(dirname(versionEntry(root, current.cli)), { recursive: true });
    writeFileSync(versionEntry(root, current.cli), '');
    expect(handoffTarget(NPM_MODULE(), '0.1.0-alpha.32', {}, home)).toBeNull();
  });

  it('never applies inside a runtime build', () => {
    writeState({ schemaVersion: 1, current, previous: null, pending: null });
    place(current.cli, current.node);
    const inside = pathToFileURL(versionEntry(root, '0.1.0-alpha.32')).href;
    expect(handoffTarget(inside, '0.1.0-alpha.32', {}, home)).toBeNull();
  });

  it('never applies under a non-default TENJIN_DATA_DIR, and does under the default spelled out', () => {
    writeState({ schemaVersion: 1, current, previous: null, pending: null });
    place(current.cli, current.node);
    const other = { TENJIN_DATA_DIR: join(home, 'profile') };
    expect(handoffTarget(NPM_MODULE(), '0.1.0-alpha.32', other, home)).toBeNull();
    const spelled = { TENJIN_DATA_DIR: join(home, '.tenjin') };
    expect(handoffTarget(NPM_MODULE(), '0.1.0-alpha.32', spelled, home)).not.toBeNull();
  });
});

describe('markLive', () => {
  it('writes this pid under the version and unlinks it once', () => {
    const moduleDir = join(root, 'versions', '0.1.0-alpha.32', 'dist');
    const unmark = markLive(moduleDir, 4242);
    const marker = join(versionDir(root, '0.1.0-alpha.32'), '.live', '4242');
    expect(existsSync(marker)).toBe(true);
    unmark();
    unmark();
    expect(existsSync(marker)).toBe(false);
  });

  it('does nothing outside a runtime build', () => {
    const unmark = markLive(join(home, 'npm', 'dist'), 4242);
    unmark();
    expect(readdirSync(home)).toEqual(['.tenjin']);
  });
});
