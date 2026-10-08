import { execFile } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { FileClientChannelStorage } from '@x402/evm/batch-settlement/client/file-storage';
import { loadRawConfig } from '../lib/config';
import { CliError } from '../lib/errors';
import { inspectHooksFile, ownsHookEntry, pruneOurHandlers } from '../lib/harness-hooks';
import { toMoney } from '../lib/money';
import { evaluateSpendPolicy, type SpendPolicy } from '../lib/policy';
import { resolveContextSettings, type ResolvedSettings } from '../lib/settings';
import { spentOf } from '../lib/spend-ledger';
import { readUsdcBalance } from '../lib/usdc-balance';
import { onPath } from '../lib/skill-wiring';
import { describeWallet, resolveWalletProvider, type WalletProvider } from '../lib/wallet';
import { readSpendSummary } from '../lib/wallet/spend';
import { walletFileExists } from '../lib/wallet/store';
import type { CommandContext, CommandResult } from '../context';
import { agentsWithoutRequestTool } from './agent-tools';
import {
  CHANNEL_DEPOSIT_ATOMIC,
  MIN_DEPOSIT_ATOMIC,
  payerDir,
  ROUTING_FEE_ATOMIC,
  unpaid,
  usd,
} from './fee';
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
import { routerSettings, type RouterSettings } from './settings';
import { REQUEST_TOOL } from './names';
import { probeRouter, type RouterCheck } from './reachability';
import { clearRouterMemo, readRouterMemo, type RouterMemo } from './router-memo';
import {
  ACCEPT_COMMAND,
  OWN_LIMITS_COMMANDS,
  shownLimits,
  spendQuestion,
  type RouterLimits,
} from './spend-question';
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

export type { RouterCheck };

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
  now?: () => number;
}

const NODE_FLOOR = 24;

