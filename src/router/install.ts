import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';
import { claudeAdapter } from '../adapters/claude';
import { persistRouterDefaults } from '../commands/config';
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
import { paint } from '../lib/output';
import { resolveContextSettings } from '../lib/settings';
import type { SpendPolicy } from '../lib/policy';
import { onPath } from '../lib/skill-wiring';
import type { WalletDeps, WalletOutcome } from '../commands/install-wallet';
import type { CommandContext, CommandResult } from '../context';
import { ensureStatusLine, type StatusLineMode, type StatusLineResult } from './status-line-wiring';

/**
 * `tenjin install` for the router product: three hook entries, one MCP server,
 * one permission rule, the spend defaults, and a wallet when there is none.
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

/** The subagent tool, under its current name and its older one. */
export const DELEGATION_MATCHER = 'Agent|Task';

/** The three entries, spelled once so `uninstall` and the tests read the same list. */
export function routerHookPlan(): unknown[] {
  const handler = (command: string) => [
    { type: 'command', command, timeout: HOOK_TIMEOUT_SECONDS },
  ];
  return [
    { event: 'UserPromptSubmit', hooks: handler('tenjin hook prompt') },
    { event: 'PreToolUse', matcher: 'WebSearch|WebFetch', hooks: handler('tenjin hook native') },
    { event: 'PreToolUse', matcher: DELEGATION_MATCHER, hooks: handler('tenjin hook agent') },
  ];
}

export const DISCLOSURE: readonly string[] = [
  'What leaves this machine: the bounded text of each prompt, each native search query or URL, and each task handed to a subagent, sent to Tenjin for the free routing gate.',
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
  /**
   * What to do about Claude Code's `statusLine`. Absent is the default path:
   * write ours when the key is free, and print the composition line when it is
   * not. `compose` wraps the status line already there and appends ours;
   * `skip` leaves the key alone entirely.
   */
  statusLine?: StatusLineMode;
  /** Create no wallet, for CI and scripted machines. */
  noWallet?: boolean;
}

