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
import { uninstallEach, type SharedParts } from './hosts';
import { LAUNCHER_MARKER, renderPluginFiles } from './plugin-files';
import { pluginFolderPath, writePluginFolder } from './plugin-folder';
import { folderFor } from './plugin-registration';
import {
  claudeInstallsLeft,
  removeRuntimeAndLaunchers,
  resolveUninstallTarget,
  runRouterUninstall,
  runtimeKeptFor,
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
/** Folders where `claude plugin uninstall` answers not_installed and keeps the record (a cwd Claude Code does not match). */
let staleIn: Set<string>;
/** `claude plugin marketplace remove` fails, as a marketplace Claude Code holds open would. */
let marketplaceRemoveFails: boolean;
/** `claude plugin marketplace list` answers nothing readable. */
let marketplaceListFails: boolean;

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
  staleIn = new Set();
  marketplaceRemoveFails = false;
  marketplaceListFails = false;
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
    if (staleIn.has(opts.cwd)) {
      return { code: 1, stdout: '{"outcome":"error","failureCode":"not_installed"}\n', stderr: '' };
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
  if (args.join(' ') === 'plugin marketplace remove tenjin --json' && marketplaceRemoveFails) {
    return { code: 1, stdout: '{"outcome":"error","message":"EBUSY"}\n', stderr: '' };
  }
  if (args.join(' ') === 'plugin marketplace list --json') {
    if (marketplaceListFails) return { code: 1, stdout: '', stderr: 'settings unreadable' };
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

describe('a user install Claude Code does not record', () => {
  /** The folder a run with no `claude` wrote, starting the runtime's own Node and entry. */
  const userFolder = () => pluginFolderPath(cfg);
  beforeEach(async () => {
    const written = await writePluginFolder(
      userFolder(),
      renderPluginFiles('0.1.0-alpha.32', '/h/.tenjin/runtime/versions/x/dist/index.js', {
        node: '/n',
      }),
    );
    expect(written.state).toBe('written');
  });

  it('counts as remaining when a project goes, so the marketplace and runtime stay', async () => {
    await writeRecords([localEntry(other)]);
    const { target, out } = await uninstall({}, other);
    expect(target).toEqual({ kind: 'project', path: other });
    expect(out.data).toMatchObject({ remaining: ['user'], marketplace: 'kept' });
    expect(out.humanLines).toContain(
      'Kept the tenjin marketplace: still used by your user install.',
    );
    expect(calls.some((c) => c.args.startsWith('plugin marketplace'))).toBe(false);
    expect(await stat(userFolder()).catch(() => null)).not.toBeNull();
  });

  it('goes with --all', async () => {
    await writeRecords([localEntry(other)]);
    const { out } = await uninstall({ all: true }, elsewhere);
    expect(out.data).toMatchObject({ remaining: [], marketplace: 'removed' });
    expect(await stat(userFolder()).catch(() => null)).toBeNull();
  });

  it('keeps Claude Code counted as holding an install for an uninstall it was not part of', async () => {
    expect(await claudeInstallsLeft(ctx(), deps(elsewhere))).toBe(true);
  });
});

describe('claudeInstallsLeft', () => {
  it('is false only once Claude Code records nothing and no project or folder install is left', async () => {
    expect(await claudeInstallsLeft(ctx(), deps(elsewhere))).toBe(false);
    await writeRecords([localEntry(other)]);
    expect(await claudeInstallsLeft(ctx(), deps(elsewhere))).toBe(true);
    await writeFile(recordsFile(), '{not json');
    expect(await claudeInstallsLeft(ctx(), deps(elsewhere))).toBe(true);
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
    expect((err as CliError).fix).toBe(
      `Run \`tenjin uninstall --all\` again; if it still fails, type /plugin uninstall tenjin@tenjin in a Claude Code session started in ${other}.`,
    );
  });

  /**
   * Claude Code's record decides, not the exit code: `not_installed` from a
   * folder Claude Code does not match (a symlinked project) leaves the install
   * recorded, and the marketplace, runtime and launcher must not go under it.
   */
  it('refuses when Claude Code still records an install its uninstall called not installed', async () => {
    await writeRecords([userEntry(), localEntry(other)]);
    await persistRouterProject(data, other);
    staleIn.add(other);
    const err = await runRouterUninstall({ target: { kind: 'all' } }, ctx(), deps(elsewhere)).catch(
      (e: unknown) => e,
    );
    expect(err).toMatchObject({ code: 'REFUSED', details: { removed: ['user'], left: [other] } });
    expect(calls.some((c) => c.args.startsWith('plugin marketplace'))).toBe(false);
    const config = JSON.parse(await readFile(join(data, 'config.json'), 'utf8')) as {
      install?: { routerProjects?: string[] };
    };
    expect(config.install?.routerProjects).toEqual([other]);
  });

  it('retries the run’s own target: --project from anywhere, bare for the user install', async () => {
    await writeRecords([userEntry(), localEntry(other)]);
    failIn.add(other);
    const project = await runRouterUninstall(
      { target: { kind: 'project', path: other } },
      ctx(),
      deps(home),
    ).catch((e: unknown) => e);
    expect((project as CliError).fix).toBe(
      `Run \`tenjin uninstall --project ${other}\` again; if it still fails, type /plugin uninstall tenjin@tenjin in a Claude Code session started in ${other}.`,
    );
    failIn = new Set([home]);
    const user = await runRouterUninstall(
      { target: { kind: 'user' } },
      ctx(),
      deps(elsewhere),
    ).catch((e: unknown) => e);
    expect((user as CliError).fix).toBe(
      'Run `tenjin uninstall` again; if it still fails, type /plugin uninstall tenjin@tenjin in a Claude Code session.',
    );
  });

  /**
   * The marketplace is the runtime's `claude` folder: while Claude Code still
   * registers it, the runtime, and the launcher a retry runs, stay.
   */
  it('refuses when the marketplace cannot be removed, keeping the runtime and the launcher', async () => {
    await writeRecords([userEntry()]);
    marketplaceRemoveFails = true;
    let sharedRemoved = 0;
    const shared: SharedParts = {
      remove: async () => {
        sharedRemoved += 1;
        return { data: {}, humanLines: [] };
      },
      claudeLeft: async () => false,
      keptFor: () => null,
    };
    const target: UninstallTarget = { kind: 'user' };
    const run = () =>
      uninstallEach(
        ['claude'],
        data,
        target,
        () => runRouterUninstall({ target }, ctx(), deps(elsewhere)),
        shared,
      );
    const err = await run().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).exitCode).toBe(3);
    expect(err).toMatchObject({
      message:
        'The tenjin marketplace could not be removed (claude plugin marketplace remove: EBUSY). Removed: your user install. Kept the tenjin marketplace.',
      details: { removed: ['user'], left: ['tenjin marketplace'] },
      fix: 'Run `tenjin uninstall` again; if it still fails, run `claude plugin marketplace remove tenjin`, then `tenjin uninstall`.',
    });
    expect(sharedRemoved).toBe(0);
    // The retry it names finds the marketplace with no plugin left, and finishes.
    marketplaceRemoveFails = false;
    const out = await run();
    expect(out.data).toMatchObject({ remaining: [], marketplace: 'removed' });
    expect(sharedRemoved).toBe(1);
  });

  it('refuses when the marketplace cannot be listed, keeping the runtime and the launcher', async () => {
    await writeRecords([userEntry()]);
    marketplaceListFails = true;
    let sharedRemoved = 0;
    const shared: SharedParts = {
      remove: async () => {
        sharedRemoved += 1;
        return { data: {}, humanLines: [] };
      },
      claudeLeft: async () => false,
      keptFor: () => null,
    };
    const target: UninstallTarget = { kind: 'user' };
    const err = await uninstallEach(
      ['claude'],
      data,
      target,
      () => runRouterUninstall({ target }, ctx(), deps(elsewhere)),
      shared,
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).exitCode).toBe(3);
    expect(err).toMatchObject({
      message:
        'The tenjin marketplace could not be checked (claude plugin marketplace list: settings unreadable). Removed: your user install. Kept the tenjin marketplace.',
      details: { removed: ['user'], left: ['tenjin marketplace'] },
      fix: 'Run `tenjin uninstall` again.',
    });
    expect(sharedRemoved).toBe(0);
    expect(calls.some((c) => c.args === 'plugin marketplace remove tenjin --json')).toBe(false);
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

  /**
   * `install --project` with no `claude` writes the project's plugin folder
   * and lists the project in `routerProjects`; Claude Code records nothing,
   * so there is nothing `claude` must check, and the folder goes.
   */
  it('removes a project folder install made with no claude binary, with none to run', async () => {
    const env = { CLAUDE_CONFIG_DIR: cfg, PATH: '' };
    const folder = folderFor('local', env, home, other);
    const written = await writePluginFolder(
      folder,
      renderPluginFiles('0.1.0-alpha.32', '/h/.tenjin/runtime/versions/x/dist/index.js', {
        node: '/n',
      }),
    );
    expect(written.state).toBe('written');
    await persistRouterProject(data, other);
    const { target, out } = await uninstall({ project: other }, elsewhere, {
      findClaude: () => null,
    });
    expect(target).toEqual({ kind: 'project', path: other });
    expect(removalsOf(out)).toEqual([{ scope: 'local', projectPath: other, state: 'absent' }]);
    expect(await stat(folder).catch(() => null)).toBeNull();
    const config = JSON.parse(await readFile(join(data, 'config.json'), 'utf8')) as {
      install?: { routerProjects?: string[] };
    };
    expect(config.install?.routerProjects ?? []).toEqual([]);
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

describe('the kept line names the runtime only where there is one', () => {
  it('says the marketplace alone until an install set the runtime up, then all three', async () => {
    const dataDir = join(home, '.tenjin');
    const defaultCtx = { ...ctx(), dataDir };
    await writeRecords([userEntry(), localEntry(other)]);
    const project = async () => {
      await writeRecords([userEntry(), localEntry(other)]);
      return runRouterUninstall(
        { target: { kind: 'project', path: other } },
        defaultCtx,
        deps(elsewhere),
      );
    };
    // A platform Tenjin pins no Node for, or a fallback install: no runtime.
    expect((await project()).humanLines).toContain(
      'Kept the tenjin marketplace: still used by your user install.',
    );
    expect(runtimeKeptFor(dataDir, home, ['Codex'])).toBeNull();
    await mkdir(join(dataDir, 'runtime'), { recursive: true });
    await writeFile(join(dataDir, 'runtime', 'state.json'), '{}');
    expect((await project()).humanLines).toContain(
      "Kept the tenjin marketplace, Tenjin's runtime and its launcher: still used by your user install.",
    );
    expect(runtimeKeptFor(dataDir, home, ['Codex'])).toBe(
      "Kept Tenjin's runtime and its launcher: still used by Codex.",
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
