import {
  decodePaymentRequiredHeader,
  decodePaymentResponseHeader,
  decodePaymentSignatureHeader,
} from '@x402/core/http';
import { toClientEvmSigner } from '@x402/evm';
import {
  BatchSettlementEvmScheme,
  computeChannelId,
  readChannelBalanceAndTotalClaimed,
} from '@x402/evm/batch-settlement/client';
import { FileClientChannelStorage } from '@x402/evm/batch-settlement/client/file-storage';
import { lstat, opendir } from 'node:fs/promises';
import { basename, join } from 'node:path';
import {
  encodeAbiParameters,
  keccak256,
  parseAbi,
  zeroAddress,
  type TypedDataDefinition,
} from 'viem';
import { z } from 'zod';
import { withFileLock } from '../lib/lock';
import { buildSiwxHeader, SIWX_CHAIN_ID, SIWX_HEADER } from '../lib/siwx';
import { modelInferenceRunDir, modelInferenceRunScope } from './model-channel';
import { RPC_TIMEOUT_MS, type RoutingPayerDeps } from './routing-payer';
import { readJsonFile, writePrivate } from './store-files';

const REFUND_TIMEOUT_MS = 20_000;
const PROBE_TIMEOUT_MS = 3_000;
const REFUND_RETRY_MS = 300_000;
const CORRECTION_RETRY_MS = 2_000;
const PRE_BROADCAST_ERRORS = new Set([
  'invalid_batch_settlement_evm_cumulative_amount_mismatch',
  'invalid_batch_settlement_evm_cumulative_below_claimed',
  'invalid_batch_settlement_evm_refund_no_balance',
]);
const JOURNAL_BYTES = 256 * 1024;
const AUTHORIZATION_STATE = parseAbi([
  'function authorizationState(address authorizer, bytes32 nonce) view returns (bool)',
]);
const address = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/)
  .transform(toHex);
const bytes32 = z
  .string()
  .regex(/^0x[0-9a-fA-F]{64}$/)
  .transform(toHex);
const uint = z.string().regex(/^\d{1,78}$/);
const network = z.string().regex(/^eip155:[1-9]\d{0,14}$/);
const channel = z.object({
  payer: address,
  payerAuthorizer: address,
  receiver: address,
  receiverAuthorizer: address,
  token: address,
  withdrawDelay: z.number().int().nonnegative(),
  salt: bytes32,
});
const offer = z.object({
  scheme: z.literal('batch-settlement'),
  network,
  asset: address,
  payTo: address,
  amount: uint,
  extra: z.object({
    receiverAuthorizer: address.refine((value) => value !== zeroAddress),
    withdrawDelay: z.number().int().nonnegative(),
  }),
});
const payment = z.object({
  x402Version: z.literal(2),
  accepted: offer,
  payload: z.object({
    type: z.enum(['deposit', 'voucher', 'refund']),
    channelConfig: channel,
    voucher: z.object({ channelId: bytes32 }),
    amount: z.unknown().optional(),
    deposit: z.unknown().optional(),
  }),
});
const funding = z.object({ nonce: bytes32, validBefore: uint });
const receipt = z.object({
  amountAtomic: uint.refine((value) => BigInt(value) > 0n),
  transaction: bytes32,
});
const record = z.object({
  v: z.literal(1),
  runId: z.string().min(1),
  url: z.string(),
  network,
  channel,
  channelId: bytes32,
  funding: z.array(funding),
  retryAfter: z.number().int().nonnegative(),
  sealed: z.boolean(),
  submitted: receipt.extend({ balance: uint }).optional(),
  state: z.enum(['pending', 'no_balance', 'closed', 'refunded']),
});
const settlement = z.object({
  success: z.literal(true),
  network,
  payer: address,
  amount: uint,
  transaction: bytes32,
  extra: z.object({
    channelState: z.object({ channelId: bytes32, balance: uint, totalClaimed: uint }),
  }),
});

type RunRecord = z.infer<typeof record>;
type Funding = z.infer<typeof funding>;
type RefundDeps = Pick<
  RoutingPayerDeps,
  'getSigner' | 'readContract' | 'fetchImpl' | 'now' | 'readBlockTimestamp' | 'readChainId'
