import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import pkg from '../../package.json';
import { loadRawConfig } from '../lib/config';
import { CliError } from '../lib/errors';
import { toMoney } from '../lib/money';
import { evaluateSpendPolicy, type SpendPolicy } from '../lib/policy';
import { resolveContextSettings, type ResolvedSettings } from '../lib/settings';
import { spentOf } from '../lib/spend-ledger';
import { isNewer } from '../lib/update-check';
import { readUsdcBalance } from '../lib/usdc-balance';
import { describeWallet, resolveWalletProvider, type WalletProvider } from '../lib/wallet';
import { readSpendSummary } from '../lib/wallet/spend';
import { walletFileExists } from '../lib/wallet/store';
import type { CommandContext, CommandResult } from '../context';
import { agentsWithoutRequestTool } from './agent-tools';
import { readAliveStamp } from './alive';
import {
  CLAUDE_CODE_FLOOR,
  claudeConfigDir,
  findClaudeBinary,
  readClaudeCode,
  runClaude,
  type ClaudeBinary,
  type ClaudeCodeState,
} from './claude-cli';
import {
  CHANNEL_DEPOSIT_ATOMIC,
  feeRefusal,
  MIN_DEPOSIT_ATOMIC,
  ROUTING_FEE_ATOMIC,
  SUGGESTED_FUND_USD,
  unpaid,
  usd,
} from './fee';
import { channelCredit } from './channel-credit';
import { loadStep, pluginProof, projectInstallHere, settingsInstallPaths } from './install';
import { commandForm, handlersIn } from './hook-form';
import { inspectLegacyInstall, type LegacyInstall } from './legacy-install';
import { routerSettings, type RouterSettings } from './settings';
import { MARKETPLACE_NAME, PLUGIN_ID, PLUGIN_SERVER, REQUEST_TOOL } from './names';
import { PLUGIN_DIR } from './plugin-files';
import { folderState, readPluginListing, type PluginScope } from './plugin-registration';
import { probeRouter, type RouterCheck } from './reachability';
import { readMcpServers, type InstalledAt, type ListMcpProcesses } from './mcp-processes';
import { clearRouterMemo, readRouterMemo, type RouterMemo } from './router-memo';
import {
  ACCEPT_COMMAND,
  OWN_LIMITS_COMMANDS,
  shownLimits,
  spendQuestion,
  type RouterLimits,
} from './spend-question';

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
 * EVERY FIX IS A STEP THE AGENT TAKES IN THE SESSION: a command it runs, or a
 * slash command the person types there. None sends anyone out of Claude Code.
 *
 * THE SHELF'S DOCTOR IS NOT THIS ONE. It stays with the product it belongs to
 * (`src/commands/doctor.ts`, unregistered), and this one reports the router's
 * own wiring.
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
  /** This user's running `tenjin mcp` processes; tests inject them. */
  listMcpProcesses?: ListMcpProcesses;
  /** When this build was installed; tests inject it. */
  installedAt?: InstalledAt;
  now?: () => number;
  /** The platform the hook-form check judges for. Tests inject `win32`. */
  platform?: NodeJS.Platform;
}

const NODE_FLOOR = 22;

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

  const checks: RouterCheck[] = [nodeCheck(deps.nodeVersion ?? process.version)];
  checks.push(claudeCodeCheck(claude));
  const plugin = await pluginCheck(claude, { scope, env, home, cwd, dataDir: ctx.dataDir, legacy });
  checks.push(plugin.check);
  const platform = deps.platform ?? process.platform;
  const form = await hookFormCheck(
    { scope, env, home, cwd, dataDir: ctx.dataDir, legacy },
    platform,
  );
  if (form !== null) checks.push(form);
  if (plugin.registered && claude.binary !== null) {
    checks.push(await serverCheck(claude.binary, env, cwd));
  }
  if (legacy.present || legacy.unreadable !== undefined) {
    checks.push(await migrationCheck(legacy, claude, ctx.dataDir, env, cwd));
  }
  checks.push(routingCheck(router));
  checks.push((await readMcpServers(deps, { settingsInstallPending: legacy.present })).check);
  const rawConfig = await loadRawConfig(ctx.dataDir);
  const unanswered =
    rawConfig.maxAutoSpend === undefined ? { limits: shownLimits(rawConfig) } : null;
  checks.push(
    spendCheck(settings.policy.maxAutoSpendAtomic, settings.policy.sessionBudgetAtomic, unanswered),
  );
  checks.push(experimentalCheck(settings.experimentalBazaar));
  checks.push(await routingFeeCheck(ctx, settings, deps.fetchImpl, unanswered));
  checks.push(...(await walletCheck(ctx)));
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
  };
  if (failure !== undefined) {
    // REFUSED, the exit-3 class: a machine this command found unready is
    // understood and refused, not a runtime failure of the command itself.
    throw new CliError('REFUSED', failure.detail, {
      ...(failure.fix !== undefined ? { fix: failure.fix } : {}),
      details: data,
    });
  }
  return { data, humanLines: doctorLines(checks) };
}

