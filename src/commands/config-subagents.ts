import { realpath } from 'node:fs/promises';
import { CliError } from '../lib/errors';
import { formatUsdDisplay, parseUsdToAtomic } from '../lib/money';
import { resolveContextSettings } from '../lib/settings';
import type { CommandContext, CommandResult } from '../context';
import { persist } from './config';
import {
  modelConsent,
  modelConsentSchema,
  namedDirectories,
  perCallLimitAtomic,
} from '../router/model-settings';
import { loadRawConfig } from '../lib/config';
import {
  MODEL_MINIMUM_CALL_ATOMIC,
  MODEL_MINIMUM_JOB_ATOMIC,
  MODEL_OUTPUT_TOKENS,
  usdOfAtomic,
} from '../router/model-limits';
import { ModelJobStore, type NoOffer } from '../router/model-job';
import { validateWindowsWorkerConfig } from '../router/windows-worker-config';

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

/**
 * THE SCOPE IN PLAIN WORDS, the same in the status readback and after each `on`: every
 * workspace, or only the listed directories. A listed directory includes its subfolders.
 */
function scopeLine(directories: readonly string[] | null): string {
  return directories
    ? `Scope: only these directories, each with its subfolders: ${directories.join(', ')}. A session outside them gets no offer.`
    : 'Scope: every workspace. A session in any directory can be offered DeepSeek, and its worker gets that session’s own workspace.';
}
const usd = (atomic: bigint) => `$${formatUsdDisplay(atomic.toString())}`;

/** Read only: whether routing is on, its scope and the cap in force. */
async function status(ctx: CommandContext): Promise<CommandResult> {
  const config = await loadRawConfig(ctx.dataDir);
  const consent = modelConsentSchema.safeParse(config.router?.subagentConsent);
  if (config.router?.subagents !== true)
    return {
      data: { enabled: false },
      humanLines: [
        'DeepSeek subagent routing is off. Turn it on with `tenjin config subagents on`.',
      ],
    };
  if (!consent.success)
    return {
      data: { enabled: true, consent: false },
      humanLines: [
        'DeepSeek subagent routing is on, but no valid consent is saved, so no job is offered. Run `tenjin config subagents on`.',
      ],
    };
  const directories = namedDirectories(consent.data);
  const perCall = perCallLimitAtomic(config);
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
    humanLines: [
      `DeepSeek subagent routing is on at ${consent.data.routerOrigin}.`,
      scopeLine(directories),
      named !== undefined && named < perCall
        ? `Each job costs at most ${usd(named)}, the ceiling you named, under your per-call spend limit of ${usd(perCall)}.`
        : `Each job costs up to your per-call spend limit, ${usd(perCall)} now.`,
    ],
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
  if (named !== undefined && named < MODEL_MINIMUM_JOB_ATOMIC)
    throw new CliError(
      'USAGE',
      `The job ceiling must be at least ${usdOfAtomic(MODEL_MINIMUM_JOB_ATOMIC)} for the current minimum Messages reservation and routing fee. Actual input can require more.`,
    );
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
        }, inside its sandbox and your native permissions; your own sessions gain nothing. It may read env files in those directories as a native session can, and Tenjin replaces their values with [env:NAME] before anything reaches Tenjin or DeepSeek; values under 8 characters and bare words or numbers under 16 are sent as written. Claude Code loads your global configuration into the worker as it does for a native subagent: your personal CLAUDE.md and the skills, plugins, agents, commands and rules under ~/.claude are among its instructions, and the worker’s file tools and commands do not read those files. Of ~/.claude they read every session transcript and memory folder, your prompt history and your settings files, so what the worker loads or reads there, other projects’ sessions included, can reach Tenjin and DeepSeek; the values in those settings files’ env blocks are replaced with [env:NAME]. Settings backups, wallet and login files, env files elsewhere and folders outside the worker’s directories stay unreadable; known secrets are masked, not guaranteed anonymous.`,
    `Proxy replies can be replayed for 24 hours, with expired content removed by bounded cleanup. A job costs up to your per-call spend limit as it stands at each offer, or a lower ceiling you name with --max-job; the daily budget and creator allowlist still apply. A worker request, with its ${MODEL_OUTPUT_TOKENS.toLocaleString('en-US')}-token output cap, reserves at least ${usdOfAtomic(MODEL_MINIMUM_CALL_ATOMIC)} at the current peak tariff, plus input beyond framing. Each call needs its full quote available within the remaining job ceiling; the routing fee can add up to $0.003. A worker’s web searches are paid Tenjin tool calls to Exa search, $0.004 each with no routing fee, and a page its WebFetch could not fetch is read through Exa for $0.001; each is paid from your wallet within your per-call limit and daily budget and counted against the job ceiling.`,
  ].join('\n\n');
  let repositories: string[] | null = null;
  // What this turn-on did to the scope the saved consent had, said in its readback.
  let change = '';
  await persist(ctx.dataDir, (c) => {
    const prior = modelConsentSchema.safeParse(c.router?.subagentConsent);
    const here = prior.success && prior.data.routerOrigin === routerOrigin;
    // The directories named earlier at this router, which another `--repository` keeps.
    const before = namedDirectories(c.router?.subagentConsent, routerOrigin);
    repositories = limited ? [...new Set([...(before ?? []), ...chosen])] : null;
    change = !here
      ? ''
      : limited && !before
        ? ' This narrows a consent that covered every workspace.'
        : !limited && before
          ? ` This widens a consent that was limited to: ${before.join(', ')}. Those directories are no longer named.`
          : '';
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
  const scope = scopeLine(repositories) + change;
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
      disclosure,
      readback: scope,
      ...(windowsWorker ? { windowsWorker: { enabled: true } } : {}),
    },
    humanLines: [
      disclosure,
      `Enabled at ${routerOrigin}. ${scope}`,
      named === undefined
        ? `Each job costs up to your per-call spend limit, ${usd(perCall)} now.`
        : named < perCall
          ? `Each job costs at most ${usd(named)}, the ceiling you named, under your per-call spend limit of ${usd(perCall)}.`
          : `Each job costs at most ${usd(perCall)}, your per-call spend limit: the ${usd(named)} ceiling you named does not lift it.`,
      ...(process.platform === 'win32' && !windowsWorker
        ? [
            'Claude on Windows uses native subagents until you opt in with a dedicated Windows worker account.',
          ]
        : []),
      'Undo: tenjin config subagents off',
    ],
  };
}
