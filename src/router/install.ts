import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';
import { claudeAdapter } from '../adapters/claude';
import { persistRouterDefaults, persistRouterProject } from '../commands/config';
import type { RouterDefaultsResult } from '../commands/config';
import { CliError } from '../lib/errors';
import { appendAllowlistRules, claudeSettingsPath } from '../lib/harness-permissions';
import {
  inspectHooksFile,
  ownsHookEntry,
  pruneHooks,
  writeHooks,
  type HooksResult,
} from '../lib/harness-hooks';
import { toMoney } from '../lib/money';
import { resolveContextSettings } from '../lib/settings';
import type { SpendPolicy } from '../lib/policy';
import { onPath } from '../lib/skill-wiring';
import { loadRawConfig } from '../lib/config';
import { configPath } from '../lib/paths';
import type { PartialConfig } from '../lib/config';
import type { CommandContext, CommandResult } from '../context';

/**
 * `tenjin install` for the router product: two hook entries, one MCP server,
 * one permission rule, the spend defaults, and the disclosure.
 *
 * WHAT IT WRITES IS WHAT IT SAYS. There is no skill to materialize, no daemon
 * to start and no background process of any kind: the hooks are plain command
 * lines, the tool lives in an MCP server the harness starts per session, and
 * every other key in the settings file is preserved byte for byte.
 */

const exec = promisify(execFile);

/**
 * The harness's kill budget for each hook entry, and the number every other
 * wait inside the hook is cut from: 1 s of stdin plus 3.5 s of gate, with
 * 500 ms left for node's boot and the transcript read (`wire.test.ts` pins it).
 * Raised from 3 s because a gate abort costs the turn its hint silently.
 *
 * A machine carrying the old number is converged by the writer, not by the
 * user: the entries are ours by marker, so `install`, `install --refresh` and
 * the refresh `tenjin update` spawns all rewrite them in place.
 */
export const HOOK_TIMEOUT_SECONDS = 5;
export const MCP_SERVER_NAME = 'x402';
export const ALLOW_RULE = 'mcp__x402__request';
/**
 * The MCP registration follows the SAME SCOPE the hook entries do. A
 * `--project` install that wrote its hooks into the project and then registered
 * the server at user scope would reach into `~/.claude.json` on a run whose
 * whole point is to touch this project and nothing else, and `tenjin uninstall
 * --project` would leave that behind.
 *
 * Project scope writes `<project>/.mcp.json`, so the registration lives beside
 * the settings file that names the hooks and travels with the repository.
 */
export function mcpScope(project: boolean | undefined): 'user' | 'project' {
  return project === true ? 'project' : 'user';
}

export function mcpAddCommand(project?: boolean): string {
  return `claude mcp add ${MCP_SERVER_NAME} -s ${mcpScope(project)} -- tenjin mcp`;
}

export function mcpRemoveCommand(project?: boolean): string {
  return `claude mcp remove ${MCP_SERVER_NAME} -s ${mcpScope(project)}`;
}

/** The user-scope form, kept as the name the docs and the tests already use. */
export const MCP_ADD_COMMAND = mcpAddCommand();

/**
 * Which settings file this machine's router wiring lives in, spelled once so
 * `install`, `uninstall` and `doctor` can never disagree about where to look.
 * A doctor reading the home file on a `--project` install reported a correctly
 * wired machine as unwired and exited 3.
 */
export function routerSettingsPath(
  opts: { project?: boolean; homeDir?: string; cwd?: string } = {},
): string {
  if (opts.project === true) return join(opts.cwd ?? process.cwd(), '.claude', 'settings.json');
  return claudeSettingsPath(opts.homeDir ?? homedir());
}

/** The two entries, spelled once so `uninstall` and the tests read the same list. */
export function routerHookPlan(): unknown[] {
  const handler = (command: string) => [
    { type: 'command', command, timeout: HOOK_TIMEOUT_SECONDS },
  ];
  return [
    { event: 'UserPromptSubmit', hooks: handler('tenjin hook prompt') },
    { event: 'PreToolUse', matcher: 'WebSearch|WebFetch', hooks: handler('tenjin hook native') },
  ];
}

