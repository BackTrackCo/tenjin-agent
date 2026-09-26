import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { WalletOutcome } from '../commands/install-wallet';
import { persistRouterDefaults } from '../commands/config';
import { CliError } from '../lib/errors';
import { withAppServer } from '../lib/codex-app-server';
import type { CommandContext, CommandResult } from '../context';
import {
  at,
  CODEX_GRANT,
  CODEX_PLUGIN,
  codexVersion,
  readCodexConfig,
  requestConfigured,
  WEB_QUALIFIED_VERSION,
} from './codex-host';

const exec = promisify(execFile);
type Action = 'install' | 'doctor' | 'uninstall';
interface Options {
  project?: boolean;
  refresh?: boolean;
  noWallet?: boolean;
  approveRequest?: boolean;
}
export interface CodexInstallDeps {
  run?: (args: string[]) => Promise<string>;
  config?: () => Promise<unknown>;
  version?: () => Promise<string | null>;
  grant?: () => Promise<boolean>;
  packageRoot?: string;
  hooks?: () => Promise<unknown>;
}
const runHost = async (args: string[]): Promise<string> =>
  (await exec('codex', args, { timeout: 20_000, maxBuffer: 2_000_000 })).stdout;

/** Locate the shipped marketplace from source or a split dist chunk. */
async function packageRoot(): Promise<string> {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 4; i++, dir = dirname(dir)) {
    try {
      const p = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')) as { name?: string };
      if (p.name === 'tenjin-cli') return dir;
    } catch {
      /* next parent */
    }
  }
  throw new CliError('CONFIG_INVALID', 'Cannot locate the installed Tenjin plugin package.');
}

async function approveRequest(): Promise<boolean> {
  return (
    (await withAppServer(homedir(), process.env, 3_000, async (request) => {
      const result = await request('config/batchWrite', {
        edits: [{ keyPath: CODEX_GRANT, value: 'approve', mergeStrategy: 'replace' }],
        filePath: null,
        expectedVersion: null,
        reloadUserConfig: true,
      });
      return result !== undefined;
    })) === true
  );
}

export async function runCodexSetup(
  action: Action,
  opts: Options,
  ctx: CommandContext,
  deps: CodexInstallDeps = {},
): Promise<CommandResult> {
  if (opts.project)
    throw new CliError(
      'USAGE',
      'Codex plugin setup currently supports user scope only; omit --project.',
    );
  const run = deps.run ?? runHost;
  const readConfig = deps.config ?? (() => readCodexConfig(process.cwd(), 3_000));
  if (action === 'uninstall') {
    await run(['plugin', 'remove', CODEX_PLUGIN, '--json']);
    return {
      data: { removed: CODEX_PLUGIN },
      humanLines: ['Codex plugin removed. Wallet, Claude setup and user tool policy are kept.'],
    };
  }
  let wallet: WalletOutcome | undefined;
  let walletLine: string | undefined;
  if (action === 'install') {
    const before = await readConfig();
    if (before == null)
      throw new CliError(
        'CONFIG_INVALID',
        'Could not inspect Codex configuration. Start Codex once, then retry.',
      );
    if (at(before, 'mcp_servers', 'x402') !== undefined)
      throw new CliError(
        'CONFIG_INVALID',
        'A direct Codex x402 server already exists. Remove that experimental registration before installing the Tenjin plugin.',
      );
    if (opts.refresh && at(before, 'plugins', CODEX_PLUGIN, 'enabled') !== true)
      throw new CliError(
        'CONFIG_INVALID',
        'No enabled Tenjin Codex plugin to refresh. Run tenjin install --harness codex.',
      );
    const root = deps.packageRoot ?? (await packageRoot());
    await run(['plugin', 'marketplace', 'add', root, '--json']);
    await run(['plugin', 'add', CODEX_PLUGIN, '--json']);
    if (!opts.refresh) {
      await persistRouterDefaults(ctx.dataDir, false);
      const { resolveWallet, walletValue } = await import('../commands/install-wallet');
      wallet = await resolveWallet(ctx, {}, opts.noWallet ? 'flag' : undefined, false);
      walletLine = `Wallet: ${walletValue(wallet)}`;
    }
    if (opts.approveRequest) {
      const existing = at(
        before,
        'plugins',
        CODEX_PLUGIN,
        'mcp_servers',
        'x402',
        'tools',
        'request',
        'approval_mode',
      );
      if (existing !== undefined && existing !== 'approve')
        throw new CliError(
          'CONFIG_INVALID',
          'An explicit Codex request policy already exists. Review it in Codex; setup will not overwrite it.',
        );
      if (!(await (deps.grant ?? approveRequest)()))
        throw new CliError(
          'CONFIG_INVALID',
          'Codex refused the request-tool grant. Review its managed/user policy.',
        );
    }
  }
  const config = await readConfig();
  const version = await (deps.version ?? codexVersion)();
  const configured = requestConfigured(config);
  // Hook trust is the host's responsibility. Do not manufacture private hashes.
  const result = await (
    deps.hooks ??
    (() =>
      withAppServer(homedir(), process.env, 3_000, (request) =>
        request('hooks/list', { cwds: [process.cwd()] }),
      ))
  )();
  const groups = at(result, 'data');
  const hooks = Array.isArray(groups)
    ? groups
        .flatMap((g) => {
          const h = at(g, 'hooks');
          return Array.isArray(h) ? h : [];
        })
        .filter((h) => {
          const command = at(h, 'command');
          const path = at(h, 'sourcePath');
          return (
            typeof command === 'string' &&
            command.startsWith('tenjin hook ') &&
            command.endsWith('--harness codex') &&
            typeof path === 'string' &&
            path.includes('/tenjin/')
          );
        })
    : [];
  const trusted =
    hooks.length === 3 &&
    hooks.every(
      (h) =>
        at(h, 'enabled') === true && ['trusted', 'managed'].includes(String(at(h, 'trustStatus'))),
    );
  const webVerified = version === WEB_QUALIFIED_VERSION;
  const lines = [
    `Codex plugin: ${at(config, 'plugins', CODEX_PLUGIN, 'enabled') === true ? 'enabled' : 'not enabled'}`,
    `Request tool policy: ${configured ? 'approved' : 'not ready'}`,
    `Hooks: ${trusted ? 'trusted' : 'review required or unavailable — open Codex /hooks'}`,
    `Web routing: ${webVerified ? `qualified on ${version}` : `unverified on ${version ?? 'unknown build'}; strict payload checks still apply`}`,
    'Start a new Codex session after installation or a plugin update.',
  ];
  if (!configured)
    lines.push(
      'Review the exact tool grant with: tenjin install --harness codex --approve-request (wallet limits still apply).',
    );
  lines.push('Check wallet and spending policy with tenjin status; fund with tenjin wallet fund.');
  if (walletLine !== undefined) lines.push(walletLine);
  const data = {
    plugin: CODEX_PLUGIN,
    configured,
    trusted,
    webVerified,
    version,
    configurationReady: configured && trusted,
    fullReadinessVerified: false,
    mcpConnection: 'verify in a new Codex session',
    paymentReady: 'check wallet and spend limits',
    ...(wallet !== undefined ? { wallet } : {}),
  };
  if (action === 'doctor' && !data.configurationReady)
    throw new CliError('REFUSED', 'Codex configuration is not ready.', {
      details: data,
      fix: lines.join('\n'),
    });
  return { data, humanLines: lines };
}
