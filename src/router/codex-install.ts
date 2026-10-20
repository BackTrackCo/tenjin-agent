import { execFile } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { persistRouterDefaults } from '../commands/config';
import { versionFreeEntry } from '../commands/update';
import type { WalletDeps, WalletOutcome } from '../commands/install-wallet';
import { withAppServer } from '../lib/codex-app-server';
import { loadRawConfig } from '../lib/config';
import { CliError } from '../lib/errors';
import type { CommandContext, CommandResult } from '../context';
import {
  at,
  CODEX_MARKETPLACE,
  CODEX_PLUGIN,
  codexVersion,
  readCodexConfig,
  WEB_VERIFIED_VERSION,
} from './codex-host';
import { approveLimits, spendApprovalFor, type RouterInstallDeps } from './install';
import { CODEX_ALLOW_HOOK_COMMAND, CODEX_HOOK_COUNT } from './plugin-files';
import { shownLimits } from './spend-question';

/**
 * `tenjin install|uninstall|doctor --harness codex`. Codex's own commands do
 * every plugin write: `codex plugin marketplace add` and `codex plugin add`
 * copy the plugin from this package's `dist/hosts/codex`. The plugin's own
 * `PermissionRequest` hook allows the request tool, so install writes no Codex
 * config: the wallet, the spend defaults and the plugin. User scope only.
 */

export interface CodexArgs {
  project?: boolean;
  yes?: boolean;
  noWallet?: boolean;
}

export interface CodexRun {
  code: number;
  stdout: string;
  stderr: string;
}

export interface CodexSetupDeps
  extends WalletDeps, Pick<RouterInstallDeps, 'promptLimits' | 'promptAmount'> {
  /** One `codex` command, recorded in tests. */
  run?: (args: string[]) => Promise<CodexRun>;
  /** Codex's merged config (`config/read`), or null when it could not be read. */
  config?: () => Promise<unknown>;
  /** Codex's hook list (`hooks/list`). */
  hooks?: () => Promise<unknown>;
  version?: () => Promise<string | null>;
  /** The marketplace folder, by default this package's `dist/hosts/codex`. */
  hostsDir?: string | null;
  isInteractive?: boolean;
}

const RUN_TIMEOUT_MS = 30_000;
const APP_SERVER_TIMEOUT_MS = 5_000;

