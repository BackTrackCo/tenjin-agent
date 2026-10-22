import { existsSync } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, resolve, sep } from 'node:path';
import { persistRouterProject } from '../commands/config';
import type { CommandContext, CommandResult } from '../context';
import { loadRawConfig } from '../lib/config';
import { CliError } from '../lib/errors';
import { defaultDataDir, runtimeDir } from '../lib/paths';
import { runtimeStatePath } from '../lib/runtime-layout';
import { readWalletFacts } from '../lib/wallet-facts';
import { removeAliveState } from './alive';
import { findClaudeBinary, jsonList, jsonResult, runClaude, type ClaudeBinary } from './claude-cli';
import { projectInstallAt, settingsInstallPaths } from './install';
import { inspectLegacyInstall, removeLegacyInstall, type LegacyRemoval } from './legacy-install';
import { MARKETPLACE_NAME, PLUGIN_ID } from './names';
import { removePluginFolder, type FolderRemoval } from './plugin-folder';
import {
  folderFor,
  folderState,
  ownMarketplace,
  recordedInstalls,
  type InstallRecord,
} from './plugin-registration';

/**
 * `tenjin uninstall`: take out the install for where you are, and the shared
 * parts once no install is left anywhere.
 *
 * WHICH INSTALL. Claude Code records every `tenjin@tenjin` install, in any
 * scope or project, in its own `installed_plugins.json`; `install.routerProjects`
 * adds the projects `install --project` wired. A bare run takes the project
 * install whose folder is the cwd or the nearest one above it, else the user
 * install; `--project <path>` takes that project's, and `--all` every one. Each
 * goes through `claude plugin uninstall` run in exactly its own folder, the
 * only cwd Claude Code accepts for a local install.
 *
 * ALL OR NOTHING FOR THE SHARED PARTS. The marketplace (and, through `finish`
 * in `hosts.ts`, Tenjin's runtime and its launcher) go only when no install is
 * left anywhere and every removal this run asked for succeeded. A removal that
 * fails refuses, naming what was removed and what is left; so does a
 * marketplace Claude Code would not remove, which keeps the runtime its folder
 * lives in, and the launcher that retries.
 *
 * THE WALLET AND `spend.json` STAY. Removing an integration is not a reason to
 * destroy a key that holds funds or a ledger that records what was spent; both
 * are the user's, and the receipt says where they are.
 */

export type UninstallTarget =
  { kind: 'all' } | { kind: 'user' } | { kind: 'project'; path: string };

export interface RouterUninstallDeps {
  homeDir?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  findClaude?: (env: NodeJS.ProcessEnv) => ClaudeBinary | null;
  /** Runs one `claude` command; tests inject one that records its cwd. */
  runClaude?: typeof runClaude;
}

/** One install this run went after, and what became of it. */
export interface Removal {
  scope: InstallRecord['scope'];
  projectPath: string | null;
  /** `skipped`: the project folder is gone, so `claude` cannot be run there. */
  state: 'removed' | 'absent' | 'skipped' | 'failed';
  reason?: string;
}

/** `remaining`'s name for the user install; a project is its folder. */
const USER = 'user';

const real = (path: string): Promise<string> => realpath(path).catch(() => resolve(path));
const isDir = async (path: string): Promise<boolean> =>
  (await stat(path).catch(() => null))?.isDirectory() === true;

/** Is `dir` the folder `parent`, or inside it? */
function within(dir: string, parent: string): boolean {
  return dir === parent || dir.startsWith(parent.endsWith(sep) ? parent : `${parent}${sep}`);
}

function uncheckable(): CliError {
  return new CliError('REFUSED', "Tenjin's plugin could not be checked, so nothing was removed", {
    fix: `Run \`tenjin uninstall\` from a terminal where \`claude\` runs, or type /plugin uninstall ${PLUGIN_ID} in Claude Code.`,
  });
}

/**
 * EVERY INSTALL ON THIS MACHINE: Claude Code's record, plus each project in
 * `install.routerProjects` that still holds an install of ours, by realpath.
 * A project only that list names, and that holds nothing any more, is stale
 * and does not keep the shared parts. Throws when Claude Code's record is
 * there and cannot be read: what it holds is unknown, so nothing may go.
 * `recorded` counts the installs Claude Code itself records: only those need
 * `claude` to remove; a project only the list names is a folder install.
 */
