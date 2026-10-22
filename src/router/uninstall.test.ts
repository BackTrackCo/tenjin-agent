import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { persistRouterProject } from '../commands/config';
import type { CommandContext } from '../context';
import { CliError } from '../lib/errors';
import { writePassphraseRecord } from '../lib/passphrase-record';
import { describeStoreLocation } from '../lib/wallet/passphrase';
import type { ClaudeRun } from './claude-cli';
import { LAUNCHER_MARKER } from './plugin-files';
import {
  removeRuntimeAndLaunchers,
  resolveUninstallTarget,
  runRouterUninstall,
  type RouterUninstallDeps,
  type UninstallTarget,
} from './uninstall';

/**
 * `tenjin uninstall` for where you are: which install a bare run, `--project`
 * and `--all` take, from Claude Code's own record and `routerProjects`; that
 * each removal runs in exactly its project's folder; and that the marketplace
 * goes only once no install is left anywhere. `claude` is a seam that edits
 * the `installed_plugins.json` fixture as the real one would.
 */

const ADDRESS = '0x3c0D84055994c3062819Ce8730869D0aDeA4c3Bf';

let root: string;
let home: string;
let data: string;
let cfg: string;
let other: string;
let elsewhere: string;
let calls: { args: string; cwd: string }[];
/** Folders whose `claude plugin uninstall` fails. */
let failIn: Set<string>;

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'router-uninstall-')));
  home = join(root, 'home');
  data = join(root, 'data');
  cfg = join(root, 'cfg');
  other = join(root, 'other');
  elsewhere = join(root, 'elsewhere');
  for (const dir of [home, data, other, elsewhere, join(cfg, 'plugins')]) {
    await mkdir(dir, { recursive: true });
  }
  calls = [];
  failIn = new Set();
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function ctx(): CommandContext {
  const sink = () => ({ write: () => true }) as unknown as NodeJS.WritableStream;
  return {
    flags: { json: true, timeout: 5000 },
    dataDir: data,
    io: { stdout: sink(), stderr: sink(), isTTY: false },
  };
}

const recordsFile = () => join(cfg, 'plugins', 'installed_plugins.json');

/** Claude Code's record in the lab's Q5 shape: key order varies between entries. */
async function writeRecords(entries: Record<string, unknown>[]): Promise<void> {
  await writeFile(
    recordsFile(),
    JSON.stringify({
      version: 2,
      plugins: { 'tenjin@tenjin': entries, 'other@market': [{ scope: 'user' }] },
    }),
  );
}
const userEntry = () => ({
  scope: 'user',
  installPath: '/stale',
  version: '0.0.1',
  installedAt: 'x',
});
const localEntry = (projectPath: string) => ({
  version: '0.0.1',
  projectPath,
  installedAt: 'x',
  scope: 'local',
  installPath: '/stale',
});

/** A `claude` that removes the record its scope and cwd name, as the real one does. */
const fakeRun: NonNullable<RouterUninstallDeps['runClaude']> = async (_bin, args, opts) => {
  calls.push({ args: args.join(' '), cwd: opts.cwd });
  const ok = (stdout: string): ClaudeRun => ({ code: 0, stdout, stderr: '' });
  if (args[0] === 'plugin' && args[1] === 'uninstall') {
    if (failIn.has(opts.cwd)) {
      return { code: 1, stdout: '{"outcome":"error","message":"boom"}\n', stderr: '' };
    }
    const scope = args[args.indexOf('--scope') + 1];
    const raw = JSON.parse(await readFile(recordsFile(), 'utf8').catch(() => '{"plugins":{}}')) as {
      plugins: Record<string, Record<string, unknown>[]>;
    };
    const entries = raw.plugins['tenjin@tenjin'] ?? [];
    const keep = entries.filter((e) =>
      scope === 'user' ? e.scope !== 'user' : !(e.scope === 'local' && e.projectPath === opts.cwd),
    );
    if (keep.length === entries.length) {
      return { code: 1, stdout: '{"outcome":"error","failureCode":"not_installed"}\n', stderr: '' };
    }
    raw.plugins['tenjin@tenjin'] = keep;
    await writeFile(recordsFile(), JSON.stringify(raw));
    return ok('{"outcome":"ok"}\n');
  }
  if (args.join(' ') === 'plugin marketplace list --json') {
    return ok(
      JSON.stringify([
        { name: 'tenjin', source: 'directory', path: join(home, '.tenjin', 'runtime', 'claude') },
      ]),
    );
  }
  return ok('{"outcome":"ok"}\n');
};