/** The human report: one line a check, and under each row to look at, its
 *  fix, as `--json` carries it. */
export function doctorLines(checks: RouterCheck[]): string[] {
  const bad = checks.filter((c) => c.status !== 'ok').length;
  return [
    ...checks.flatMap((c) => [
      `${c.status === 'ok' ? 'ok  ' : c.status === 'warn' ? 'warn' : 'fail'}  ${c.name}: ${c.detail}`,
      ...(c.status !== 'ok' && c.fix !== undefined ? [`      fix: ${c.fix}`] : []),
    ]),
    bad === 0
      ? `${checks.length} checks, all pass.`
      : `${checks.length} checks, ${bad} to look at.`,
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
      return {
        registered: false,
        check: {
          name,
          status: 'fail',
          required: true,
          detail: `${listing.id} is installed but disabled, so no lookup is routed`,
          fix: `Run \`claude plugin enable ${listing.id}\`, then ${loadStep(c.legacy.present)}.`,
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
    // Claude Code's own environment shows only in the `alive` stamp, which the
    // plugin's SessionStart leg writes from a real session: doctor's PATH may
    // find a Node that Claude Code's does not.
    const stamp = await readAliveStamp(c.dataDir);
    if (stamp === null || isNewer(pkg.version, stamp.version)) {
      return {
        registered: true,
        check: {
          name,
          status: 'warn',
          required: false,
          detail: `${listing.id} ${pkg.version} is enabled, and no session has started it at this version${stamp !== null ? ` (last ${stamp.version}, at ${stamp.at})` : ''}`,
          fix: "Claude Code starts the plugin with the Node on its own PATH; run `node --version` in this session's shell (it must be 22 or newer), then restart Claude Code after installing or updating Node.",
        },
      };
    }
    return {
      registered: true,
      check: { name, status: 'ok', required: true, detail: `${listing.id} ${pkg.version} enabled` },
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
    return {
      registered: true,
      check:
        stamp === null
          ? {
              name,
              status: 'warn',
              required: false,
              detail: `the plugin folder is at ${folder.path} and has not loaded in a session yet`,
              fix: `To load it, ${loadStep(c.legacy.present)}.`,
            }
          : {
              name,
              status: 'ok',
              required: true,
              detail: `the plugin folder at ${folder.path} loaded, last at ${stamp.at}`,
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
async function listedInClaudeFiles(env: NodeJS.ProcessEnv, home: string): Promise<boolean> {
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
 * THE FORM OF EVERY TENJIN COMMAND HOOK ON DISK: the plugin's, wherever Claude
 * Code loads it from, and an earlier release's settings install. Shell form
 * runs under Git Bash or PowerShell on Windows, where these commands fail, so
 * a stale install shows here before a session finds out.
 */
async function hookFormCheck(
  c: PluginContext,
  platform: NodeJS.Platform,
): Promise<RouterCheck | null> {
  const shell = new Set<string>();
  let exec = 0;
  for (const path of await pluginHookFiles(c)) {
    for (const handler of handlersIn(await readJson(path))) {
      const form = commandForm(handler);
      if (form === 'exec') exec += 1;
      else if (form === 'shell') shell.add(path);
    }
  }
  if (c.legacy.shellCommands > 0) shell.add(c.legacy.settingsPath);
  const name = 'hook form';
  if (shell.size === 0) {
    return exec === 0
      ? null
      : { name, status: 'ok', required: false, detail: `exec, ${exec} command hooks and no shell` };
  }
  const detail = `shell, in ${[...shell].join(', ')}: Windows runs these through Git Bash or PowerShell, where they fail`;
  if (platform !== 'win32') return { name, status: 'ok', required: false, detail };
  return {
    name,
    status: 'warn',
    required: false,
    detail,
    fix: `Run \`tenjin install${c.scope === 'local' ? ' --project' : ''}\`: it writes the plugin in exec form, and removes an earlier settings install once the plugin has loaded.`,
  };
}

/**
 * The plugin's hooks files as Claude Code loads them: the folder fallback's,
 * the marketplace folder for a `directory` marketplace (loaded in place, its
 * cache copy unread), and otherwise each install path Claude Code records.
 */
async function pluginHookFiles(c: PluginContext): Promise<string[]> {
  const out: string[] = [];
  const folder = await folderState(c.scope, c.env, c.home, c.cwd);
  if (folder.state === 'ours') out.push(join(folder.path, 'hooks', 'hooks.json'));
  const plugins = join(claudeConfigDir(c.env, c.home), 'plugins');
  const market = (await readJson(join(plugins, 'known_marketplaces.json')))?.[MARKETPLACE_NAME] as
    { source?: { source?: unknown }; installLocation?: unknown } | undefined;
  if (market?.source?.source === 'directory' && typeof market.installLocation === 'string') {
    out.push(join(market.installLocation, PLUGIN_DIR, 'hooks', 'hooks.json'));
    return out;
  }
  const records = (
    (await readJson(join(plugins, 'installed_plugins.json')))?.plugins as
      Record<string, unknown> | undefined
  )?.[PLUGIN_ID];
  for (const record of Array.isArray(records) ? records : []) {
    const path = (record as { installPath?: unknown } | null)?.installPath;
    if (typeof path === 'string' && path.length > 0) out.push(join(path, 'hooks', 'hooks.json'));
  }
  return out;
}

async function readJson(path: string): Promise<Record<string, unknown> | null> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as unknown;
    return parsed !== null && typeof parsed === 'object'
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
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
    fix: 'Restart Claude Code (quit it from the tray) or sign out and in: the plugin starts the CLI with `node` from the PATH Claude Code started with, so a Claude Code opened before Node was installed cannot find it.',
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
          ? `To load the plugin, ${loadStep(true)}; the next \`tenjin install\` or \`tenjin update\` then removes the old entries.`
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

/**
 * THE ROUTING FEE, AS THE NEXT PAID CALL WOULD MEET IT: the reasons the session
 * notice gives (`unpaid`), worked out here from the wallet, the spend limits,
 * the ledger and the channel the SDK keeps. Never a failure: a call the fee
 * cannot pay takes the free path. A payment that failed in a session leaves
 * nothing to read here; these are the causes this can check.
 */
async function routingFeeCheck(
  ctx: CommandContext,
  settings: ResolvedSettings,
  fetchImpl: typeof fetch | undefined,
  unanswered: { limits: RouterLimits } | null,
): Promise<RouterCheck> {
  let host: string;
  try {
    host = new URL(settings.baseUrl).host;
  } catch {
    // The router check below names the bad base URL and its fix.
    return {
      name: 'routing fee',
      status: 'warn',
      required: false,
      detail: 'not checked, because the base URL is not a URL',
    };
  }
  const why = await routingFeeBlock({
    dataDir: ctx.dataDir,
    policy: settings.policy,
    rpcUrl: settings.rpcUrl,
    host,
    timeoutMs: ctx.flags.timeout,
    provider: (await walletFileExists(ctx.dataDir)) ? resolveWalletProvider(ctx) : null,
    ...(fetchImpl !== undefined ? { fetchImpl } : {}),
  }).catch(() => null);
  return routingFeeRow(why, host, unanswered);
}

/** The routing-fee row for what {@link routingFeeBlock} found. */
export function routingFeeRow(
  why: string | null,
  host: string,
  unanswered: { limits: RouterLimits } | null,
): RouterCheck {
  const u = why === null ? null : unpaid(why);
  if (why === null || u === null) {
    return {
      name: 'routing fee',
      status: 'ok',
      required: false,
      detail: `$${usd(ROUTING_FEE_ATOMIC)} a call, paid from channel deposits of up to $${usd(CHANNEL_DEPOSIT_ATOMIC)} that count against the spend limits`,
    };
  }
  if (why === 'limit_below_deposit' && unanswered !== null) {
    // The zero is the open spend question, not a limit anyone chose: the fix
    // is the question itself, with the fee terms it approves.
    return {
      name: 'routing fee',
      status: 'warn',
      required: false,
      detail: 'the spend limits are not answered yet, so routing calls take the free path',
      fix: `Answer the spend question: ${spendQuestion(unanswered.limits)} For a yes, run \`${ACCEPT_COMMAND}\`; for other amounts, ${OWN_LIMITS_COMMANDS}.`,
    };
  }
  const fixes: Record<string, string> = {
    no_wallet: `Run \`tenjin wallet create\`, then \`tenjin wallet fund ${SUGGESTED_FUND_USD}\`.`,
    limit_below_deposit: `Raise it with \`tenjin config set maxAutoSpend ${usd(CHANNEL_DEPOSIT_ATOMIC)}\`.`,
    budget_reached:
      'Room comes back as the rolling day passes, or raise it with `tenjin config set sessionBudget <usd>`.',
    not_allowlisted: `Add ${host} to allowlistCreators, or clear the allowlist.`,
  };
  return {
    name: 'routing fee',
    status: 'warn',
    required: false,
    detail: `${u.reason}, so routing calls take the free path`,
    fix: fixes[why] ?? u.fix,
  };
}

/** What {@link routingFeeBlock} reads; `provider` is null with no wallet. */
export interface RoutingFeeInput {
  dataDir: string;
  policy: SpendPolicy;
  rpcUrl: string;
  /** The router's host, the creator a deposit pays. */
  host: string;
  timeoutMs: number;
  provider: WalletProvider | null;
  fetchImpl?: typeof fetch;
}

/** Why the next deposit would be refused, or null when the fee can be paid. */
export async function routingFeeBlock(input: RoutingFeeInput): Promise<string | null> {
  const { provider, policy } = input;
  // The fee's per-payment checks first, before the wallet, as the payer runs
  // them on every call: a channel with credit pays nothing they refuse, and
  // unanswered limits are the question to name, not the passphrase.
  const refused = feeRefusal(policy, input.host);
  if (refused !== null) return refused;
  if (provider === null) return 'no_wallet';
  const verified = await provider.verify?.().catch(() => null);
  if (verified !== undefined && verified !== null && verified.status !== 'verified') {
    return 'wallet_locked';
  }
  const ledger = await readSpendSummary(input.dataDir);
  const spent = ledger === null ? 0n : spentOf(ledger);
  const { address } = await describeWallet(provider);
  if ((await channelCredit(input.dataDir, address)) >= ROUTING_FEE_ATOMIC) return null;
  const deposit =
    policy.maxAutoSpendAtomic < CHANNEL_DEPOSIT_ATOMIC
      ? policy.maxAutoSpendAtomic
      : CHANNEL_DEPOSIT_ATOMIC;
  if (deposit < MIN_DEPOSIT_ATOMIC) return 'limit_below_deposit';
  const evaluation = evaluateSpendPolicy(policy, {
    mode: 'automatic',
    amountAtomic: deposit,
    creator: input.host,
    sessionSpentAtomic: spent,
  });
  if (evaluation.reason === 'not_allowlisted') return 'not_allowlisted';
  if (evaluation.reason === 'session_budget_exceeded') return 'budget_reached';
  const balance = await readUsdcBalance(address, input.rpcUrl, {
    timeoutMs: input.timeoutMs,
    ...(input.fetchImpl !== undefined ? { fetchImpl: input.fetchImpl } : {}),
  });
  return balance !== null && balance < deposit ? 'wallet_low' : null;
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
 * `unanswered` is set when the config file names no `maxAutoSpend`: the state
 * an install that could not ask leaves, the same as a cancel at its selector.
 * The code default's zero holds, and that is a question still open, not a
 * broken machine, so it warns with the question and its one-step yes, and the
 * checks after it (the router probe above all) still print. A 0 the user
 * wrote is their answer and stays a failure.
 */
function spendCheck(
  maxAutoSpendAtomic: bigint,
  sessionBudgetAtomic: bigint | null,
  unanswered: { limits: RouterLimits } | null,
): RouterCheck {
  if (sessionBudgetAtomic === 0n) {
    return {
      name: 'spend',
      status: 'fail',
      required: true,
      detail: 'The daily limit is 0, so positive payments are refused even with --yes.',
      fix: 'Choose a daily limit with `tenjin config set sessionBudget <usd|none>`.',
    };
  }
  if (maxAutoSpendAtomic === 0n && unanswered !== null) {
    return {
      name: 'spend',
      status: 'warn',
      required: false,
      detail: `the spend limits are not answered yet, so automatic payments are off and every lookup needs approval. Ask the user: ${spendQuestion(unanswered.limits)}`,
      fix: `Answer the spend question: for a yes, run \`${ACCEPT_COMMAND}\`; for other amounts, ${OWN_LIMITS_COMMANDS}.`,
    };
  }
  if (maxAutoSpendAtomic === 0n) {
    return {
      name: 'spend',
      status: 'fail',
      required: true,
      detail: 'maxAutoSpend is 0, so every lookup needs approval and none can pay',
      fix: 'Set a per-call limit with `tenjin config set maxAutoSpend <usd>`.',
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

async function walletCheck(ctx: CommandContext): Promise<RouterCheck[]> {
  if (!(await walletFileExists(ctx.dataDir))) {
    return [
      {
        name: 'wallet',
        status: 'fail',
        required: true,
        detail: 'no wallet on this machine, so nothing can pay',
        fix: `Run \`tenjin wallet create\`, then \`tenjin wallet fund ${SUGGESTED_FUND_USD}\`.`,
      },
    ];
  }
  try {
    const described = await describeWallet(resolveWalletProvider(ctx));
    return [{ name: 'wallet', status: 'ok', required: true, detail: described.address }];
  } catch (err) {
    return [
      {
        name: 'wallet',
        status: 'fail',
        required: true,
        detail: err instanceof CliError ? err.message : String(err),
        ...(err instanceof CliError && err.fix !== undefined ? { fix: err.fix } : {}),
      },
    ];
  }
}