export const DISCLOSURE: readonly string[] = [
  'What leaves this machine: the bounded text of each prompt and each native search query or URL, sent to Tenjin for the free routing gate.',
  'What is kept when a lookup is paid: the capability chosen, a hash of the contract, a hash of the arguments, and your wallet address. No prompt text, no arguments, no hint text.',
  'What never leaves: your private key. It is decrypted in this CLI to sign, and never sent anywhere.',
];

export interface RouterInstallArgs {
  /** Write into this project's `.claude/settings.json` instead of your home one. */
  project?: boolean;
  /**
   * Bring the entries this machine ALREADY has up to the running build, and
   * add nothing: no config write, no MCP registration, and a refusal when
   * nothing of ours is here. `tenjin update` spawns exactly this after it swaps
   * the binary, so the flag's name and meaning are a compatibility contract.
   */
  refresh?: boolean;
}

export interface RouterInstallDeps {
  homeDir?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** PATH probe for the `claude` binary. */
  which?: (bin: string) => boolean;
  /** Runs `claude mcp add`; tests inject it so no binary is spawned. The scope
   *  and the working directory are passed, because project scope is decided by
   *  where the command runs as much as by the flag. */
  registerMcp?: (
    command: string,
    opts: { scope: 'user' | 'project'; cwd: string },
  ) => Promise<void>;
  /** Runs `claude mcp remove`, the only safe way past a same-name entry that
   *  launches something else: `add` refuses to overwrite one. */
  removeMcp?: (opts: { scope: 'user' | 'project'; cwd: string }) => Promise<void>;
  /** Reads the registration the scope's own file holds; tests inject it. */
  readMcpEntry?: (
    scope: 'user' | 'project',
    cwd: string,
    home: string,
  ) => Promise<{ found: boolean; state: McpEntryState }>;
}

export interface McpRegistration {
  name: string;
  registered: boolean;
  /** Which scope it went to, following the hook entries rather than the flag
   *  being read twice. `project` writes `<project>/.mcp.json`. */
  scope: 'user' | 'project';
  /** The command to run by hand, when this run could not. */
  command: string;
  /**
   * WHAT THIS RUN ACTUALLY DID, which `registered` alone cannot say:
   * `already-registered` (the scope's file already launches `tenjin mcp`, and
   * nothing was spawned), `added`, `repaired` (a same-name entry launching
   * something else was removed and re-added), `unrepaired` (a registration this
   * run KNOWS is wrong or unreadable and could not fix) or `unavailable` (it is
   * simply not there and this machine could not add it, e.g. no `claude` on
   * PATH). A refresh fails on `unrepaired`, because reporting convergence over
   * a registration that launches something else is the thing to avoid; it still
   * only prints the manual command for `unavailable`.
   */
  reconciled: 'already-registered' | 'added' | 'repaired' | 'unrepaired' | 'unavailable';
  reason?: string;
}

