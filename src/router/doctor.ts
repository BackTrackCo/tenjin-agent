import { execFile } from 'node:child_process';
import { readFile, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, posix, resolve, sep, win32 } from 'node:path';
import pkg from '../../package.json';
import { autoUpdateLine } from '../lib/auto-update';
import { hasCode } from '../lib/errno';
import { CliError } from '../lib/errors';
import { toMoney } from '../lib/money';
import { defaultDataDir, launcherDir, runtimeDir } from '../lib/paths';
import { readRuntimeState, runtimeBuild, type RuntimeState } from '../lib/runtime-layout';
import { resolveContextSettings } from '../lib/settings';
import { isNewer } from '../lib/update-check';
import type { WalletProvider } from '../lib/wallet';
import { createLocalProvider, type PassphraseOverrides } from '../lib/wallet/local';
import { describeStoreLocation } from '../lib/wallet/passphrase';
import { walletFileExists } from '../lib/wallet/store';
import type { SigningSource, UnlockReason } from '../lib/wallet-unlock';
import type { CommandContext, CommandResult } from '../context';
import { agentsWithoutRequestTool } from './agent-tools';
import { readAliveStamp, type AliveStamp } from './alive';
import {
  CLAUDE_CODE_FLOOR,
  claudeConfigDir,
  findClaudeBinary,
  jsonList,
  readClaudeCode,
  runClaude,
  type ClaudeBinary,
  type ClaudeCodeState,
} from './claude-cli';
import { isDefiniteBlock } from './eligibility';
import { checkEligibility, type Eligibility, type EligibilityInput } from './eligibility-check';
import { CHANNEL_DEPOSIT_ATOMIC, ROUTING_FEE_ATOMIC, SUGGESTED_FUND_USD, unpaid, usd } from './fee';
import { NEW_SESSION_STEP, pluginProof, projectInstallHere, settingsInstallPaths } from './install';
import { inspectLegacyInstall, type LegacyInstall } from './legacy-install';
import { routerSettings, type RouterSettings } from './settings';
import { MARKETPLACE_NAME, MCP_SERVER_NAME, PLUGIN_ID, PLUGIN_SERVER, REQUEST_TOOL } from './names';
import { LAUNCHER_MARKER, PLUGIN_DIR, RUNTIME_MISSING_FIX } from './plugin-files';
import { folderState, readPluginListing, type PluginScope } from './plugin-registration';
import { probeRouter, type RouterCheck } from './reachability';
import {
  mcpServersState,
  readProcessSnapshot,
  RECONNECT_FIX,
  type InstalledAt,
  type ListMcpProcesses,
  type ListProcesses,
  type ProcessSnapshot,
} from './mcp-processes';
import { clearRouterMemo, readRouterMemo, type RouterMemo } from './router-memo';
import {
  liveObservations,
  readObservations,
  servedObservations,
  type RouterObservation,
} from './router-observation';
import {
  KEYCHAIN_LOCKED_FIX,
  NO_SESSION_CHECKED,
  REPAIR_CLAUSE,
  UNKNOWN_DETAIL,
  WALLET_REASONS,
} from './wallet-reasons';

/**
 * `tenjin doctor` for the router product: the things that decide whether a
 * lookup can happen at all, read and never written.
 *
 * THE PLUGIN IS ASKED ABOUT THROUGH CLAUDE CODE ITSELF: `claude --version`
 * against the floor, `claude plugin list --json` for the plugin and its
 * version, and `claude mcp get` for its `router` server. With no binary, the
 * plugin folder and the `alive` stamp stand in. A settings install of an
 * earlier release is reported with its migration state; doctor never migrates.
 *
 * THE RUNTIME CLAUDE CODE STARTS is read from the plugin it loads (the
 * marketplace `claude plugin marketplace list` names, and its `.mcp.json`),
 * run once with `--version`, and checked with the launcher a terminal needs.
 * Plugin installation uses the default data directory only.
 *
 * EVERY FIX IS A STEP THE AGENT TAKES IN THE SESSION: a command it runs, or a
 * slash command the person types there. None sends anyone out of Claude Code.
 */

export type { RouterCheck };

export interface RouterDoctorDeps {
  homeDir?: string;
  cwd?: string;
  /** Check the project install, as `install --project` registered it. Absent,
   *  a project install in `cwd` is found ({@link projectInstallHere}). */
  project?: boolean;
  env?: NodeJS.ProcessEnv;
  /** Finds the `claude` binary; tests inject one. */
  findClaude?: (env: NodeJS.ProcessEnv) => ClaudeBinary | null;
  fetchImpl?: typeof fetch;
  /** Node's own version, for the floor check. */
  nodeVersion?: string;
  /** This user's running routers and Claude Code processes; tests inject them. */
  listProcesses?: ListProcesses;
  /** This user's running `tenjin mcp` processes alone (the older seam); tests inject them. */
  listMcpProcesses?: ListMcpProcesses;
  /** When this build was installed; tests inject it. */
  installedAt?: InstalledAt;
  now?: () => number;
  /** The one eligibility check doctor makes; tests inject it. Defaults to {@link checkEligibility}. */
  eligibility?: (input: EligibilityInput) => Promise<Eligibility>;
  /** What the running `tenjin mcp` processes wrote about themselves; tests inject it. */
  readObservations?: (dataDir: string) => Promise<RouterObservation[]>;
  /** Whether a pid is alive, when `ps` could not run; tests inject it. */
  isAlive?: (pid: number) => boolean;
  /**
   * Passphrase-resolution seam for the wallet's verify (keychain exec,
   * platform). Tests MUST set it, or inject `eligibility`, before a verify can
   * run: without it, a wallet's verify reads the developer's own keychain.
   */
  walletPassphrase?: PassphraseOverrides;
  /** Where Claude Code starts the router from, read from the plugin it loads; tests inject it. */
  readLaunch?: (binary: ClaudeBinary | null) => Promise<PluginLaunch | null>;
  /** Runs `<command> <entry> --version` as Claude Code would, with no shell; tests inject it. */
  runVersion?: (command: string, entry: string) => Promise<VersionRun>;
  /** The first `tenjin` on PATH and what it is; tests inject it. */
  pathTenjin?: () => Promise<PathTenjin | null>;
  /** This machine's platform when Tenjin pins no Node for it, else null; tests inject it. */
  unpinnedPlatform?: () => Promise<string | null>;
}

/** The plugin's `router` server as Claude Code will start it. */
export interface PluginLaunch {
  /** The marketplace folder, or the plugin folder of the folder fallback. */
  path: string;
  source: 'marketplace' | 'folder';
  /** Null when the folder holds no `router` server to read: its `.mcp.json` is gone or names none. */
  command: string | null;
  /** Its first argument, `${CLAUDE_PLUGIN_ROOT}` expanded; null when it has none. */
  entry: string | null;
  /**
   * The plugin's `.mcp.json` is not there at all: the folder Claude Code loads
   * was deleted (an npm prefix a Node upgrade took, or the runtime), so
   * nothing can start the router from it.
   */
  missing?: true;
}