async function installRecords(
  dataDir: string,
  env: NodeJS.ProcessEnv,
  home: string,
): Promise<InstallRecord[] & { recorded: number }> {
  const claude = await recordedInstalls(env, home);
  if (claude === null) throw uncheckable();
  const listed = (await loadRawConfig(dataDir).catch(() => null))?.install?.routerProjects ?? [];
  const records: InstallRecord[] = [];
  const seen = new Set<string>();
  for (const r of claude) {
    const key = r.projectPath === null ? USER : await real(r.projectPath);
    if (seen.has(key)) continue;
    seen.add(key);
    records.push(r.projectPath === null ? r : { scope: 'local', projectPath: key });
  }
  const recorded = records.length;
  for (const dir of listed) {
    const key = await real(dir);
    if (seen.has(key) || !(await projectInstallAt(key, home, env))) continue;
    seen.add(key);
    records.push({ scope: 'local', projectPath: key });
  }
  return Object.assign(records, { recorded });
}

/**
 * The project install for `dir`: the record whose folder is `dir` or the
 * nearest one above it. One at home counts only from home itself, or every
 * folder under home would read as inside that project.
 */
async function nearestProject(
  records: InstallRecord[],
  dir: string,
  home: string,
): Promise<(InstallRecord & { projectPath: string }) | undefined> {
  const homeReal = await real(home);
  return records
    .filter(
      (r): r is InstallRecord & { projectPath: string } =>
        r.projectPath !== null &&
        within(dir, r.projectPath) &&
        (r.projectPath !== homeReal || dir === homeReal),
    )
    .sort((a, b) => b.projectPath.length - a.projectPath.length)[0];
}

/**
 * Which install a run removes, decided before the hosts are picked: `--all`,
 * the project `--project` names (this folder's when it names none), or for a
 * bare run the project install here, else the user install.
 */
export async function resolveUninstallTarget(
  o: { all?: boolean; project?: string | true },
  ctx: CommandContext,
  deps: RouterUninstallDeps = {},
): Promise<UninstallTarget> {
  if (o.all === true) return { kind: 'all' };
  const env = deps.env ?? process.env;
  const home = deps.homeDir ?? homedir();
  const cwd = deps.cwd ?? process.cwd();
  const records = await installRecords(ctx.dataDir, env, home);
  if (o.project !== undefined) {
    const dir = await real(o.project === true ? cwd : resolve(cwd, o.project));
    return {
      kind: 'project',
      path: (await nearestProject(records, dir, home))?.projectPath ?? dir,
    };
  }
  const here = await nearestProject(records, await real(cwd), home);
  return here !== undefined ? { kind: 'project', path: here.projectPath } : { kind: 'user' };
}