function runCodex(args: string[]): Promise<CodexRun> {
  return new Promise((resolve) => {
    execFile(
      'codex',
      args,
      { timeout: RUN_TIMEOUT_MS, maxBuffer: 4_000_000 },
      (err, stdout, stderr) => {
        const code = err === null ? 0 : typeof err.code === 'number' ? err.code : 127;
        resolve({ code, stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });
}

function listHooks(): Promise<unknown> {
  return withAppServer(homedir(), process.env, APP_SERVER_TIMEOUT_MS, (request) =>
    request('hooks/list', { cwds: [process.cwd()] }),
  );
}

/** This package's `dist/hosts/codex`, by its version-free path under pnpm. */
export async function codexHostsDir(
  moduleDir: string = dirname(fileURLToPath(import.meta.url)),
): Promise<string | null> {
  const catalog = join(moduleDir, 'hosts', 'codex', '.agents', 'plugins', 'marketplace.json');
  const stable = versionFreeEntry(catalog) ?? catalog;
  if ((await stat(stable).catch(() => null))?.isFile() !== true) return null;
  return dirname(dirname(dirname(stable)));
}

/**
 * The plugin, as Codex's one `hooks/list` shows it. Every row carries its
 * `pluginId`, `enabled` and `trustStatus`: no Tenjin row means the plugin is
 * not installed (or is off), and every row present, enabled and trusted means
 * it is installed, on and trusted.
 */
export interface CodexHookRows {
  state: 'trusted' | 'review' | 'absent' | 'unknown';
  /** The request tool's allow hook is off in `/hooks`, so the tool asks first. */
  allowOff: boolean;
}

function isAllowHook(hook: unknown): boolean {
  return (
    at(hook, 'command') === CODEX_ALLOW_HOOK_COMMAND ||
    String(at(hook, 'key')).includes(':permission_request:')
  );
}

export function codexHookRows(list: unknown): CodexHookRows {
  const groups = at(list, 'data');
  if (!Array.isArray(groups)) return { state: 'unknown', allowOff: false };
  const ours = groups
    .flatMap((group) => {
      const hooks = at(group, 'hooks');
      return Array.isArray(hooks) ? (hooks as unknown[]) : [];
    })
    .filter((hook) => at(hook, 'pluginId') === CODEX_PLUGIN);
  if (ours.length === 0) return { state: 'absent', allowOff: false };
  // Turning the allow hook off is the documented opt-out, not a broken install.
  const optedOut = (hook: unknown) => isAllowHook(hook) && at(hook, 'enabled') === false;
  const ready = ours.every(
    (hook) =>
      optedOut(hook) ||
      (at(hook, 'enabled') === true &&
        ['trusted', 'managed'].includes(String(at(hook, 'trustStatus')))),
  );
  return {
    state: ours.length === CODEX_HOOK_COUNT && ready ? 'trusted' : 'review',
    allowOff: ours.some(optedOut),
  };
}

/**
 * Can Codex show an MCP elicitation, the Pay once ask? Not under
 * `approval_policy = "never"`, nor with the feature off: there a call over the
 * limit returns `needs_approval` with the command the user runs.
 */
export function elicitationCanShow(config: unknown): boolean {
  return (
    at(config, 'approval_policy') !== 'never' &&
    at(config, 'features', 'tool_call_mcp_elicitation') !== false
  );
}

function failed(step: string, out: CodexRun): CliError {
  const detail = (out.stderr || out.stdout).trim().split('\n')[0] ?? '';
  return new CliError('REFUSED', `\`codex ${step}\` failed${detail ? `: ${detail}` : ''}.`, {
    fix: 'Check that Codex CLI is installed and on PATH (`codex --version`), then re-run.',
  });
}

async function addPlugin(
  run: (args: string[]) => Promise<CodexRun>,
  hosts: string | null,
): Promise<void> {
  if (hosts === null) {
    throw new CliError(
      'INTERNAL',
      'This build carries no Codex plugin folder (dist/hosts/codex).',
      {
        fix: 'Reinstall a published build: npm i -g tenjin-cli',
      },
    );
  }
  const market = await run(['plugin', 'marketplace', 'add', hosts, '--json']);
  if (market.code !== 0) throw failed('plugin marketplace add', market);
  const plugin = await run(['plugin', 'add', CODEX_PLUGIN, '--json']);
  if (plugin.code !== 0) throw failed('plugin add', plugin);
}

const TRUST_STEP =
  'Open Codex, run /hooks and trust the four Tenjin hooks, then start a new session.';

function userScopeOnly(args: CodexArgs): void {
  if (args.project === true) {
    throw new CliError('USAGE', 'The Codex plugin installs for your user only; omit --project.');
  }
}

export async function runCodexInstall(
  args: CodexArgs,
  ctx: CommandContext,
  deps: CodexSetupDeps = {},
): Promise<CommandResult> {
  userScopeOnly(args);
  const run = deps.run ?? runCodex;
  const hosts = deps.hostsDir === undefined ? await codexHostsDir() : deps.hostsDir;
  const config = await loadRawConfig(ctx.dataDir);
  const humanOutput = ctx.flags.json === true ? false : (deps.isInteractive ?? ctx.io.isTTY);
  const canPrompt = humanOutput && (deps.isInteractive ?? Boolean(process.stdin.isTTY));
  // The one question comes before any write.
  const limits =
    args.yes === true ? shownLimits(config) : canPrompt ? await approveLimits(config, deps) : {};
  const consented = args.yes === true || canPrompt;

  const { resolveWallet, walletValue } = await import('../commands/install-wallet');
  const wallet: WalletOutcome = await resolveWallet(
    ctx,
    deps,
    args.noWallet === true ? 'flag' : undefined,
    false,
  );
  const spend = await persistRouterDefaults(ctx.dataDir, false, limits);
  await addPlugin(run, hosts);

  const approve = ['tenjin install --harness codex', args.noWallet ? '--no-wallet' : '', '--yes']
    .filter(Boolean)
    .join(' ');
  return {
    data: {
      plugin: CODEX_PLUGIN,
      wallet,
      spend,
      ...(consented ? {} : { approval: spendApprovalFor(config, approve) }),
      next: TRUST_STEP,
    },
    humanLines: [
      `Wallet: ${walletValue(wallet)}`,
      `Codex plugin: ${CODEX_PLUGIN} added from the package`,
      ...(consented ? [] : [`Spend limits: not approved yet. Approve them with \`${approve}\``]),
      'Request tool: its plugin hook allows it, under your wallet spend limits. Turn that hook off in /hooks to be asked first.',
      TRUST_STEP,
    ],
  };
}

export async function runCodexUninstall(
  args: CodexArgs,
  _ctx: CommandContext,
  deps: CodexSetupDeps = {},
): Promise<CommandResult> {
  userScopeOnly(args);
  const run = deps.run ?? runCodex;
  const removed = await run(['plugin', 'remove', CODEX_PLUGIN, '--json']);
  if (removed.code !== 0) throw failed('plugin remove', removed);
  // Absent already is the state uninstall wants.
  await run(['plugin', 'marketplace', 'remove', CODEX_MARKETPLACE]);
  return {
    data: { removed: CODEX_PLUGIN, marketplace: CODEX_MARKETPLACE },
    humanLines: [
      `Codex plugin ${CODEX_PLUGIN} and its marketplace removed. The wallet and Claude setup are kept.`,
    ],
  };
}

const PLUGIN_LINE: Record<CodexHookRows['state'], string> = {
  trusted: 'installed, its hooks on and trusted',
  review: `installed, its hooks need review. ${TRUST_STEP}`,
  absent: 'not installed or turned off. Run `tenjin install --harness codex`',
  unknown: "could not read Codex's hook list",
};

/** Reads Codex's view of the plugin and writes nothing. */
export async function runCodexDoctor(
  args: CodexArgs,
  _ctx: CommandContext,
  deps: CodexSetupDeps = {},
): Promise<CommandResult> {
  userScopeOnly(args);
  const [list, config, version] = await Promise.all([
    (deps.hooks ?? listHooks)(),
    (deps.config ?? (() => readCodexConfig(process.cwd(), 3_000)))(),
    (deps.version ?? codexVersion)(),
  ]);
  const hooks = codexHookRows(list);
  const read = config !== null && config !== undefined;
  const elicitation = read ? elicitationCanShow(config) : null;
  // With its allow hook off, `approval_policy = "never"` refuses the tool.
  const refused = hooks.allowOff && at(config, 'approval_policy') === 'never';
  const ok = hooks.state === 'trusted' && !refused;
  const lines = [
    `Codex plugin: ${PLUGIN_LINE[hooks.state]}`,
    `Request tool: ${refused ? 'refused: its allow hook is off in /hooks and approval_policy is never' : hooks.allowOff ? 'asks before each call (its allow hook is off in /hooks)' : 'allowed by its plugin hook, under your wallet spend limits'}`,
    `Pay once ask: ${elicitation === null ? 'unknown' : elicitation ? 'can show' : 'cannot show (approval_policy never); a call over the limit returns needs_approval'}`,
    `Codex build: ${version ?? 'unknown'} (web hooks last captured on ${WEB_VERIFIED_VERSION}; information only)`,
  ];
  const data = {
    plugin: CODEX_PLUGIN,
    hooks: hooks.state,
    allowOff: hooks.allowOff,
    elicitation,
    version,
    ok,
  };
  if (!ok) {
    throw new CliError('REFUSED', 'The Codex plugin is not ready.', {
      details: data,
      fix: lines.join('\n'),
    });
  }
  return { data, humanLines: lines };
}
