import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pkg from '../../package.json';
import { persistRouterDefaults } from '../commands/config';
import { versionFreeEntry } from '../commands/update';
import type { WalletDeps, WalletOutcome } from '../commands/install-wallet';
import { autoUpdateLine } from '../lib/auto-update';
import { resolveCodex } from '../lib/codex-bin';
import { loadRawConfig } from '../lib/config';
import { CliError } from '../lib/errors';
import { runtimeDir } from '../lib/paths';
import type { RuntimeSetup, setupRuntime } from '../lib/runtime';
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
  defaultRuntime,
  effectiveLimits,
  hasRuntime,
  namedLimits,
  NOTHING_TO_REFRESH,
  runtimeData,
  runtimeLines,
  spendStepFor,
  tilde,
  type QuestionStep,
  type RouterInstallDeps,
} from './install';
import { EVENT_LABEL, rowsOf, trustCodexHooks, type ListedHook } from '../lib/codex-trust';
import { readInstalledHosts, withNote } from './hosts';
import { CODEX_MCP_HOOKS_VERSION, renderCodexHooks } from './plugin-files';
import { shownLimits } from './spend-question';

/**
 * `tenjin install|uninstall|doctor` for Codex. Codex's own commands do
 * every plugin write: `codex plugin marketplace add` and `codex plugin add`
 * copy the plugin from Tenjin's runtime, `~/.tenjin/runtime/codex`, which
 * install sets up as the Claude install does, or from this package's
 * `dist/hosts/codex` where there is none. The plugin's own `PermissionRequest`
 * hook allows the request tool, so install writes no Codex config: the
 * wallet, the spend defaults and the plugin. User scope only.
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
  /** The marketplace folder without a runtime, by default this package's `dist/hosts/codex`. */
  hostsDir?: string | null;
  isInteractive?: boolean;
  homeDir?: string;
  /** Sets up Tenjin's runtime for this build; tests inject it, production runs `setupRuntime`. */
  runtime?: (o: Parameters<typeof setupRuntime>[0]) => Promise<RuntimeSetup>;
  /** Trusts the listed rows through Codex's app server; tests inject it. */
  trust?: typeof trustCodexHooks;
}

const RUN_TIMEOUT_MS = 30_000;

