import { realpath } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { CliError } from '../lib/errors';
import { parseUsdToAtomic } from '../lib/money';
import { resolveContextSettings } from '../lib/settings';
import type { CommandContext, CommandResult } from '../context';
import { persist } from './config';
import { modelConsentSchema } from '../router/model-settings';

function retainedRepositories(value: unknown, origin: string): string[] {
  const prior = modelConsentSchema.safeParse(value);
  if (!prior.success || prior.data.routerOrigin !== origin || BigInt(prior.data.maxJobAtomic) <= 0n)
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
  if (maxJob <= 0n) throw new CliError('USAGE', 'The job ceiling must be positive.');
  const disclosure = [
    'Allow Tenjin (using TypeSafe/Jev for routing) to receive this repository’s subagent assignments and bounded parent context. After acceptance, Tenjin and DeepSeek receive the worker’s applicable native instruction context, accepted assignment and tool results.',
    'Native global, ancestor and repository instructions retain their normal scope; Codex copies its AGENTS hierarchy. This grants no extra tool or filesystem permission. Wallet, login and environment files are excluded; known secrets are masked, not guaranteed anonymous.',
    'Proxy replies can be replayed for 24 hours, with expired content removed by bounded cleanup. Existing wallet limits apply. Claude’s Messages requests currently reserve about $0.50 minimum; a quote above the job ceiling is refused.',
  ].join('\n\n');
  let repositories = [repository];
  await persist(ctx.dataDir, (c) => {
    // The locked merge keeps other explicitly named roots; this list never
    // supplies working directories or grants tool/filesystem permissions.
    repositories = [
      ...new Set([...retainedRepositories(c.router?.subagentConsent, routerOrigin), repository]),
    ];
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
