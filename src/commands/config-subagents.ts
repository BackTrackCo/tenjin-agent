import { realpath } from 'node:fs/promises';
import { CliError } from '../lib/errors';
import { formatUsdDisplay, parseUsdToAtomic } from '../lib/money';
import { resolveContextSettings } from '../lib/settings';
import type { CommandContext, CommandResult } from '../context';
import { persist } from './config';
import { modelConsent, modelConsentSchema, namedDirectories } from '../router/model-settings';
import { loadRawConfig } from '../lib/config';
import {
  MODEL_MINIMUM_CALL_ATOMIC,
  MODEL_OUTPUT_TOKENS,
  usdOfAtomic,
} from '../router/model-limits';
import { ModelJobStore, type NoOffer } from '../router/model-job';
import { validateWindowsWorkerConfig } from '../router/windows-worker-config';
import {
  ON_HINT,
  SUBAGENT_TERMS,
  SUBAGENTS_OFF_LINE,
  scopeShown,
  subagentsOnLines,
  type SubagentsShown,
} from '../router/subagents-shown';

export type SubagentConfigFlags = {
  /** One directory or several: the limited scope. */
  repository?: string | string[];
  maxJob?: string;
  windowsWorkerSid?: string;
  windowsLauncher?: string;
  windowsClaude?: string;
  windowsConfigDir?: string;
  acceptWindowsShellAccess?: boolean;
};

const usd = (atomic: bigint) => `$${formatUsdDisplay(atomic.toString())}`;

const NATIVE_WINDOWS_DISCLOSURE =
  'The Windows DeepSeek worker runs under the dedicated standard account with Claude’s native permissions and without its shell sandbox. Shell tools can reach files and networks available to that Windows account. Tenjin and DeepSeek can receive instructions and tool results from those resources. Exa can receive search queries and public page addresses. Use a separate shared Claude profile and keep wallet, login and spend data under the controller account.';

/**
 * Why a call got no offer, in plain words. The code and its detail stay in `--json`; a
 * field of the call or of an agent's definition is named, since the person can change it.
 */
function whyReason(entry: NoOffer): string {
  const detail = entry.detail ?? '';
  switch (entry.code) {
    case 'kept_native':
      return 'Claude sent the offered call again unchanged, which keeps it native';
    case 'no_session':
      return 'Tenjin had not seen an event of this session yet';
    case 'host_unqualified':
      return 'This Claude Code cannot show a worker’s permission prompt';
    case 'no_consent':
      return 'DeepSeek subagents were off, or the session was outside their scope';
    case 'permission_mode':
      return detail === 'plan'
        ? 'The session was in plan mode'
        : 'The session’s permission mode was not seen, or a worker cannot run in it';
    case 'worker_unqualified':
      return 'The Claude Code version, login, managed policy, sandbox or workspace does not qualify here';
    case 'input_filter':
      if (detail === 'prompt') return 'The call had no prompt';
      if (detail === 'subagent_type') return 'A worker cannot run as that agent type';
      if (detail === 'definition:model') return 'The agent pins its own model';
      if (detail.startsWith('definition:'))
        return `The agent’s definition sets \`${detail.slice('definition:'.length)}\`, which a worker cannot match`;
      if (detail === 'frontmatter') return 'The agent’s definition could not be read exactly';
      return detail
        ? `The call set \`${detail}\`, which a worker cannot match`
        : 'The call set a field a worker cannot match';
    case 'caller_unqualified':
      return detail === 'tools'
        ? 'The subagent that made the call has no tool to accept an offer'
        : detail === 'mode'
          ? 'The subagent that made the call, or an agent above it, may set its own permission mode'
          : 'The subagent that made the call works in a folder of its own';
    case 'scope_not_covered':
      return 'The session’s working directory or workspace changed after the call was held, or could not be read';
    case 'parent_context_unavailable':
      return 'The session’s transcript could not be read';
    case 'over_size_limit':
      return entry.bytes === undefined
        ? 'The assignment is over the router’s size limit'
        : `The assignment is over the router’s size limit (${entry.bytes.toLocaleString('en-US')} of ${entry.limit?.toLocaleString('en-US') ?? '?'} bytes)`;
    case 'job_cap_too_low':
      return `The job cap leaves no room for the routing fee above one model call (${usdOfAtomic(MODEL_MINIMUM_CALL_ATOMIC)}); raise the per-call limit with \`tenjin config set maxAutoSpend <usd>\`, or, if you named a lower job ceiling, that ceiling with \`tenjin config subagents on --max-job <usd>\``;
    case 'job_cap_lowered':
      return 'The job cap was lowered after the call was held; send the call again for an offer at the new cap';
    case 'capture_error':
      return 'A local error before routing';
    case 'route_error':
      return 'The routing request failed, or a spend limit refused its fee';
    case 'fee_above_ceiling':
      return /^\d+$/.test(detail)
        ? `The router stated a routing fee of ${usdOfAtomic(BigInt(detail))} for this offer, more than Tenjin pays for one routing call or the job cap leaves room for; nothing was paid`
        : 'The router stated a routing fee above what Tenjin pays for one routing call or the job cap leaves room for; nothing was paid';
    case 'server_declined':
      return 'The router judged that the work stays native';
    case 'invalid_offer':
      return 'The router’s answer was not a valid offer';
    case 'superseded':
      return 'The call was cancelled while it was routed';
    case 'expired':
      return 'The offer was not accepted within 15 minutes';
    case 'interrupted':
      return 'The session closed or was interrupted while routing';
  }
}
const WHY_SHOWN = 20;
const WHY_TIME = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

