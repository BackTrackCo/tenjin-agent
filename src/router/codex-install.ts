import { execFile } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { persistRouterDefaults } from '../commands/config';
import { versionFreeEntry } from '../commands/update';
import type { WalletDeps, WalletOutcome } from '../commands/install-wallet';
import { loadRawConfig } from '../lib/config';
import { CliError } from '../lib/errors';
import type { CommandContext, CommandResult } from '../context';
import {
  at,
  CODEX_MARKETPLACE,
  CODEX_PLUGIN,
  codexHookRows,
  codexVersion,
  listCodexHooks,
  readCodexConfig,
  type CodexHookRows,
  WEB_VERIFIED_VERSION,
} from './codex-host';
import { resolveContextSettings } from '../lib/settings';
import {
  approveLimits,
  effectiveLimits,
  namedLimits,
  spendStepFor,
  type QuestionStep,
  type RouterInstallDeps,
} from './install';
import { shownLimits } from './spend-question';

/**
 * `tenjin install|uninstall|doctor` for Codex. Codex's own commands do
 * every plugin write: `codex plugin marketplace add` and `codex plugin add`
 * copy the plugin from this package's `dist/hosts/codex`. The plugin's own
 * `PermissionRequest` hook allows the request tool, so install writes no Codex
 * config: the wallet, the spend defaults and the plugin. User scope only.
 */

export interface CodexArgs {
  project?: boolean;
  yes?: boolean;
  noWallet?: boolean;
  /** `--max-auto-spend`: the per-call limit, at least 0.25 USD. */
  maxAutoSpend?: string;
  /** `--session-budget`: the daily limit in USD, or none. */
  sessionBudget?: string;
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

/** This package's `dist/hosts/codex`, by its version-free path under pnpm. */
export async function codexHostsDir(
  moduleDir: string = dirname(fileURLToPath(import.meta.url)),
): Promise<string | null> {
  const catalog = join(moduleDir, 'hosts', 'codex', '.agents', 'plugins', 'marketplace.json');
  const stable = versionFreeEntry(catalog) ?? catalog;
  if ((await stat(stable).catch(() => null))?.isFile() !== true) return null;
  return dirname(dirname(dirname(stable)));
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
  const named = namedLimits(args);
  const humanOutput = ctx.flags.json === true ? false : (deps.isInteractive ?? ctx.io.isTTY);
  const canPrompt = humanOutput && (deps.isInteractive ?? Boolean(process.stdin.isTTY));
  // The Claude install's spend model: `--yes` takes the defaults, the two
  // amount flags set the person's own, and a terminal asks once, before any
  // write, only when the file names neither limit. With no answer nothing is
  // written, the defaults hold, and the question goes to whoever ran it.
  const answered = args.yes === true || named.keys.length > 0;
  const unasked = config.maxAutoSpend === undefined && config.sessionBudget === undefined;
  const limits =
    named.keys.length > 0
      ? { ...shownLimits(config), ...named.limits }
      : args.yes === true
        ? shownLimits(config)
        : canPrompt && unasked
          ? await approveLimits(deps)
          : {};

  const { resolveWallet, walletValue } = await import('../commands/install-wallet');
  const wallet: WalletOutcome = await resolveWallet(
    ctx,
    deps,
    args.noWallet === true ? 'flag' : undefined,
    false,
  );
  const spend = await persistRouterDefaults(ctx.dataDir, false, limits, named.keys);
  await addPlugin(run, hosts);

  // Read back after the write, as the Claude install does.
  const effective = effectiveLimits((await resolveContextSettings(ctx)).policy);
  // Run again by the agent in Codex, a bare install finds Codex itself.
  const install = ['tenjin install', ...(args.noWallet ? ['--no-wallet'] : [])].join(' ');
  const spendAsk: QuestionStep | undefined =
    !canPrompt && !answered && unasked ? spendStepFor(install) : undefined;
  const daily =
    effective.sessionBudget === 'no daily ceiling'
      ? 'no daily limit'
      : `$${effective.sessionBudget} a day`;
  return {
    data: {
      plugin: CODEX_PLUGIN,
      wallet,
      spend: { ...spend, effective },
      nextSteps: spendAsk !== undefined ? [spendAsk] : [],
      next: TRUST_STEP,
    },
    humanLines: [
      `Wallet: ${walletValue(wallet)}`,
      `Codex plugin: ${CODEX_PLUGIN} added from the package`,
      `Automatic router: up to $${effective.maxAutoSpend} per call; daily limit ${daily}`,
      ...(spendAsk !== undefined
        ? [
            `  Ask the person in this session: ${spendAsk.question}`,
            ...spendAsk.options.map(
              (o) => `  ${o.label}${o.recommended ? ' (recommended)' : ''}: ${o.command}`,
            ),
          ]
        : []),
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
    (deps.hooks ?? (() => listCodexHooks(process.cwd(), 5_000)))(),
    (deps.config ?? (() => readCodexConfig(process.cwd(), 3_000)))(),
    (deps.version ?? codexVersion)(),
  ]);
  const hooks = codexHookRows(list);
  // With its allow hook off, `approval_policy = "never"` refuses the tool.
  const refused = hooks.allowOff && at(config, 'approval_policy') === 'never';
  const ok = hooks.state === 'trusted' && !refused;
  const lines = [
    `Codex plugin: ${PLUGIN_LINE[hooks.state]}`,
    `Request tool: ${refused ? 'refused: its allow hook is off in /hooks and approval_policy is never' : hooks.allowOff ? 'asks before each call (its allow hook is off in /hooks)' : 'allowed by its plugin hook, under your wallet spend limits'}`,
    `Codex build: ${version ?? 'unknown'} (web hooks last captured on ${WEB_VERIFIED_VERSION}; information only)`,
  ];
  const data = {
    plugin: CODEX_PLUGIN,
    hooks: hooks.state,
    allowOff: hooks.allowOff,
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