export interface VersionRun {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface PathTenjin {
  path: string;
  /** A launcher Tenjin wrote. */
  marked: boolean;
  version: string | null;
  /** A build that hands a terminal run to Tenjin's runtime (its package carries `tenjinRuntime`). */
  handsOff: boolean;
  /** No `tenjin-cli` package was identified behind it (a Volta or pnpm shim, or another program). */
  unknown?: true;
}

const NODE_FLOOR = 22;

/**
 * How Claude Code starts the router, which picks the fixes that fit:
 * Tenjin's runtime; the `node` on its PATH where `tenjin install` can move it
 * to the runtime; or that PATH where it cannot, on a platform Tenjin pins no
 * Node for or under a data dir of its own (decisions 15 and 18).
 */
type Layout = 'runtime' | 'path' | 'path-only';

/** The line the PATH layout's fixes end with, where the runtime can end the dependence they describe. */
const moveToRuntime = (layout: Layout): string =>
  layout === 'path' ? ' Or run `tenjin install` to move Tenjin to its own runtime.' : '';

/**
 * The stamp row's fix: a new session first, since a reload never stamps. On
 * the PATH layout, then the Node Claude Code runs; a running Claude Code keeps
 * the PATH it started with, so a new window is not enough there.
 */
function stampFix(layout: Layout): string {
  const first =
    "Start a new Claude Code session and run `tenjin doctor` again: `/reload-plugins` does not run the plugin's `SessionStart`, so only a new session writes the stamp.";
  return layout !== 'runtime'
    ? `${first} If it still warns, run \`node --version\` in that session's shell: Claude Code starts the plugin with the Node on its own PATH, and it must be 22 or newer. After installing or updating Node, quit Claude Code fully, then start a new session.${moveToRuntime(layout)}`
    : first;
}

export async function runRouterDoctor(
  ctx: CommandContext,
  deps: RouterDoctorDeps = {},
): Promise<CommandResult> {
  const env = deps.env ?? process.env;
  const home = deps.homeDir ?? homedir();
  const cwd = deps.cwd ?? process.cwd();
  // WITHOUT THE FLAG, THE INSTALL THIS DIRECTORY HOLDS: a project install
  // found here is the one a session here runs, so it is the one checked.
  const project = deps.project ?? (await projectInstallHere(cwd, home, env));
  // From the directory doctor runs in, which is the one a session there would use.
  const router = await routerSettings(
    { cwd, dataDir: ctx.dataDir },
    deps.homeDir !== undefined ? { homeDir: deps.homeDir } : {},
  ).catch((err: unknown) => (err instanceof Error ? err : new Error(String(err))));
  const settings = await resolveContextSettings(ctx);
  const claude = await readClaudeCode(env, cwd, deps.findClaude ?? findClaudeBinary);
  const scope: PluginScope = project ? 'local' : 'user';
  const paths = settingsInstallPaths(project, env, home, cwd);
  const legacy = await inspectLegacyInstall(paths.settingsPath, paths.mcpFile);
  // THE PROCESSES AND WHAT THE ROUTERS SAW, READ FIRST: before `claude mcp
  // get` (serverCheck) starts a `tenjin mcp` of its own. That router serves no
  // hook, so it never reads as a session anyway (servedSession stays false,
  // B2), but nothing it does can reach this snapshot either.
  const [{ snapshot, installed }, observations] = await Promise.all([
    readProcessSnapshot(deps),
    (deps.readObservations ?? readObservations)(ctx.dataDir).catch(() => [] as RouterObservation[]),
  ]);
  const live = servedObservations(
    liveObservations(observations, snapshot?.routers ?? null, deps.isAlive),
  );

  // Only the default profile owns plugin registration and a private runtime.
  const runtime = resolve(ctx.dataDir) === resolve(defaultDataDir(home));
  const root = runtimeDir(ctx.dataDir);
  const state = runtime ? readRuntimeState(root) : null;
  const launch = await (
    deps.readLaunch ?? ((binary) => readPluginLaunch(binary, { env, home, cwd, scope }))
  )(claude.binary).catch(() => null);
  // A platform Tenjin pins no Node for never gets a runtime (decision 15).
  const unpinned = runtime ? await (deps.unpinnedPlatform ?? thisPlatformUnpinned)() : null;
  // Which fixes fit: the ones that blame the `node` on Claude Code's PATH only
  // when that is what starts the plugin, read from the folder Claude Code
  // loads. One under `runtime/claude` whose files are gone is the runtime's.
  // A folder that no longer holds the plugin is no PATH's fault, whichever it is.
  const fromPath =
    launch === null
      ? state === null
      : launch.command === null
        ? !(await pluginGone(launch, root))
        : launch.command === 'node';
  const layout: Layout = !fromPath
    ? 'runtime'
    : runtime && unpinned === null
      ? 'path'
      : 'path-only';

  const checks: RouterCheck[] = [nodeCheck(deps.nodeVersion ?? process.version)];
  checks.push(claudeCodeCheck(claude));
  const plugin = await pluginCheck(claude, {
    scope,
    env,
    home,
    cwd,
    dataDir: ctx.dataDir,
    legacy,
    installed,
    snapshot,
    live,
    layout,
  });
  checks.push(plugin.check);
  if (plugin.registered && runtime) {
    const onPath = state !== null ? await (deps.pathTenjin ?? (() => findPathTenjin(env)))() : null;
    checks.push(
      await runtimeCheck({ launch, state, root, home, env, project, onPath, unpinned, deps }),
    );
    const old = pathTenjinCheck(onPath, home);
    if (old !== null) checks.push(old);
  }
  if (plugin.registered && claude.binary !== null) {
    const serving = live.find(
      (o) =>
        o.harness === 'claude' &&
        o.launchedByPlugin &&
        o.cliVersion === pkg.version &&
        resolve(o.cwd) === resolve(cwd),
    );
    checks.push(
      serving !== undefined
        ? {
            name: 'router server',
            status: 'ok',
            required: true,
            detail: `${PLUGIN_SERVER} is serving a Claude Code session in this directory (pid ${serving.pid})`,
          }
        : await serverCheck(claude.binary, env, cwd, layout),
    );
  }
  if (legacy.present || legacy.unreadable !== undefined) {
    checks.push(await migrationCheck(legacy, claude, ctx.dataDir, env, cwd));
  }
  checks.push(routingCheck(router));
  checks.push(
    mcpServersState(snapshot?.routers ?? null, installed, pkg.version, RECONNECT_FIX).check,
  );
  checks.push(spendCheck(settings.policy.maxAutoSpendAtomic, settings.policy.sessionBudgetAtomic));
  checks.push(experimentalCheck(settings.experimentalBazaar));

  let host: string | null;
  try {
    host = new URL(settings.baseUrl).host;
  } catch {
    // The router check below names the bad base URL and its fix.
    host = null;
  }
  const e = await shellEligibility(ctx, deps, env, {
    policy: settings.policy,
    rpcUrl: settings.rpcUrl,
    host: host ?? '',
  });
  checks.push(host === null ? UNPARSED_BASE_URL_ROW : routingFeeRow(e, host));
  checks.push(walletRow(e, ctx.dataDir));
  checks.push(sessionRow(e, live, pkg.version));
  const now = deps.now?.() ?? Date.now();
  const probe = await probeRouter(settings.baseUrl, {
    timeoutMs: ctx.flags.timeout,
    env,
    ...(deps.fetchImpl !== undefined ? { fetchImpl: deps.fetchImpl } : {}),
  });
  // A probe the router answered ends the routing legs' backoff at once.
  if (probe.status === 'ok') {
    await clearRouterMemo(ctx.dataDir, 'unreachable', settings.baseUrl);
    checks.push(probe);
  } else {
    checks.push(
      withBackoff(
        probe,
        await readRouterMemo(ctx.dataDir, 'unreachable', settings.baseUrl, now),
        now,
      ),
    );
  }
  const agents = await subagentsCheck(cwd, home);
  if (agents !== null) checks.push(agents);

  const failure = checks.find((c) => c.status === 'fail' && c.required);
  const data = {
    checks,
    dataDir: ctx.dataDir,
    baseUrl: settings.baseUrl,
    scope,
    settingsPath: paths.settingsPath,
    session: { observed: live },
    eligibility: {
      canSign: e.canSign,
      canPayRouting: e.canPayRouting,
      savedSign: e.savedSign,
      balanceAtomic: e.balanceAtomic?.toString() ?? null,
      creditAtomic: e.creditAtomic?.toString() ?? null,
    },
  };
  if (failure !== undefined) {
    // REFUSED, the exit-3 class: a machine this command found unready is
    // understood and refused, not a runtime failure of the command itself.
    throw new CliError('REFUSED', failure.detail, {
      ...(failure.fix !== undefined ? { fix: failure.fix } : {}),
      details: data,
    });
  }
  // Information only, above the summary: how the last background update ended.
  const lines = doctorLines(checks);
  const auto = state !== null ? autoUpdateLine(root) : null;
  if (auto !== null) lines.splice(lines.length - 1, 0, auto);
  return { data, humanLines: lines };
}

/** The routing-fee row when there is no host to check it against. */
const UNPARSED_BASE_URL_ROW: RouterCheck = {
  name: 'routing fee',
  status: 'warn',
  required: false,
  detail: 'not checked, because the base URL is not a URL',
  checked: false,
};

/** `env` without TENJIN_WALLET_PASSPHRASE: what a Claude Code started without it would see. */
function withoutEnvPassphrase(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const rest = { ...env };
  delete rest.TENJIN_WALLET_PASSPHRASE;
  return rest;
}

/**
 * The wallet as this shell would open it: `resolveWalletProvider`'s provider,
 * built from doctor's own env (so a test's env, not the runner's, decides).
 * Nothing here prompts: `verify` forces `isTTY: false` and keeps its 5 s read
 * deadline, and `describe` never needs a passphrase.
 */
function walletProviderFor(
  ctx: CommandContext,
  env: NodeJS.ProcessEnv,
  overrides: PassphraseOverrides | undefined,
): WalletProvider {
  return createLocalProvider({
    dir: ctx.dataDir,
    env,
    passphrase: { ...overrides, isTTY: ctx.io.isTTY ? undefined : false },
  });
}

/**
 * THE ONE ELIGIBILITY CHECK, for the wallet, routing-fee and session rows.
 * Never rejects: a check that throws (an injected one included) reads as
 * "could not check" on every row it feeds, never as ok and never as a block.
 *
 * SAVED PASSPHRASE FIRST (S7, decision 19). With TENJIN_WALLET_PASSPHRASE set,
 * `verifySaved` asks the same question install's default signing check asks
 * first: does the keychain or the file open the wallet WITHOUT the variable?
 * So a correct variable that a store also holds reports that store, and the
 * session row can say whether a Claude Code started without it could sign.
 */
async function shellEligibility(
  ctx: CommandContext,
  deps: RouterDoctorDeps,
  env: NodeJS.ProcessEnv,
  s: { policy: EligibilityInput['policy']; rpcUrl: string; host: string },
): Promise<Eligibility> {
  try {
    const keySet = (env.TENJIN_WALLET_KEY ?? '').trim().length > 0;
    const provider =
      keySet || (await walletFileExists(ctx.dataDir))
        ? walletProviderFor(ctx, env, deps.walletPassphrase)
        : null;
    const passphraseSet = (env.TENJIN_WALLET_PASSPHRASE ?? '').length > 0;
    return await (deps.eligibility ?? checkEligibility)({
      dataDir: ctx.dataDir,
      env,
      policy: s.policy,
      rpcUrl: s.rpcUrl,
      host: s.host,
      timeoutMs: ctx.flags.timeout,
      provider,
      ...(provider !== null && passphraseSet
        ? {
            verifySaved: () =>
              walletProviderFor(ctx, withoutEnvPassphrase(env), deps.walletPassphrase).verify?.() ??
              Promise.resolve(undefined),
          }
        : {}),
      ...(deps.fetchImpl !== undefined ? { fetchImpl: deps.fetchImpl } : {}),
    });
  } catch {
    const failed = {
      status: 'unknown' as const,
      reason: 'check_failed',
      detail: UNKNOWN_DETAIL['check_failed']!,
    };
    return {
      address: null,
      source: null,
      canSign: failed,
      canPayRouting: failed,
      savedSign: null,
      balanceAtomic: null,
      creditAtomic: null,
      describeError: null,
    };
  }
}

/**
 * The human report: one line a check, and under each row to look at, its fix,
 * as `--json` carries it. The summary counts what the person can act on apart
 * from what could not be checked: a check that could not answer
 * (`checked: false`) is shown as a warning but is nothing to fix.
 */
export function doctorLines(checks: RouterCheck[]): string[] {
  const act = checks.filter((c) => c.status !== 'ok' && c.checked !== false).length;
  const unchecked = checks.filter((c) => c.checked === false).length;
  const allPass = checks.every((c) => c.status === 'ok');
  return [
    ...checks.flatMap((c) => [
      `${c.status === 'ok' ? 'ok  ' : c.status === 'warn' ? 'warn' : 'fail'}  ${c.name}: ${c.detail}`,
      ...(c.status !== 'ok' && c.fix !== undefined ? [`      fix: ${c.fix}`] : []),
    ]),
    allPass
      ? `${checks.length} checks, all pass.`
      : `${checks.length} checks, ${act} to act on${unchecked > 0 ? `, ${unchecked} not checked` : ''}.`,
  ];
}

/**
 * The routing legs' backoff, named on a router line whose probe failed too.
 * It ends by itself after its minute, or when a probe here reaches the router.
 */
function withBackoff(check: RouterCheck, memo: RouterMemo | null, now: number): RouterCheck {
  if (memo === null) return check;
  const left = Math.max(1, Math.ceil((memo.until - now) / 1000));
  return {
    ...check,
    status: check.status === 'ok' ? 'warn' : check.status,
    detail: `${check.detail}; routing calls skip the router for ${left}s more, after one did not reach it`,
  };
}

/**
 * INFORMATIONAL, NEVER A FAILURE. A custom agent whose `tools:` leave the
 * request tool out is a choice its author may have meant, so this names those
 * agents and the one line that would change it, and counts as passing. It is
 * absent when there is nothing to name. The files are only read.
 */
async function subagentsCheck(cwd: string, homeDir: string): Promise<RouterCheck | null> {
  const excluded = await agentsWithoutRequestTool({ cwd, homeDir }, REQUEST_TOOL);
  if (excluded.length === 0) return null;
  return {
    name: 'subagents',
    status: 'ok',
    required: false,
    detail: `${excluded.join(', ')} ${excluded.length === 1 ? 'is' : 'are'} offered no paid lookups: add ${REQUEST_TOOL} to tools: to allow paid lookups there`,
  };
}

function nodeCheck(version: string): RouterCheck {
  const major = Number(/^v(\d+)/.exec(version)?.[1] ?? '0');
  return major >= NODE_FLOOR
    ? { name: 'node', status: 'ok', required: true, detail: version }
    : {
        name: 'node',
        status: 'fail',
        required: true,
        detail: `${version} is below the Node ${NODE_FLOOR} floor.`,
        fix: `Install Node ${NODE_FLOOR} or newer, then re-run \`tenjin doctor\`.`,
      };
}

/** Claude Code's version against the plugin's floor. */
function claudeCodeCheck(claude: ClaudeCodeState): RouterCheck {
  const name = 'claude code';
  if (claude.binary === null) {
    return {
      name,
      status: 'warn',
      required: false,
      detail:
        'no claude binary on PATH or in CLAUDE_CODE_EXECPATH, so the plugin was checked from its folder only',
      fix: 'Run `tenjin doctor` from a Claude Code session, where CLAUDE_CODE_EXECPATH names the binary.',
    };
  }
  if (claude.version === null) {
    return {
      name,
      status: 'warn',
      required: false,
      detail: `${claude.binary.path} did not report a version`,
    };
  }
  if (!claude.meetsFloor) {
    return {
      name,
      status: 'fail',
      required: true,
      detail: `Claude Code ${claude.version} is older than ${CLAUDE_CODE_FLOOR}, which the Tenjin plugin needs`,
      ...(claude.fix !== undefined ? { fix: claude.fix } : {}),
    };
  }
  return {
    name,
    status: 'ok',
    required: true,
    detail: `${claude.version}${claude.binary.source === 'execpath' ? ' (from CLAUDE_CODE_EXECPATH)' : ''}`,
  };
}

interface PluginContext {
  scope: PluginScope;
  env: NodeJS.ProcessEnv;
  home: string;
  cwd: string;
  dataDir: string;
  legacy: LegacyInstall;
  /** When this build was installed, for {@link pluginStart}. */
  installed: number | null;
  snapshot: ProcessSnapshot | null;
  /** The served live observations (B2). */
  live: RouterObservation[];
  /** How Claude Code starts the plugin, for the fixes that fit. */
  layout: Layout;
}

/** Whether a session has started the plugin at this version, as {@link pluginStart} tells it. */
export type PluginStart = 'proven' | 'pending' | 'did-not-start' | 'unknown';

/**
 * The fix when a Claude Code started since this install did not start the
 * plugin: the `node` on its PATH on that layout, else a new session and then
 * the reinstall that rebuilds the runtime.
 */
function didNotStartFix(layout: Layout): string {
  return layout !== 'runtime'
    ? `Claude Code starts the plugin with the \`node\` on its own PATH, which must be 22 or newer: run \`node --version\` in the shell it starts from, then quit Claude Code fully and start a new session.${moveToRuntime(layout)}`
    : `Start a new Claude Code session. If Tenjin still does not start: ${RUNTIME_MISSING_FIX}`;
}

/**
 * HAS A SESSION STARTED THE PLUGIN AT THIS VERSION, first match wins:
 *
 * 1. `proven`: the `alive` stamp is at or above `version`; or a router that
 *    served a Claude session (B2) runs `version`; or a plugin router under a
 *    Claude Code started at or after this install.
 * 2. `unknown`: no stamp, and no process list to look at (`ps` could not run).
 * 3. `did-not-start`: a Claude Code started at or after this install is
 *    running and none of the above holds. Its plugin never came up: most
 *    often the `node` on Claude Code's own PATH is too old.
 * 4. `pending`: nothing has started since the install; the next session will.
 *
 * Pure: the caller reads the stamp, the snapshot and the observations.
 */
export function pluginStart(i: {
  version: string;
  stamp: AliveStamp | null;
  installed: number | null;
  snapshot: ProcessSnapshot | null;
  live: RouterObservation[];
}): PluginStart {
  const since = (startedAt: number | null): boolean =>
    i.installed !== null && startedAt !== null && startedAt >= i.installed;
  if (i.stamp !== null && !isNewer(i.version, i.stamp.version)) return 'proven';
  if (servedObservations(i.live).some((o) => o.cliVersion === i.version)) return 'proven';
  if (
    i.snapshot?.routers.some(
      (r) => r.kind === 'plugin' && r.underClaude !== false && since(r.startedAt),
    ) === true
  ) {
    return 'proven';
  }
  if (i.snapshot === null && i.stamp === null) return 'unknown';
  if (i.snapshot?.claude.some((c) => since(c.startedAt)) === true) return 'did-not-start';
  return 'pending';
}

/** Does any of `paths` name the same directory as `dir`, links resolved? */
async function sameDirAsAny(paths: string[], dir: string): Promise<boolean> {
  const real = (p: string) => realpath(p).catch(() => p);
  const here = await real(dir);
  for (const path of paths) if ((await real(path)) === here) return true;
  return false;
}

/**
 * The plugin: listed and enabled at this CLI's version and stamped by a
 * session at it, or, with no binary to ask, its folder and the `alive` stamp. A machine that still routes through a
 * settings install of an earlier release warns rather than fails.
 */
async function pluginCheck(
  claude: ClaudeCodeState,
  c: PluginContext,
): Promise<{ check: RouterCheck; registered: boolean }> {
  const name = 'plugin';
  const missing = (detail: string): { check: RouterCheck; registered: boolean } => ({
    registered: false,
    check: c.legacy.present
      ? {
          name,
          status: 'warn',
          required: false,
          detail: `${detail}; the settings install of an earlier release still routes here`,
          fix: claude.meetsFloor
            ? `Run \`tenjin install${c.scope === 'local' ? ' --project' : ''}\` to move this machine to the plugin.`
            : `Run \`claude update\`, then \`tenjin install${c.scope === 'local' ? ' --project' : ''}\` to move this machine to the plugin.`,
        }
      : {
          name,
          status: 'fail',
          required: true,
          detail,
          fix: `Run \`tenjin install${c.scope === 'local' ? ' --project' : ''}\`.`,
        },
  });
  if (claude.binary !== null) {
    const listing = await readPluginListing(claude.binary, c.env, c.cwd);
    if (!listing.read) {
      return {
        registered: false,
        check: {
          name,
          status: 'warn',
          required: false,
          detail: "Claude Code's plugin list could not be read, so the plugin was not checked",
          fix: 'Run `tenjin doctor` again in a moment.',
        },
      };
    }
    if (listing.id === null) return missing(`${PLUGIN_ID} is not installed in Claude Code`);
    if (!listing.enabled) {
      // A PROJECT INSTALL MADE ELSEWHERE is listed from here as disabled.
      // Enabling it here is not the fix: it was meant for that project, and
      // there it is checked.
      if (listing.projects.length > 0 && !(await sameDirAsAny(listing.projects, c.cwd))) {
        return {
          registered: false,
          check: {
            name,
            status: 'fail',
            required: true,
            detail: `${listing.id} is installed for ${listing.projects.join(', ')} only, so nothing is routed from ${c.cwd}`,
            fix: `To check that install, run \`tenjin doctor\` from ${listing.projects[0]}.`,
          },
        };
      }
      return {
        registered: false,
        check: {
          name,
          status: 'fail',
          required: true,
          detail: `${listing.id} is installed but disabled, so no lookup is routed`,
          fix: `Run \`claude plugin enable ${listing.id} --scope ${listing.scope ?? 'user'}\`, then ${NEW_SESSION_STEP}.`,
        },
      };
    }
    if (listing.version !== pkg.version) {
      return {
        registered: true,
        check: {
          name,
          status: 'warn',
          required: false,
          detail: `${listing.id} is enabled at ${listing.version ?? 'an unknown version'}, and this CLI is ${pkg.version}`,
          fix: 'Run `tenjin install --refresh` to register this version.',
        },
      };
    }
    // Claude Code's own environment shows only in a real session: the `alive`
    // stamp its SessionStart leg writes, a router it started, or its absence
    // from a Claude Code started since. Doctor's PATH may find a Node that
    // Claude Code's does not.
    const stamp = await readAliveStamp(c.dataDir);
    const start = pluginStart({
      version: pkg.version,
      stamp,
      installed: c.installed,
      snapshot: c.snapshot,
      live: c.live,
    });
    const at = `${listing.id} ${pkg.version}`;
    const last = stamp !== null ? ` (last ${stamp.version}, at ${stamp.at})` : '';
    return {
      registered: true,
      check:
        start === 'proven'
          ? {
              name,
              status: 'ok',
              required: true,
              detail: `${at} enabled, and a session has started it`,
            }
          : start === 'pending'
            ? {
                name,
                status: 'ok',
                required: true,
                detail: `${at} enabled; the next Claude Code session starts it`,
              }
            : start === 'unknown'
              ? {
                  name,
                  status: 'warn',
                  required: false,
                  checked: false,
                  detail: `${at} is enabled; whether a session has started it at this version could not be checked${last}`,
                  fix: stampFix(c.layout),
                }
              : {
                  name,
                  status: 'warn',
                  required: false,
                  detail: `${at} is enabled, and the Claude Code started since this install has not started it${last}`,
                  fix: didNotStartFix(c.layout),
                },
    };
  }
  const folder = await folderState(c.scope, c.env, c.home, c.cwd);
  if (folder.state === 'foreign') {
    return {
      registered: false,
      check: {
        name,
        status: 'fail',
        required: true,
        detail: `${folder.path} is there and is not a folder this CLI wrote, so the plugin cannot be written`,
        fix: `Move ${folder.path} aside, then run \`tenjin install\` again.`,
      },
    };
  }
  if (folder.state === 'ours') {
    const stamp = await readAliveStamp(c.dataDir);
    const start = pluginStart({
      version: pkg.version,
      stamp,
      installed: c.installed,
      snapshot: c.snapshot,
      live: c.live,
    });
    return {
      registered: true,
      check:
        start === 'proven'
          ? {
              name,
              status: 'ok',
              required: true,
              detail:
                stamp !== null
                  ? `the plugin folder at ${folder.path} loaded, last at ${stamp.at}`
                  : `the plugin folder at ${folder.path} is loaded, and a session has started it`,
            }
          : start === 'pending'
            ? {
                name,
                status: 'ok',
                required: true,
                detail: `the plugin folder is at ${folder.path}; the next Claude Code session starts it`,
              }
            : start === 'unknown'
              ? {
                  name,
                  status: 'warn',
                  required: false,
                  checked: false,
                  detail: `the plugin folder is at ${folder.path}; whether a session has loaded it could not be checked`,
                  fix: `To load it, ${NEW_SESSION_STEP}.`,
                }
              : {
                  name,
                  status: 'warn',
                  required: false,
                  detail: `the plugin folder is at ${folder.path}, and the Claude Code started since this install has not loaded it`,
                  fix: didNotStartFix(c.layout),
                },
    };
  }
  if (await listedInClaudeFiles(c.env, c.home)) {
    return {
      registered: true,
      check: {
        name,
        status: 'warn',
        required: false,
        detail: `${PLUGIN_ID} is registered, and there is no claude binary here to check it`,
        fix: 'Run `tenjin doctor` from a Claude Code session to check it.',
      },
    };
  }
  return missing(`${PLUGIN_ID} is not registered`);
}

/** Claude Code's own record, read when no binary can be asked. */
export async function listedInClaudeFiles(env: NodeJS.ProcessEnv, home: string): Promise<boolean> {
  try {
    const raw = await readFile(
      join(claudeConfigDir(env, home), 'plugins', 'installed_plugins.json'),
      'utf8',
    );
    const plugins = (JSON.parse(raw) as { plugins?: unknown }).plugins;
    return plugins !== null && typeof plugins === 'object' && PLUGIN_ID in plugins;
  } catch {
    return false;
  }
}

/**
 * The plugin's `router` server, through `claude mcp get`, which starts it the
 * way a session would and reports whether it answered. `claude mcp get` runs
 * with doctor's own environment, so it starts `node` from doctor's PATH, not
 * the PATH a running Claude Code started with: a connected server here does
 * not prove a session can start it. The `plugin` row's `alive` stamp is the
 * proof from a real session.
 */
async function serverCheck(
  binary: ClaudeBinary,
  env: NodeJS.ProcessEnv,
  cwd: string,
  layout: Layout,
): Promise<RouterCheck> {
  const name = 'router server';
  const run = await runClaude(binary, ['mcp', 'get', PLUGIN_SERVER], {
    env,
    cwd,
    timeoutMs: 45_000,
  });
  const status = /Status:\s*(.+)/.exec(run.stdout)?.[1]?.trim();
  if (
    run.code === 0 &&
    status !== undefined &&
    /connected/i.test(status) &&
    !/fail/i.test(status)
  ) {
    return { name, status: 'ok', required: true, detail: `${PLUGIN_SERVER} connected` };
  }
  return {
    name,
    status: 'fail',
    required: true,
    detail: `${PLUGIN_SERVER} did not connect${status !== undefined ? `: ${status.slice(0, 200)}` : ''}`,
    fix:
      layout !== 'runtime'
        ? `Quit Claude Code fully (from the tray, or sign out and in), then start a new session: the plugin starts the CLI with \`node\` from the PATH Claude Code started with, so a Claude Code opened before Node was installed cannot find it.${moveToRuntime(layout)}`
        : didNotStartFix(layout),
  };
}

/**
 * WHERE CLAUDE CODE STARTS THE ROUTER FROM: the `tenjin` marketplace's folder
 * as `claude plugin marketplace list` names it, or the folder fallback's, and
 * the `router` server in its `.mcp.json`. Never `installed_plugins.json`,
 * whose `installPath` goes stale once the marketplace is repointed.
 */
export async function readPluginLaunch(
  binary: ClaudeBinary | null,
  c: { env: NodeJS.ProcessEnv; home: string; cwd: string; scope: PluginScope },
): Promise<PluginLaunch | null> {
  let found: { path: string; source: PluginLaunch['source']; plugin: string } | null = null;
  if (binary !== null) {
    const out = await runClaude(binary, ['plugin', 'marketplace', 'list', '--json'], {
      env: c.env,
      cwd: c.cwd,
    });
    const row = (out.code === 0 ? jsonList(out.stdout) : null)?.find(
      (m) => m.name === MARKETPLACE_NAME,
    );
    if (typeof row?.path === 'string') {
      found = { path: row.path, source: 'marketplace', plugin: join(row.path, PLUGIN_DIR) };
    }
  }
  if (found === null) {
    const folder = await folderState(c.scope, c.env, c.home, c.cwd);
    if (folder.state === 'ours')
      found = { path: folder.path, source: 'folder', plugin: folder.path };
  }
  if (found === null) return null;
  // A folder Claude Code still loads from, with its files gone (the runtime
  // deleted, or the npm prefix a Node upgrade took), is said as that: where
  // it loads from is known, and empty.
  let missing = false;
  const mcp = (await readFile(join(found.plugin, '.mcp.json'), 'utf8')
    .then((text) => JSON.parse(text) as unknown)
    .catch((err: unknown) => {
      missing = hasCode(err, 'ENOENT') || hasCode(err, 'ENOTDIR');
      return null;
    })) as {
    mcpServers?: Record<string, { command?: unknown; args?: unknown }>;
  } | null;
  const none = {
    path: found.path,
    source: found.source,
    command: null,
    entry: null,
    ...(missing ? { missing: true as const } : {}),
  };
  const server = mcp?.mcpServers?.[MCP_SERVER_NAME];
  if (typeof server?.command !== 'string') return none;
  const first = Array.isArray(server.args) ? server.args[0] : undefined;
  const entry =
    typeof first === 'string'
      ? resolve(first.split('${CLAUDE_PLUGIN_ROOT}').join(found.plugin))
      : null;
  return { path: found.path, source: found.source, command: server.command, entry };
}

/** `<command> <entry> --version`, in exec form: a `.cmd` is never spawned. */
function runVersion(command: string, entry: string): Promise<VersionRun> {
  return new Promise((done) => {
    execFile(
      command,
      [entry, '--version'],
      { shell: false, timeout: 15_000, windowsHide: true },
      (err, stdout, stderr) => {
        const failure = err as
          (NodeJS.ErrnoException & { killed?: boolean; code?: unknown }) | null;
        done({
          code: failure === null ? 0 : typeof failure.code === 'number' ? failure.code : null,
          stdout: String(stdout),
          stderr: String(stderr),
          timedOut: failure?.killed === true,
        });
      },
    );
  });
}

/** Why Tenjin pins no Node for this machine, or null where it pins one. */
async function thisPlatformUnpinned(): Promise<string | null> {
  const { runningGlibc, unpinnedPlatform } = await import('../lib/runtime-fetch');
  const platform = process.platform;
  return unpinnedPlatform(platform, process.arch, platform === 'linux' ? runningGlibc() : null);
}

/** Is the folder Claude Code loads Tenjin's `runtime/claude`, whether or not its files are there? */
async function inRuntimeFolder(launch: PluginLaunch, root: string): Promise<boolean> {
  return launch.source === 'marketplace' && samePath(launch.path, join(root, 'claude'));
}

/**
 * Does the folder Claude Code loads hold no plugin at all: `runtime/claude`
 * with no router to read, or any folder whose `.mcp.json` is gone? Either
 * way the router cannot start, and only a reinstall puts it back.
 */
async function pluginGone(launch: PluginLaunch, root: string): Promise<boolean> {
  return (
    launch.command === null && (launch.missing === true || (await inRuntimeFolder(launch, root)))
  );
}

const exists = async (path: string): Promise<boolean> =>
  (await stat(path).catch(() => null)) !== null;
const samePath = async (a: string, b: string): Promise<boolean> =>
  (await realpath(a).catch(() => resolve(a))) === (await realpath(b).catch(() => resolve(b)));

/** `path` with the home folder written as `~`. */
function tilde(path: string, home: string): string {
  return path === home || path.startsWith(`${home}${sep}`) ? `~${path.slice(home.length)}` : path;
}

/**
 * THE RUNTIME CLAUDE CODE STARTS, by what the plugin's `.mcp.json` names:
 *
 * - `runtime/claude` with no router to read, or any folder whose `.mcp.json`
 *   is gone (the runtime deleted, or the npm prefix a Node upgrade took):
 *   Claude Code cannot start the router (the one required failure);
 * - a marketplace outside `runtime/claude` while a runtime exists: an older
 *   build moved it back (warn);
 * - an older npm installation on an unsupported platform (warn, with no retry);
 * - `node` from PATH: no runtime, so a Node upgrade or `npm rm -g` stops it
 *   (warn);
 * - an absolute Node or entry that is not there, or that does not run: Claude
 *   Code cannot start the router (the one required failure, where `router
 *   server` fails too);
 * - otherwise ok, and the launcher a terminal needs is checked with it.
 */
async function runtimeCheck(i: {
  launch: PluginLaunch | null;
  state: RuntimeState | null;
  root: string;
  home: string;
  env: NodeJS.ProcessEnv;
  project: boolean;
  onPath: PathTenjin | null;
  /** This platform, when Tenjin pins no Node for it. */
  unpinned: string | null;
  deps: RouterDoctorDeps;
}): Promise<RouterCheck> {
  const name = 'runtime';
  const flag = i.project ? ' --project' : '';
  const t = (p: string) => tilde(p, i.home);
  const failFix =
    RUNTIME_MISSING_FIX +
    (i.project
      ? ' For a project-only installation, pass `--project` to the installer from that project folder.'
      : '');
  const { launch } = i;
  const unread: RouterCheck = {
    name,
    status: 'warn',
    required: false,
    checked: false,
    detail: "where Claude Code starts Tenjin from could not be read from the plugin's .mcp.json",
  };
  if (launch === null) return unread;
  if (await pluginGone(launch, i.root)) {
    return {
      name,
      status: 'fail',
      required: true,
      detail: `Claude Code loads Tenjin from ${t(launch.path)}, which no longer holds its plugin, so the router cannot start`,
      fix: failFix,
    };
  }
  if (
    i.state !== null &&
    launch.source === 'marketplace' &&
    !(await samePath(launch.path, join(i.root, 'claude')))
  ) {
    return {
      name,
      status: 'warn',
      required: false,
      detail: `Claude Code loads Tenjin from ${t(launch.path)}, not Tenjin's runtime: an older tenjin-cli build registered it there`,
      fix: `Run \`tenjin install${flag}\`, then start a new Claude Code session.`,
    };
  }
  if (launch.command === null) return unread;
  if (launch.command === 'node' && i.unpinned !== null) {
    const from = launch.entry !== null ? ` at ${t(dirname(launch.entry))}` : '';
    return {
      name,
      status: 'warn',
      required: false,
      detail: `This older installation runs from npm's copy${from}; this platform (${i.unpinned}) does not support Tenjin's private runtime`,
      fix: 'Use macOS, Windows or glibc Linux 2.28+ on x64/arm64. This installation was left unchanged.',
    };
  }
  if (launch.command === 'node') {
    const from = launch.entry !== null ? `, from ${t(dirname(launch.entry))}` : '';
    return {
      name,
      status: 'warn',
      required: false,
      detail: `Claude Code starts Tenjin with the \`node\` on its PATH${from}, so a Node upgrade or \`npm rm -g tenjin-cli\` stops it`,
      fix: `Run \`tenjin install${flag}\` to move it to Tenjin's own runtime.`,
    };
  }
  const missing = [launch.command, ...(launch.entry !== null ? [launch.entry] : [])];
  const gone: string[] = [];
  for (const p of missing) if (!(await exists(p))) gone.push(t(p));
  if (launch.entry === null || gone.length > 0) {
    return {
      name,
      status: 'fail',
      required: true,
      detail:
        launch.entry === null
          ? `Claude Code starts Tenjin with ${t(launch.command)} and no entry script, so the router cannot start`
          : `Claude Code starts Tenjin with ${gone.join(' and ')}, which ${gone.length === 1 ? 'is' : 'are'} not there, so the router cannot start`,
      fix: failFix,
    };
  }
  const shown = `${t(launch.command)} ${t(launch.entry)} --version`;
  const run = await (i.deps.runVersion ?? runVersion)(launch.command, launch.entry);
  if (run.timedOut) {
    return {
      name,
      status: 'warn',
      required: false,
      checked: false,
      detail: `\`${shown}\` did not answer within 15 s`,
    };
  }
  if (run.code !== 0) {
    const said = (run.stderr || run.stdout).trim().slice(0, 200);
    return {
      name,
      status: 'fail',
      required: true,
      detail: `\`${shown}\` exited ${run.code ?? 'without a code'}${said.length > 0 ? `: ${said}` : ''}, so the router cannot start`,
      fix: failFix,
    };
  }
  const nodeVersion =
    /[\\/]node[\\/](\d+\.\d+\.\d+)[\\/]/.exec(launch.command)?.[1] ??
    i.state?.current.node ??
    'unknown';
  const from = runtimeBuild(dirname(launch.entry))?.root ?? i.root;
  const detail = `Claude Code starts tenjin ${run.stdout.trim()} on Node ${nodeVersion} from ${t(from)}`;
  // THE LAUNCHER A TERMINAL NEEDS once npm's copy is gone.
  const platform = process.platform;
  const launcher = join(launcherDir(i.home), platform === 'win32' ? 'tenjin.cmd' : 'tenjin');
  if (!(await exists(launcher))) {
    return {
      name,
      status: 'warn',
      required: false,
      detail: `${detail}; ${t(launcher)} is missing, so a terminal does not find Tenjin's \`tenjin\``,
      fix: `Run \`tenjin install${flag}\` to write it.`,
    };
  }
  // Off PATH is only worth a row when the terminal finds no `tenjin` at all: npm's
  // copy hands off to the runtime, and an old one gets its own row below.
  if (i.onPath === null && !launcherOnPath(launcherDir(i.home), i.env, platform)) {
    const { pathLine } = await import('../lib/runtime');
    return {
      name,
      status: 'warn',
      required: false,
      detail: `${detail}; ${t(launcherDir(i.home))} is not on your PATH, so a terminal does not find \`tenjin\` there`,
      fix: pathLine(i.env, i.home, platform),
    };
  }
  return {
    name,
    status: 'ok',
    required: true,
    detail: `${detail}; tenjin on PATH: ${t(i.onPath?.path ?? launcher)}`,
  };
}

/** Is `dir` on this environment's PATH, compared as `writeLaunchers` compares it? */
function launcherOnPath(dir: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform): boolean {
  const p = platform === 'win32' ? win32 : posix;
  const norm = (value: string) => {
    const full = p.resolve(value).replace(/[\\/]+$/, '');
    return platform === 'win32' ? full.toLowerCase() : full;
  };
  const raw = (platform === 'win32' ? (env.Path ?? env.PATH) : env.PATH) ?? '';
  return raw
    .split(p.delimiter)
    .filter((entry) => entry.length > 0)
    .some((entry) => norm(entry) === norm(dir));
}

/**
 * THE FIRST `tenjin` ON PATH, and the package behind it: the nearest
 * `tenjin-cli` package above its realpath (npm's POSIX link), or
 * `node_modules/tenjin-cli` beside it (npm's Windows shim). A launcher Tenjin
 * wrote needs no package. One with no package identified (a Volta or pnpm
 * shim) is still the one a terminal runs, marked `unknown`. Null when there
 * is none.
 */
export async function findPathTenjin(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): Promise<PathTenjin | null> {
  const raw = (platform === 'win32' ? (env.Path ?? env.PATH) : env.PATH) ?? '';
  const delimiter = platform === 'win32' ? win32.delimiter : posix.delimiter;
  const name = platform === 'win32' ? 'tenjin.cmd' : 'tenjin';
  for (const dir of raw.split(delimiter).filter((d) => d.length > 0)) {
    const path = join(dir, name);
    if ((await stat(path).catch(() => null))?.isFile() !== true) continue;
    const body = await readFile(path, 'utf8').catch(() => '');
    if (body.includes(LAUNCHER_MARKER))
      return { path, marked: true, version: null, handsOff: true };
    let root: string | null;
    if (platform === 'win32') root = join(dir, 'node_modules', 'tenjin-cli');
    else {
      const { packageRootOf } = await import('../lib/runtime');
      root = packageRootOf(dirname(await realpath(path).catch(() => path)));
    }
    // The first one on PATH is what a terminal runs, identified or not.
    const unknown = { path, marked: false, version: null, handsOff: false, unknown: true } as const;
    if (root === null) return unknown;
    const manifest = await readFile(join(root, 'package.json'), 'utf8')
      .then((t) => JSON.parse(t) as { name?: unknown; version?: unknown; tenjinRuntime?: unknown })
      .catch(() => null);
    if (manifest?.name !== 'tenjin-cli') return unknown;
    return {
      path,
      marked: false,
      version: typeof manifest.version === 'string' ? manifest.version : null,
      handsOff: manifest.tenjinRuntime !== undefined,
    };
  }
  return null;
}

/** An older npm copy a terminal runs instead of Tenjin's runtime, named; nothing else. */
function pathTenjinCheck(found: PathTenjin | null, home: string): RouterCheck | null {
  if (found === null || found.marked || found.handsOff || found.unknown === true) return null;
  return {
    name: 'tenjin on PATH',
    status: 'warn',
    required: false,
    detail: `\`tenjin\` in a terminal runs tenjin-cli ${found.version ?? '(unknown version)'} at ${tilde(found.path, home)}, an older build that does not hand off to Tenjin's runtime`,
    fix: 'Remove it with `npm uninstall -g tenjin-cli` using the Node that installed it, or upgrade it with `npm i -g tenjin-cli@latest`.',
  };
}

/**
 * A settings install of an earlier release: what is left, and whether the
 * next `tenjin install` or `tenjin update` removes it. Never a failure, and
 * never written here.
 */
async function migrationCheck(
  legacy: LegacyInstall,
  claude: ClaudeCodeState,
  dataDir: string,
  env: NodeJS.ProcessEnv,
  cwd: string,
): Promise<RouterCheck> {
  const name = 'settings install';
  if (legacy.unreadable !== undefined) {
    return { name, status: 'warn', required: false, detail: legacy.unreadable };
  }
  const parts = [
    ...(legacy.events.length > 0 ? [`hook entries (${legacy.events.join(', ')})`] : []),
    ...(legacy.allowRule || legacy.denyRule ? ['permission rules'] : []),
    ...(legacy.statusLine === 'ours' || legacy.statusLine === 'composed' ? ['a status line'] : []),
    ...(legacy.mcp === 'ok' ? ['the x402 MCP server'] : []),
  ];
  const found = `${parts.join(', ')} from an earlier release in ${legacy.settingsPath}`;
  const lookalikes =
    legacy.lookalikes.length > 0
      ? `; not Tenjin's and left alone: ${legacy.lookalikes.join(', ')}`
      : '';
  const proof = await pluginProof(claude, dataDir, env, cwd);
  return proof.proven
    ? {
        name,
        status: 'warn',
        required: false,
        detail: `${found}, ready to remove: the plugin has loaded here${lookalikes}`,
        fix: 'Run `tenjin install --refresh` to remove it.',
      }
    : {
        name,
        status: 'warn',
        required: false,
        detail: `${found}, kept until the plugin loads: ${proof.reason}${lookalikes}`,
        fix: claude.meetsFloor
          ? `To load the plugin, ${NEW_SESSION_STEP}; the next \`tenjin install\` or \`tenjin update\` then removes the old entries.`
          : 'Run `claude update`, then `tenjin install`: until then the old entries keep routing.',
      };
}

/**
 * WIRED BUT SWITCHED OFF is a choice, not a fault, so it warns and names the
 * file that made it.
 */
function routingCheck(router: RouterSettings | Error): RouterCheck {
  const name = 'routing';
  if (router instanceof Error) {
    return {
      name,
      status: 'warn',
      required: false,
      detail: `the router is off here: ${router.message}`,
      fix: 'Fix or delete that file.',
    };
  }
  if (!router.enabled.value) {
    const file = router.enabled.path ?? 'the config';
    return {
      name,
      status: 'warn',
      required: false,
      detail: `router.enabled is false in ${file}, so nothing is routed from this directory`,
      fix:
        router.enabled.source === 'file'
          ? 'Run `tenjin config set router.enabled true` to route again.'
          : `Remove router.enabled from ${file} to route here again.`,
    };
  }
  return { name, status: 'ok', required: false, detail: 'on' };
}

/** The unlock reasons a routing-fee row words from WALLET_REASONS, with the PERSON fix (decision 15). */
const UNLOCK_WHY: ReadonlySet<string> = new Set([
  'wallet_corrupt',
  'env_key_invalid',
  'passphrase_missing',
  'passphrase_wrong',
  'env_passphrase_wrong',
  'keychain_locked',
  'wallet_locked',
]);

/**
 * THE ROUTING FEE, AS THE NEXT PAID CALL WOULD MEET IT: `canPayRouting`, the
 * verdict the payer and the hooks reach on the same facts, in TODAY'S words
 * (S5). Never a failure: a call the fee cannot pay takes the free path.
 *
 * - ready: today's ok row, byte for byte;
 * - blocked by money or policy: today's `unpaid` detail, and today's fix
 *   (`fixes[why]`, else fee.ts's own);
 * - blocked because the wallet cannot sign: the WALLET_REASONS fragment and
 *   the verdict's PERSON fix, never `agentFix`: doctor is read by a person;
 * - unknown (a balance or a keychain that did not answer): "could not check",
 *   never ok, never a fix.
 */
export function routingFeeRow(e: Pick<Eligibility, 'canPayRouting'>, host: string): RouterCheck {
  const name = 'routing fee';
  const v = e.canPayRouting;
  if (v.status === 'unknown') {
    return {
      name,
      status: 'warn',
      required: false,
      checked: false,
      detail: `could not check: ${v.detail}`,
    };
  }
  if (v.status === 'ready') {
    return {
      name,
      status: 'ok',
      required: false,
      detail: `$${usd(ROUTING_FEE_ATOMIC)} a call, paid from channel deposits of up to $${usd(CHANNEL_DEPOSIT_ATOMIC)} that count against the spend limits`,
    };
  }
  const why = v.reason;
  if (UNLOCK_WHY.has(why)) {
    return {
      name,
      status: 'warn',
      required: false,
      detail: `${WALLET_REASONS[why as keyof typeof WALLET_REASONS].reason}, so Tenjin is not routing calls`,
      fix: v.fix,
    };
  }
  const u = unpaid(why);
  const fixes: Record<string, string> = {
    no_wallet: `Run \`tenjin wallet create\`, then \`tenjin wallet fund ${SUGGESTED_FUND_USD}\`.`,
    limit_below_deposit: `Raise it with \`tenjin config set maxAutoSpend ${usd(CHANNEL_DEPOSIT_ATOMIC)}\`.`,
    budget_reached:
      'Room comes back as the rolling day passes, or raise it with `tenjin config set sessionBudget <usd>`.',
    not_allowlisted: `Add ${host} to allowlistCreators, or clear the allowlist.`,
  };
  return {
    name,
    status: 'warn',
    required: false,
    detail: `${u?.reason ?? v.detail}, so Tenjin is not routing calls`,
    fix: fixes[why] ?? u?.fix ?? v.fix,
  };
}

/** INFORMATIONAL: which experiment is on, in one line. Either state passes. */
function experimentalCheck(bazaar: boolean): RouterCheck {
  return {
    name: 'experimental',
    status: 'ok',
    required: false,
    detail: bazaar
      ? 'list: on; bazaar: on (experimental): the router may also suggest unreviewed sellers from the open x402 Bazaar'
      : 'list: on; bazaar: off (experimental): `tenjin config set experimental.bazaar on` to add the open x402 Bazaar',
  };
}

/**
 * The two limits: the daily budget is the control, the per-call ceiling the
 * runaway guard. A per-call limit an earlier release left below $0.25 shows
 * on the routing-fee row, which names the deposit it refuses.
 */
function spendCheck(maxAutoSpendAtomic: bigint, sessionBudgetAtomic: bigint | null): RouterCheck {
  if (sessionBudgetAtomic === 0n) {
    return {
      name: 'spend',
      status: 'fail',
      required: true,
      detail: 'The daily limit is 0, so positive payments are refused even with --yes.',
      fix: 'Choose a daily limit with `tenjin config set sessionBudget <usd|none>`.',
    };
  }
  if (maxAutoSpendAtomic === 0n) {
    return {
      name: 'spend',
      status: 'fail',
      required: true,
      detail: 'maxAutoSpend is 0, so every lookup needs approval and none can pay',
      fix: `Raise it with \`tenjin config set maxAutoSpend ${usd(CHANNEL_DEPOSIT_ATOMIC)}\`.`,
    };
  }
  const budget =
    sessionBudgetAtomic === null
      ? 'no daily ceiling'
      : `${toMoney(sessionBudgetAtomic.toString()).usd} USD a day`;
  return {
    name: 'spend',
    status: sessionBudgetAtomic === null ? 'warn' : 'ok',
    required: false,
    detail: `automatic approval up to ${toMoney(maxAutoSpendAtomic.toString()).usd} USD a call, ${budget}`,
    ...(sessionBudgetAtomic === null
      ? { fix: 'Set one with `tenjin config set sessionBudget 1.00`.' }
      : {}),
  };
}

/** Where a ready wallet's passphrase (or key) came from, as the wallet row says it;
 *  the passphrase file under `dataDir`, which `TENJIN_DATA_DIR` moves. */
function signedFrom(source: SigningSource, address: string, dataDir: string): string {
  switch (source) {
    case 'keychain':
      return 'macOS keychain';
    case 'secret-service':
      return 'Linux keyring';
    case 'dpapi':
      return 'DPAPI file';
    case 'file':
      return `passphrase file ${describeStoreLocation('file', address.toLowerCase(), dataDir)}`;
    case 'key-env':
      return 'TENJIN_WALLET_KEY in this shell';
    case 'passphrase-env':
      return 'TENJIN_WALLET_PASSPHRASE in this shell';
    case 'legacy':
      return 'legacy keychain entry';
  }
}

/** The unlock reasons a wallet row warns about with the WALLET_REASONS person fix. */
const WARN_UNLOCK: ReadonlySet<string> = new Set<UnlockReason>([
  'passphrase_missing',
  'passphrase_wrong',
  'env_passphrase_wrong',
  'wallet_corrupt',
]);

/**
 * THE WALLET ROW: can this shell's wallet SIGN, and with what.
 *
 * Exit codes keep their meaning (S11): no wallet, a wallet.json `describe`
 * cannot read, and an invalid TENJIN_WALLET_KEY fail as required, exactly as
 * before. A wallet that is there but cannot be unlocked only warns: lookups
 * still run on the free path, and the fix is a person's, never `agentFix`
 * (decision 15), never "set TENJIN_WALLET_PASSPHRASE" and never the plaintext
 * file (B1, S3). A check that could not answer is said as not checked.
 */
export function walletRow(e: Eligibility, dataDir: string): RouterCheck {
  const name = 'wallet';
  const sign = e.canSign;
  if (e.describeError !== null && e.describeError !== undefined) {
    const err = e.describeError;
    return {
      name,
      status: 'fail',
      required: true,
      detail: err instanceof CliError ? err.message : String(err),
      ...(err instanceof CliError && err.fix !== undefined ? { fix: err.fix } : {}),
    };
  }
  if (sign.status === 'blocked' && sign.reason === 'no_wallet') {
    return {
      name,
      status: 'fail',
      required: true,
      detail: 'no wallet on this machine, so nothing can pay',
      fix: `Run \`tenjin wallet create\`, then \`tenjin wallet fund ${SUGGESTED_FUND_USD}\`.`,
    };
  }
  if (sign.status === 'blocked' && sign.reason === 'env_key_invalid') {
    return { name, status: 'fail', required: true, detail: sign.detail, fix: sign.fix };
  }
  const address = e.address ?? 'the wallet';
  if (sign.status === 'ready') {
    if (sign.warning !== undefined) {
      return {
        name,
        status: 'warn',
        required: false,
        detail: `${address} unlocks with the saved passphrase; TENJIN_WALLET_PASSPHRASE is set but wrong`,
        fix: 'Remove it from this shell and your shell profile: `unset TENJIN_WALLET_PASSPHRASE`.',
      };
    }
    return {
      name,
      status: 'ok',
      required: true,
      detail:
        sign.source !== undefined
          ? `${address} unlocks without a prompt (${signedFrom(sign.source, address, dataDir)})`
          : `${address} unlocks without a prompt`,
    };
  }
  if (sign.status === 'blocked') {
    const fix = WARN_UNLOCK.has(sign.reason)
      ? WALLET_REASONS[sign.reason as keyof typeof WALLET_REASONS].fix
      : sign.fix;
    return {
      name,
      status: 'warn',
      required: false,
      detail: `${address} cannot be unlocked: ${sign.detail}`,
      fix,
    };
  }
  return {
    name,
    status: 'warn',
    required: false,
    checked: false,
    detail: `could not check whether ${address} unlocks: ${sign.detail}`,
    ...(sign.reason === 'keychain_locked' ? { fix: KEYCHAIN_LOCKED_FIX } : {}),
  };
}

/** The S7 repair fix: the person saves the passphrase where every Claude Code can read it. */
const SAVE_FOR_EVERY_SESSION_FIX = `Run \`tenjin wallet repair\` yourself to save the passphrase where every Claude Code can read it ${REPAIR_CLAUSE}.`;

/** `HH:MM`, local time, for a router's start. */
function clock(ms: number): string {
  return new Date(ms).toTimeString().slice(0, 5);
}

/**
 * THE `claude session` ROW: what the router a running Claude Code started saw
 * when it tried to unlock this wallet, read from the observation it wrote.
 * Doctor's own shell is not that session: its environment, its PATH and its
 * keychain answer can all differ, which is the whole point of this row.
 *
 * Only a router that has served a Claude hook counts (B2): one started by
 * `claude mcp get` or `list`, a Codex one, or one prewarmed with no hook
 * served yet, is not "the running Claude session" and is ignored.
 *
 * With none, the row says what this shell alone can say, and is not checked,
 * except in the one case it can say more (S7): this shell signs only through
 * TENJIN_WALLET_PASSPHRASE and the saved stores DEFINITELY do not open the
 * wallet, so a Claude Code started without the variable cannot unlock it. An
 * unknown saved-store answer (a locked keychain) makes no such claim.
 *
 * Never a failure, and never new routing-fee wording (S5): the routing-fee
 * row says that.
 */
export function sessionRow(
  shell: Eligibility,
  live: RouterObservation[],
  version: string = pkg.version,
): RouterCheck {
  const name = 'claude session';
  // At this version first, then the most recent: the router the next lookup most likely meets.
  const served = [...servedObservations(live)].sort(
    (a, b) =>
      Number(b.cliVersion === version) - Number(a.cliVersion === version) ||
      b.startedAt - a.startedAt,
  );
  if (served.length === 0) {
    const shellReady = shell.canSign.status === 'ready' && shell.canPayRouting.status === 'ready';
    const detail = shellReady ? NO_SESSION_CHECKED : 'no running Claude session checked';
    if (
      shell.source === 'passphrase-env' &&
      shell.savedSign !== null &&
      isDefiniteBlock(shell.savedSign)
    ) {
      return {
        name,
        status: 'warn',
        required: false,
        detail: `${detail}, and a Claude Code started without TENJIN_WALLET_PASSPHRASE cannot unlock the wallet`,
        fix: SAVE_FOR_EVERY_SESSION_FIX,
      };
    }
    return {
      name,
      status: 'warn',
      required: false,
      checked: false,
      detail,
      ...(shell.source === 'key-env'
        ? { fix: 'Start Claude Code from a shell that sets TENJIN_WALLET_KEY.' }
        : {}),
    };
  }

  const blocked = served.find((o) => o.sign.status === 'blocked');
  if (blocked !== undefined) {
    const reason = blocked.sign.reason ?? '';
    const wallet = Object.prototype.hasOwnProperty.call(WALLET_REASONS, reason)
      ? WALLET_REASONS[reason as keyof typeof WALLET_REASONS]
      : undefined;
    const detail = blocked.sign.detail ?? wallet?.reason ?? reason;
    const fix = wallet?.fix ?? blocked.sign.fix;
    return {
      name,
      status: 'warn',
      required: false,
      detail: `the router Claude Code started (pid ${blocked.pid}) cannot unlock the wallet: ${detail}`,
      ...(fix !== undefined ? { fix } : {}),
    };
  }

  const here = shell.address?.toLowerCase() ?? null;
  const other = served.find(
    (o) => o.address !== null && here !== null && o.address.toLowerCase() !== here,
  );
  if (other !== undefined) {
    return {
      name,
      status: 'warn',
      required: false,
      detail: `Claude Code's router uses ${other.address}, this shell ${shell.address}`,
    };
  }

  const waiting = served.find((o) => o.sign.status !== 'ready');
  if (waiting !== undefined) {
    const why =
      waiting.sign.status === 'pending'
        ? 'it has not tried to unlock yet'
        : (waiting.sign.detail ??
          UNKNOWN_DETAIL[waiting.sign.reason ?? ''] ??
          UNKNOWN_DETAIL['check_failed']!);
    return {
      name,
      status: 'warn',
      required: false,
      checked: false,
      detail: `could not check whether the router Claude Code started (pid ${waiting.pid}) unlocks the wallet: ${why}`,
    };
  }

  const o = served[0]!;
  return {
    name,
    status: 'ok',
    required: false,
    detail: `the router Claude Code started (pid ${o.pid}, since ${clock(o.startedAt)}, v${o.cliVersion}) unlocked ${o.address ?? shell.address ?? 'the wallet'}`,
  };
}