export async function runRouterUninstall(
  o: { target: UninstallTarget },
  ctx: CommandContext,
  deps: RouterUninstallDeps = {},
): Promise<CommandResult> {
  const env = deps.env ?? process.env;
  const home = deps.homeDir ?? homedir();
  if (!isAbsolute(home)) throw new Error('The home directory is not an absolute path.');
  const cwd = deps.cwd ?? process.cwd();
  const binary = (deps.findClaude ?? findClaudeBinary)(env);
  const run = (args: string[], at: string) =>
    (deps.runClaude ?? runClaude)(binary!, args, { env, cwd: at });

  const records = await installRecords(ctx.dataDir, env, home);
  // Only what Claude Code records needs `claude` to remove. A project only
  // `routerProjects` names is the folder a run with no `claude` wrote: it is
  // `absent` below, and its folder goes in cleanUp.
  if (binary === null && records.recorded > 0) throw uncheckable();
  const { target } = o;
  let targets = records.filter((r) =>
    target.kind === 'all'
      ? true
      : target.kind === 'user'
        ? r.projectPath === null
        : r.projectPath === target.path,
  );
  // A USER INSTALL CLAUDE CODE DOES NOT RECORD (the folder a run with no
  // `claude` wrote, which starts the runtime's own Node and entry) is one
  // `--all` removes too, and one any other run leaves in use.
  const userUnrecorded =
    !records.some((r) => r.projectPath === null) &&
    (await leftHere({ scope: 'user', projectPath: null }, env, home));
  if (target.kind === 'all' && userUnrecorded && targets.length > 0) {
    targets = [{ scope: 'user', projectPath: null }, ...targets];
  }
  const others = records.filter((r) => !targets.includes(r));
  if (targets.length === 0) {
    // NOTHING CLAUDE CODE RECORDS FOR THE TARGET. A folder or settings install
    // of ours is still one; with other installs left and neither, there is
    // nothing here to remove. With nothing left anywhere, the run goes on, so
    // a marketplace or runtime that outlived its plugin is cleared.
    const fallback: InstallRecord =
      target.kind === 'project'
        ? { scope: 'local', projectPath: target.path }
        : { scope: 'user', projectPath: null };
    const live = await liveOthers(others);
    if (live.length > 0 && !(await leftHere(fallback, env, home))) {
      return nothingHere(target, await real(cwd), live.map(labelOf), ctx.dataDir, env, home);
    }
    targets = [fallback];
  }

  const removals: Removal[] = [];
  for (const r of targets) {
    if (r.projectPath !== null && !(await isDir(r.projectPath))) {
      removals.push({ ...r, state: 'skipped', reason: `${r.projectPath} no longer exists` });
      continue;
    }
    // No binary and no record: Claude Code holds no install to remove.
    if (binary === null) {
      removals.push({ ...r, state: 'absent' });
      continue;
    }
    const out = await run(
      ['plugin', 'uninstall', PLUGIN_ID, '--scope', r.scope, '--json'],
      r.projectPath ?? home,
    );
    const result = jsonResult(out.stdout);
    if (out.code === 0) removals.push({ ...r, state: 'removed' });
    else if (result?.failureCode === 'not_installed') removals.push({ ...r, state: 'absent' });
    else {
      const message =
        typeof result?.message === 'string' ? result.message : out.stderr.trim().slice(0, 200);
      removals.push({ ...r, state: 'failed', reason: `claude plugin uninstall: ${message}` });
    }
  }

  // WHAT CLAUDE CODE STILL RECORDS decides, not the exit codes alone.
  const after = (await recordedInstalls(env, home)) ?? [];
  const afterKeys = new Set(
    await Promise.all(after.map((r) => (r.projectPath === null ? USER : real(r.projectPath)))),
  );
  const left = removals.filter(
    (r) =>
      r.state === 'failed' ||
      (r.state !== 'skipped' && afterKeys.has(r.projectPath === null ? USER : r.projectPath)),
  );
  const gone = removals.filter((r) => !left.includes(r) && r.state !== 'skipped');
  const userKept = userUnrecorded && !targets.some((r) => r.projectPath === null);
  const remaining =
    left.length > 0 ? [] : [...(userKept ? [USER] : []), ...(await liveOthers(others)).map(keyOf)];

  // THE INSTALLS THAT WENT leave their plugin folders and settings installs
  // too, and are forgotten, so a later `tenjin update` does not go looking for
  // a project this machine no longer wires. Done before a refusal as well.
  const folders: FolderRemoval[] = [];
  const settings: { path: string; found: boolean; removed: LegacyRemoval | null }[] = [];
  const cleanUp = async (): Promise<void> => {
    for (const r of gone) {
      const at = r.projectPath ?? home;
      folders.push(await removePluginFolder(folderFor(r.scope, env, home, at)));
      const paths = settingsInstallPaths(r.projectPath !== null, env, home, at);
      const legacy = await inspectLegacyInstall(paths.settingsPath, paths.mcpFile);
      settings.push({
        path: paths.settingsPath,
        found: legacy.present,
        removed: legacy.present
          ? await removeLegacyInstall(legacy, { binary, env, cwd: at, mcpScope: paths.mcpScope })
          : null,
      });
    }
    for (const r of removals) {
      if (r.projectPath !== null && !left.includes(r)) {
        await persistRouterProject(ctx.dataDir, r.projectPath, false).catch(() => undefined);
      }
    }
  };

  const named = (list: Removal[]) => list.map(labelOf).join(', ') || 'nothing';
  if (left.length > 0) {
    await cleanUp();
    throw new CliError(
      'REFUSED',
      `${left.length} Tenjin install${left.length === 1 ? '' : 's'} could not be removed: ${left.map((r) => `${labelOf(r)}${r.reason !== undefined ? ` (${r.reason})` : ''}`).join(', ')}. Removed: ${named(gone)}. Kept ${sharedParts(ctx.dataDir, home)}.`,
      {
        details: { removed: gone.map(keyOf), left: left.map(keyOf), removals },
        fix: retryFix(target, left),
      },
    );
  }

  let marketplace: 'removed' | 'absent' | 'kept' = 'kept';
  let marketplaceWhy: string | undefined;
  if (remaining.length > 0) {
    marketplaceWhy = `Kept ${sharedParts(ctx.dataDir, home)}: still used by ${remaining.map(nameOf).join(', ')}.`;
  } else if (binary === null) {
    marketplaceWhy = `the ${MARKETPLACE_NAME} marketplace was not checked: no claude binary on PATH or in CLAUDE_CODE_EXECPATH`;
  } else {
    // THE MARKETPLACE GOES ONLY WHEN IT IS THE ONE `install` ADDED, and
    // unscoped from home: that clears every scope's record of it.
    const listing = await run(['plugin', 'marketplace', 'list', '--json'], home);
    const listed = jsonList(listing.stdout);
    if (listed === null) {
      // A LIST THAT DID NOT ANSWER IS NOT AN ABSENT MARKETPLACE: it may still be
      // registered on the runtime's folder, so the shared parts stay with it.
      await cleanUp();
      const again = againCommand(target);
      throw new CliError(
        'REFUSED',
        `The ${MARKETPLACE_NAME} marketplace could not be checked (claude plugin marketplace list${listing.stderr.trim() !== '' ? `: ${listing.stderr.trim().slice(0, 200)}` : ''}). Removed: ${named(gone)}. Kept ${sharedParts(ctx.dataDir, home)}.`,
        {
          details: {
            removed: gone.map(keyOf),
            left: [`${MARKETPLACE_NAME} marketplace`],
            removals,
          },
          fix: `Run \`${again}\` again.`,
        },
      );
    }
    const row = listed.find((m) => m.name === MARKETPLACE_NAME);
    if (row === undefined) marketplace = 'absent';
    else if (!(await ownMarketplace(row))) {
      marketplaceWhy = `kept the ${MARKETPLACE_NAME} marketplace: it is not one \`tenjin install\` added`;
    } else {
      const removed = await run(
        ['plugin', 'marketplace', 'remove', MARKETPLACE_NAME, '--json'],
        home,
      );
      if (removed.code !== 0) {
        // A MARKETPLACE STILL REGISTERED KEEPS ITS FOLDER: it is the runtime's
        // `claude` folder, so the runtime and the launcher a retry runs must
        // stay with it. A refusal keeps `uninstallEach` from removing them.
        await cleanUp();
        const result = jsonResult(removed.stdout);
        const why =
          typeof result?.message === 'string'
            ? result.message
            : removed.stderr.trim().slice(0, 200);
        const again = againCommand(target);
        throw new CliError(
          'REFUSED',
          `The ${MARKETPLACE_NAME} marketplace could not be removed (claude plugin marketplace remove${why !== '' ? `: ${why}` : ''}). Removed: ${named(gone)}. Kept ${sharedParts(ctx.dataDir, home)}.`,
          {
            details: {
              removed: gone.map(keyOf),
              left: [`${MARKETPLACE_NAME} marketplace`],
              removals,
            },
            fix: `Run \`${again}\` again; if it still fails, run \`claude plugin marketplace remove ${MARKETPLACE_NAME}\`, then \`${again}\`.`,
          },
        );
      }
      marketplace = 'removed';
    }
  }
  await cleanUp();
  const aliveRemoved = remaining.length === 0 ? await removeAliveState(ctx.dataDir) : false;
  const kept = await keptBlock(ctx.dataDir, env, home);

  const data = {
    target,
    removals,
    remaining,
    marketplace,
    ...(remaining.length > 0 ? { marketplaceKeptFor: remaining } : {}),
    folders,
    settings,
    aliveRemoved,
    kept: kept.data,
  };
  const lines = [
    ...removals.map(removalLine),
    ...(marketplace === 'removed' ? [`removed the ${MARKETPLACE_NAME} marketplace`] : []),
    ...(marketplaceWhy !== undefined ? [marketplaceWhy] : []),
    ...folders.flatMap(folderLines),
    ...settings.flatMap((s) => settingsLines(s.path, s.removed)),
    ...kept.lines,
  ];
  return { data, humanLines: lines };
}

