import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { promisify } from 'node:util';
import { CliError } from '../lib/errors';
import { inspectHooksFile, ownsHookEntry, pruneOurHandlers } from '../lib/harness-hooks';
import { httpRequest } from '../lib/http';
import { toMoney } from '../lib/money';
import { PRODUCTION_ORIGIN } from '../lib/production-origin';
import { resolveContextSettings } from '../lib/settings';
import { onPath } from '../lib/skill-wiring';
import { describeWallet, resolveWalletProvider } from '../lib/wallet';
import { walletFileExists } from '../lib/wallet/store';
import type { CommandContext, CommandResult } from '../context';
import { agentsWithoutRequestTool } from './agent-tools';
import { ROUTER_PATH } from './decision';
import {
  ALLOW_RULE,
  MCP_SERVER_NAME,
  mcpAddCommand,
  mcpScope,
  readMcpEntry,
  routerHookPlan,
  routerSettingsPath,
  type McpEntryState,
} from './install';
import { REQUEST_TOOL } from './names';
import { inspectStatusLine, STATUS_LINE_COMMAND } from './status-line-wiring';

/**
 * `tenjin doctor` for the router product: the six things that decide whether a
 * lookup can happen at all.
 *
 * THE SHELF'S DOCTOR IS NOT THIS ONE. It checks a loop daemon, a skills tree
 * and a marketplace contract, and prescribes `tenjin daemon start`, a command
 * this release does not register: on a router install every one of those lines
 * was a failure about a product that is not installed. That doctor stays with
 * the product it belongs to (`src/commands/doctor.ts`, unregistered), and this
 * one reports the router's own wiring.
 */

const exec = promisify(execFile);

export interface RouterCheck {
  name: string;
  status: 'ok' | 'warn' | 'fail';
  required: boolean;
  detail: string;
  fix?: string;
}

export interface RouterDoctorDeps {
  homeDir?: string;
  cwd?: string;
  /** Look at this project's `.claude/settings.json`, as `--project` installed it. */
  project?: boolean;
  env?: NodeJS.ProcessEnv;
  which?: (bin: string) => boolean;
  fetchImpl?: typeof fetch;
  /** The harness's own read-back, for a user-scope registration this build
   *  cannot find on disk; tests inject it so nothing is spawned. */
  readMcp?: (opts: { scope: 'user' | 'project'; cwd: string }) => Promise<boolean>;
  /** Reads the registration entry from the file the scope writes. */
  readMcpEntry?: (
    scope: 'user' | 'project',
    cwd: string,
    home: string,
  ) => Promise<{ found: boolean; state: McpEntryState }>;
  /** Node's own version, for the floor check. */
  nodeVersion?: string;
}

const NODE_FLOOR = 24;

export async function runRouterDoctor(
  ctx: CommandContext,
  deps: RouterDoctorDeps = {},
): Promise<CommandResult> {
  const env = deps.env ?? process.env;
  const settings = await resolveContextSettings(ctx);
  // The SAME resolution `install` and `uninstall` use. Reading the home file
  // only made a correctly wired `--project` install, which the README tells
  // people to do, fail a required check and exit 3.
  const settingsPath = routerSettingsPath({
    ...(deps.project === true ? { project: true } : {}),
    ...(deps.homeDir !== undefined ? { homeDir: deps.homeDir } : {}),
    ...(deps.cwd !== undefined ? { cwd: deps.cwd } : {}),
  });
  const checks: RouterCheck[] = [nodeCheck(deps.nodeVersion ?? process.version)];
  checks.push(await hooksCheck(settingsPath, ctx.dataDir));
  checks.push(await statusLineCheck(settingsPath));
  checks.push(
    await mcpCheck(
      deps,
      env,
      deps.project === true,
      deps.cwd ?? process.cwd(),
      deps.homeDir ?? homedir(),
    ),
  );
  checks.push(spendCheck(settings.policy.maxAutoSpendAtomic, settings.policy.sessionBudgetAtomic));
  checks.push(...(await walletCheck(ctx)));
  checks.push(await routerCheck(settings.baseUrl, ctx.flags.timeout, deps.fetchImpl));
  const agents = await subagentsCheck(deps.cwd ?? process.cwd(), deps.homeDir ?? homedir());
  if (agents !== null) checks.push(agents);

  const failure = checks.find((c) => c.status === 'fail' && c.required);
  const data = { checks, dataDir: ctx.dataDir, baseUrl: settings.baseUrl, settingsPath };
  if (failure !== undefined) {
    // REFUSED, the exit-3 class: a machine this command found unready is
    // understood and refused, not a runtime failure of the command itself.
    throw new CliError('REFUSED', failure.detail, {
      ...(failure.fix !== undefined ? { fix: failure.fix } : {}),
      details: data,
    });
  }
  const bad = checks.filter((c) => c.status !== 'ok').length;
  return {
    data,
    humanLines: [
      ...checks.map(
        (c) =>
          `${c.status === 'ok' ? 'ok  ' : c.status === 'warn' ? 'warn' : 'fail'}  ${c.name}: ${c.detail}`,
      ),
      bad === 0
        ? `${checks.length} checks, all pass.`
        : `${checks.length} checks, ${bad} to look at.`,
    ],
  };
}