export async function runRouterInstall(
  args: RouterInstallArgs,
  ctx: CommandContext,
  deps: RouterInstallDeps = {},
): Promise<CommandResult> {
  const env = deps.env ?? process.env;
  const home = deps.homeDir ?? homedir();
  if (!isAbsolute(home)) {
    throw new CliError('INTERNAL', 'The home directory is not an absolute path.', {
      fix: 'Set HOME to your home directory (`export HOME=...`), then re-run `tenjin install`.',
    });
  }
  const cwd = deps.cwd ?? process.cwd();
  // A refresh converges EVERY install this machine has, in the scope each one
  // was made in. `tenjin update` spawns it from the HOME directory, so looking
  // around cwd would miss a project install entirely; the projects are read
  // from the list `install --project` recorded. A refresh that silently moved a
  // project install to user scope would also leave two installations and
  // double-fire every hook.
  // `project` UNSET means "work it out"; an explicit true or false is a single
  // target, which is what the fan-out below passes back in. Without that
  // distinction the user-scope leg would re-enter here forever.
  if (args.refresh === true && args.project === undefined) {
    return refreshEveryInstall(ctx, deps, home, cwd, env);
  }
  const project = args.project === true;
  const settingsPath = routerSettingsPath({
    ...(project ? { project: true } : {}),
    homeDir: home,
    cwd,
  });

  if (args.refresh === true) {
    const probe = await probeOurEntries(settingsPath, ctx.dataDir);
    // An unreadable file is not an absence, and telling someone to install over
    // it is the wrong instruction: the writer would refuse it too.
    if (probe.state === 'unreadable') {
      throw new CliError('CONFIG_INVALID', `Could not inspect ${settingsPath}: ${probe.reason}`, {
        fix: `Fix ${settingsPath}, then re-run: tenjin update`,
      });
    }
    if (probe.state === 'absent') {
      throw new CliError(
        'REFUSED',
        `Nothing to refresh in ${settingsPath}: no Tenjin hook entries are registered here.`,
        { fix: 'Run `tenjin install` to set this machine up.' },
      );
    }
  }
  const hooks = await writeHooks({
    adapter: claudeAdapter,
    homeDir: home,
    dataDir: ctx.dataDir,
    env,
    plan: routerHookPlan(),
    settingsPath,
  });
  const permissions = await ensureAllowRule(settingsPath);
  const mcp = await registerMcpServer(deps, env, project, cwd, home);
  if (args.refresh === true) {
    // The SAME writers, minus the one that decides anything: the entries are
    // rewritten in place by their ownership marker so an upgrade never
    // duplicates them, the rule and the registration are re-checked because a
    // new version can change either, and `config.json`, the wallet and
    // `spend.json` are not touched at all. Widening an agent's spend policy
    // during an unattended upgrade is not a convergence.
    // RECONCILED, not re-added: `claude mcp add` exits 1 on an existing entry,
    // so the registration is read first and only written when it is missing or
    // wrong (see {@link registerMcpServer}).
    const rewritten = [
      ...(hooks.wrote ? ['hook entries'] : []),
      ...(permissions.added ? ['the permission rule'] : []),
      ...(mcp.reconciled === 'repaired' ? ['the MCP registration'] : []),
    ];
    // A registration this run KNOWS is wrong and could not repair is not a
    // converged install, and `tenjin update` reporting success over it is how
    // a machine keeps a stale `x402` server across upgrade after upgrade.
    if (mcp.reconciled === 'unrepaired') {
      throw new CliError(
        'REFUSED',
        `The ${MCP_SERVER_NAME} MCP registration (${mcpScope(project)} scope) is not the router's and this run could not repair it: ${mcp.reason ?? 'unknown reason'}.`,
        { fix: `Run: ${mcp.command}`, details: { settingsPath, hooks, permissions, mcp } },
      );
    }
    return {
      data: { settingsPath, hooks, permissions, mcp, refresh: true, scope: mcpScope(project) },
      humanLines: [
        rewritten.length === 0
          ? `Already current: ${hooks.entries} hook entries in ${settingsPath}, nothing rewritten.`
          : `Rewrote ${rewritten.join(' and ')} in ${settingsPath}.`,
        mcp.registered
          ? `Re-checked the ${MCP_SERVER_NAME} MCP registration (${mcpScope(project)} scope): ${mcp.reconciled}.`
          : `mcp: run ${mcp.command}`,
        'Your wallet, spend ledger and config were not touched.',
      ],
    };
  }
  const spend = await persistRouterDefaults(ctx.dataDir);
  // Remembered so `tenjin update` can find this project again from anywhere.
  if (project) await persistRouterProject(ctx.dataDir, cwd);
  // Read back AFTER the write: a machine that already carried its own caps
  // keeps them, and a readout quoting the defaults would describe limits this
  // run did not set.
  const effective = await resolveContextSettings(ctx);

  const data = {
    settingsPath,
    hooks,
    permissions,
    spend: { ...spend, effective: effectiveLimits(effective.policy) },
    mcp,
    disclosure: DISCLOSURE,
  };
  return {
    data,
    humanLines: lines(settingsPath, hooks, permissions, spend, mcp, effective.policy),
  };
}