/** `Nov 18 12:45`, in this machine's own time zone. */
function whyTime(at: number): string {
  const part = Object.fromEntries(
    WHY_TIME.formatToParts(new Date(at)).map(({ type, value }) => [type, value]),
  );
  return `${part.month} ${part.day} ${part.hour}:${part.minute}`;
}

function whyLines(entries: readonly NoOffer[]): string[] {
  // A native subagent's own call, at any depth, is judged as the main loop's is.
  const tool = (entry: NoOffer) =>
    entry.from === 'subagent' ? `${entry.tool} from a subagent` : entry.tool;
  const width = Math.max(...entries.map((entry) => tool(entry).length));
  return entries.map(
    (entry) => `  ${whyTime(entry.at)}  ${tool(entry).padEnd(width)}  ${whyReason(entry)}`,
  );
}

/** Read only: whether DeepSeek subagents are on, their scope and the cap in force. */
async function status(ctx: CommandContext): Promise<CommandResult> {
  const config = await loadRawConfig(ctx.dataDir);
  const consent = modelConsentSchema.safeParse(config.router?.subagentConsent);
  if (config.router?.subagents !== true)
    return {
      data: { enabled: false },
      humanLines: ['○ DeepSeek subagents are off', '', ON_HINT],
    };
  if (!consent.success)
    return {
      data: { enabled: true, consent: false },
      humanLines: [
        '○ DeepSeek subagents are on, but no valid consent is saved, so no job is offered',
        '',
        'Run `tenjin config subagents on` to save it.',
      ],
    };
  const directories = namedDirectories(consent.data);
  const settings = await resolveContextSettings(ctx);
  const perCall = settings.policy.maxAutoSpendAtomic;
  const named =
    consent.data.maxJobAtomic === undefined ? undefined : BigInt(consent.data.maxJobAtomic);
  const cap = named !== undefined && named < perCall ? named : perCall;
  return {
    data: {
      enabled: true,
      scope: directories ? 'directories' : 'every-workspace',
      ...(directories ? { repositories: directories } : {}),
      ...(named === undefined ? {} : { maxJobAtomic: named.toString() }),
      jobCapAtomic: cap.toString(),
      perCallLimitAtomic: perCall.toString(),
      routerOrigin: consent.data.routerOrigin,
    },
    humanLines: subagentsOnLines(ctx, {
      directories,
      perCall,
      ...(named === undefined ? {} : { named }),
      daily: settings.policy.sessionBudgetAtomic !== null,
      routerOrigin: consent.data.routerOrigin,
    }),
  };
}