/**
 * The way back after a removal that failed: this run's own target again (a
 * bare run here finds the same install; from elsewhere it would not), then
 * Claude Code's own command, in each project's folder where one is left.
 */
function retryFix(target: UninstallTarget, left: Removal[]): string {
  const again = againCommand(target);
  const projects = left.flatMap((r) => (r.projectPath !== null ? [r.projectPath] : []));
  const where =
    projects.length === 0
      ? 'a Claude Code session'
      : `a Claude Code session started in ${projects.join(', ')}${projects.length < left.length ? ' (any session for your user install)' : ''}`;
  return `Run \`${again}\` again; if it still fails, type /plugin uninstall ${PLUGIN_ID} in ${where}.`;
}

/** This run's own target as a command: a bare run here finds the same install; from elsewhere it would not. */
function againCommand(target: UninstallTarget): string {
  return target.kind === 'all'
    ? 'tenjin uninstall --all'
    : target.kind === 'project'
      ? `tenjin uninstall --project ${shellWord(target.path)}`
      : 'tenjin uninstall';
}

/** `path` as one shell word: quoted only when it needs to be. */
function shellWord(path: string): string {
  return /^[\w@%+=:,./~-]+$/.test(path) ? path : `'${path.replace(/'/g, "'\\''")}'`;
}