export async function runRouterDoctor(
  ctx: CommandContext,
  deps: RouterDoctorDeps = {},
): Promise<CommandResult> {
  const env = deps.env ?? process.env;
  // From the directory doctor runs in, which is the one a session there would use.
  const router = await routerSettings(
    { cwd: deps.cwd ?? process.cwd(), dataDir: ctx.dataDir },
    deps.homeDir !== undefined ? { homeDir: deps.homeDir } : {},
  ).catch((err: unknown) => (err instanceof Error ? err : new Error(String(err))));
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
  checks.push(await hooksCheck(settingsPath, ctx.dataDir, router));
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
  const rawConfig = await loadRawConfig(ctx.dataDir);
  checks.push(
    spendCheck(
      settings.policy.maxAutoSpendAtomic,
      settings.policy.sessionBudgetAtomic,
      rawConfig.maxAutoSpend === undefined ? { limits: shownLimits(rawConfig) } : null,
    ),
  );
  checks.push(experimentalCheck(settings.experimentalBazaar));
  checks.push(await routingFeeCheck(ctx, settings, deps.fetchImpl));
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

async function hooksCheck(
  path: string,
  dataDir: string,
  router: RouterSettings | Error,
): Promise<RouterCheck> {
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
  // WIRED BUT SWITCHED OFF is a choice, not a fault, so it warns and names the
  // file that made it: the entries are there and every one of them is silent.
  if (router instanceof Error) {
    return {
      name: 'hooks',
      status: 'warn',
      required: false,
      detail: `${events.join(' and ')} registered, but the router is off here: ${router.message}`,
      fix: 'Fix or delete that file.',
    };
  }
  if (!router.enabled.value) {
    const file = router.enabled.path ?? 'the config';
    return {
      name: 'hooks',
      status: 'warn',
      required: false,
      detail: `${events.join(' and ')} registered, but router.enabled is false in ${file}, so nothing is routed from this directory`,
      fix:
        router.enabled.source === 'file'
          ? 'Run `tenjin config set router.enabled true` to route again.'
          : `Remove router.enabled from ${file} to route here again.`,
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
  // one-command remedy, not a failure: its `tenjin hook` command entries take
  // the free path only, and the entries it lacks are offers it does not make.
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

/** One entry as `event matcher → what it runs`, the way doctor names it. */
function entryLabel(event: string, matcher: unknown, handler: unknown): string {
  const h = (handler ?? {}) as Record<string, unknown>;
  const runs =
    h.type === 'mcp_tool'
      ? `${String(h.server)} ${String(h.tool)} ${String((h.input as { kind?: unknown } | undefined)?.kind)}`
      : typeof h.command === 'string'
        ? h.command
        : typeof h.url === 'string'
          ? h.url
          : '?';
  return `${event}${typeof matcher === 'string' ? ` ${matcher}` : ''} → ${runs}`;
}

/**
 * Which of `routerHookPlan()`'s entries this file lacks, and which handlers of
 * ours it carries that the plan no longer writes (an older install's
 * `tenjin hook prompt` command, or a shelf-era entry). Compared by event,
 * matcher and what the handler runs, so a timeout the writer would raise is not
 * called drift here.
 */
function planDrift(
  hooks: Record<string, unknown[]>,
  dataDir: string,
): { missing: string[]; stale: string[] } {
  const planned = (routerHookPlan() as PlannedEntry[]).map((entry) =>
    entryLabel(entry.event, entry.matcher, entry.hooks[0]),
  );
  const present: string[] = [];
  for (const [event, list] of Object.entries(hooks)) {
    for (const entry of list) {
      if (!ownsHookEntry(entry, dataDir)) continue;
      const { matcher, hooks: handlers } = entry as { matcher?: unknown; hooks: unknown[] };
      // Ours only: a handler someone hand-merged beside ours is not drift.
      const kept = pruneOurHandlers(entry, dataDir) as { hooks: unknown[] } | null;
      for (const handler of handlers.filter((h) => kept === null || !kept.hooks.includes(h))) {
        present.push(entryLabel(event, matcher, handler));
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
  hooks: unknown[];
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
  const u = why === null ? null : unpaid(why);
  if (why === null || u === null) {
    return {
      name: 'routing fee',
      status: 'ok',
      required: false,
      detail: `$${usd(ROUTING_FEE_ATOMIC)} a call, paid from channel deposits of up to $${usd(CHANNEL_DEPOSIT_ATOMIC)} that count against the spend limits`,
    };
  }
  const fixes: Record<string, string> = {
    no_wallet: 'Run `tenjin wallet create`, then `tenjin wallet fund 0.25`.',
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
  if (provider === null) return 'no_wallet';
  const verified = await provider.verify?.().catch(() => null);
  if (verified !== undefined && verified !== null && verified.status !== 'verified') {
    return 'wallet_locked';
  }
  const { address } = await describeWallet(provider);
  if ((await channelCredit(input.dataDir, address)) >= ROUTING_FEE_ATOMIC) return null;
  const deposit =
    policy.maxAutoSpendAtomic < CHANNEL_DEPOSIT_ATOMIC
      ? policy.maxAutoSpendAtomic
      : CHANNEL_DEPOSIT_ATOMIC;
  if (deposit < MIN_DEPOSIT_ATOMIC) return 'limit_below_deposit';
  const ledger = await readSpendSummary(input.dataDir);
  const evaluation = evaluateSpendPolicy(policy, {
    mode: 'automatic',
    amountAtomic: deposit,
    creator: input.host,
    sessionSpentAtomic: ledger === null ? 0n : spentOf(ledger),
  });
  if (evaluation.reason === 'not_allowlisted') return 'not_allowlisted';
  if (evaluation.reason === 'session_budget_exceeded') return 'budget_reached';
  const balance = await readUsdcBalance(address, input.rpcUrl, {
    timeoutMs: input.timeoutMs,
    ...(input.fetchImpl !== undefined ? { fetchImpl: input.fetchImpl } : {}),
  });
  return balance !== null && balance < deposit ? 'wallet_low' : null;
}

/** What the wallet's routing channel still holds for fees, from the SDK's own files. */
async function channelCredit(dataDir: string, address: string): Promise<bigint> {
  const dir = payerDir(dataDir, address);
  const storage = new FileClientChannelStorage({ directory: dir });
  let best = 0n;
  for (const name of await readdir(join(dir, 'client')).catch(() => [] as string[])) {
    const id = /^(0x[0-9a-f]{64})\.json$/.exec(name)?.[1];
    const channel = id === undefined ? undefined : await storage.get(id).catch(() => undefined);
    if (channel === undefined) continue;
    const credit = BigInt(channel.balance ?? '0') - BigInt(channel.chargedCumulativeAmount ?? '0');
    if (credit > best) best = credit;
  }
  return best;
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
      fix: `Answer the spend question: for a yes, run \`${ACCEPT_COMMAND}\`; for other amounts, ${OWN_LIMITS_COMMANDS}; or run \`tenjin install\` in a terminal to choose.`,
    };
  }
  if (maxAutoSpendAtomic === 0n) {
    return {
      name: 'spend',
      status: 'fail',
      required: true,
      detail: 'maxAutoSpend is 0, so every lookup needs approval and none can pay',
      fix: 'Run `tenjin install` in a terminal to approve the limits, or `tenjin config set maxAutoSpend 0.10`.',
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
