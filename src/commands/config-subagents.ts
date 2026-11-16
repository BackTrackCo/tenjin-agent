import { realpath } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { CliError } from '../lib/errors';
import { parseUsdToAtomic } from '../lib/money';
import { resolveContextSettings } from '../lib/settings';
import type { CommandContext, CommandResult } from '../context';
import { persist } from './config';
import { modelConsentSchema } from '../router/model-settings';
import { modelGithubRepositories } from '../router/model-repositories';
import { MODEL_MINIMUM_JOB_ATOMIC } from '../router/model-limits';

function retainedRepositories(value: unknown, origin: string): string[] {
  const prior = modelConsentSchema.safeParse(value);
  if (
    !prior.success ||
    prior.data.version !== 2 ||
    prior.data.routerOrigin !== origin ||
    BigInt(prior.data.maxJobAtomic) <= 0n
  )
    return [];
  return prior.data.repositories.flatMap((path) => {
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
  if (mode !== 'on' || !flags.repository || !flags.maxJob)
    throw new CliError('USAGE', 'Use on --repository <path> --max-job <USD>, or off.');
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
    'Native global, ancestor and repository instructions retain their normal scope; Codex copies its AGENTS hierarchy. A Claude worker may read and write in every named directory, inside its sandbox and your native permissions; your own sessions gain nothing. It may read env files in those directories as a native session can, and Tenjin replaces their values with [env:NAME] before anything reaches Tenjin or DeepSeek; values under 8 characters and bare words or numbers under 16 are sent as written. Wallet and login files, and env files elsewhere, are excluded; known secrets are masked, not guaranteed anonymous.',
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