/** The other installs that can still be used: the user's, and projects still on disk. */
async function liveOthers(others: InstallRecord[]): Promise<InstallRecord[]> {
  const live: InstallRecord[] = [];
  for (const r of others) if (r.projectPath === null || (await isDir(r.projectPath))) live.push(r);
  return live;
}

/** An install of ours Claude Code does not record: a plugin folder, or a settings install. */
async function leftHere(r: InstallRecord, env: NodeJS.ProcessEnv, home: string): Promise<boolean> {
  if (r.projectPath !== null) return projectInstallAt(r.projectPath, home, env);
  if ((await folderState('user', env, home, home)).state === 'ours') return true;
  const paths = settingsInstallPaths(false, env, home, home);
  return (await inspectLegacyInstall(paths.settingsPath, paths.mcpFile)).present;
}

const keyOf = (r: Pick<InstallRecord, 'projectPath'>): string => r.projectPath ?? USER;
const nameOf = (key: string): string => (key === USER ? 'your user install' : key);
const labelOf = (r: Pick<InstallRecord, 'projectPath'>): string => nameOf(keyOf(r));

/**
 * Does Claude Code hold any Tenjin install still, in any scope or project?
 * Asked by an uninstall Claude Code was not part of (Codex removed last), so
 * the runtime goes only once nothing at all can use it. A record that cannot
 * be read counts as one.
 */
export async function claudeInstallsLeft(
  ctx: CommandContext,
  deps: RouterUninstallDeps = {},
): Promise<boolean> {
  const env = deps.env ?? process.env;
  const home = deps.homeDir ?? homedir();
  try {
    const records = await installRecords(ctx.dataDir, env, home);
    if ((await liveOthers(records)).length > 0) return true;
    return await leftHere({ scope: 'user', projectPath: null }, env, home);
  } catch {
    return true;
  }
}

/** The line for a runtime kept because another recorded host still runs it; none where there is no runtime. */
export function runtimeKeptFor(dataDir: string, home: string, users: string[]): string | null {
  if (!hasRuntime(dataDir, home)) return null;
  return `Kept Tenjin's runtime and its launcher: still used by ${users.join(', ')}.`;
}

