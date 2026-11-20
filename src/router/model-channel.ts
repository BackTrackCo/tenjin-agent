import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { payerDir, ROUTING_DEPOSIT_KEY } from './fee';

export type ModelPaymentPath = '/api/model-router/route' | '/api/model-proxy/messages';
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

/** A new channel for every accepted run, including a continuation of a paid job. */
export function modelInferenceRunScope(origin: string, runId: string) {
  const canonicalOrigin = new URL(origin).origin;
  const id = createHash('sha256')
    .update(JSON.stringify(['tenjin-model-channel', 2, canonicalOrigin, 'model-inference', runId]))
    .digest('hex');
  return { origin: canonicalOrigin, id, salt: `0x${id}` as `0x${string}` };
}

export function modelInferenceRunDir(
  dataDir: string,
  address: string,
  origin: string,
  runId: string,
) {
  return join(
    payerDir(dataDir, address),
    'model-inference',
    modelInferenceRunScope(origin, runId).id,
  );
}

/**
 * THE OLD SHARED INFERENCE CHANNELS of earlier dev builds: two per wallet and router, slot 0
 * (the scope `modelChannelScope(origin, 'model-inference')` still names) and slot 1, which
 * had a `1` in its scope. Nothing opens or pays on them any more; only the one-time recovery
 * of what they hold reads them (`tenjin wallet reclaim-subagent-credit`). Delete with it.
 */
export function legacySharedInferenceChannel(origin: string, slot: 0 | 1) {
  const canonicalOrigin = new URL(origin).origin;
  const id = createHash('sha256')
    .update(
      JSON.stringify([
        'tenjin-model-channel',
        1,
        canonicalOrigin,
        'model-inference',
        ...(slot === 1 ? [1] : []),
      ]),
    )
    .digest('hex');
  return { id, salt: `0x${id}` as `0x${string}` };
}

/**
 * THE LEDGER KEYS OF ONE RUN'S DEPOSITS. A run's own channel is refunded when the run
 * ends, so its deposits are counted under the run (`prefix`): a confirmed refund gives
 * back that run's own exposure and no other spend. What the run kept is then counted
 * under `kept`, still a routing deposit to `tenjin status`.
 */
export function modelRunDepositKeys(origin: string, runId: string) {
  const { id } = modelInferenceRunScope(origin, runId);
  return { prefix: `${ROUTING_DEPOSIT_KEY}run:${id}:`, kept: `${ROUTING_DEPOSIT_KEY}kept:${id}` };
}