function deps(cwd: string, over: Partial<RouterUninstallDeps> = {}): RouterUninstallDeps {
  return {
    homeDir: home,
    cwd,
    env: { CLAUDE_CONFIG_DIR: cfg, PATH: '' },
    findClaude: () => ({ path: '/fake/claude', source: 'path' }),
    runClaude: fakeRun,
    ...over,
  };
}

async function uninstall(
  o: { all?: boolean; project?: string | true },
  cwd: string,
  over: Partial<RouterUninstallDeps> = {},
) {
  const target = await resolveUninstallTarget(o, ctx(), deps(cwd, over));
  return { target, out: await runRouterUninstall({ target }, ctx(), deps(cwd, over)) };
}

const removalsOf = (out: { data: unknown }) =>
  (out.data as { removals: { projectPath: string | null; state: string }[] }).removals;

describe('which install a run removes', () => {
  it('--all from elsewhere: each in its own folder, then the marketplace, unscoped, from home', async () => {
    await writeRecords([userEntry(), localEntry(other)]);
    const { out } = await uninstall({ all: true }, elsewhere);
    expect(calls).toEqual([
      { args: 'plugin uninstall tenjin@tenjin --scope user --json', cwd: home },
      { args: 'plugin uninstall tenjin@tenjin --scope local --json', cwd: other },
      { args: 'plugin marketplace list --json', cwd: home },
      { args: 'plugin marketplace remove tenjin --json', cwd: home },
    ]);
    expect(out.data).toMatchObject({ remaining: [], marketplace: 'removed' });
  });

  it('bare from elsewhere: only the user install; the marketplace stays for the project', async () => {
    await writeRecords([userEntry(), localEntry(other)]);
    const { target, out } = await uninstall({}, elsewhere);
    expect(target).toEqual({ kind: 'user' });
    expect(calls.map((c) => c.args)).toEqual([
      'plugin uninstall tenjin@tenjin --scope user --json',
    ]);
    expect(out.data).toMatchObject({
      remaining: [other],
      marketplace: 'kept',
      marketplaceKeptFor: [other],
    });
    expect(out.humanLines).toContain(`Kept the tenjin marketplace: still used by ${other}.`);
  });

  it("bare from a project's subfolder: that project, removed in its own folder", async () => {
    await writeRecords([userEntry(), localEntry(other)]);
    const deeper = join(other, 'sub', 'deeper');
    await mkdir(deeper, { recursive: true });
    const { target, out } = await uninstall({}, deeper);
    expect(target).toEqual({ kind: 'project', path: other });
    expect(calls).toEqual([
      { args: 'plugin uninstall tenjin@tenjin --scope local --json', cwd: other },
    ]);
    expect(out.data).toMatchObject({ remaining: ['user'] });
  });

  it('--project <path> from elsewhere: only that project; the user install keeps the marketplace', async () => {
    const p = join(root, 'p');
    await mkdir(p);
    await writeRecords([localEntry(p), userEntry()]);
    const { out } = await uninstall({ project: p }, elsewhere);
    expect(calls).toEqual([
      { args: 'plugin uninstall tenjin@tenjin --scope local --json', cwd: p },
    ]);
    expect(out.data).toMatchObject({ remaining: ['user'], marketplace: 'kept' });
    expect(out.humanLines).toContain(
      'Kept the tenjin marketplace: still used by your user install.',
    );
  });

  it('finds a project only Claude Code records, and one only routerProjects names', async () => {
    const q = join(root, 'q');
    await mkdir(join(q, '.claude'), { recursive: true });
    await writeFile(
      join(q, '.claude', 'settings.local.json'),
      JSON.stringify({ enabledPlugins: { 'tenjin@tenjin': true } }),
    );
    await persistRouterProject(data, q);
    // A project routerProjects names that holds no install any more is stale.
    await persistRouterProject(data, elsewhere);
    await writeRecords([localEntry(other)]);
    const { out } = await uninstall({ all: true }, elsewhere);
    expect(removalsOf(out)).toEqual([
      { scope: 'local', projectPath: other, state: 'removed' },
      { scope: 'local', projectPath: q, state: 'absent' },
    ]);
    const config = JSON.parse(await readFile(join(data, 'config.json'), 'utf8')) as {
      install?: { routerProjects?: string[] };
    };
    expect(config.install?.routerProjects).toEqual([elsewhere]);
  });

  it('skips a project whose folder is gone, names it, and does not block', async () => {
    const gone = join(root, 'gone');
    await writeRecords([userEntry(), localEntry(gone)]);
    const { out } = await uninstall({ all: true }, elsewhere);
    expect(removalsOf(out)).toContainEqual({
      scope: 'local',
      projectPath: gone,
      state: 'skipped',
      reason: `${gone} no longer exists`,
    });
    expect(out.humanLines).toContain(`skipped the install for ${gone}: ${gone} no longer exists`);
    expect(out.data).toMatchObject({ remaining: [], marketplace: 'removed' });
  });

  it('says nothing is here, removes nothing and exits 0, naming what is installed', async () => {
    await writeRecords([localEntry(other)]);
    const { target, out } = await uninstall({}, elsewhere);
    expect(target).toEqual({ kind: 'user' });
    expect(calls).toEqual([]);
    expect(out.humanLines).toEqual([
      `No Tenjin install for your user, so nothing was removed. Still installed: ${other}. Run \`tenjin uninstall --project <path>\` for one of them, or \`tenjin uninstall --all\`.`,
    ]);
    const here = await uninstall({ project: true }, elsewhere);
    expect(here.out.humanLines?.[0]).toMatch(/^No Tenjin install for this folder's project,/);
  });
});

describe('all or nothing', () => {
  it('a local removal that fails under --all refuses, keeps the marketplace and names both', async () => {
    await writeRecords([userEntry(), localEntry(other)]);
    failIn.add(other);
    const target: UninstallTarget = { kind: 'all' };
    const err = await runRouterUninstall({ target }, ctx(), deps(elsewhere)).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).code).toBe('REFUSED');
    expect((err as CliError).message).toContain(`could not be removed: ${other}`);
    expect((err as CliError).message).toContain('Removed: your user install.');
    expect((err as CliError).details).toMatchObject({ removed: ['user'], left: [other] });
    expect(calls.some((c) => c.args.startsWith('plugin marketplace'))).toBe(false);
  });

  it('removes nothing with no claude binary while installs are recorded', async () => {
    await writeRecords([userEntry()]);
    const err = await runRouterUninstall({ target: { kind: 'user' } }, ctx(), {
      ...deps(elsewhere),
      findClaude: () => null,
    }).catch((e: unknown) => e);
    expect(err).toMatchObject({
      code: 'REFUSED',
      message: "Tenjin's plugin could not be checked, so nothing was removed",
    });
    expect(calls).toEqual([]);
  });

  it("removes nothing when Claude Code's record cannot be read", async () => {
    await writeFile(recordsFile(), '{not json');
    for (const o of [{}, { project: true as const }]) {
      const err = await resolveUninstallTarget(o, ctx(), deps(elsewhere)).catch((e: unknown) => e);
      expect(err).toMatchObject({ code: 'REFUSED' });
    }
    const err = await runRouterUninstall({ target: { kind: 'all' } }, ctx(), deps(elsewhere)).catch(
      (e: unknown) => e,
    );
    expect(err).toMatchObject({ code: 'REFUSED' });
    expect(calls).toEqual([]);
  });
});