export interface RouterInstallDeps extends WalletDeps {
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
   * something else was removed and re-added, which only `uninstall` does now),
   * `unrepaired` (a registration this run KNOWS is wrong or unreadable and will
   * not touch) or `unavailable` (it is simply not there and this machine could
   * not add it, e.g. no `claude` on PATH). A refresh fails on `unrepaired`,
   * because reporting convergence over a registration that launches something
   * else is the thing to avoid; it still only prints the manual command for
   * `unavailable`.
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
  // ONE SCOPE, THE ONE THIS RAN IN. `--refresh` converges the install whose
  // settings file is here: home by default, this project under `--project`.
  // The fan-out across recorded projects is gone with the list it read, along
  // with a failure mode where one project's broken JSON decided what every
  // other install got. `tenjin update` is a binary swap plus this, nothing more.
  // With no flag, a refresh converges the install that is actually HERE: the
  // project file when this directory carries our entries, the home file
  // otherwise. `--project` and its absence are still explicit targets, so
  // nothing silently moves an install from one scope to the other.
  const project =
    args.project ??
    (args.refresh === true &&
      (await probeOurEntries(routerSettingsPath({ project: true, cwd }), ctx.dataDir)).state ===
        'present');
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
  const statusLine = await ensureStatusLine(settingsPath, {
    ...(args.statusLine !== undefined ? { mode: args.statusLine } : {}),
    ...(args.refresh === true ? { refreshOnly: true } : {}),
  });
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
      data: {
        settingsPath,
        hooks,
        permissions,
        statusLine,
        mcp,
        refresh: true,
        scope: mcpScope(project),
      },
      humanLines: refreshLines(ctx, problems(ctx, hooks, permissions, statusLine, mcp)),
    };
  }
  const spend = await persistRouterDefaults(ctx.dataDir);
  // The shelf install's wallet step, unchanged except that it never asks: a
  // lookup cannot be paid without a wallet, so install makes one. A failure is
  // reported, never fatal; everything above is useful without it.
  const { resolveWallet } = await import('../commands/install-wallet');
  const wallet = await resolveWallet(ctx, deps, args.noWallet === true ? 'flag' : undefined, false);
  // Read back AFTER the write: a machine that already carried its own caps
  // keeps them, and a readout quoting the defaults would describe limits this
  // run did not set.
  const effective = await resolveContextSettings(ctx);

  const data = {
    settingsPath,
    hooks,
    permissions,
    statusLine,
    spend: { ...spend, effective: effectiveLimits(effective.policy) },
    mcp,
    wallet,
    disclosure: DISCLOSURE,
  };
  return {
    data,
    humanLines: lines(ctx, {
      project,
      hooks,
      permissions,
      statusLine,
      mcp,
      wallet,
      policy: effective.policy,
    }),
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
 * `tenjin mcp` is the goal state and nothing is spawned, and a file that cannot
 * be read is refused out loud rather than written over.
 *
 * AN `x402` ENTRY THAT LAUNCHES SOMETHING ELSE IS SOMEBODY ELSE'S. This command
 * will not delete it. It may be another tool of the user's that happens to
 * share the name, and an installer that removes a registration nobody asked it
 * to touch has destroyed configuration to make its own output look tidy. The
 * conflict is reported with the exact two commands to run, and the user decides.
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
  // REFUSED, NOT REPLACED. Nothing of the user's is removed to make room.
  if (existing.state === 'wrong-command') {
    return {
      ...base,
      registered: false,
      reconciled: 'unrepaired',
      command: `${mcpRemoveCommand(project)} && ${command}`,
      reason: `an MCP server named ${MCP_SERVER_NAME} is already registered at ${scope} scope and launches something else. This command will not remove a registration it did not write; run the two commands above if that entry is stale`,
    };
  }
  const which = deps.which ?? ((bin: string) => onPath(bin, env));
  if (!which('claude')) {
    return {
      ...base,
      registered: false,
      reconciled: 'unavailable',
      reason: 'the `claude` binary is not on PATH',
    };
  }
  try {
    await (deps.registerMcp ?? runClaudeMcpAdd)(command, { scope, cwd });
    return { ...base, registered: true, reconciled: 'added' };
  } catch (err) {
    return {
      ...base,
      registered: false,
      reconciled: 'unavailable',
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

/** Only the status-line state that needs the user: one this install would not
 *  touch, with the command that adds the footer beside it. */
export function statusLineProblems(ctx: CommandContext, result: StatusLineResult): string[] {
  const warn = (text: string) => paint(ctx.io, 'yellow', `! ${text}`);
  if (result.warning !== undefined) {
    return [warn(`The live status line was not registered (${result.warning})`)];
  }
  if (result.state !== 'foreign') return [];
  return [
    warn('You already have a status line, so it was left exactly as it is.'),
    '  To show the live x402 footer beside it, run:',
    '  tenjin install --status-line compose',
    ...(result.compose === undefined
      ? []
      : ['  or set this command yourself:', `  ${result.compose}`]),
  ];
}

/**
 * A few lines a first-time user can read at a glance: it worked, here is your
 * wallet, here is the one thing to do next. The file paths, entry counts and
 * data-handling detail stay in `--json` and the docs; the terminal only grows
 * a line when something needs the user.
 */
function lines(
  ctx: CommandContext,
  s: {
    project: boolean;
    hooks: HooksResult;
    permissions: AllowRuleResult;
    statusLine: StatusLineResult;
    mcp: McpRegistration;
    wallet: WalletOutcome;
    policy: SpendPolicy;
  },
): string[] {
  const ok = paint(ctx.io, 'green', '✓');
  const limits = effectiveLimits(s.policy);
  const daily =
    s.policy.sessionBudgetAtomic === 0n ? 'no daily limit' : `$${limits.sessionBudget} a day`;
  // The first line only says "set up" when it is: a settings file this run
  // would not write to means nothing was set up, and hooks without the MCP
  // server point at a `request` tool that is not there.
  const blocked = s.hooks.skipped !== undefined;
  const needsMcp = !blocked && !s.mcp.registered;
  const where = s.project ? ' in this project' : '';
  const fund = paint(ctx.io, 'bold', 'tenjin wallet fund');
  return [
    blocked
      ? paint(ctx.io, 'yellow', `! Tenjin could not finish setting up Claude Code${where}`)
      : needsMcp
        ? paint(ctx.io, 'yellow', '! Almost done: Claude Code needs one command')
        : `${ok} Tenjin is set up for Claude Code${where}`,
    ...walletLines(ctx, ok, s.wallet),
    `  Spends at most $${limits.maxAutoSpend} a lookup, ${daily}`,
    ...(s.statusLine.state === 'ours' || s.statusLine.state === 'composed'
      ? ['  Live status line on: each lookup names its provider while it runs']
      : []),
    ...problems(ctx, s.hooks, s.permissions, s.statusLine, s.mcp),
    '',
    blocked
      ? 'Next: fix the file above, then run tenjin install again'
      : needsMcp
        ? s.wallet.status === 'created'
          ? `Next: run the command above and ${fund}, then restart Claude Code`
          : 'Next: run the command above, then restart Claude Code'
        : s.wallet.status === 'created'
          ? `Next: ${fund}, then restart Claude Code`
          : 'Next: restart Claude Code',
  ];
}

/** "Up to date" only when nothing below it needs the user. */
function refreshLines(ctx: CommandContext, issues: string[]): string[] {
  if (issues.length === 0) return [`${paint(ctx.io, 'green', '✓')} Tenjin is up to date`];
  return [paint(ctx.io, 'yellow', '! Tenjin is updated, but needs one fix'), ...issues];
}

function walletLines(ctx: CommandContext, ok: string, w: WalletOutcome): string[] {
  if (w.status === 'created') return [`${ok} Wallet created: ${w.address}`];
  if (w.status === 'existing') return [`${ok} Wallet: ${w.address}`];
  if (w.reason === 'flag') return ['  No wallet yet. Create one with: tenjin wallet create'];
  return [
    paint(ctx.io, 'yellow', `! No wallet was created. ${w.warning ?? ''}`.trimEnd()),
    `  ${w.fix ?? 'Create one with: tenjin wallet create'}`,
  ];
}

/** Only what needs the user, each with the command that fixes it. */
function problems(
  ctx: CommandContext,
  hooks: HooksResult,
  permissions: AllowRuleResult,
  statusLine: StatusLineResult,
  mcp: McpRegistration,
): string[] {
  const warn = (text: string) => paint(ctx.io, 'yellow', `! ${text}`);
  const out: string[] = [];
  // The hooks and the permission rule share one settings file, so a file this
  // run would not touch is reported once, not once per writer.
  if (hooks.skipped !== undefined) {
    out.push(
      warn(
        hooks.warning ??
          `${hooks.path ?? 'Your Claude Code settings file'} was left untouched (${hooks.skipped}).`,
      ),
    );
  } else {
    if (hooks.warning !== undefined) out.push(warn(hooks.warning));
    if (permissions.warning !== undefined) out.push(warn(permissions.warning));
  }
  if (!mcp.registered) {
    // The reason stays in --json: raw exec output is noise here, the fix is not.
    out.push(warn('Could not add the request tool to Claude Code. Run:'));
    out.push(`  ${mcp.command}`);
  }
  out.push(...statusLineProblems(ctx, statusLine));
  return out;
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