>;
export type ModelRefundResult =
  | { state: 'none' | 'pending' | 'no_balance' | 'closed' }
  | ({ state: 'refunded' } & z.infer<typeof receipt>);

function toHex(value: string) {
  return value.toLowerCase() as `0x${string}`;
}

function exactEndpoint(origin: string, rawUrl: string) {
  const url = new URL(rawUrl);
  if (
    url.origin !== origin ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname !== '/api/model-proxy/messages' && url.pathname !== '/api/model-proxy/responses')
  ) {
    throw new Error('Invalid inference refund URL');
  }
  return url.href;
}

function refundDir(dataDir: string) {
  return join(dataDir, 'model-refunds');
}

function recordPath(dataDir: string, origin: string, runId: string) {
  return join(refundDir(dataDir), modelInferenceRunScope(origin, runId).id + '.json');
}

export function modelRefundRunLock(dataDir: string, origin: string, runId: string) {
  return join(dataDir, 'model-refund-' + modelInferenceRunScope(origin, runId).id + '.lock');
}

async function readRecord(path: string) {
  const raw = await readJsonFile(path, JOURNAL_BYTES);
  if (raw === null) {
    const info = await lstat(path).catch((err: NodeJS.ErrnoException) => {
      if (err.code !== 'ENOENT') throw err;
      return null;
    });
    if (info === null) return null;
  }
  const value = record.parse(raw);
  const origin = new URL(value.url).origin;
  if (
    value.url !== exactEndpoint(origin, value.url) ||
    basename(path) !== basename(recordPath('', origin, value.runId)) ||
    value.channel.salt !== modelInferenceRunScope(origin, value.runId).salt ||
    computeChannelId(value.channel, value.network) !== value.channelId ||
    (value.state === 'refunded' && !value.submitted)
  ) {
    throw new Error('Invalid inference refund record');
  }
  return value;
}

async function writeRecord(path: string, value: RunRecord) {
  const json = JSON.stringify(value);
  if (Buffer.byteLength(json) > JOURNAL_BYTES) throw new Error('Inference refund record too large');
  await writePrivate(path, json);
}

function refundResult(value: RunRecord | null): ModelRefundResult {
  if (value === null) return { state: 'none' };
  if (value.state === 'refunded' && value.submitted) {
    const { amountAtomic, transaction } = value.submitted;
    return { state: 'refunded', amountAtomic, transaction };
  }
  return { state: value.state === 'refunded' ? 'pending' : value.state };
}

export async function readModelRefundResult(dataDir: string, origin: string, runId: string) {
  try {
    return refundResult(await readRecord(recordPath(dataDir, origin, runId)));
  } catch {
    return { state: 'pending' } as const;
  }
}

async function* recordFiles(dataDir: string) {
  const dir = refundDir(dataDir);
  const entries = await opendir(dir).catch((err: NodeJS.ErrnoException) => {
    if (err.code !== 'ENOENT') throw err;
    return null;
  });
  if (entries === null) return;
  for await (const entry of entries) {
    if (entry.isFile() && /^[a-f0-9]{64}\.json$/.test(entry.name)) yield join(dir, entry.name);
  }
}

export async function hasModelRefundRecords(dataDir: string) {
  for await (const path of recordFiles(dataDir)) {
    if ((await readRecord(path).catch(() => null))?.state === 'pending') return true;
  }
  return false;
}

export async function readModelRefundSummary(dataDir: string, origin: string, wallet: string) {
  const canonicalOrigin = new URL(origin).origin;
  let pending = 0;
  let refunded = 0n;
  for await (const path of recordFiles(dataDir)) {
    const candidate = await readRecord(path).catch(() => null);
    if (
      candidate === null ||
      new URL(candidate.url).origin !== canonicalOrigin ||
      candidate.channel.payer !== wallet.toLowerCase()
    ) {
      continue;
    }
    if (candidate.state === 'pending') pending++;
    if (candidate.state === 'refunded' && candidate.submitted) {
      refunded += BigInt(candidate.submitted.amountAtomic);
    }
  }
  return { pending, refundedAtomic: refunded.toString() };
}

