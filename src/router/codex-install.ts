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
  CODEX_GRANT,
  CODEX_MARKETPLACE,
  CODEX_PLUGIN,
  codexVersion,
  grantOf,
  GRANT_VALUE,
  readCodexConfig,
  requestConfigured,
  WEB_VERIFIED_VERSION,
} from './codex-host';
import { approveLimits, spendApprovalFor, type RouterInstallDeps } from './install';
import { CODEX_LEGS } from './plugin-files';
import { shownLimits } from './spend-question';

/**
 * `tenjin install|uninstall|doctor --harness codex`. Codex's own commands do
 * every plugin write: `codex plugin marketplace add` and `codex plugin add`
 * copy the plugin from this package's `dist/hosts/codex`, and the grant goes
 * through the app server's `config/batchWrite`. Install writes the wallet,
 * the spend defaults, the plugin and then the grant. User scope only.
 */

export interface CodexArgs {
  project?: boolean;
  refresh?: boolean;
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
  /** Writes the grant's value, or clears it with null (`config/batchWrite`). */
  writeGrant?: (value: string | null) => Promise<boolean>;
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

async function writeGrant(value: string | null): Promise<boolean> {
  const result = await withAppServer(homedir(), process.env, APP_SERVER_TIMEOUT_MS, (request) =>
    request('config/batchWrite', {
      edits: [{ keyPath: CODEX_GRANT, value, mergeStrategy: 'replace' }],
      filePath: null,
      expectedVersion: null,
      reloadUserConfig: true,
    }),
  );
  return at(result, 'status') === 'ok';
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

/** The plugin's row in `codex plugin list --json`, or why it could not be read. */
export interface CodexListing {
  read: boolean;
  installed: boolean;
  enabled: boolean;
  version: string | null;
}

export async function readCodexListing(
  run: (args: string[]) => Promise<CodexRun>,
): Promise<CodexListing> {
  const out = await run(['plugin', 'list', '--json']);
  let rows: unknown;
  try {
    rows = out.code === 0 ? at(JSON.parse(out.stdout), 'installed') : undefined;
  } catch {
    rows = undefined;
  }
  if (!Array.isArray(rows)) return { read: false, installed: false, enabled: false, version: null };
  const row: unknown = rows.find((r) => at(r, 'pluginId') === CODEX_PLUGIN);
  const version = at(row, 'version');
  return {
    read: true,
    installed: row !== undefined,
    enabled: at(row, 'enabled') === true,
    version: typeof version === 'string' ? version : null,
  };
}

/** Hook trust, from Codex's own list: every Tenjin leg present, enabled and trusted. */
export function hookTrust(list: unknown): 'trusted' | 'review' | 'unknown' {
  const groups = at(list, 'data');
  if (!Array.isArray(groups)) return 'unknown';
  const ours = groups
    .flatMap((group) => {
      const hooks = at(group, 'hooks');
      return Array.isArray(hooks) ? (hooks as unknown[]) : [];
    })
    .filter((hook) => at(hook, 'pluginId') === CODEX_PLUGIN);
  const trusted = ours.filter(
    (hook) =>
      at(hook, 'enabled') === true &&
      ['trusted', 'managed'].includes(String(at(hook, 'trustStatus'))),
  );
  return ours.length === CODEX_LEGS.length && trusted.length === ours.length ? 'trusted' : 'review';
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
  'Open Codex, run /hooks and trust the three Tenjin hooks, then start a new session.';

export async function runCodexInstall(
  args: CodexArgs,
  ctx: CommandContext,
  deps: CodexSetupDeps = {},
): Promise<CommandResult> {
  if (args.project === true) {
    throw new CliError('USAGE', 'The Codex plugin installs for your user only; omit --project.');
  }
  const run = deps.run ?? runCodex;
  const hosts = deps.hostsDir === undefined ? await codexHostsDir() : deps.hostsDir;
  if (args.refresh === true) {
    const listing = await readCodexListing(run);
    if (!listing.installed) {
      throw new CliError(
        'REFUSED',
        `Nothing to refresh: the ${CODEX_PLUGIN} plugin is not in Codex.`,
        {
          fix: 'Run `tenjin install --harness codex` to set it up.',
        },
      );
    }
    await addPlugin(run, hosts);
    return {
      data: { plugin: CODEX_PLUGIN, refresh: true },
      humanLines: ['Codex plugin refreshed. Start a new Codex session to load it.'],
    };
  }
  const config = await loadRawConfig(ctx.dataDir);
  const humanOutput = ctx.flags.json === true ? false : (deps.isInteractive ?? ctx.io.isTTY);
  const canPrompt = humanOutput && (deps.isInteractive ?? Boolean(process.stdin.isTTY));
  // The one question comes before any write, and the answer is also the
  // consent the grant needs.
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

  const before = await (deps.config ?? (() => readCodexConfig(process.cwd(), 3_000)))();
  const existing = grantOf(before);
  let grant: 'approved' | 'kept' | 'pending' | 'refused';
  if (typeof existing === 'string' && existing !== GRANT_VALUE) grant = 'kept';
  else if (existing === GRANT_VALUE) grant = 'approved';
  else if (!consented) grant = 'pending';
  else grant = (await (deps.writeGrant ?? writeGrant)(GRANT_VALUE)) ? 'approved' : 'refused';

  const approve = ['tenjin install --harness codex', args.noWallet ? '--no-wallet' : '', '--yes']
    .filter(Boolean)
    .join(' ');
  const lines = [
    `Wallet: ${walletValue(wallet)}`,
    `Codex plugin: ${CODEX_PLUGIN} added from the package`,
    grant === 'approved'
      ? 'Request tool: approved in Codex, under your wallet spend limits'
      : grant === 'kept'
        ? `Request tool: your own Codex policy (${String(existing)}) is kept`
        : grant === 'pending'
          ? `Request tool: not approved yet; approve with \`${approve}\``
          : 'Request tool: Codex refused the grant; check its managed policy',
    TRUST_STEP,
  ];
  return {
    data: {
      plugin: CODEX_PLUGIN,
      wallet,
      spend,
      grant,
      ...(grant === 'pending' ? { approval: spendApprovalFor(config, approve) } : {}),
      next: TRUST_STEP,
    },
    humanLines: lines,
  };
}

export async function runCodexUninstall(
  args: CodexArgs,
  _ctx: CommandContext,
  deps: CodexSetupDeps = {},
): Promise<CommandResult> {
  if (args.project === true) {
    throw new CliError('USAGE', 'The Codex plugin installs for your user only; omit --project.');
  }
  const run = deps.run ?? runCodex;
  // `codex plugin remove` drops the plugin's whole config table, so a value
  // the user set for the request tool is read first and written back after.
  const existing = grantOf(await (deps.config ?? (() => readCodexConfig(process.cwd(), 3_000)))());
  const removed = await run(['plugin', 'remove', CODEX_PLUGIN, '--json']);
  if (removed.code !== 0) throw failed('plugin remove', removed);
  const kept =
    typeof existing === 'string' && existing !== GRANT_VALUE
      ? await (deps.writeGrant ?? writeGrant)(existing)
      : false;
  // Absent already is the state uninstall wants.
  await run(['plugin', 'marketplace', 'remove', CODEX_MARKETPLACE]);
  return {
    data: {
      removed: CODEX_PLUGIN,
      marketplace: CODEX_MARKETPLACE,
      grant: existing === GRANT_VALUE ? 'removed' : kept ? 'kept' : 'absent',
    },
    humanLines: [
      `Codex plugin ${CODEX_PLUGIN} and its marketplace removed. The wallet and Claude setup are kept.`,
      ...(kept ? [`Your own request tool policy (${String(existing)}) is kept.`] : []),
    ],
  };
}

/** Reads Codex's view of the plugin and writes nothing. */
export async function runCodexDoctor(
  args: CodexArgs,
  _ctx: CommandContext,
  deps: CodexSetupDeps = {},
): Promise<CommandResult> {
  if (args.project === true) {
    throw new CliError('USAGE', 'The Codex plugin installs for your user only; omit --project.');
  }
  const run = deps.run ?? runCodex;
  const [listing, config, hooks, version] = await Promise.all([
    readCodexListing(run),
    (deps.config ?? (() => readCodexConfig(process.cwd(), 3_000)))(),
    (deps.hooks ?? listHooks)(),
    (deps.version ?? codexVersion)(),
  ]);
  const granted = requestConfigured(config);
  const trust = hookTrust(hooks);
  const elicitation = config === null ? null : elicitationCanShow(config);
  const ok = listing.enabled && granted && trust === 'trusted';
  const lines = [
    `Codex plugin: ${!listing.read ? 'could not read `codex plugin list`' : listing.enabled ? `enabled (${listing.version ?? 'no version'})` : listing.installed ? 'disabled' : 'not installed'}`,
    `Hooks: ${trust === 'trusted' ? 'trusted' : trust === 'review' ? `review needed. ${TRUST_STEP}` : 'could not be read'}`,
    `Request tool: ${granted ? 'approved' : 'not approved; run `tenjin install --harness codex --yes`'}`,
    `Pay once ask: ${elicitation === null ? 'unknown' : elicitation ? 'can show' : 'cannot show (approval_policy never); a call over the limit returns needs_approval'}`,
    `Codex build: ${version ?? 'unknown'} (web hooks last captured on ${WEB_VERIFIED_VERSION}; information only)`,
  ];
  const data = {
    plugin: CODEX_PLUGIN,
    listing,
    granted,
    hooks: trust,
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