/**
 * INFORMATIONAL, NEVER A FAILURE. A custom agent whose `tools:` leave the
 * request tool out is a choice its author may have meant, so this names those
 * agents and the one line that would change it, and counts as passing. It is
 * absent when there is nothing to name. The files are only read.
 */
async function subagentsCheck(cwd: string, homeDir: string): Promise<RouterCheck | null> {
  const excluded = await agentsWithoutRequestTool({ cwd, homeDir });
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

/**
 * The live footer, which is the one check here that is never required: a lookup
 * runs exactly the same without it. It reports what is in the file, including a
 * status line of the user's that this CLI deliberately did not touch.
 */
async function statusLineCheck(path: string): Promise<RouterCheck> {
  const found = await inspectStatusLine(path);
  const name = 'status line';
  if (found.warning !== undefined) {
    return { name, status: 'warn', required: false, detail: found.warning };
  }
  switch (found.state) {
    case 'ours':
      return { name, status: 'ok', required: false, detail: `\`${STATUS_LINE_COMMAND}\`` };
    case 'composed':
      return {
        name,
        status: 'ok',
        required: false,
        detail: 'yours, with the x402 footer appended',
      };
    case 'foreign':
      return {
        name,
        status: 'warn',
        required: false,
        detail: 'yours is registered and was left alone, so there is no live x402 footer',
        fix: 'Run `tenjin install --status-line compose` to show both.',
      };
    default:
      return {
        name,
        status: 'warn',
        required: false,
        detail: 'not registered, so lookups run without the live footer',
        fix: 'Run `tenjin install` to register it.',
      };
  }
}

async function hooksCheck(path: string, dataDir: string): Promise<RouterCheck> {
  const found = await inspectHooksFile(path);
  if ('refusal' in found) {
    return {
      name: 'hooks',
      status: 'fail',
      required: true,
      detail: found.refusal.message,
      fix: 'Fix the reported file, then run `tenjin install`.',
    };
  }
  const events = Object.entries(found.hooks)
    .filter(([, list]) => list.some((entry) => ownsHookEntry(entry, dataDir)))
    .map(([event]) => event);
  const allow = allowRules(found.settings);
  if (events.length === 0) {
    return {
      name: 'hooks',
      status: 'fail',
      required: true,
      detail: `no Tenjin hook entries in ${path}`,
      fix: 'Run `tenjin install`, then restart Claude Code.',
    };
  }
  if (!allow.includes(ALLOW_RULE)) {
    return {
      name: 'hooks',
      status: 'warn',
      required: false,
      detail: `${events.join(' and ')} registered, but ${ALLOW_RULE} is not allowed, so every lookup asks`,
      fix: 'Run `tenjin install` to write the permission rule.',
    };
  }
  // AN INSTALL FROM AN OLDER BUILD STILL WORKS, so this is a warning with its
  // one-command remedy, not a failure: its `tenjin hook native` entry is a
  // no-op now, and the entries it lacks are offers it does not make.
  const drift = planDrift(found.hooks, dataDir);
  if (drift.missing.length > 0 || drift.stale.length > 0) {
    const parts = [
      ...(drift.missing.length > 0 ? [`missing ${drift.missing.join(', ')}`] : []),
      ...(drift.stale.length > 0 ? [`stale ${drift.stale.join(', ')}`] : []),
    ];
    return {
      name: 'hooks',
      status: 'warn',
      required: false,
      detail: `${events.join(' and ')} registered, but not as this build writes them: ${parts.join('; ')}`,
      fix: 'Run `tenjin install --refresh`.',
    };
  }
  return {
    name: 'hooks',
    status: 'ok',
    required: true,
    detail: `${events.join(' and ')} registered, ${ALLOW_RULE} allowed`,
  };
}

/** One entry as `event matcher → command`, the way doctor names it. */
function entryLabel(event: string, matcher: unknown, command: string): string {
  return `${event}${typeof matcher === 'string' ? ` ${matcher}` : ''} → ${command}`;
}

/**
 * Which of `routerHookPlan()`'s entries this file lacks, and which handlers of
 * ours it carries that the plan no longer writes (an older install's
 * `tenjin hook native`, or a shelf-era entry). Compared by event, matcher and
 * command, so a timeout the writer would raise is not called drift here.
 */
function planDrift(
  hooks: Record<string, unknown[]>,
  dataDir: string,
): { missing: string[]; stale: string[] } {
  const planned = (routerHookPlan() as PlannedEntry[]).map((entry) =>
    entryLabel(entry.event, entry.matcher, entry.hooks[0]!.command),
  );
  const present: string[] = [];
  for (const [event, list] of Object.entries(hooks)) {
    for (const entry of list) {
      if (!ownsHookEntry(entry, dataDir)) continue;
      const { matcher, hooks: handlers } = entry as { matcher?: unknown; hooks: unknown[] };
      // Ours only: a handler someone hand-merged beside ours is not drift.
      const kept = pruneOurHandlers(entry, dataDir) as { hooks: unknown[] } | null;
      for (const handler of handlers.filter((h) => kept === null || !kept.hooks.includes(h))) {
        const command = (handler as { command?: unknown }).command;
        const url = (handler as { url?: unknown }).url;
        const label = typeof command === 'string' ? command : typeof url === 'string' ? url : '?';
        present.push(entryLabel(event, matcher, label));
      }
    }
  }
  return {
    missing: planned.filter((label) => !present.includes(label)),
    stale: present.filter((label) => !planned.includes(label)),
  };
}

interface PlannedEntry {
  event: string;
  matcher?: string;
  hooks: { command: string }[];
}

function allowRules(settings: Record<string, unknown>): string[] {
  const permissions = settings.permissions;
  if (permissions === null || typeof permissions !== 'object' || Array.isArray(permissions)) {
    return [];
  }
  const allow = (permissions as { allow?: unknown }).allow;
  return Array.isArray(allow) ? allow.filter((r): r is string => typeof r === 'string') : [];
}

async function mcpCheck(
  deps: RouterDoctorDeps,
  env: NodeJS.ProcessEnv,
  project: boolean,
  cwd: string,
  home: string,
): Promise<RouterCheck> {
  const scope = mcpScope(project);
  const add = mcpAddCommand(project);
  const where = scope === 'project' ? "this project's .mcp.json" : '~/.claude.json';
  const { found, state } = await (deps.readMcpEntry ?? readMcpEntry)(scope, cwd, home);

  if (state === 'ok') {
    return {
      name: 'mcp',
      status: 'ok',
      required: true,
      detail: `${MCP_SERVER_NAME} registered (${scope} scope), running \`tenjin mcp\``,
    };
  }
  if (state === 'wrong-command') {
    return {
      name: 'mcp',
      status: 'fail',
      required: true,
      detail: `${MCP_SERVER_NAME} registered but not \`tenjin mcp\`: the entry in ${where} launches something else, so the request tool is not there`,
      fix: `Remove it and re-run \`tenjin install\`${project ? ' --project' : ''}, or: ${add}`,
    };
  }
  // A file that is there and unreadable is not an absence: "run install" would
  // be the wrong instruction, since `install` refuses to write over it too.
  if (state === 'unreadable') {
    return {
      name: 'mcp',
      status: 'fail',
      required: true,
      detail: `${where} could not be read, so whether ${MCP_SERVER_NAME} is registered is unknown`,
      fix: `Fix the JSON in ${where}, then re-run \`tenjin install\`${project ? ' --project' : ''}.`,
    };
  }
  // Absent. On USER scope the file may simply not be where this build looks,
  // so the harness's own answer is worth asking before calling it missing.
  if (scope === 'user') {
    const which = deps.which ?? ((bin: string) => onPath(bin, env));
    if (which('claude')) {
      const seen = await (deps.readMcp ?? claudeHasServer)({ scope, cwd }).catch(() => false);
      if (seen) {
        return {
          name: 'mcp',
          status: 'warn',
          required: false,
          detail: `${MCP_SERVER_NAME} is registered somewhere this check cannot read, so what it launches was not verified`,
          fix: `Re-run \`tenjin install\` to write a registration this build can check, or: ${add}`,
        };
      }
    }
  }
  return {
    name: 'mcp',
    status: 'fail',
    required: true,
    detail: found
      ? `${MCP_SERVER_NAME} is not in ${where}, so there is no request tool`
      : `${where} does not exist, so ${MCP_SERVER_NAME} is not registered`,
    fix: `Run \`tenjin install\`${project ? ' --project' : ''}, or: ${add}`,
  };
}

/** The harness's own answer, for a user-scope registration this build cannot
 *  find on disk. It resolves across scopes, which is why it is a last resort
 *  and only ever downgrades the verdict to a warn. */
async function claudeHasServer(opts: { scope: 'user' | 'project'; cwd: string }): Promise<boolean> {
  const { stdout } = await exec('claude', ['mcp', 'get', MCP_SERVER_NAME], {
    timeout: 15_000,
    cwd: opts.cwd,
  });
  return stdout.includes(MCP_SERVER_NAME) && !/no mcp server/i.test(stdout);
}

function spendCheck(maxAutoSpendAtomic: bigint, sessionBudgetAtomic: bigint): RouterCheck {
  if (maxAutoSpendAtomic === 0n) {
    return {
      name: 'spend',
      status: 'fail',
      required: true,
      detail: 'maxAutoSpend is 0, so every lookup needs approval and none can pay',
      fix: 'Run `tenjin install`, or `tenjin config set maxAutoSpend 0.10`.',
    };
  }
  const budget =
    sessionBudgetAtomic === 0n
      ? 'no daily ceiling'
      : `${toMoney(sessionBudgetAtomic.toString()).usd} USD a day`;
  return {
    name: 'spend',
    status: sessionBudgetAtomic === 0n ? 'warn' : 'ok',
    required: false,
    detail: `at most ${toMoney(maxAutoSpendAtomic.toString()).usd} USD a call, ${budget}`,
    ...(sessionBudgetAtomic === 0n
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
        fix: 'Run `tenjin wallet create`, then `tenjin wallet fund`.',
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

/**
 * One cheap request to the free decision route with an empty body. It checks
 * the route is reachable and enabled, not that it routes: a 400 is the route
 * refusing that body, and a 404 is the route switched off. Nothing is signed
 * and no Jev request is spent.
 */
async function routerCheck(
  baseUrl: string,
  timeoutMs: number,
  fetchImpl: typeof fetch | undefined,
): Promise<RouterCheck> {
  const url = new URL(ROUTER_PATH, baseUrl).toString();
  const probe = await httpRequest(url, {
    method: 'POST',
    timeoutMs,
    blockRedirects: true,
    jsonBody: {},
    ...(fetchImpl !== undefined ? { fetchImpl } : {}),
  });
  const fail = (detail: string, fix: string): RouterCheck => ({
    name: 'router',
    status: 'fail',
    required: true,
    detail,
    fix,
  });
  const checkBase =
    'Check that the configured base URL names the Tenjin router (`tenjin config get baseUrl`), then try again later.';
  if (!probe.ok) {
    return fail(`the router at ${url} is unreachable or erroring (${probe.message})`, checkBase);
  }
  // 429 is the route's own rate limit: proof the router is there.
  if (probe.status === 200 || probe.status === 400 || probe.status === 429) {
    return { name: 'router', status: 'ok', required: true, detail: `${url} is live` };
  }
  if (probe.status === 404) {
    return fail(`the router is not enabled at ${url}`, checkBase);
  }
  if (probe.status === 401 || probe.status === 403) {
    return fail(
      `${url} is not a Tenjin router (it asked for credentials)`,
      `Set the router URL with \`tenjin config set baseUrl ${PRODUCTION_ORIGIN}\`.`,
    );
  }
  if (probe.status >= 500) {
    return fail(`the router at ${url} is unreachable or erroring (${probe.status})`, checkBase);
  }
  return fail(
    `${url} answered ${probe.status}, which a Tenjin router does not`,
    'Check that the configured base URL names a Tenjin deployment (`tenjin config get baseUrl`).',
  );
}