function runCodex(args: string[]): Promise<CodexRun> {
  const codex = resolveCodex();
  if (codex === null) {
    return Promise.resolve({ code: 127, stdout: '', stderr: 'codex was not found on PATH' });
  }
  return new Promise((resolve) => {
    execFile(
      codex.cmd,
      [...codex.prefix, ...args],
      { timeout: RUN_TIMEOUT_MS, maxBuffer: 4_000_000, windowsHide: true },
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

/**
 * The runtime's Codex marketplace, when the runtime has one: a `kept` older
 * runtime may predate it.
 */
function runtimeHosts(rt: RuntimeSetup): string | null {
  if (rt.state !== 'active' && rt.state !== 'current' && rt.state !== 'kept') return null;
  const hosts = join(rt.root, 'codex');
  return existsSync(join(hosts, '.agents', 'plugins', 'marketplace.json')) ? hosts : null;
}

/**
 * `registered` is the folder Codex's config names for the `tenjin`
 * marketplace. Codex keeps one marketplace by that name, so one added from
 * another folder (the package's, before the runtime) is removed first.
 */
async function addPlugin(
  run: (args: string[]) => Promise<CodexRun>,
  hosts: string | null,
  registered: unknown,
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
  if (typeof registered === 'string' && resolve(registered) !== resolve(hosts)) {
    // Absent already is fine: the add then reports.
    await run(['plugin', 'marketplace', 'remove', CODEX_MARKETPLACE]);
  }
  const market = await run(['plugin', 'marketplace', 'add', hosts, '--json']);
  if (market.code !== 0) throw failed('plugin marketplace add', market);
  const plugin = await run(['plugin', 'add', CODEX_PLUGIN, '--json']);
  if (plugin.code !== 0) throw failed('plugin add', plugin);
}

const TRUST_STEP =
  'Open Codex, run /hooks and trust the five Tenjin hooks, then start a new session.';
/** What a person reads when this Codex cannot run the plugin's routing hooks. */
const CODEX_TOO_OLD = `Routing in Codex needs Codex ${CODEX_MCP_HOOKS_VERSION} or later, so Tenjin left its Codex plugin as it was. Ask your agent to update Codex.`;
/** What a person reads when an install or update turned the hooks on itself. */
const NEW_SESSION_STEP = 'Start a new Codex session: Codex reads hooks when a session starts.';

/**
 * ONE OF THE PLUGIN'S OWN HOOKS, as `hooks/list` lists it: our plugin's hooks
 * file, and at that event, group and position exactly the handler this build
 * renders (an `mcp_tool` leg into `router`/`hook`, the deny, or the allow).
 * Anything else in the list, another plugin's row or a row that moved, is not
 * ours to trust.
 */
export function ownCodexRow(row: ListedHook): boolean {
  if (row.pluginId !== CODEX_PLUGIN) return false;
  if (typeof row.sourcePath !== 'string' || !/[\\/]hooks[\\/]hooks\.json$/.test(row.sourcePath)) {
    return false;
  }
  const at = /:([a-z_]+):(\d+):(\d+)$/.exec(typeof row.key === 'string' ? row.key : '');
  if (at === null) return false;
  const event = Object.keys(EVENT_LABEL).find((e) => EVENT_LABEL[e] === at[1]);
  const group = (renderCodexHooks().hooks[event ?? ''] as Record<string, unknown>[] | undefined)?.[
    Number(at[2])
  ] as { matcher?: string; hooks: Record<string, unknown>[] } | undefined;
  const want = group?.hooks[Number(at[3])];
  if (group === undefined || want === undefined) return false;
  if ((row.matcher ?? null) !== (group.matcher ?? null)) return false;
  return want.type === 'mcp_tool'
    ? row.handlerType === 'mcpTool' && row.server === want.server && row.tool === want.tool
    : row.handlerType === 'command' &&
        (row.command === want.command || row.command === want.commandWindows);
}

/**
 * TURNS THE PLUGIN'S HOOKS ON, as installing a Claude Code plugin does:
 * through `lib/codex-trust.ts`, which echoes back the `currentHash` Codex
 * reports for each of our rows and verifies them trusted. A row the person
 * turned off in `/hooks` (the allow hook's opt-out) stays off. False when
 * Codex lists none of our rows or any step fails: the person then reviews
 * them in `/hooks`.
 */
async function trustPlugin(deps: CodexSetupDeps): Promise<boolean> {
  const list = await (deps.hooks ?? (() => listCodexHooks(process.cwd(), 5_000)))();
  const ours = rowsOf(list).filter(ownCodexRow);
  if (ours.length === 0) return false;
  const keys = ours
    .filter(
      (r) => r.enabled !== false && r.trustStatus !== 'trusted' && r.trustStatus !== 'managed',
    )
    .map((r) => r.key as string);
  const result = await (deps.trust ?? trustCodexHooks)(
    deps.homeDir ?? homedir(),
    keys,
    ownCodexRow,
  );
  return result.ok;
}

/** What `tenjin update` says about Codex, in person-facing words with no command. */
export const CODEX_REFRESH_LINES = {
  done: "Tenjin updated its Codex hooks. They run in Codex's next new session.",
  review:
    "Tenjin updated its Codex hooks but could not turn them on. Open /hooks in Codex and approve Tenjin's hooks so routing works.",
  old: CODEX_TOO_OLD,
  failed:
    'Tenjin could not update its Codex hooks. Ask your agent to run the Tenjin doctor for Codex.',
} as const;

/**
 * A bare `install --refresh` with the Codex refresh beside it: the Codex one
 * runs whatever Claude Code's did. Only Claude Code's "nothing to refresh"
 * (a Codex-only machine) gives way to a Codex line; any other Claude Code
 * failure stands, so `tenjin update` still reports it with its fix.
 */
export async function alongsideCodexRefresh(
  claude: () => Promise<CommandResult>,
  codex: () => Promise<string | undefined>,
): Promise<CommandResult> {
  let out: CommandResult;
  try {
    out = await claude();
  } catch (err) {
    const line = await codex();
    const nothing = err instanceof CliError && err.message.startsWith(NOTHING_TO_REFRESH);
    if (line === undefined || !nothing) throw err;
    return { data: { notices: [line] }, humanLines: [line] };
  }
  return withNote(out, await codex());
}

/**
 * THE CODEX REFRESH `tenjin update` RUNS, in the new build (`install
 * --refresh`). Only where Codex already has the Tenjin plugin with the
 * command legs of an older build: it re-adds the plugin from the same folder,
 * which replaces Codex's copy, then turns the new hooks on (`trustPlugin`).
 * It never installs the plugin anywhere it was not, never asks, and never
 * throws: what happened is one line, or nothing.
 */
export async function refreshCodexPlugin(
  ctx: CommandContext,
  deps: CodexSetupDeps = {},
): Promise<string | undefined> {
  try {
    const version = await (deps.version ?? codexVersion)();
    if (version === null) {
      const recorded = (await readInstalledHosts(ctx.dataDir))?.includes('codex') === true;
      return recorded ? CODEX_REFRESH_LINES.failed : undefined;
    }
    const rows = codexHookRows(
      await (deps.hooks ?? (() => listCodexHooks(process.cwd(), 5_000)))(),
    );
    if (rows.state === 'absent') return undefined;
    if (rows.state === 'unknown') return CODEX_REFRESH_LINES.failed;
    if (rows.routing !== 'free') return undefined;
    if (!codexAtLeast(version, CODEX_MCP_HOOKS_VERSION)) return CODEX_REFRESH_LINES.old;
    const runtimeCodex = join(runtimeDir(ctx.dataDir), 'codex');
    const hosts = existsSync(join(runtimeCodex, '.agents', 'plugins', 'marketplace.json'))
      ? runtimeCodex
      : deps.hostsDir === undefined
        ? await codexHostsDir()
        : deps.hostsDir;
    const config = await (deps.config ?? (() => readCodexConfig(process.cwd(), 3_000)))();
    await addPlugin(
      deps.run ?? runCodex,
      hosts,
      at(config, 'marketplaces', CODEX_MARKETPLACE, 'source'),
    );
    return (await trustPlugin(deps)) ? CODEX_REFRESH_LINES.done : CODEX_REFRESH_LINES.review;
  } catch {
    return CODEX_REFRESH_LINES.failed;
  }
}

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
  const home = deps.homeDir ?? homedir();
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
  // TENJIN'S OWN RUNTIME, for a Codex-only machine too, so a Node upgrade
  // cannot stop the plugin. A runtime that could not be set up, or a
  // non-default data dir, keeps the package's folder.
  const rt = await (deps.runtime ?? defaultRuntime)({
    dataDir: ctx.dataDir,
    home,
    env: deps.env ?? process.env,
    version: pkg.version,
    moduleDir: dirname(fileURLToPath(import.meta.url)),
    refresh: false,
  });
  const fromRuntime = runtimeHosts(rt);
  const hosts =
    fromRuntime ?? (deps.hostsDir === undefined ? await codexHostsDir() : deps.hostsDir);
  // A Codex too old to run `mcp_tool` hooks keeps whatever copy it has: the
  // new hooks would be skipped, or the file refused. An unknown build installs.
  const version = await (deps.version ?? codexVersion)();
  const tooOld = version !== null && !codexAtLeast(version, CODEX_MCP_HOOKS_VERSION);
  let next: string = CODEX_TOO_OLD;
  if (!tooOld) {
    const codexConfig = await (deps.config ?? (() => readCodexConfig(process.cwd(), 3_000)))();
    await addPlugin(run, hosts, at(codexConfig, 'marketplaces', CODEX_MARKETPLACE, 'source'));
    next = (await trustPlugin(deps).catch(() => false)) ? NEW_SESSION_STEP : TRUST_STEP;
  }

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
      runtime: runtimeData(rt),
      nextSteps: spendAsk !== undefined ? [spendAsk] : [],
      next,
    },
    humanLines: [
      `Wallet: ${walletValue(wallet)}`,
      tooOld
        ? `Codex plugin: left as it was (Codex ${version})`
        : `Codex plugin: ${CODEX_PLUGIN} added from ${fromRuntime !== null ? tilde(fromRuntime, home) : 'the package'}`,
      ...runtimeLines(ctx, rt, home),
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
      next,
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

/**
 * What the plugin's hooks and server run, from the folder Codex's config names
 * for the marketplace: information only. Nothing when Codex names none, or
 * names another folder on a machine with no runtime to move to.
 */
function runsFrom(ctx: CommandContext, deps: CodexSetupDeps, source: unknown): string | null {
  if (typeof source !== 'string') return null;
  const home = deps.homeDir ?? homedir();
  const hosts = join(runtimeDir(ctx.dataDir), 'codex');
  if (resolve(source) === resolve(hosts)) return `Tenjin's runtime (${tilde(hosts, home)})`;
  if (!hasRuntime(ctx.dataDir, home)) return null;
  return "`tenjin` from your PATH; run `tenjin install --harness codex` to move it to Tenjin's runtime";
}

/** Whether `version` (`x.y.z`, any suffix ignored) is `floor` or later. */
export function codexAtLeast(version: string, floor: string): boolean {
  const parts = (v: string) =>
    v
      .split(/[-+]/)[0]!
      .split('.')
      .map((n) => Number.parseInt(n, 10));
  const have = parts(version);
  for (const [i, least] of parts(floor).entries()) {
    const part = have[i] ?? 0;
    if (!Number.isFinite(part)) return false;
    if (part !== least) return part > least;
  }
  return true;
}

const ROUTING_LINE: Record<CodexHookRows['routing'], string> = {
  paid: 'its routing hooks call the router MCP server, which pays the routing fee under your wallet spend limits',
  free: 'its routing hooks are commands from an older build, which cannot pay the routing fee, so they offer nothing. Run `tenjin update` or `tenjin install --harness codex` to replace them',
  unknown: "could not read how Codex runs the plugin's routing hooks",
};

/**
 * Reads Codex's view of the plugin and writes nothing. Routing compatibility
 * is read the same way, with nothing paid or sent: the legs must be `mcp_tool`
 * hooks into the plugin's server (`codexHookRows`), and the Codex build must
 * run them ({@link CODEX_MCP_HOOKS_VERSION}).
 */
export async function runCodexDoctor(
  args: CodexArgs,
  ctx: CommandContext,
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
  // An unknown build is not failed on: only a known older one cannot run the legs.
  const tooOld = version !== null && !codexAtLeast(version, CODEX_MCP_HOOKS_VERSION);
  const routing = hooks.state === 'absent' ? null : hooks.routing;
  // Command legs from an older build warn without failing: `tenjin update`
  // replaces them, and Codex still runs the rest of the plugin.
  const ok = hooks.state === 'trusted' && !refused && routing !== 'unknown' && !tooOld;
  const runs = runsFrom(ctx, deps, at(config, 'marketplaces', CODEX_MARKETPLACE, 'source'));
  const auto = hasRuntime(ctx.dataDir, deps.homeDir ?? homedir())
    ? autoUpdateLine(runtimeDir(ctx.dataDir))
    : null;
  const lines = [
    `Codex plugin: ${PLUGIN_LINE[hooks.state]}`,
    `Request tool: ${refused ? 'refused: its allow hook is off in /hooks and approval_policy is never' : hooks.allowOff ? 'asks before each call (its allow hook is off in /hooks)' : 'allowed by its plugin hook, under your wallet spend limits'}`,
    ...(routing !== null
      ? [`${routing === 'free' ? '! ' : ''}Routing: ${ROUTING_LINE[routing]}`]
      : []),
    tooOld
      ? `Codex build: ${version}, which cannot run the plugin's routing hooks. Update Codex to ${CODEX_MCP_HOOKS_VERSION} or later`
      : `Codex build: ${version ?? 'unknown'} (web hooks last captured on ${WEB_VERIFIED_VERSION}; information only)`,
    ...(runs !== null ? [`Codex plugin runs: ${runs}`] : []),
    ...(auto !== null ? [auto] : []),
  ];
  const data = {
    plugin: CODEX_PLUGIN,
    hooks: hooks.state,
    allowOff: hooks.allowOff,
    routing,
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
