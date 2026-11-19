import { realpath } from 'node:fs/promises';
import { CliError } from '../lib/errors';
import { formatUsdDisplay, parseUsdToAtomic } from '../lib/money';
import { resolveContextSettings } from '../lib/settings';
import type { CommandContext, CommandResult } from '../context';
import { persist } from './config';
import { modelConsent } from '../router/model-settings';
import {
  MODEL_MINIMUM_CALL_ATOMIC,
  MODEL_MINIMUM_JOB_ATOMIC,
  MODEL_OUTPUT_TOKENS,
  usdOfAtomic,
} from '../router/model-limits';
import { ModelJobStore, type NoOffer } from '../router/model-job';
import { validateWindowsWorkerConfig } from '../router/windows-worker-config';

export type SubagentConfigFlags = {
  repository?: string;
  maxJob?: string;
  windowsWorkerSid?: string;
  windowsLauncher?: string;
  windowsClaude?: string;
  windowsConfigDir?: string;
  acceptWindowsShellAccess?: boolean;
};

const NATIVE_WINDOWS_DISCLOSURE =
  'The Windows DeepSeek worker runs under the dedicated standard account with Claude’s native permissions and without its shell sandbox. Shell tools can reach files and networks available to that Windows account. Tenjin and DeepSeek can receive instructions and tool results from those resources. Exa can receive search queries and public page addresses. Use a separate shared Claude profile and keep wallet, login and spend data under the controller account.';

/** What each no-offer code means, in the words `tenjin config subagents why` prints. */
const NO_OFFER_REASONS: Record<NoOffer['code'], string> = {
  kept_native: 'the parent sent the offered call again unchanged, which keeps it native',
  no_session: 'this Tenjin process had not seen an event of the session yet',
  host_unqualified: 'the host cannot show a worker permission prompt',
  no_consent: 'subagent routing is off, or no DeepSeek consent is saved for this router',
  permission_mode: 'the session was in plan mode, or its mode was not seen',
  worker_unqualified:
    'Claude Code version, login, managed policy, sandbox or workspace does not qualify here',
  input_filter: 'the call set a field a worker cannot match',
  caller_unqualified:
    'the subagent that made the call cannot accept an offer (tools), or it or an agent above it may set its own permission mode (mode), or it works in a folder of its own (folder)',
  scope_not_covered:
    "the session's working directory or its workspace changed after the call was held, or the workspace could not be read",
  parent_context_unavailable: "the session's transcript could not be read",
  over_size_limit: "the assignment is over the router's request limit",
  job_cap_too_low:
    'the job cap (your per-call spend limit, or a lower ceiling you named) is under what one model call and its routing fee need; raise the limit with tenjin config set maxAutoSpend <usd>',
  job_cap_lowered:
    'the job cap (your per-call spend limit, or a lower ceiling you named) was lowered after the call was held, under the cap it was held at; send the call again for an offer at the cap as it stands',
  capture_error: 'a local error before routing',
  route_error: 'the routing request failed, or a spend limit refused its fee',
  server_declined: 'the router judged that the work stays native',
  invalid_offer: "the router's answer was not a valid offer",
  superseded: 'the call was cancelled while it was routed',
  expired: 'the offer was not accepted within 15 minutes',
  interrupted: 'the session closed or was interrupted while routing',
};
const WHY_SHOWN = 20;

function whyLine(entry: NoOffer): string {
  const size = entry.bytes === undefined ? '' : ` (${entry.bytes} of ${entry.limit ?? '?'} bytes)`;
  const code = entry.detail === undefined ? entry.code : `${entry.code}:${entry.detail}`;
  // A native subagent's own call, at any depth, is judged as the main loop's is.
  const tool = entry.from === 'subagent' ? `${entry.tool} from a subagent` : entry.tool;
  return `${new Date(entry.at).toISOString()}  ${tool}  ${code}${size}  ${NO_OFFER_REASONS[entry.code]}`;
}