describe('what the receipt says it keeps', () => {
  it('names the wallet, where its passphrase is, and the variable only when set', async () => {
    await writeFile(join(data, 'wallet.json'), JSON.stringify({ address: ADDRESS }));
    await writePassphraseRecord(data, ADDRESS, { store: 'keychain', by: 'create' });
    const where = describeStoreLocation('keychain', ADDRESS.toLowerCase(), data);
    const { out } = await uninstall({}, elsewhere);
    expect(out.humanLines?.slice(-2)).toEqual([
      `Kept ${data}: your wallet ${ADDRESS} (it may hold funds; move them with \`tenjin wallet send\` before you delete it), the spend ledger and the config.`,
      `The wallet passphrase stays in ${where}.`,
    ]);
    expect(out.data).toMatchObject({
      kept: { dataDir: data, wallet: ADDRESS, passphraseStore: where },
    });
    const withVar = await uninstall({}, elsewhere, {
      env: { CLAUDE_CONFIG_DIR: cfg, PATH: '', TENJIN_WALLET_PASSPHRASE: 'x' },
    });
    expect(withVar.out.humanLines?.at(-1)).toBe(
      'TENJIN_WALLET_PASSPHRASE is set in this shell; remove its export line from your shell startup file if you added one.',
    );
  });
});