function verifyOffer(value: z.infer<typeof offer>, config: z.infer<typeof channel>) {
  if (
    value.asset !== config.token ||
    value.payTo !== config.receiver ||
    value.extra.receiverAuthorizer !== config.receiverAuthorizer ||
    value.extra.withdrawDelay !== config.withdrawDelay
  ) {
    throw new Error('Inference refund channel terms changed');
  }
}

function verifyChallenge(response: Response, saved?: RunRecord) {
  const required = response.headers.get('payment-required');
  if (response.status !== 402 || required === null) {
    throw new Error('Router did not provide an inference refund challenge');
  }
  const parsed = z
    .object({ x402Version: z.literal(2), accepts: z.tuple([offer]), error: z.string().optional() })
    .parse(decodePaymentRequiredHeader(required));
  const [quote] = parsed.accepts;
  if (BigInt(quote.amount) !== 0n || (saved && quote.network !== saved.network)) {
    throw new Error('Router provided an incompatible inference refund challenge');
  }
  if (saved) verifyOffer(quote, saved.channel);
  return parsed.error;
}

function fundingAttempt(raw: unknown, channelId: `0x${string}`): Funding {
  const { validBefore, salt } = z
    .object({
      authorization: z.object({
        erc3009Authorization: z.object({
          validBefore: uint,
          salt: bytes32,
        }),
      }),
    })
    .parse(raw).authorization.erc3009Authorization;
  // The SDK's ERC-3009 collector binds the nonce to this channel before it signs.
  const nonce = keccak256(
    encodeAbiParameters([{ type: 'bytes32' }, { type: 'uint256' }], [channelId, BigInt(salt)]),
  );
  return { validBefore, nonce };
}