export async function runConfigSubagents(
  mode: string,
  flags: SubagentConfigFlags,
  ctx: CommandContext,
): Promise<CommandResult> {
  const configuringWindows =
    flags.windowsWorkerSid !== undefined ||
    flags.windowsLauncher !== undefined ||
    flags.windowsClaude !== undefined ||
    flags.windowsConfigDir !== undefined ||
    flags.acceptWindowsShellAccess === true;
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
      humanLines: ['Subagent model routing is off. No new DeepSeek jobs may start.'],
    };
  }
  if (mode === 'why') {
    // Read only: the codes the CLI kept on this machine, newest first. Nothing is sent.
    const noOffers = (await new ModelJobStore(ctx.dataDir).noOffers()).reverse();
    return {
      data: { noOffers },
      humanLines: noOffers.length
        ? [
            'Subagent calls that got no DeepSeek offer, newest first (kept 7 days, on this machine only):',
            ...noOffers.slice(0, WHY_SHOWN).map(whyLine),
          ]
        : [
            'No subagent call without an offer is on record. A call is recorded only while subagent routing is on.',
          ],
    };
  }
  if (mode !== 'on')
    throw new CliError('USAGE', 'Use on [--repository <path>] [--max-job <USD>], off, or why.');
  // `--repository` is an addition: without it the consent covers each session's own workspace.
  const repository = flags.repository === undefined ? undefined : await realpath(flags.repository);
  const settings = await resolveContextSettings(ctx);
  const routerOrigin = new URL(settings.baseUrl).origin;
  // A JOB IS ONE CALL to the person, so its cap is their per-call spend limit, read at
  // each offer. `--max-job` names a lower ceiling and never lifts the cap above the limit.
  const perCall = settings.policy.maxAutoSpendAtomic;
  const named = flags.maxJob === undefined ? undefined : BigInt(parseUsdToAtomic(flags.maxJob));
  if (named !== undefined && named < MODEL_MINIMUM_JOB_ATOMIC)
    throw new CliError(
      'USAGE',
      `The job ceiling must be at least ${usdOfAtomic(MODEL_MINIMUM_JOB_ATOMIC)} for the current minimum Messages reservation and routing fee. Actual input can require more.`,
    );
  const usd = (atomic: bigint) => `$${formatUsdDisplay(atomic.toString())}`;
  if (perCall < MODEL_MINIMUM_JOB_ATOMIC)
    throw new CliError(
      'USAGE',
      `Your per-call spend limit, ${usd(perCall)}, is under the ${usdOfAtomic(MODEL_MINIMUM_JOB_ATOMIC)} that one model call and its routing fee need, so no job would be offered. Nothing was changed.`,
      {
        fix: 'Raise the limit with `tenjin config set maxAutoSpend <usd>`, then run this command again.',
      },
    );
  const cap = named !== undefined && named < perCall ? named : perCall;
  if (configuringWindows && repository === undefined)
    throw new CliError(
      'USAGE',
      'The Windows worker flags require --repository <path>: the worker account works only for sessions inside a directory you name.',
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
  const disclosure = [
    'Allow Tenjin (using TypeSafe/Jev for routing) to receive subagent assignments and bounded parent context from every session whose subagent calls it routes. After acceptance, Tenjin and DeepSeek receive the worker’s applicable native instruction context, accepted assignment and tool results, and Exa receives the worker’s web search queries and the address of a public page its WebFetch could not fetch. Your Tenjin block and only rules apply to those Exa calls as they do to what Tenjin picks on its own.',
    windowsWorker
      ? NATIVE_WINDOWS_DISCLOSURE
      : 'Native global, ancestor and repository instructions retain their normal scope; Codex copies its AGENTS hierarchy. A Claude worker may read and write in its session’s own workspace, inside its sandbox and your native permissions; your own sessions gain nothing. A directory you name with --repository is an addition: a session inside a named directory gives its worker every named directory to read and write too. It may read env files in those directories as a native session can, and Tenjin replaces their values with [env:NAME] before anything reaches Tenjin or DeepSeek; values under 8 characters and bare words or numbers under 16 are sent as written. Claude Code loads your global configuration into the worker as it does for a native subagent: your personal CLAUDE.md and the skills, plugins, agents, commands and rules under ~/.claude are among its instructions, and the worker’s file tools and commands do not read those files. Of ~/.claude they read every session transcript and memory folder, your prompt history and your settings files, so what the worker loads or reads there, other projects’ sessions included, can reach Tenjin and DeepSeek; the values in those settings files’ env blocks are replaced with [env:NAME]. Settings backups, wallet and login files, env files elsewhere and folders outside the worker’s directories stay unreadable; known secrets are masked, not guaranteed anonymous.',
    `Proxy replies can be replayed for 24 hours, with expired content removed by bounded cleanup. A job costs up to your per-call spend limit as it stands at each offer, or a lower ceiling you name with --max-job; the daily budget and creator allowlist still apply. A worker request, with its ${MODEL_OUTPUT_TOKENS.toLocaleString('en-US')}-token output cap, reserves at least ${usdOfAtomic(MODEL_MINIMUM_CALL_ATOMIC)} at the current peak tariff, plus input beyond framing. Each call needs its full quote available within the remaining job ceiling; the routing fee can add up to $0.003. A worker’s web searches are paid Tenjin tool calls to Exa search, $0.004 each with no routing fee, and a page its WebFetch could not fetch is read through Exa for $0.001; each is paid from your wallet within your per-call limit and daily budget and counted against the job ceiling.`,
  ].join('\n\n');
  let repositories: string[] = [];
  await persist(ctx.dataDir, (c) => {
    // The locked merge keeps the directories named earlier at this router.
    const consent = modelConsent({
      routerOrigin,
      prior: c.router?.subagentConsent,
      ...(repository === undefined ? {} : { repository }),
      ...(named === undefined ? {} : { maxJobAtomic: named.toString() }),
    });
    repositories = consent.repositories ?? [];
    const router = { ...c.router, subagents: true, subagentConsent: consent };
    if (windowsWorker) router.windowsWorker = windowsWorker;
    else delete router.windowsWorker;
    return { ...c, router };
  });
  return {
    data: {
      enabled: true,
      ...(repository === undefined ? {} : { repository }),
      repositories,
      ...(named === undefined ? {} : { maxJobAtomic: named.toString() }),
      jobCapAtomic: cap.toString(),
      perCallLimitAtomic: perCall.toString(),
      routerOrigin,
      disclosure,
      ...(windowsWorker ? { windowsWorker: { enabled: true } } : {}),
    },
    humanLines: [
      disclosure,
      `Enabled at ${routerOrigin}, for the workspace of each session.${
        repositories.length ? ` Named directories: ${repositories.join(', ')}.` : ''
      } ${
        named === undefined
          ? `Each job costs up to your per-call spend limit, ${usd(perCall)} now.`
          : named < perCall
            ? `Each job costs at most ${usd(named)}, the ceiling you named, under your per-call spend limit of ${usd(perCall)}.`
            : `Each job costs at most ${usd(perCall)}, your per-call spend limit: the ${usd(named)} ceiling you named does not lift it.`
      }`,
      ...(process.platform === 'win32' && !windowsWorker
        ? [
            'Claude on Windows uses native subagents until you opt in with a dedicated Windows worker account.',
          ]
        : []),
      'Undo: tenjin config subagents off',
    ],
  };
}
