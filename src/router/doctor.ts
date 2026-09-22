import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { CliError } from '../lib/errors';
import { inspectHooksFile, ownsHookEntry } from '../lib/harness-hooks';
import { httpRequest } from '../lib/http';
import { toMoney } from '../lib/money';
import { resolveContextSettings } from '../lib/settings';
import { onPath } from '../lib/skill-wiring';
import { describeWallet, resolveWalletProvider } from '../lib/wallet';
import { walletFileExists } from '../lib/wallet/store';
import type { CommandContext, CommandResult } from '../context';
import { ROUTER_PATH } from './decision';
import {
  ALLOW_RULE,
  MCP_SERVER_NAME,
  mcpAddCommand,
  mcpScope,
  routerSettingsPath,
} from './install';

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
  /** Reads back the MCP registration; tests inject it so nothing is spawned. */
  readMcp?: (opts: { scope: 'user' | 'project'; cwd: string }) => Promise<boolean>;
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
  checks.push(await mcpCheck(deps, env, deps.project === true, deps.cwd ?? process.cwd()));
  checks.push(spendCheck(settings.policy.maxAutoSpendAtomic, settings.policy.sessionBudgetAtomic));
  checks.push(...(await walletCheck(ctx)));
  checks.push(await routerCheck(settings.baseUrl, ctx.flags.timeout, deps.fetchImpl));

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
  return {
    name: 'hooks',
    status: 'ok',
    required: true,
    detail: `${events.join(' and ')} registered, ${ALLOW_RULE} allowed`,
  };
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
): Promise<RouterCheck> {
  // Read back in the SAME scope the install wrote, or a project install reads
  // as unregistered and a user one as registered when neither is true.
  const scope = mcpScope(project);
  const add = mcpAddCommand(project);
  const which = deps.which ?? ((bin: string) => onPath(bin, env));
  if (!which('claude')) {
    return {
      name: 'mcp',
      status: 'warn',
      required: false,
      detail: 'the `claude` binary is not on PATH, so the registration cannot be read back',
      fix: `Register it yourself: ${add}`,
    };
  }
  const registered = await (deps.readMcp ?? claudeHasServer)({ scope, cwd }).catch(() => false);
  return registered
    ? {
        name: 'mcp',
        status: 'ok',
        required: true,
        detail: `${MCP_SERVER_NAME} registered (${scope} scope)`,
      }
    : {
        name: 'mcp',
        status: 'fail',
        required: true,
        detail:
          scope === 'project'
            ? `${MCP_SERVER_NAME} is not in this project's .mcp.json, so there is no request tool here`
            : `${MCP_SERVER_NAME} is not registered at user scope, so there is no request tool`,
        fix: `Run \`tenjin install\`, or: ${add}`,
      };
}

/**
 * Is the server registered AT THIS SCOPE?
 *
 * `claude mcp get` resolves across scopes, so run inside a project it answers
 * yes for a server inherited from the user's own file. Asked about a project
 * install that is what "registered" would have meant: the project's `.mcp.json`
 * could be missing entirely and doctor would pass, hiding exactly the half-done
 * install it exists to find. Project scope is therefore read from the file that
 * scope writes, which needs no subprocess and cannot inherit; user scope keeps
 * the read-back, where inheritance is not a question.
 */
async function claudeHasServer(opts: { scope: 'user' | 'project'; cwd: string }): Promise<boolean> {
  if (opts.scope === 'project') {
    const raw = await readFile(join(opts.cwd, '.mcp.json'), 'utf8').catch(() => null);
    if (raw === null) return false;
    try {
      const parsed: unknown = JSON.parse(raw);
      const servers = (parsed as { mcpServers?: unknown } | null)?.mcpServers;
      return (
        servers !== null &&
        typeof servers === 'object' &&
        Object.hasOwn(servers as object, MCP_SERVER_NAME)
      );
    } catch {
      return false;
    }
  }
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
 * The router endpoint's own 402, which is free and rate-limited: a 402 proves
 * the route is deployed and turned on, and anything else names what a lookup
 * would hit. Nothing is signed and no Jev request is spent.
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
  if (!probe.ok) {
    return {
      name: 'router',
      status: 'fail',
      required: true,
      detail: `${url} is unreachable (${probe.message})`,
      fix: 'Check your connection, and that the configured base URL names a Tenjin deployment (`tenjin config get baseUrl`).',
    };
  }
  if (probe.status === 402) {
    return { name: 'router', status: 'ok', required: true, detail: `${url} answers 402` };
  }
  return {
    name: 'router',
    status: 'fail',
    required: true,
    detail: `${url} answered ${probe.status}; paid routing looks turned off there`,
    fix: 'Nothing local fixes this: paid routing is off at that deployment. Try again later.',
  };
}
