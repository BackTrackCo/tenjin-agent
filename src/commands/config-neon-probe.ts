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
import { neonSeller } from '../router/neon-seller';
import { NeonTransport, readNeonRecord } from '../router/neon-transport';

export const NEON_PROBE_ENV = 'TENJIN_NEON_PROBE';

/**
 * A DEV-ONLY DOOR for the Neon evaluation, hidden and off unless `TENJIN_NEON_PROBE=1`: it sends
 * one given request body through the Neon transport with the seller `TENJIN_NEON_SELLER` names,
 * and prints the reply, its usage and what the call was quoted and charged. It is the worker's
 * own payment code under the person's own limits and Neon consent, with no worker around it.
 * With `--refund` it asks the x402inference channel for the remainder back instead.
 */
export async function runNeonProbe(
  file: string | undefined,
  flags: { refund?: boolean },
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
  const seller = neonSeller();
  const abort = new AbortController();
  if (flags.refund) {
    if (seller !== 'x402inference')
      throw new CliError('USAGE', 'Only the x402inference channel has a remainder to refund.');
    const settled = await transport.refundChannel(abort.signal);
    return {
      data: { seller, refund: settled },
      humanLines: [`Refund answered: ${JSON.stringify(settled)}`],
    };
  }
  if (file === undefined) throw new CliError('USAGE', 'Give the request body file.');
  const body = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
  const consent = await modelSettings(ctx.dataDir, process.cwd(), 'neon');
  if (!consent)
    throw new CliError(
      'USAGE',
      'Neon is off here: run `tenjin config neon on` for this directory.',
    );
  const job = {
    id: randomUUID(),
    sessionId: 'probe',
    turnId: 'probe',
    callId: 'probe',
    root: process.cwd(),
    task: 'probe',
    native: {},
    decision: { provider: 'neon', maxOutputTokens: NEON_TURN_MAX_TOKENS },
    capAtomic: consent.maxJobAtomic.toString(),
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
  return summary(seller, job.id, ctx.dataDir, message, failure, transport.lastRaw);
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
      `seller ${seller}`,
      message ? `stop ${stop}  usage ${JSON.stringify(message.usage)}` : `failed ${stop}`,
      `ceiling ${call?.quotedAtomic}  charged ${call?.settledAtomic}  output ${call?.outputTokens}  reasoning ${call?.reasoningTokens ?? 0}  cached ${call?.cachedInputTokens}`,
      ...(notice ? [`seller notice ${notice}`] : []),
      ...(message ? [`text ${JSON.stringify(message.content).slice(0, 400)}`] : []),
    ],
  };
}