function boundedSignal(ms: number, signal?: AbortSignal) {
  const timeout = AbortSignal.timeout(ms);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

/** The router gave no answer on refund support: the request failed or timed out, or it
 *  answered a rate limit or a server error (`status`). Nothing was signed or sent for it. */
export class RefundProbeUnanswered extends Error {
  constructor(
    readonly status?: number,
    options?: ErrorOptions,
  ) {
    super(
      status === undefined
        ? 'The router did not answer the inference refund probe'
        : `The router answered the inference refund probe with ${status}`,
      options,
    );
    this.name = 'RefundProbeUnanswered';
  }
}

export class ModelRefundJournal {
  private readonly origin: string;
  private readonly fetchImpl: typeof fetch;

  constructor(
    private readonly dataDir: string,
    origin: string,
    private readonly deps: RefundDeps,
  ) {
    this.origin = new URL(origin).origin;
    this.fetchImpl = deps.fetchImpl ?? fetch;
  }

  /**
   * Whether the router refunds a run's own channel. A request that failed or timed out, a
   * rate limit and a server error are no answer (`RefundProbeUnanswered`): the caller asks
   * again. Any other answer that is not a zero-quote challenge is refused.
   */
  async requireSupport(url: string, signal?: AbortSignal, timeoutMs = PROBE_TIMEOUT_MS) {
    const endpoint = exactEndpoint(this.origin, url);
    let response: Response;
    try {
      response = await this.fetchImpl(endpoint, {
        method: 'GET',
        redirect: 'error',
        signal: boundedSignal(timeoutMs, signal),
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new RefundProbeUnanswered(undefined, { cause: error });
    }
    try {
      if (response.status === 404 || response.status === 405) return false;
      if (response.status === 429 || response.status >= 500)
        throw new RefundProbeUnanswered(response.status);
      verifyChallenge(response);
      return response.headers.get('tenjin-inference-refunds') === 'worker-v1';
    } finally {
      void response.body?.cancel().catch(() => undefined);
    }
  }

  /** Must run under the worker's lifetime lock before forwarding the payment. */
  async record(runId: string, url: string, header: string, signal?: AbortSignal) {
    const endpoint = exactEndpoint(this.origin, url);
    const signed = payment.parse(decodePaymentSignatureHeader(header));
    const config = signed.payload.channelConfig;
    const channelId = computeChannelId(config, signed.accepted.network);
    verifyOffer(signed.accepted, config);
    const signer = await this.deps.getSigner();
    if (
      BigInt(signed.accepted.amount) === 0n ||
      signed.payload.type === 'refund' ||
      config.salt !== modelInferenceRunScope(this.origin, runId).salt ||
      config.payer !== signer.address.toLowerCase() ||
      config.payerAuthorizer !== config.payer ||
      signed.payload.voucher.channelId !== channelId
    ) {
      throw new Error('Payment does not belong to this inference run');
    }
    signal?.throwIfAborted();
    const path = recordPath(this.dataDir, this.origin, runId);
    const previous = await readRecord(path);
    if (
      previous !== null &&
      (previous.state !== 'pending' ||
        previous.sealed ||
        previous.channelId !== channelId ||
        previous.url !== endpoint ||
        previous.network !== signed.accepted.network)
    ) {
      throw new Error('Inference refund record is already sealed or payment terms changed');
    }
    if (signed.payload.type === 'voucher' && previous !== null) return;
    const next: RunRecord = previous ?? {
      v: 1,
      runId,
      url: endpoint,
      network: signed.accepted.network,
      channel: config,
      channelId,
      funding: [],
      retryAfter: 0,
      sealed: false,
      state: 'pending',
    };
    if (signed.payload.type === 'deposit') {
      const attempt = fundingAttempt(signed.payload.deposit, channelId);
      if (next.funding.some((value) => value.nonce === attempt.nonce)) return;
      next.funding.push(attempt);
    }
    signal?.throwIfAborted();
    await writeRecord(path, next);
  }

  async close(runId: string, signal?: AbortSignal): Promise<ModelRefundResult> {
    return this.closeLocked(runId, boundedSignal(REFUND_TIMEOUT_MS, signal));
  }

  async recoverPending(signal?: AbortSignal) {
    const deadline = boundedSignal(REFUND_TIMEOUT_MS, signal);
    for await (const path of recordFiles(this.dataDir)) {
      if (deadline.aborted) return;
      const saved = await readRecord(path).catch(() => null);
      if (saved?.state === 'pending' && new URL(saved.url).origin === this.origin) {
        await this.closeLocked(saved.runId, deadline);
      }
    }
  }

  private async closeLocked(runId: string, signal: AbortSignal): Promise<ModelRefundResult> {
    const path = recordPath(this.dataDir, this.origin, runId);
    try {
      return await withFileLock(
        modelRefundRunLock(this.dataDir, this.origin, runId),
        async () => {
          const saved = await readRecord(path);
          if (!saved || saved.state !== 'pending') return refundResult(saved);
          if (!saved.sealed) {
            saved.sealed = true;
            await writeRecord(path, saved);
          }
          return this.refund(path, saved, signal);
        },
        { timeoutMs: 150, retryMs: 25, takeOverDead: true, signal },
      );
    } catch {
      return readModelRefundResult(this.dataDir, this.origin, runId);
    }
  }

  private async refund(
    path: string,
    saved: RunRecord,
    signal: AbortSignal,
  ): Promise<ModelRefundResult> {
    const readContract = this.deps.readContract;
    if (!readContract || !this.deps.readChainId) return { state: 'pending' };
    const signer = await this.deps.getSigner();
    if (saved.channel.payer !== signer.address.toLowerCase()) return { state: 'pending' };
    if (saved.network !== `eip155:${await this.deps.readChainId(RPC_TIMEOUT_MS)}`) {
      return { state: 'pending' };
    }
    const clientSigner = toClientEvmSigner(
      {
        address: signer.address,
        signTypedData: (message) => {
          signal.throwIfAborted();
          return signer.signTypedData(message as unknown as TypedDataDefinition);
        },
      },
      {
        readContract: (args) => {
          signal.throwIfAborted();
          return readContract(args, RPC_TIMEOUT_MS);
        },
      },
    );
    if (!(await this.fundingSettled(saved, readContract, signal))) return { state: 'pending' };
    const [balance, totalClaimed] = await readChannelBalanceAndTotalClaimed(
      clientSigner,
      saved.channelId,
    );
    if (balance === totalClaimed) return this.finish(path, saved, balance);
    if (balance < totalClaimed || saved.submitted || saved.retryAfter > this.now()) {
      return { state: 'pending' };
    }

    const storage = new FileClientChannelStorage({
      directory: modelInferenceRunDir(this.dataDir, signer.address, this.origin, saved.runId),
    });
    const scheme = new BatchSettlementEvmScheme(clientSigner, {
      storage,
      salt: saved.channel.salt,
    });
    await scheme.refund(saved.url, {
      fetch: async (url, init) => {
        if (url !== saved.url || init?.method !== 'GET') {
          throw new Error('Invalid inference refund request');
        }
        signal.throwIfAborted();
        const headers = new Headers(init.headers);
        const header = headers.get('payment-signature');
        if (header !== null) {
          const signed = payment.parse(decodePaymentSignatureHeader(header));
          verifyOffer(signed.accepted, saved.channel);
          if (
            signed.accepted.network !== saved.network ||
            BigInt(signed.accepted.amount) !== 0n ||
            signed.payload.type !== 'refund' ||
            signed.payload.amount !== undefined ||
            signed.payload.voucher.channelId !== saved.channelId ||
            computeChannelId(signed.payload.channelConfig, saved.network) !== saved.channelId
          ) {
            throw new Error('Invalid signed inference refund request');
          }
          headers.set(
            SIWX_HEADER,
            await buildSiwxHeader(signer, {
              baseUrl: this.origin,
              chainId: SIWX_CHAIN_ID,
              ttlMs: REFUND_RETRY_MS,
            }),
          );
          signal.throwIfAborted();
          saved.retryAfter = this.now() + REFUND_RETRY_MS;
          await writeRecord(path, saved);
        }
        const response = await this.fetchImpl(saved.url, {
          method: 'GET',
          headers,
          redirect: 'error',
          signal,
        });
        try {
          if (response.status === 402) {
            const code = verifyChallenge(response, saved);
            if (
              header !== null &&
              code !== undefined &&
              PRE_BROADCAST_ERRORS.has(code) &&
              !response.headers.has('payment-response')
            ) {
              saved.retryAfter = this.now() + CORRECTION_RETRY_MS;
              await writeRecord(path, saved);
            }
          }
          if (header !== null && response.ok) {
            const raw = response.headers.get('payment-response');
            if (raw === null) throw new Error('Missing inference refund settlement');
            const result = settlement.parse(decodePaymentResponseHeader(raw));
            const state = result.extra.channelState;
            if (
              result.network !== saved.network ||
              result.payer !== saved.channel.payer ||
              state.channelId !== saved.channelId ||
              state.balance !== state.totalClaimed ||
              BigInt(result.amount) <= 0n ||
              BigInt(result.amount) !== balance - BigInt(state.balance)
            ) {
              throw new Error('Invalid inference refund settlement');
            }
            // Keep the matched receipt even if the SDK fails while updating local channel state.
            saved.submitted = {
              amountAtomic: result.amount,
              transaction: result.transaction,
              balance: state.balance,
            };
            await writeRecord(path, saved);
          }
          return response;
        } finally {
          void response.body?.cancel().catch(() => undefined);
        }
      },
    });
    if (!saved.submitted) return { state: 'pending' };
    const [after, claimed] = await readChannelBalanceAndTotalClaimed(clientSigner, saved.channelId);
    return after === claimed ? this.finish(path, saved, after) : { state: 'pending' };
  }

  private async fundingSettled(
    saved: RunRecord,
    readContract: NonNullable<RefundDeps['readContract']>,
    signal: AbortSignal,
  ) {
    let timestamp: bigint | undefined;
    for (const { nonce, validBefore } of saved.funding) {
      signal.throwIfAborted();
      if (
        (await readContract(
          {
            address: saved.channel.token,
            abi: AUTHORIZATION_STATE,
            functionName: 'authorizationState',
            args: [saved.channel.payer, nonce],
          },
          RPC_TIMEOUT_MS,
        )) === true
      ) {
        continue;
      }
      timestamp ??= await this.deps.readBlockTimestamp?.(RPC_TIMEOUT_MS);
      if (timestamp === undefined || timestamp <= BigInt(validBefore)) return false;
    }
    return true;
  }

  private async finish(
    path: string,
    saved: RunRecord,
    balance: bigint,
  ): Promise<ModelRefundResult> {
    if (saved.submitted && BigInt(saved.submitted.balance) === balance) {
      saved.state = 'refunded';
    } else {
      saved.state = saved.retryAfter > 0 ? 'closed' : 'no_balance';
    }
    await writeRecord(path, saved);
    return refundResult(saved);
  }

  private now() {
    return (this.deps.now ?? Date.now)();
  }
}
