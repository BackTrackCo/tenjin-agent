import { createHash, createPrivateKey, generateKeyPairSync, sign } from 'node:crypto';
import { join } from 'node:path';
import { z } from 'zod';
import type { CommandContext } from '../../context';
import { CliError } from '../../lib/errors';
import { httpRequest } from '../../lib/http';
import { withFileLock } from '../../lib/lock';
import type { WalletProvider } from '../../lib/wallet';
import { reviewAccount } from './account';
import { privateDir, readPrivate, reviewDir, savePrivate } from './store';

export class ReviewReadError extends CliError {
  constructor(readonly retryAfterMs: number) {
    super(
      'REFUSED',
      'RentAHuman request could not be verified. A saved mutation must be reconciled before another attempt.',
    );
  }
}

export interface ReviewDeps {
  fetchImpl?: typeof fetch;
  provider?: WalletProvider;
  now?: () => number;
}
const IdentitySchema = z.object({
  agentId: z.string(),
  publicKey: z.string(),
  privateKey: z.string(),
});
const component = '[A-Za-z0-9_-]+';
const paths = new RegExp(
  `^/(?:wallet/(?:balance|controls)|keys/register-identity|bounties(?:/${component}(?:/applications(?:/${component})?|/submissions(?:/${component})?)?)?|escrow(?:/${component}/release)?)(?:\\?limit=100(?:&cursor=[A-Za-z0-9_%.-]+)?|\\?bountyId=${component})?$`,
);

export async function accountLock<T>(ctx: CommandContext, fn: () => Promise<T>): Promise<T> {
  const dir = reviewDir(ctx.dataDir);
  await privateDir(dir);
  return withFileLock(join(dir, 'account.lock'), fn);
}

export async function providerCall(
  ctx: CommandContext,
  deps: ReviewDeps,
  path: string,
  method: 'GET' | 'POST' | 'PATCH' = 'GET',
  body?: Record<string, unknown>,
  action?: string,
): Promise<unknown> {
  if (!paths.test(path)) throw new CliError('REFUSED', 'Unsupported human-review endpoint.');
  const { account } = await reviewAccount(ctx, deps);
  if (!account) throw new CliError('REFUSED', 'Connect RentAHuman with tenjin jobs connect first.');
  const headers: Record<string, string> = { 'X-API-Key': account.apiKey };
  let payload = body;
  if (action) {
    const identity = await readPrivate(
      join(reviewDir(ctx.dataDir), 'identity.json'),
      IdentitySchema,
    );
    if (!identity)
      throw new CliError(
        'REFUSED',
        'Human-review signing identity is missing; preserve account state for recovery.',
      );
    const timestamp = new Date().toISOString();
    const signature = sign(
      null,
      Buffer.from(`${timestamp}:${identity.agentId}:${action}`),
      createPrivateKey({
        key: Buffer.from(identity.privateKey, 'base64'),
        format: 'der',
        type: 'pkcs8',
      }),
    ).toString('base64');
    const verification = {
      agentId: identity.agentId,
      publicKey: identity.publicKey,
      timestamp,
      signature,
    };
    if (method === 'GET')
      Object.assign(headers, {
        'X-Agent-Id': identity.agentId,
        'X-Agent-PublicKey': identity.publicKey,
        'X-Agent-Timestamp': timestamp,
        'X-Agent-Signature': signature,
      });
    else
      payload =
        path === '/keys/register-identity'
          ? verification
          : { ...body, agentId: identity.agentId, agentVerification: verification };
  }
  const result = await httpRequest(`https://rentahuman.ai/api${path}`, {
    method,
    headers,
    ...(payload ? { jsonBody: payload } : {}),
    timeoutMs: ctx.flags.timeout,
    blockRedirects: true,
    ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
  });
  if (
    !result.ok ||
    result.status < 200 ||
    result.status >= 300 ||
    !z.object({ success: z.literal(true) }).safeParse(result.json).success
  ) {
    // Do not surface provider errors: they can reflect credentials or signed requests.
    const retry = result.ok ? result.header('retry-after') : undefined;
    const delay =
      retry && /^\d+$/.test(retry)
        ? Number(retry) * 1000
        : retry
          ? Date.parse(retry) - Date.now()
          : 60_000;
    throw new ReviewReadError(Number.isFinite(delay) ? Math.max(60_000, delay) : 60_000);
  }
  return JSON.parse(
    JSON.stringify(result.json).replaceAll(account.apiKey, '[REDACTED]'),
  ) as unknown;
}

/** Call only inside accountLock. The same saved key is reused after interrupted registration. */
export async function ensureIdentity(ctx: CommandContext, deps: ReviewDeps): Promise<void> {
  const dir = reviewDir(ctx.dataDir);
  let identity = await readPrivate(join(dir, 'identity.json'), IdentitySchema);
  if (!identity) {
    const pair = generateKeyPairSync('ed25519');
    const publicDer = pair.publicKey.export({ format: 'der', type: 'spki' });
    identity = {
      agentId: `agent_${createHash('sha256').update(publicDer).digest('hex').slice(0, 16)}`,
      publicKey: publicDer.toString('base64'),
      privateKey: pair.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
    };
    await savePrivate(join(dir, 'identity.json'), identity);
  }
  const marker = join(dir, 'identity-registered.json');
  const registered = await readPrivate(marker, z.object({ agentId: z.string() }));
  if (registered) {
    if (registered.agentId !== identity.agentId)
      throw new CliError('REFUSED', 'Saved identity registration does not match.');
    return;
  }
  await providerCall(
    ctx,
    deps,
    '/keys/register-identity',
    'POST',
    {},
    `${identity.agentId}:register_identity`,
  );
  await savePrivate(marker, { agentId: identity.agentId });
}