describe('removeRuntimeAndLaunchers', () => {
  it('does nothing under a non-default data dir', async () => {
    const out = await removeRuntimeAndLaunchers(data, home, {
      removeLaunchers: async () => {
        throw new Error('must not run');
      },
      removeRuntime: async () => {
        throw new Error('must not run');
      },
    });
    expect(out).toEqual({ data: { runtime: null, launcher: null }, humanLines: [] });
  });

  it('removes the marked launcher and the runtime, then says to remove npm’s copy after', async () => {
    const dataDir = join(home, '.tenjin');
    const runtime = join(dataDir, 'runtime');
    await mkdir(join(runtime, 'versions', '0.1.0'), { recursive: true });
    await writeFile(join(dataDir, 'wallet.json'), '{"keep":true}');
    const bin = join(home, '.local', 'bin');
    await mkdir(bin, { recursive: true });
    await writeFile(join(bin, 'tenjin'), `#!/bin/sh\n# ${LAUNCHER_MARKER}\n`);
    const out = await removeRuntimeAndLaunchers(dataDir, home, { platform: 'darwin' });
    expect(out.humanLines).toEqual([
      'removed the launcher ~/.local/bin/tenjin',
      "removed Tenjin's runtime ~/.tenjin/runtime",
      'To remove the CLI too, run `npm uninstall -g tenjin-cli` now: always after `tenjin uninstall`, never before.',
    ]);
    expect(await stat(runtime).catch(() => null)).toBeNull();
    expect(await readFile(join(dataDir, 'wallet.json'), 'utf8')).toBe('{"keep":true}');
  });

  it('names what a running node.exe holds, to delete once this exits', async () => {
    const held = 'C:\\Users\\Jane\\.tenjin\\runtime\\node\\24.14.0\\node.exe';
    const out = await removeRuntimeAndLaunchers(join(home, '.tenjin'), home, {
      removeLaunchers: async () => ({ removed: [], left: [] }),
      removeRuntime: async () => ({ removed: false, left: [held] }),
    });
    expect(out.humanLines).toContain(`  delete ${held} after this exits`);
    expect(out.humanLines?.at(-1)).toMatch(/^To remove the CLI too/);
  });
});