/** The parts every install shares, as the "kept" lines name them: the runtime only where there is one. */
function sharedParts(dataDir: string, home: string): string {
  return hasRuntime(dataDir, home)
    ? `the ${MARKETPLACE_NAME} marketplace, Tenjin's runtime and its launcher`
    : `the ${MARKETPLACE_NAME} marketplace`;
}

/**
 * Is there a runtime to keep? Only the default data dir has one, and only once
 * an install set it up: a platform Tenjin pins no Node for, or an install that
 * fell back, has none.
 */
function hasRuntime(dataDir: string, home: string): boolean {
  return isDefaultDataDir(dataDir, home) && existsSync(runtimeStatePath(runtimeDir(dataDir)));
}

function isDefaultDataDir(dataDir: string, home: string): boolean {
  return resolve(dataDir) === resolve(defaultDataDir(home));
}

async function nothingHere(
  target: UninstallTarget,
  cwd: string,
  installed: string[],
  dataDir: string,
  env: NodeJS.ProcessEnv,
  home: string,
): Promise<CommandResult> {
  const whose =
    target.kind !== 'project'
      ? 'your user'
      : target.path === cwd
        ? "this folder's project"
        : target.path;
  const kept = await keptBlock(dataDir, env, home);
  return {
    data: {
      target,
      removals: [],
      remaining: installed,
      marketplace: 'kept',
      marketplaceKeptFor: installed,
      folders: [],
      settings: [],
      aliveRemoved: false,
      kept: kept.data,
    },
    humanLines: [
      `No Tenjin install for ${whose}, so nothing was removed. Still installed: ${installed.join(', ')}. Run \`tenjin uninstall --project <path>\` for one of them, or \`tenjin uninstall --all\`.`,
    ],
  };
}

function removalLine(r: Removal): string {
  const which = r.projectPath === null ? 'your user install' : `the install for ${r.projectPath}`;
  switch (r.state) {
    case 'removed':
      return `removed the ${PLUGIN_ID} plugin (${which})`;
    case 'absent':
      return `plugin: ${PLUGIN_ID} was not installed (${which})`;
    case 'skipped':
      return `skipped ${which}: ${r.reason ?? 'its folder no longer exists'}`;
    case 'failed':
      return `plugin: ${r.reason ?? 'left in place'} (${which})`;
  }
}

function folderLines(folder: FolderRemoval): string[] {
  if (folder.removed) {
    return [
      folder.left.length === 0
        ? `removed the plugin folder ${folder.path}`
        : `removed the plugin's files from ${folder.path}; kept what is not Tenjin's: ${folder.left.join(', ')}`,
    ];
  }
  return folder.reason !== undefined ? [`folder: ${folder.reason}`] : [];
}

function settingsLines(settingsPath: string, settings: LegacyRemoval | null): string[] {
  if (settings === null) return [];
  const lines: string[] = [];
  const parts = [
    ...(settings.events.length > 0 ? [`hook entries (${settings.events.join(', ')})`] : []),
    ...(settings.allowRule || settings.denyRule ? ['the permission rules'] : []),
    ...(settings.statusLine !== 'kept' ? ['the status line'] : []),
    ...(settings.mcp === 'removed' ? ['the x402 MCP server'] : []),
  ];
  if (parts.length > 0) {
    lines.push(`removed the settings install's ${parts.join(', ')} from ${settingsPath}`);
  }
  lines.push(...settings.warnings.map((w) => `settings: ${w}`));
  return lines;
}

/** `path` with the home folder written as `~`. */
function tilde(path: string, home: string): string {
  return path === home || path.startsWith(`${home}${sep}`) ? `~${path.slice(home.length)}` : path;
}

/**
 * WHAT STAYS, said last: the data dir with the wallet (named, since it may
 * hold funds), and where its passphrase is kept. Read through the hook-safe
 * facts: nothing is unlocked to name them.
 */
