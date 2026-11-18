import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { payerDir } from './fee';

/** Once-per-job model routing is independent of variable tool-routing quotes. */
export const MODEL_ROUTING_FEE_CEILING_ATOMIC = 3_000n;

export type ModelPaymentPath =
  '/api/model-router/route' | '/api/model-proxy/messages' | '/api/model-proxy/responses';
export type ModelChannelLane = 'model-routing' | 'model-inference';
export type ModelInferenceSlot = 0 | 1;

export function modelChannelLane(path: ModelPaymentPath): ModelChannelLane {
  return path === '/api/model-router/route' ? 'model-routing' : 'model-inference';
}

/** URL is not part of the SDK's channel ID. Scope its supported salt ourselves,
 * so independent local/production ledgers cannot fork one onchain channel. */
export function modelChannelScope(
  origin: string,
  lane: ModelChannelLane,
  inferenceSlot: ModelInferenceSlot = 0,
) {
  const canonicalOrigin = new URL(origin).origin;
  const slot = lane === 'model-inference' && inferenceSlot === 1 ? [inferenceSlot] : [];
  const id = createHash('sha256')
    .update(JSON.stringify(['tenjin-model-channel', 1, canonicalOrigin, lane, ...slot]))
    .digest('hex');
  return { origin: canonicalOrigin, id, salt: `0x${id}` as `0x${string}` };
}

export function modelChannelDir(
  dataDir: string,
  address: string,
  lane: ModelChannelLane,
  origin: string,
  inferenceSlot?: ModelInferenceSlot,
) {
  return join(payerDir(dataDir, address), lane, modelChannelScope(origin, lane, inferenceSlot).id);
}
