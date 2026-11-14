import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { payerDir } from './fee';

/** Once-per-job model routing is independent of variable tool-routing quotes. */
export const MODEL_ROUTING_FEE_CEILING_ATOMIC = 3_000n;

export type ModelPaymentPath =
  '/api/model-router/route' | '/api/model-proxy/messages' | '/api/model-proxy/responses';
export type ModelChannelLane = 'model-routing' | 'model-inference';

export function modelChannelLane(path: ModelPaymentPath): ModelChannelLane {
  return path === '/api/model-router/route' ? 'model-routing' : 'model-inference';
}

/** URL is not part of the SDK's channel ID. Scope its supported salt ourselves,
 * so independent local/production ledgers cannot fork one onchain channel. */
export function modelChannelScope(origin: string, lane: ModelChannelLane) {
  const canonicalOrigin = new URL(origin).origin;
  const id = createHash('sha256')
    .update(JSON.stringify(['tenjin-model-channel', 1, canonicalOrigin, lane]))
    .digest('hex');
  return { origin: canonicalOrigin, id, salt: `0x${id}` as `0x${string}` };
}

export function modelChannelDir(
  dataDir: string,
  address: string,
  lane: ModelChannelLane,
  origin: string,
) {
  return join(payerDir(dataDir, address), lane, modelChannelScope(origin, lane).id);
}