async function keptBlock(
  dataDir: string,
  env: NodeJS.ProcessEnv,
  home: string,
): Promise<{
  data: { dataDir: string; wallet: string | null; passphraseStore: string | null };
  lines: string[];
}> {
  const facts = await readWalletFacts(dataDir, env);
  const wallet = facts.address;
  let store: string | null = null;
  if (wallet !== null && facts.passphraseStore !== null) {
    const { describeStoreLocation } = await import('../lib/wallet/passphrase');
    store = describeStoreLocation(facts.passphraseStore, wallet.toLowerCase(), dataDir);
  }
  const lines = [
    wallet !== null
      ? `Kept ${tilde(dataDir, home)}: your wallet ${wallet} (it may hold funds; move them with \`tenjin wallet send\` before you delete it), the spend ledger and the config.`
      : `Kept ${tilde(dataDir, home)}: the spend ledger and the config.`,
    ...(store !== null ? [`The wallet passphrase stays in ${store}.`] : []),
    ...(facts.envPassphraseSet
      ? [
          'TENJIN_WALLET_PASSPHRASE is set in this shell; remove its export line from your shell startup file if you added one.',
        ]
      : []),
  ];
  return { data: { dataDir, wallet, passphraseStore: store }, lines };
}

export interface RuntimeRemovalDeps {
  platform?: NodeJS.Platform;
  /** Tests inject these; the defaults are `runtime.ts`'s own. */
  removeLaunchers?: (
    home: string,
    platform?: NodeJS.Platform,
  ) => Promise<{ removed: string[]; left: string[] }>;
  removeRuntime?: (root: string) => Promise<{ removed: boolean; left: string[] }>;
}

/**
 * UNINSTALL'S LAST STEP, run by `hosts.uninstallEach` only once no install is
 * left anywhere: the launchers, then Tenjin's runtime. Nothing under a
 * non-default data dir, whose installs never had either.
 *
 * NOTHING IS IMPORTED AFTER THE REMOVAL. When this build runs from the
 * runtime, its own files are gone once it returns, so `runtime.ts` is loaded
 * first and every line after is plain string work. On Windows a running
 * `node.exe` keeps its folder; it is named, to delete once this exits.
 */
export async function removeRuntimeAndLaunchers(
  dataDir: string,
  home: string,
  deps: RuntimeRemovalDeps = {},
): Promise<CommandResult> {
  if (!isDefaultDataDir(dataDir, home)) {
    return { data: { runtime: null, launcher: null }, humanLines: [] };
  }
  const lib =
    deps.removeLaunchers !== undefined && deps.removeRuntime !== undefined
      ? null
      : await import('../lib/runtime');
  const removeLaunchers = deps.removeLaunchers ?? lib!.removeLaunchers;
  const removeRuntime = deps.removeRuntime ?? lib!.removeRuntime;
  const root = runtimeDir(dataDir);
  const launcher = await removeLaunchers(home, deps.platform ?? process.platform).catch(() => ({
    removed: [] as string[],
    left: [] as string[],
  }));
  const runtime = await removeRuntime(root).then(
    (r) => ({ ...r, error: null as string | null }),
    (err: unknown) => ({
      removed: false,
      left: [] as string[],
      error: err instanceof Error ? err.message : String(err),
    }),
  );
  const lines = [
    ...launcher.removed.map((p) => `removed the launcher ${tilde(p, home)}`),
    ...launcher.left.map((p) => `left ${tilde(p, home)}: it is not a launcher Tenjin wrote`),
  ];
  if (runtime.error !== null) {
    lines.push(`kept Tenjin's runtime ${tilde(root, home)}: ${runtime.error}`);
  } else if (runtime.removed || runtime.left.length > 0) {
    lines.push(
      runtime.left.length === 0
        ? `removed Tenjin's runtime ${tilde(root, home)}`
        : `removed Tenjin's runtime ${tilde(root, home)}, except what is still running:`,
      ...runtime.left.map((p) => `  delete ${p} after this exits`),
      'To remove the CLI too, run `npm uninstall -g tenjin-cli` now: always after `tenjin uninstall`, never before.',
    );
  }
  return {
    data: {
      runtime: { root, removed: runtime.removed, left: runtime.left },
      launcher: { removed: launcher.removed, left: launcher.left },
    },
    humanLines: lines,
  };
}