export interface AllowRuleResult {
  path: string;
  rule: string;
  added: boolean;
  /** Set when the file could not be written; the rule is then not in force. */
  warning?: string;
}

/**
 * The one permission rule, through the shared allowlist writer rather than a
 * third hand-rolled one: it resolves a symlinked settings.json before the
 * rename, refuses a file it cannot parse, and compares the bytes it read before
 * committing, none of which a local copy of the merge would have.
 */
async function ensureAllowRule(path: string): Promise<AllowRuleResult> {
  const result = await appendAllowlistRules(path, [ALLOW_RULE]);
  return {
    path: result.path,
    rule: ALLOW_RULE,
    added: result.added.length > 0,
    ...(result.warning !== undefined
      ? { warning: result.warning }
      : result.skipped !== undefined
        ? { warning: `${result.path} was left untouched (${result.skipped}).` }
        : {}),
  };
}

/**
 * RECONCILE, do not re-add blindly. `claude mcp add` is not idempotent: Claude
 * Code 2.1.280 exits 1 on a second identical add with "MCP server x402 already
 * exists in .mcp.json". Running it unconditionally therefore reported a
 * perfectly healthy machine as an unregistered one and printed a repair command
 * that would fail the same way, while a same-name entry launching something
 * else never converged, because `add` refuses to overwrite it.
 *
 * So the scope's own file is read first: an entry that already launches
 * `tenjin mcp` is the goal state and nothing is spawned; a stale one is removed
 * and re-added; a file that cannot be read is refused out loud rather than
 * written over.
 */
