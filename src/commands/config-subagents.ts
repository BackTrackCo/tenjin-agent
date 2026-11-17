import { realpath } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { CliError } from '../lib/errors';
import { parseUsdToAtomic } from '../lib/money';
import { resolveContextSettings } from '../lib/settings';
import type { CommandContext, CommandResult } from '../context';
import { persist } from './config';
import { modelConsentSchema, outdatedModelConsent } from '../router/model-settings';
import { modelGithubRepositories } from '../router/model-repositories';
import { MODEL_MINIMUM_JOB_ATOMIC } from '../router/model-limits';
import { ModelJobStore, type NoOffer } from '../router/model-job';

/** What each no-offer code means, in the words `tenjin config subagents why` prints. */
const NO_OFFER_REASONS: Record<NoOffer['code'], string> = {
  kept_native: 'the parent sent the offered call again unchanged, which keeps it native',
  no_session: 'this Tenjin process had not seen an event of the session yet',
  host_unqualified: 'the host cannot show a worker permission prompt',
  no_consent: 'no DeepSeek consent covers this directory at this router',
  consent_outdated:
    'your DeepSeek consent predates what a worker can read now; read the current terms and renew it with tenjin config subagents on --repository <path> --max-job <USD>',
  permission_mode: 'the session was in plan mode, or its mode was not seen',
  worker_unqualified:
    'Claude Code version, login, managed policy, sandbox or workspace does not qualify here',
  input_filter: 'the call set a field a worker cannot match',
  scope_not_covered: "consent does not cover the session's working directories",
  parent_context_unavailable: "the session's transcript could not be read",
  over_size_limit: "the assignment is over the router's request limit",
  job_cap_too_low: 'the job ceiling is under the minimum a job needs',
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
  return `${new Date(entry.at).toISOString()}  ${entry.tool}  ${code}${size}  ${NO_OFFER_REASONS[entry.code]}`;
}

function retainedRepositories(value: unknown, origin: string): string[] {
  // A consent from before the current disclosure still names the directories to keep.
  const parsed = modelConsentSchema.safeParse(value);
  const prior = parsed.success ? parsed.data : outdatedModelConsent(value);
  if (
    !prior ||
    prior.version !== 2 ||
    prior.routerOrigin !== origin ||
    BigInt(prior.maxJobAtomic) <= 0n
  )
    return [];
  return prior.repositories.flatMap((path) => {
    if (!isAbsolute(path)) return [];
    try {
      return [realpathSync(path)];
    } catch {
      return [];
    }
  });
}

export async function runConfigSubagents(
  mode: string,
  flags: { repository?: string; maxJob?: string },
  ctx: CommandContext,
): Promise<CommandResult> {
  if (mode === 'off') {
    await persist(ctx.dataDir, (c) => ({ ...c, router: { ...c.router, subagents: false } }));
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
  if (mode !== 'on' || !flags.repository || !flags.maxJob)
    throw new CliError('USAGE', 'Use on --repository <path> --max-job <USD>, off, or why.');
  const repository = await realpath(flags.repository);
  const maxJob = BigInt(parseUsdToAtomic(flags.maxJob));
  const settings = await resolveContextSettings(ctx);
  const routerOrigin = new URL(settings.baseUrl).origin;
  if (maxJob < MODEL_MINIMUM_JOB_ATOMIC)
    throw new CliError(
      'USAGE',
      'The job ceiling must be at least $0.044611 for the current minimum Messages reservation and routing fee. Actual input can require more.',
    );
  const disclosure = [
    'Allow Tenjin (using TypeSafe/Jev for routing) to receive subagent assignments and bounded parent context for the named repositories or folder. After acceptance, Tenjin and DeepSeek receive the worker’s applicable native instruction context, accepted assignment and tool results.',
    'Native global, ancestor and repository instructions retain their normal scope; Codex copies its AGENTS hierarchy. A Claude worker may read and write in every named directory, inside its sandbox and your native permissions; your own sessions gain nothing. It may read env files in those directories as a native session can, and Tenjin replaces their values with [env:NAME] before anything reaches Tenjin or DeepSeek; values under 8 characters and bare words or numbers under 16 are sent as written. It loads your global Claude Code configuration as a native subagent does: your personal CLAUDE.md is in its instructions, and it can read the skills, plugins, agents, commands and rules under ~/.claude, every session transcript and memory folder there, your prompt history and your settings files, so what it reads there, other projects’ sessions included, can reach Tenjin and DeepSeek; the values in those settings files’ env blocks are replaced with [env:NAME]. Settings backups, wallet and login files, env files elsewhere and folders you did not name stay unreadable; known secrets are masked, not guaranteed anonymous.',
    'Proxy replies can be replayed for 24 hours, with expired content removed by bounded cleanup. The saved job ceiling controls inference payments; the daily budget, creator allowlist and an explicit automatic-spend stop still apply. Claude’s usual 32K-output request reserves at least $0.041611 at the current peak tariff, plus input beyond framing. Each call needs its full quote available within the remaining job ceiling; the routing fee can add up to $0.003.',
  ].join('\n\n');
  let repositories = [repository];
  let githubRepositories: string[] = [];
  await persist(ctx.dataDir, (c) => {
    // The locked merge keeps other explicitly named roots. Each is a working
    // directory for a Claude worker; native sessions gain no permission.
    repositories = [
      ...new Set([...retainedRepositories(c.router?.subagentConsent, routerOrigin), repository]),
    ];
    githubRepositories = modelGithubRepositories(repositories);
    return {
      ...c,
      router: {
        ...c.router,
        subagents: true,
        subagentConsent: {
          version: 2,
          instructions: 'applicable',
          reads: 'claude-home',
          recipients: ['Tenjin', 'DeepSeek'],
          repositories,
          githubRepositories,
          maxJobAtomic: maxJob.toString(),
          routerOrigin,
        },
      },
    };
  });
  return {
    data: {
      enabled: true,
      repository,
      repositories,
      githubRepositories,
      maxJobAtomic: maxJob.toString(),
      routerOrigin,
      disclosure,
    },
    humanLines: [
      disclosure,
      `Enabled for ${repositories.join(', ')}, at ${routerOrigin}, at most $${flags.maxJob} per job.`,
      'Undo: tenjin config subagents off',
    ],
  };
}
