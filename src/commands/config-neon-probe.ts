import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { CliError } from '../lib/errors';
import { resolveContextSettings } from '../lib/settings';
import { resolveSpendAuthorizer, resolveWalletProvider } from '../lib/wallet';
import type { CommandContext, CommandResult } from '../context';
import { modelSettings } from '../router/model-settings';
import type { ModelJob } from '../router/model-job';
import { chainReader } from '../router/routing-payer';
import { NEON_TURN_MAX_TOKENS } from '../router/neon-chat';
import { lookupNeonTerms } from '../router/neon-terms';
import { NeonTransport, readNeonRecord } from '../router/neon-transport';

export const NEON_PROBE_ENV = 'TENJIN_NEON_PROBE';

/**
 * A DEV-ONLY DOOR for the Neon evaluation, hidden and off unless `TENJIN_NEON_PROBE=1`: it reads
 * the Neon provider row, sends one given request body through the Neon transport under those
 * terms, and prints the reply, its usage and what the call was quoted and charged. It is the
 * worker's own payment code under the person's own limits, with no worker around it. The
 * channel's remainder comes back through `tenjin refund`.
 */
export async function runNeonProbe(
  file: string | undefined,
  _flags: Record<string, never>,
  ctx: CommandContext,
): Promise<CommandResult> {
  if (process.env[NEON_PROBE_ENV] !== '1')
    throw new CliError('USAGE', `This is a dev door: set ${NEON_PROBE_ENV}=1 to use it.`);
  const settings = await resolveContextSettings(ctx);
  const provider = resolveWalletProvider(ctx);
  const transport = new NeonTransport({
    dataDir: ctx.dataDir,
    ctx,
    provider,
    authorizer: resolveSpendAuthorizer(ctx, settings.policy),
    readContract: chainReader(settings.rpcUrl),
  });
  const terms = await lookupNeonTerms({ ctx, baseUrl: settings.baseUrl });
  const abort = new AbortController();
  if (file === undefined) throw new CliError('USAGE', 'Give the request body file.');
  const body = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
  const current = await modelSettings(ctx.dataDir, process.cwd(), 'neon');
  if (!current) throw new CliError('USAGE', 'Tenjin is switched off here.');
  const job = {
    id: randomUUID(),
    sessionId: 'probe',
    turnId: 'probe',
    callId: 'probe',
    root: process.cwd(),
    task: 'probe',
    native: {},
    decision: { provider: 'neon', neonTerms: terms, maxOutputTokens: NEON_TURN_MAX_TOKENS },
    capAtomic: current.maxJobAtomic.toString(),
    state: 'running',
    expiresAt: Date.now() + 60_000,
  } as unknown as ModelJob;
  let failure: unknown;
  let message: Record<string, unknown> | undefined;
  try {
    message = await transport.messages(job, body, abort.signal);
  } catch (error) {
    failure = error;
  }
  return summary(terms.label, job.id, ctx.dataDir, message, failure, transport.lastRaw);
}

/** The seller's own notice in a reply, such as NanoGPT's reasoning-budget message. */
export function sellerNotice(raw: string): string | undefined {
  return /"([^"]*max_tokens[^"]*(?:reasoning|effort)[^"]*)"/i.exec(raw)?.[1];
}

/** The same summary for a reply and for a failure: what was asked, charged and spent on thought. */
export async function summary(
  seller: string,
  jobId: string,
  dataDir: string,
  message: Record<string, unknown> | undefined,
  failure: unknown,
  raw: string,
): Promise<CommandResult> {
  const call = (await readNeonRecord(dataDir, jobId))?.calls.at(-1);
  const stop = message
    ? String(message.stop_reason)
    : failure instanceof Error
      ? failure.message
      : String(failure);
  const notice = sellerNotice(raw);
  return {
    data: { seller, ok: message !== undefined, stop, message, call, ...(notice ? { notice } : {}) },
    humanLines: [
      `${seller}  model ${call?.model ?? ''}`,
      message ? `stop ${stop}  usage ${JSON.stringify(message.usage)}` : `failed ${stop}`,
      `ceiling ${call?.quotedAtomic}  charged ${call?.settledAtomic}  output ${call?.outputTokens}  reasoning ${call?.reasoningTokens ?? 0}  cached ${call?.cachedInputTokens}`,
      ...(notice ? [`seller notice ${notice}`] : []),
      ...(message ? [`text ${JSON.stringify(message.content).slice(0, 400)}`] : []),
    ],
  };
}
