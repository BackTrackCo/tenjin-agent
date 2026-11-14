import { realpath } from 'node:fs/promises';
import { CliError } from '../lib/errors';
import { parseUsdToAtomic } from '../lib/money';
import { resolveContextSettings } from '../lib/settings';
import type { CommandContext, CommandResult } from '../context';
import { persist } from './config';

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
  if (maxJob <= 0n) throw new CliError('USAGE', 'The job ceiling must be positive.');
  const disclosure =
    'Allow Tenjin (using TypeSafe/Jev for routing) to receive this repository’s subagent assignments and bounded parent context. After acceptance, Tenjin and DeepSeek receive the worker’s applicable native instruction context, accepted assignment and tool results. Native global, ancestor and repository instructions keep their normal scope; Codex copies its AGENTS hierarchy into the worker. No wallet, login or environment files are included. This grants no extra tool or filesystem permission. Proxy replay is available for 24 hours; expired content is removed by bounded cleanup. Known secrets are masked, not guaranteed anonymous. Existing tool permissions and wallet limits still apply.';
  await persist(ctx.dataDir, (c) => ({
    ...c,
    router: {
      ...c.router,
      subagents: true,
      subagentConsent: {
        version: 2,
        instructions: 'applicable',
        recipients: ['Tenjin', 'DeepSeek'],
        repositories: [repository],
        maxJobAtomic: maxJob.toString(),
        routerOrigin: new URL(settings.baseUrl).origin,
      },
    },
  }));
  return {
    data: {
      enabled: true,
      repository,
      maxJobAtomic: maxJob.toString(),
      routerOrigin: new URL(settings.baseUrl).origin,
      disclosure,
    },
    humanLines: [
      disclosure,
      `Enabled for ${repository}, at ${new URL(settings.baseUrl).origin}, at most $${flags.maxJob} per job.`,
      'Undo: tenjin config subagents off',
    ],
  };
}