async function registerMcpServer(
  deps: RouterInstallDeps,
  env: NodeJS.ProcessEnv,
  project: boolean,
  cwd: string,
  home: string,
): Promise<McpRegistration> {
  const scope = mcpScope(project);
  const command = mcpAddCommand(project);
  const base = { name: MCP_SERVER_NAME, scope, command };
  const existing = await (deps.readMcpEntry ?? readMcpEntry)(scope, cwd, home);
  if (existing.state === 'ok') {
    return { ...base, registered: true, reconciled: 'already-registered' };
  }
  if (existing.state === 'unreadable') {
    return {
      ...base,
      registered: false,
      reconciled: 'unrepaired',
      reason: `the ${scope}-scope registration file could not be read, so nothing was written over it`,
    };
  }
  const which = deps.which ?? ((bin: string) => onPath(bin, env));
  if (!which('claude')) {
    return {
      ...base,
      registered: false,
      // A machine with no `claude` on PATH cannot be wired by this run either
      // way; that is not the same as finding a registration that is WRONG,
      // which is what a refresh is entitled to fail on.
      reconciled: existing.state === 'wrong-command' ? 'unrepaired' : 'unavailable',
      reason: 'the `claude` binary is not on PATH',
    };
  }
  if (existing.state === 'wrong-command') {
    try {
      await (deps.removeMcp ?? runClaudeMcpRemove)({ scope, cwd });
    } catch (err) {
      return {
        ...base,
        registered: false,
        reconciled: 'unrepaired',
        command: `${mcpRemoveCommand(project)} && ${command}`,
        reason: `a ${MCP_SERVER_NAME} entry that launches something else could not be removed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }
  try {
    await (deps.registerMcp ?? runClaudeMcpAdd)(command, { scope, cwd });
    return {
      ...base,
      registered: true,
      reconciled: existing.state === 'wrong-command' ? 'repaired' : 'added',
    };
  } catch (err) {
    return {
      ...base,
      registered: false,
      reconciled: existing.state === 'wrong-command' ? 'unrepaired' : 'unavailable',
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

export type McpEntryState = 'ok' | 'absent' | 'wrong-command' | 'unreadable';

/**
 * What an entry named `x402` actually launches. The name proves nothing: a
 * stale entry pointing at another binary would read as a working request tool.
 */
export function classifyMcpEntry(entry: unknown): McpEntryState {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return 'absent';
  const { command, args } = entry as { command?: unknown; args?: unknown };
  if (typeof command !== 'string' || command.length === 0) return 'wrong-command';
  // The basename, so `/opt/homebrew/bin/tenjin` and a bare `tenjin` both pass.
  const binary = command.split(/[\\/]/).pop();
  const runsRouter =
    binary === 'tenjin' && Array.isArray(args) && args.length === 1 && args[0] === 'mcp';
  return runsRouter ? 'ok' : 'wrong-command';
}

/**
 * The file each scope writes: the project's own `.mcp.json`, or the user's
 * `~/.claude.json`. Neither can inherit from the other. Shared by `install`,
 * which reconciles against it, and `doctor`, which reports it.
 */
export async function readMcpEntry(
  scope: 'user' | 'project',
  cwd: string,
  home: string,
): Promise<{ found: boolean; state: McpEntryState }> {
  const path = scope === 'project' ? join(cwd, '.mcp.json') : join(home, '.claude.json');
  // ONLY "it is not there" is an absence. A permission or filesystem error on a
  // file that DOES exist says nothing about what is registered in it, and
  // treating it as missing sent the refresh on to `claude mcp add` over a
  // registration it had never read: a failed add then looked like a machine
  // that simply lacks the tooling, and `tenjin update` exited 0 over whatever
  // was actually in there.
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return { found: false, state: 'absent' };
    return { found: true, state: 'unreadable' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // NOT an absence: the harness's own file is there and unreadable to this
    // build, so neither "register it" nor "it is missing" is a true statement.
    return { found: true, state: 'unreadable' };
  }
  const servers = (parsed as { mcpServers?: unknown } | null)?.mcpServers;
  if (servers === undefined) return { found: true, state: 'absent' };
  if (servers === null || typeof servers !== 'object' || Array.isArray(servers)) {
    return { found: true, state: 'unreadable' };
  }
  const entry = (servers as Record<string, unknown>)[MCP_SERVER_NAME];
  if (entry === undefined) return { found: true, state: 'absent' };
  return { found: true, state: classifyMcpEntry(entry) };
}

async function runClaudeMcpRemove(opts: { scope: 'user' | 'project'; cwd: string }): Promise<void> {
  await exec('claude', ['mcp', 'remove', MCP_SERVER_NAME, '-s', opts.scope], {
    timeout: 20_000,
    cwd: opts.cwd,
  });
}

/** Project scope is decided by the working directory as well as the flag:
 *  `claude` writes `.mcp.json` beside the project it was run in. */
async function runClaudeMcpAdd(
  _command: string,
  opts: { scope: 'user' | 'project'; cwd: string },
): Promise<void> {
  await exec('claude', ['mcp', 'add', MCP_SERVER_NAME, '-s', opts.scope, '--', 'tenjin', 'mcp'], {
    timeout: 20_000,
    cwd: opts.cwd,
  });
}

interface EffectiveLimits {
  maxAutoSpend: string;
  sessionBudget: string;
}

function effectiveLimits(policy: SpendPolicy): EffectiveLimits {
  return {
    maxAutoSpend: toMoney(policy.maxAutoSpendAtomic.toString()).usd,
    sessionBudget:
      policy.sessionBudgetAtomic === 0n
        ? 'no daily ceiling'
        : toMoney(policy.sessionBudgetAtomic.toString()).usd,
  };
}

function lines(
  settingsPath: string,
  hooks: HooksResult,
  permissions: AllowRuleResult,
  spend: RouterDefaultsResult,
  mcp: McpRegistration,
  policy: SpendPolicy,
): string[] {
  const out = [
    hooks.skipped === undefined
      ? `hooks: ${hooks.entries} entries in ${settingsPath}`
      : `hooks: ${settingsPath} was left untouched (${hooks.skipped}); fix it, then re-run: tenjin install`,
    permissions.warning === undefined
      ? `permissions: ${ALLOW_RULE} allowed`
      : `permissions: ${permissions.warning}`,
    mcp.registered
      ? `mcp: ${MCP_SERVER_NAME} registered`
      : `mcp: not registered (${mcp.reason ?? 'unknown'}); run: ${mcp.command}`,
    `spend: at most ${effectiveLimits(policy).maxAutoSpend} USD per call, ${
      policy.sessionBudgetAtomic === 0n
        ? 'no daily ceiling'
        : `${effectiveLimits(policy).sessionBudget} USD a day`
    }` + (spend.kept.length > 0 ? ` (kept your ${spend.kept.join(', ')})` : ''),
    '',
    ...DISCLOSURE,
    '',
    'Fund it with `tenjin wallet fund`, check it with `tenjin status`, undo it with `tenjin uninstall`.',
    'Restart Claude Code to load the hooks.',
  ];
  if (hooks.warning !== undefined) out.push(`! ${hooks.warning}`);
  return out;
}

/**
 * Converge every install on this machine: the user one when it exists, and each
 * recorded project whose settings file still carries our entries. A project
 * that no longer does is forgotten, so the list cannot grow stale.
 *
 * Refusing only when NOTHING was found keeps `tenjin update`'s contract: it
 * reads the child's exit code, and a machine with a project install must not
 * report "nothing is installed here".
 */
async function refreshEveryInstall(
  ctx: CommandContext,
  deps: RouterInstallDeps,
  home: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<CommandResult> {
  // NOT caught. An absent config.json is an empty one and refreshing the user
  // install from it is right, which `loadRawConfig` already encodes by
  // returning {} for ENOENT only. Anything else means the recorded project
  // installs are unreadable, and swallowing it made `tenjin update` refresh the
  // user scope and exit 0 while every project install silently stayed behind.
  const config = await loadRawConfig(ctx.dataDir).catch((cause: unknown) => {
    const recorded = recordedProjectsRaw(ctx.dataDir);
    throw new CliError(
      'CONFIG_INVALID',
      `Could not read ${configPath(ctx.dataDir)}, so ${
        recorded === undefined
          ? 'no project install was refreshed'
          : `these project installs were not refreshed: ${recorded.join(', ')}`
      }.`,
      {
        fix: `Fix or delete ${configPath(ctx.dataDir)}, then re-run: tenjin update`,
        cause,
      },
    );
  });
  const targets: { project: boolean; dir: string }[] = [];
  const skipped: string[] = [];
  const homePath = routerSettingsPath({ homeDir: home });
  const homeProbe = await probeOurEntries(homePath, ctx.dataDir);
  if (homeProbe.state === 'present') targets.push({ project: false, dir: home });
  else if (homeProbe.state === 'unreadable') {
    skipped.push(`skipped ${homePath}: it could not be inspected (${homeProbe.reason})`);
  }
  for (const dir of config.install?.routerProjects ?? []) {
    const path = routerSettingsPath({ project: true, cwd: dir });
    const probe = await probeOurEntries(path, ctx.dataDir);
    if (probe.state === 'present') {
      targets.push({ project: true, dir });
      continue;
    }
    // KEPT, not forgotten. A settings file this run could not inspect says
    // nothing about whether the install is there, and pruning on it is
    // irreversible: repairing the file later would not put the project back.
    // Reported instead, so an operator sees which install went unrefreshed.
    if (probe.state === 'unreadable') {
      skipped.push(
        `skipped ${dir}: its settings file could not be inspected (${probe.reason}) (still recorded)`,
      );
      continue;
    }
    // Forgetting a project keeps the list from growing stale, but it is a
    // change to what the next `tenjin update` covers, so say it out loud, and
    // only once the config write went through: a failed write keeps the entry.
    const why = existsSync(dir)
      ? 'no Tenjin hook entries are registered there'
      : 'the directory is gone';
    const forgotten = await persistRouterProject(ctx.dataDir, dir, false).then(
      () => true,
      () => false,
    );
    skipped.push(`skipped ${dir}: ${why} (${forgotten ? 'forgotten' : 'still recorded'})`);
  }
  // The directory this ran in, when it is a project install nobody recorded: an
  // install from before this list existed still refreshes, and is remembered.
  // Skipped when that path IS the user's file, which is what `cwd` is when
  // `tenjin update` spawns this from the home directory.
  const here = routerSettingsPath({ project: true, cwd });
  if (
    here !== routerSettingsPath({ homeDir: home }) &&
    !targets.some((t) => t.project && t.dir === cwd) &&
    (await probeOurEntries(here, ctx.dataDir)).state === 'present'
  ) {
    targets.push({ project: true, dir: cwd });
    await persistRouterProject(ctx.dataDir, cwd).catch(() => undefined);
  }

  if (targets.length === 0) {
    // "Nothing is registered" and "nothing could be read" are different
    // machines, and only the first of them is fixed by installing again.
    const unreadable = skipped.filter((line) => line.includes('could not be inspected'));
    throw new CliError(
      'REFUSED',
      unreadable.length === 0
        ? `Nothing to refresh for ${ctx.dataDir}: no Tenjin hook entries are registered here.`
        : `Nothing could be refreshed for ${ctx.dataDir}: ${unreadable.join('; ')}.`,
      {
        fix:
          unreadable.length === 0
            ? 'Run `tenjin install` to set this machine up.'
            : 'Fix the settings files named above, then re-run: tenjin update',
      },
    );
  }

  const results: CommandResult[] = [];
  for (const target of targets) {
    results.push(
      await runRouterInstall({ refresh: true, project: target.project }, ctx, {
        ...deps,
        homeDir: home,
        cwd: target.dir,
        env,
      }),
    );
  }
  return {
    data: { refresh: true, installs: results.map((r) => r.data), skipped },
    humanLines: [...results.flatMap((r) => r.humanLines ?? []), ...skipped],
  };
}

/**
 * The recorded project installs, read past whatever made the config unreadable,
 * so the failure can name them. Undefined when even that much is unavailable,
 * which is the honest answer for a file with broken JSON syntax.
 */
function recordedProjectsRaw(dataDir: string): string[] | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(configPath(dataDir), 'utf8'));
    const projects = (parsed as PartialConfig | null)?.install?.routerProjects;
    return Array.isArray(projects) &&
      projects.every((d) => typeof d === 'string') &&
      projects.length > 0
      ? projects
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * THREE ANSWERS, NOT TWO. A settings file that cannot be read or parsed is not
 * a file without our entries, and collapsing the two let `refreshEveryInstall`
 * read a momentarily broken project settings file as confirmed absence and
 * strike the project off `install.routerProjects` for good: repairing the file
 * afterwards did not bring it back, so every later `tenjin update` from HOME
 * silently skipped it.
 */
type EntriesProbe =
  { state: 'present' } | { state: 'absent' } | { state: 'unreadable'; reason: string };

async function probeOurEntries(path: string, dataDir: string): Promise<EntriesProbe> {
  const found = await inspectHooksFile(path);
  if ('refusal' in found) {
    // `unreadable` here is the inspection's own vocabulary for "the file exists
    // and this build could not use it"; a file that is simply not there comes
    // back as an empty, readable inspection rather than a refusal.
    return { state: 'unreadable', reason: found.refusal.reason };
  }
  const present = Object.values(found.hooks).some((list) =>
    list.some((entry) => ownsHookEntry(entry, dataDir)),
  );
  return present ? { state: 'present' } : { state: 'absent' };
}

/** Shared with `uninstall`: the prune this module's writer already performs. */
export { pruneHooks };