export async function runConfigSubagents(
  mode: string | undefined,
  flags: SubagentConfigFlags,
  ctx: CommandContext,
): Promise<CommandResult> {
  const configuringWindows =
    flags.windowsWorkerSid !== undefined ||
    flags.windowsLauncher !== undefined ||
    flags.windowsClaude !== undefined ||
    flags.windowsConfigDir !== undefined ||
    flags.acceptWindowsShellAccess === true;
  if (mode === undefined || mode === 'status') {
    if (configuringWindows || flags.repository !== undefined || flags.maxJob !== undefined)
      throw new CliError('USAGE', 'Flags go with on. Use on, off, why, or no mode for the status.');
    return status(ctx);
  }
  if (configuringWindows && (mode !== 'on' || process.platform !== 'win32'))
    throw new CliError(
      'USAGE',
      'The Windows worker flags require native Windows and subagents on.',
    );
  if (mode === 'off') {
    await persist(ctx.dataDir, (c) => {
      const router = { ...c.router, subagents: false };
      delete router.windowsWorker;
      return { ...c, router };
    });
    return {
      data: { enabled: false },
      humanLines: [SUBAGENTS_OFF_LINE],
    };
  }
  if (mode === 'why') {
    // Read only: the codes the CLI kept on this machine, newest first. Nothing is sent.
    const noOffers = (await new ModelJobStore(ctx.dataDir).noOffers()).reverse();
    return {
      data: { noOffers },
      humanLines: noOffers.length
        ? [
            'Subagent calls with no DeepSeek offer · last 7 days, this machine only',
            '',
            ...whyLines(noOffers.slice(0, WHY_SHOWN)),
          ]
        : [
            'No subagent call went without an offer in the last 7 days. Calls are recorded only while DeepSeek subagents are on.',
          ],
    };
  }
  if (mode !== 'on')
    throw new CliError(
      'USAGE',
      'Use on [--repository <path>...] [--max-job <USD>], off, why, or no mode for the status.',
    );
  // THE SCOPE IS THE COMMAND'S OWN WORD. No `--repository`: every session's workspace.
  // With it: only the named directories. Neither is ever kept or widened in silence.
  const chosen = await Promise.all([flags.repository ?? []].flat().map((path) => realpath(path)));
  const repository = chosen[0];
  const settings = await resolveContextSettings(ctx);
  const routerOrigin = new URL(settings.baseUrl).origin;
  // A JOB IS ONE CALL to the person, so its cap is their per-call spend limit, read at
  // each offer. `--max-job` names a lower ceiling and never lifts the cap above the limit.
  const perCall = settings.policy.maxAutoSpendAtomic;
  const named = flags.maxJob === undefined ? undefined : BigInt(parseUsdToAtomic(flags.maxJob));
  if (named !== undefined && named <= MODEL_MINIMUM_CALL_ATOMIC)
    throw new CliError(
      'USAGE',
      `The job ceiling must be above ${usdOfAtomic(MODEL_MINIMUM_CALL_ATOMIC)}, the current minimum Messages reservation, with the routing fee on top. Actual input can require more.`,
    );
  if (perCall <= MODEL_MINIMUM_CALL_ATOMIC)
    throw new CliError(
      'USAGE',
      `Your per-call spend limit, ${usd(perCall)}, is not above ${usdOfAtomic(MODEL_MINIMUM_CALL_ATOMIC)}, the least one model call reserves, so no job would be offered. Nothing was changed.`,
      {
        fix: 'Raise the limit with `tenjin config set maxAutoSpend <usd>`, then run this command again.',
      },
    );
  const cap = named !== undefined && named < perCall ? named : perCall;
  if (configuringWindows && repository === undefined)
    throw new CliError(
      'USAGE',
      'On native Windows the worker runs only under the limited scope: it has no shell sandbox and works as an account that was given the directories you name. A bare on would cover every workspace, which Windows does not allow.',
      { fix: 'Add --repository <path> for each directory the worker account may work in.' },
    );
  if (configuringWindows && !flags.acceptWindowsShellAccess)
    throw new CliError('USAGE', NATIVE_WINDOWS_DISCLOSURE, {
      fix: 'Review the Windows disclosure and add --accept-windows-shell-access if you agree.',
    });
  const windowsWorker = configuringWindows
    ? await validateWindowsWorkerConfig(
        {
          version: 1,
          workerSid: flags.windowsWorkerSid,
          launcherPath: flags.windowsLauncher,
          claudePath: flags.windowsClaude,
          configDir: flags.windowsConfigDir,
          routerOrigin,
          shellAccess: 'native-windows',
        },
        ctx.dataDir,
      )
    : null;
  if (configuringWindows && !windowsWorker)
    throw new CliError('USAGE', 'The Windows worker setup is incomplete or unavailable.', {
      fix: 'Supply a dedicated account SID, readable local launcher and Claude .exe paths, and a separate shared Claude config directory.',
    });
  const limited = chosen.length > 0;
  const disclosure = [
    `Allow Tenjin (using TypeSafe/Jev for routing) to receive subagent assignments and bounded parent context ${
      limited
        ? 'from sessions inside the directories you name, and from no other session'
        : 'from every session whose subagent calls it routes, in any directory'
    }. After acceptance, Tenjin and DeepSeek receive the worker’s applicable native instruction context, accepted assignment and tool results, and Exa receives the worker’s web search queries and the address of a public page its WebFetch could not fetch. Your Tenjin block and only rules apply to those Exa calls as they do to what Tenjin picks on its own.`,
    windowsWorker
      ? NATIVE_WINDOWS_DISCLOSURE
      : `Native global, ancestor and repository instructions retain their normal scope; Codex copies its AGENTS hierarchy. ${
          limited
            ? 'A Claude worker may read and write in every named directory, subfolders included'
            : 'A Claude worker may read and write in its session’s own workspace'
        }, inside its sandbox and your native permissions; your own sessions gain nothing. It may read env files in those directories as a native session can; env files are not masked, and what it reads can reach Tenjin and DeepSeek. Claude Code loads your global configuration into the worker as it does for a native subagent: your personal CLAUDE.md and the skills, plugins, agents, commands and rules under ~/.claude are among its instructions, and the worker’s file tools and commands do not read those files. Of ~/.claude they read every session transcript and memory folder, your prompt history and your settings files, so what the worker loads or reads there, other projects’ sessions included, can reach Tenjin and DeepSeek. Settings backups, wallet and login files and folders outside the worker’s directories stay unreadable; what a worker reads or prints, secrets and credential command output included, is not masked and can reach Tenjin and DeepSeek as written, and the routing context sent before an offer is masked for known secrets, not guaranteed anonymous.`,
    `Proxy replies can be replayed for 24 hours, with expired content removed by bounded cleanup. A job costs up to your per-call spend limit as it stands at each offer, or a lower ceiling you name with --max-job; the daily budget and creator allowlist still apply. A worker request, with its ${MODEL_OUTPUT_TOKENS.toLocaleString('en-US')}-token output cap, reserves at least ${usdOfAtomic(MODEL_MINIMUM_CALL_ATOMIC)} at the current peak tariff, plus input beyond framing. Each call needs its full quote available within the remaining job ceiling; the routing fee, 15% of the expected cost of a job, comes on top of that. A worker’s web searches are paid Tenjin tool calls to Exa search, $0.004 each with no routing fee, and a page its WebFetch could not fetch is read through Exa for $0.001; each is paid from your wallet within your per-call limit and daily budget and counted against the job ceiling.`,
  ].join('\n\n');
  let repositories: string[] | null = null;
  // The scope this turn-on replaced, where it narrowed or widened one: said on the scope row.
  let was: SubagentsShown['was'];
  // The cap the saved consent held at this router, which this turn-on may have changed.
  let wasCap: bigint | undefined;
  await persist(ctx.dataDir, (c) => {
    const prior = modelConsentSchema.safeParse(c.router?.subagentConsent);
    const here = prior.success && prior.data.routerOrigin === routerOrigin;
    // The directories named earlier at this router, which another `--repository` keeps.
    const before = namedDirectories(c.router?.subagentConsent, routerOrigin);
    if (here) {
      const earlier = prior.data.maxJobAtomic;
      wasCap = earlier !== undefined && BigInt(earlier) < perCall ? BigInt(earlier) : perCall;
    }
    repositories = limited ? [...new Set([...(before ?? []), ...chosen])] : null;
    was = !here
      ? undefined
      : limited && !before
        ? 'every-workspace'
        : !limited && before
          ? before
          : undefined;
    const consent = modelConsent({
      routerOrigin,
      ...(repositories ? { repositories } : {}),
      ...(named === undefined ? {} : { maxJobAtomic: named.toString() }),
    });
    const router = { ...c.router, subagents: true, subagentConsent: consent };
    if (windowsWorker) router.windowsWorker = windowsWorker;
    else delete router.windowsWorker;
    return { ...c, router };
  });
  const shown: SubagentsShown = {
    directories: repositories,
    ...(was === undefined ? {} : { was }),
    ...(wasCap === undefined ? {} : { wasCap }),
    perCall,
    ...(named === undefined ? {} : { named }),
    daily: settings.policy.sessionBudgetAtomic !== null,
    routerOrigin,
  };
  const humanLines = subagentsOnLines(ctx, shown, {
    terms: true,
    notes: windowsWorker
      ? [
          'On Windows the worker has no shell sandbox: it runs as the dedicated account, with the access Windows gives that account.',
        ]
      : process.platform === 'win32'
        ? [
            'Claude on Windows uses native subagents until you opt in with a dedicated Windows worker account.',
          ]
        : [],
  });
  return {
    data: {
      enabled: true,
      scope: repositories ? 'directories' : 'every-workspace',
      ...(repository === undefined ? {} : { repository }),
      ...(repositories ? { repositories } : {}),
      ...(named === undefined ? {} : { maxJobAtomic: named.toString() }),
      jobCapAtomic: cap.toString(),
      perCallLimitAtomic: perCall.toString(),
      routerOrigin,
      // The full terms. The human output prints the short form and links to the guide.
      disclosure,
      terms: SUBAGENT_TERMS.join('\n'),
      // The scope row as printed, with a narrowed or widened scope said.
      readback: `Scope: ${scopeShown(shown)}`,
      ...(windowsWorker ? { windowsWorker: { enabled: true } } : {}),
    },
    humanLines,
  };
}
