import { realpath } from 'node:fs/promises';
import { loadRawConfig } from '../lib/config';
import { CliError } from '../lib/errors';
import { lockSupport } from '../lib/held-lock';
import { formatUsdDisplay, parseUsdToAtomic } from '../lib/money';
import { resolveContextSettings } from '../lib/settings';
import type { CommandContext, CommandResult } from '../context';
import { persist } from './config';
import { namedDirectories, neonConsent, neonConsentSchema } from '../router/model-settings';
import { NEON_MINIMUM_JOB_ATOMIC, NEON_TURN_MAX_TOKENS } from '../router/neon-chat';

export type NeonConfigFlags = { repository?: string | string[]; maxJob?: string };

const usd = (atomic: bigint) => `$${formatUsdDisplay(atomic.toString())}`;
const DETAILS_URL = 'https://github.com/BackTrackCo/tenjin-agent/blob/main/docs/neon-subagent.md';

/**
 * THE NEON TERMS, shown at each turn-on and carried whole in `--json`. They name every party
 * the worker sends data to: BlockRun, which takes each request and the payment, and Google,
 * whose Gemini 4 Neon reads them. Tenjin's router receives nothing.
 */
export const NEON_TERMS = [
  'When you ask for a Neon worker, BlockRun and Google get the task, its instructions and the worker’s tool results, unmasked: only the job’s tokens and your wallet key and passphrase are removed. Tenjin’s router receives nothing and no routing fee is charged. The worker has no web search.',
  'Its instructions come from your ~/.claude (CLAUDE.md, skills, plugins). Its file tools can read the session transcripts, prompt history and settings there, and what they read can reach BlockRun and Google.',
  'Each model call is a payment from your wallet to BlockRun, within your per-call limit, your daily budget and the job ceiling. A call that fails after it was paid is not repeated.',
  `Details: ${DETAILS_URL}`,
] as const;

/** Whether Neon is on, its scope and the cap in force. Read only. */
async function status(ctx: CommandContext): Promise<CommandResult> {
  const config = await loadRawConfig(ctx.dataDir);
  const consent = neonConsentSchema.safeParse(config.router?.neonConsent);
  if (config.router?.neon !== true || !consent.success)
    return {
      data: { enabled: false },
      humanLines: ['○ Neon subagents are off', '', 'Run `tenjin config neon on` to turn them on.'],
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
      jobCapAtomic: cap.toString(),
      perCallLimitAtomic: perCall.toString(),
    },
    humanLines: [
      '● Neon subagents are on',
      `  Scope    ${directories ? `${directories.join(', ')} and subfolders` : 'Every workspace'}`,
      `  Cost     Up to ${usd(cap)} a job · your daily budget applies`,
      '  Sent to  BlockRun and Google, when you ask for a Neon worker',
    ],
  };
}

/**
 * `tenjin config neon`: the person's own consent to Gemini 4 Neon workers, a record of its own
 * (`router.neon`, `router.neonConsent`). DeepSeek subagents, and any usage setting, never turn
 * it on, and it turns nothing else on: an offer for DeepSeek is judged under its own consent.
 */
export async function runConfigNeon(
  mode: string | undefined,
  flags: NeonConfigFlags,
  ctx: CommandContext,
): Promise<CommandResult> {
  if (mode === undefined || mode === 'status') {
    if (flags.repository !== undefined || flags.maxJob !== undefined)
      throw new CliError('USAGE', 'Flags go with on. Use on, off, or no mode for the status.');
    return status(ctx);
  }
  if (mode === 'off') {
    await persist(ctx.dataDir, (c) => ({ ...c, router: { ...c.router, neon: false } }));
    return {
      data: { enabled: false },
      humanLines: ['○ Neon subagents are off. No new jobs will start.'],
    };
  }
  if (mode !== 'on')
    throw new CliError(
      'USAGE',
      'Use on [--repository <path>...] [--max-job <USD>], off, or no mode for the status.',
    );
  const lock = lockSupport();
  if (!lock.ok)
    throw new CliError('USAGE', `Neon subagents cannot run here. ${lock.reason}`, {
      fix: 'Run Tenjin with Node 24, as its installer sets up, then run this command again.',
    });
  if (process.platform === 'win32')
    throw new CliError('USAGE', 'The Neon worker does not run on native Windows.');
  const chosen = await Promise.all([flags.repository ?? []].flat().map((path) => realpath(path)));
  const settings = await resolveContextSettings(ctx);
  const perCall = settings.policy.maxAutoSpendAtomic;
  const named = flags.maxJob === undefined ? undefined : BigInt(parseUsdToAtomic(flags.maxJob));
  if (named !== undefined && named <= NEON_MINIMUM_JOB_ATOMIC)
    throw new CliError(
      'USAGE',
      `The job ceiling must be above ${usd(NEON_MINIMUM_JOB_ATOMIC)}, the least one Neon call reserves.`,
    );
  if (perCall <= NEON_MINIMUM_JOB_ATOMIC)
    throw new CliError(
      'USAGE',
      `Your per-call spend limit, ${usd(perCall)}, is not above ${usd(NEON_MINIMUM_JOB_ATOMIC)}, the least one Neon call reserves. Nothing was changed.`,
      {
        fix: 'Raise the limit with `tenjin config set maxAutoSpend <usd>`, then run this command again.',
      },
    );
  const cap = named !== undefined && named < perCall ? named : perCall;
  let repositories: string[] | null = null;
  await persist(ctx.dataDir, (c) => {
    const before = namedDirectories(c.router?.neonConsent);
    repositories = chosen.length > 0 ? [...new Set([...(before ?? []), ...chosen])] : null;
    const consent = neonConsent({
      ...(repositories ? { repositories } : {}),
      ...(named === undefined ? {} : { maxJobAtomic: named.toString() }),
    });
    return { ...c, router: { ...c.router, neon: true, neonConsent: consent } };
  });
  const scope = repositories
    ? `${(repositories as string[]).join(', ')} and subfolders`
    : 'Every workspace';
  return {
    data: {
      enabled: true,
      scope: repositories ? 'directories' : 'every-workspace',
      ...(repositories ? { repositories } : {}),
      jobCapAtomic: cap.toString(),
      perCallLimitAtomic: perCall.toString(),
      outputCapTokens: NEON_TURN_MAX_TOKENS,
      terms: NEON_TERMS.join('\n'),
    },
    humanLines: [
      '● Neon subagents are on',
      `  Scope    ${scope}`,
      `  Cost     Up to ${usd(cap)} a job (your ${named !== undefined && named < perCall ? '--max-job' : 'per-call limit'}) · your daily budget applies`,
      '',
      ...NEON_TERMS,
    ],
  };
}
