import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodePaymentRequiredHeader } from '@x402/core/http';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CommandContext } from '../context';
import { ModelJobStore, type ModelJob } from './model-job';
import {
  ModelCallFailed,
  retryableModelCall,
  withModelRetry,
  workerEndText,
} from './model-worker-control';
import { neonMinimumJobAtomic, NEON_TURN_MAX_TOKENS } from './neon-chat';
import {
  depositAdmitter,
  grantNeonRoom,
  neonNextCallNeedAtomic,
  NeonTransport,
  readNeonRecord,
} from './neon-transport';
import { createLocalSpendAuthorizer } from '../lib/wallet/spend';
import { readSpendSummary, spentOf } from '../lib/spend-ledger';
import {
  VoucherSpend,
  channelDeposit,
  ChannelDepositRefused,
  NEON_CHANNEL_DEPOSIT_CAP_ATOMIC,
  PayeeMismatch,
  unspentInChannel,
} from './neon-seller';
import { NeonRefunds } from './neon-refund';
import type { NeonTerms } from './neon-terms';

let dir: string;
afterEach(async () => {
  vi.unstubAllEnvs();
  if (dir) await rm(dir, { recursive: true, force: true });
});

/** A provider row's terms as the door saves them with a job: $3.15 in, $15.75 out per million. */
const TERMS: NeonTerms = {
  rowId: 'row-1',
  label: 'Test Writer',
  url: 'https://seller.example/chat',
  payTo: '0x00000000000000000000000000000000000000aa',
  network: 'eip155:8453',
  asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  model: 'test/model',
  wire: 'chat',
  scheme: 'batch-settlement',
  usage: 'nanogpt',
  inputAtomicPerMillion: '3150000',
  outputAtomicPerMillion: '15750000',
  cacheReadAtomicPerMillion: '157500',
};

async function fixture(limits: Record<string, unknown> = {}) {
  dir = await realpath(await mkdtemp(join(tmpdir(), 'neon-')));
  const data = join(dir, 'data');
  const repo = join(dir, 'repo');
  await mkdir(data);
  await mkdir(join(repo, '.git'), { recursive: true });
  // No consent record and no Neon switch: a Neon job needs neither.
  await writeFile(join(data, 'config.json'), JSON.stringify({ ...limits }));
  const ctx: CommandContext = {
    flags: { json: true, timeout: 30_000 } as CommandContext['flags'],
    dataDir: data,
    io: { stdout: process.stdout, stderr: process.stderr, isTTY: false },
  };
  return { data, repo, ctx };
}

const job = (
  repo: string,
  capAtomic = '1000000',
  terms: NeonTerms | null = TERMS,
  id = '6f2f8f0e-2b64-4b4f-9a39-6d3b2f1c0a11',
): ModelJob => ({
  id,
  sessionId: 's',
  turnId: 't',
  callId: 'c',
  root: repo,
  task: 'Write the release notes',
  native: { prompt: 'Write the release notes', subagent_type: 'general-purpose' },
  decision: {
    provider: 'neon',
    ...(terms ? { neonTerms: terms } : {}),
    maxOutputTokens: NEON_TURN_MAX_TOKENS,
  },
  capAtomic,
  state: 'running',
  expiresAt: Date.now() + 60_000,
});

const MESSAGES = {
  model: 'deepseek-flash',
  max_tokens: 65_536,
  messages: [{ role: 'user', content: [{ type: 'text', text: 'Write it.' }] }],
};

const REPLY = {
  choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'Release notes.' } }],
  usage: { prompt_tokens: 40, completion_tokens: 12, prompt_tokens_details: { cached_tokens: 8 } },
};

const batchAnswer = (
  over: Partial<{
    status: number;
    text: string;
    ceilingAtomic: bigint;
    costAtomic: bigint;
    depositedAtomic: bigint;
    channel: { payer: string; receiverAuthorizer: string; withdrawDelay: number };
  }> = {},
) => ({
  status: 200,
  text: JSON.stringify(REPLY),
  ceilingAtomic: 40_000n,
  costAtomic: 7_321n,
  depositedAtomic: 0n,
  ...over,
});

/** A batch payer as a stub: what it posts, what it answers, and what its refund does. */
function withBatch(
  ctx: CommandContext,
  post: (
    body: string,
    signal: AbortSignal,
    room: bigint,
  ) => Promise<ReturnType<typeof batchAnswer>>,
  state: { transmitted: boolean } = { transmitted: false },
  refund: () => Promise<unknown> = async () => ({ success: true, transaction: '0xrefund' }),
) {
  const made: NeonTerms[] = [];
  const batch = {
    post: vi.fn(post),
    refund: vi.fn(refund),
    get transmitted() {
      return state.transmitted;
    },
  };
  return {
    batch,
    made,
    transport: new NeonTransport({
      dataDir: ctx.dataDir,
      ctx,
      provider: {} as never,
      authorizer: {} as never,
      batch: (terms) => {
        made.push(terms);
        return batch as never;
      },
    }),
  };
}

const signal = () => new AbortController().signal;

it('posts chat completions to the row, and records the real charge beside the ceiling', async () => {
  const { ctx, repo, data } = await fixture();
  const { batch, made, transport: neon } = withBatch(ctx, async () => batchAnswer());
  const sent = job(repo);
  const message = await neon.messages(sent, MESSAGES, signal());
  expect(message).toMatchObject({ stop_reason: 'end_turn', content: [{ text: 'Release notes.' }] });
  const [body, , room] = batch.post.mock.calls[0]!;
  // The model and the seller are the job's saved terms, and the turn asks for the cap.
  expect(JSON.parse(body)).toMatchObject({
    model: 'test/model',
    stream: false,
    reasoning_effort: 'low',
    max_tokens: NEON_TURN_MAX_TOKENS,
  });
  expect(made[0]).toEqual(TERMS);
  // The room of a turn is under the channel's deposit cap.
  expect(room).toBe(NEON_CHANNEL_DEPOSIT_CAP_ATOMIC);
  const record = await readNeonRecord(data, sent.id);
  // The job counts what was charged, not the ceiling the voucher allowed.
  expect(record).toMatchObject({
    spentAtomic: '7321',
    settledAtomic: '7321',
    taskClass: 'writing',
  });
  expect(record!.calls[0]).toMatchObject({
    model: 'test/model',
    quotedAtomic: '40000',
    settledAtomic: '7321',
    settlement: 'settled',
    outputTokens: 12,
    cachedInputTokens: 8,
    systemTokens: 0,
  });
  expect(record!.calls[0]!.messageTokens).toBeGreaterThan(0);
  // The size of the request is kept: a revision's history is at least that big again.
  expect(record!.calls[0]!.bytes).toBe(Buffer.byteLength(body));
  expect(await neonNextCallNeedAtomic(data, sent, TERMS)).toBeGreaterThan(
    neonMinimumJobAtomic(TERMS),
  );
  // The paid ledger names the seller of the saved terms.
  expect(await readFile(join(data, 'paid', 'ledger.jsonl'), 'utf8')).toContain('seller.example');
});

it('keeps the funded channel config the seller named, for a withdrawal that cannot ask it again', async () => {
  const { ctx, repo, data } = await fixture();
  const channel = {
    payer: '0x00000000000000000000000000000000000000c1',
    receiverAuthorizer: '0x3721824a31197dcDD2984cF43b92B6cc8A87c0Fb',
    withdrawDelay: 900,
  };
  const { transport: neon } = withBatch(ctx, async () => batchAnswer({ channel }));
  await neon.messages(job(repo), MESSAGES, signal());
  expect(
    (
      await new NeonRefunds({
        dataDir: data,
        payer: () => ({ refund: async () => ({}) }),
      }).entries()
    )[0]!.channel,
  ).toEqual(channel);
});

// Failure caught by review: the channel config was kept only after a paid reply succeeded, so a
// funded first request that got a 503 left a deposit that `tenjin refund` and the timed
// withdrawal could not recover while the seller was offline. It is kept before the payment leaves.
it('keeps the funded channel config when the paid request fails with a 503', async () => {
  const { ctx, repo, data } = await fixture();
  const account = privateKeyToAccount(generatePrivateKey());
  const secret = 'SECRET-DRAFT-TEXT';
  const bodies: string[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const request = input instanceof Request ? input.clone() : new Request(input, init);
    bodies.push(await request.clone().text());
    if (request.headers.has('payment-signature')) return new Response('down', { status: 503 });
    return new Response('{}', {
      status: 402,
      headers: {
        'payment-required': encodePaymentRequiredHeader({
          x402Version: 2,
          error: 'payment required',
          resource: { url: TERMS.url, description: '', mimeType: 'application/json' },
          accepts: [
            {
              scheme: 'batch-settlement',
              network: 'eip155:8453',
              amount: '42521',
              asset: TERMS.asset,
              payTo: TERMS.payTo,
              maxTimeoutSeconds: 330,
              extra: {
                name: 'USD Coin',
                version: '2',
                receiverAuthorizer: '0x3721824a31197dcDD2984cF43b92B6cc8A87c0Fb',
                withdrawDelay: 900,
              },
            },
          ],
        }),
      },
    });
  };
  const neon = new NeonTransport({
    dataDir: data,
    ctx,
    provider: { getSigner: async () => account } as never,
    authorizer: createLocalSpendAuthorizer({
      dir: data,
      policy: { maxAutoSpendAtomic: 1_000_000n, sessionBudgetAtomic: null, allowlistCreators: [] },
    }),
    fetchImpl,
  });
  const messages = { ...MESSAGES, messages: [{ role: 'user', content: secret }] };
  await expect(neon.messages(job(repo), messages, signal())).rejects.toBeInstanceOf(
    ModelCallFailed,
  );
  // The first request, the unpaid one, carried none of the draft.
  expect(bodies[0]).not.toContain(secret);
  const [entry] = await new NeonRefunds({
    dataDir: data,
    payer: () => ({ refund: async () => ({}) }),
  }).entries();
  expect(entry!.channel).toEqual({
    payer: account.address,
    receiverAuthorizer: '0x3721824a31197dcDD2984cF43b92B6cc8A87c0Fb',
    withdrawDelay: 900,
  });
});

// Failure caught by review: the door quoted a first draft from an estimate of what Claude Code
// adds around it, and a real first request over that estimate failed right after the yes with no
// way to ask again. The call that does not fit now measures its real request and keeps what it
// needs, so the same worker is asked about at that amount and not at the estimate.
it('measures a first request that does not fit, and asks about it again at that amount', async () => {
  const { ctx, repo, data } = await fixture();
  const { transport: neon, batch } = withBatch(ctx, async () => batchAnswer());
  const big = {
    ...MESSAGES,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'x'.repeat(200_000) }] }],
  };
  // Room for the estimate of a small draft and not for the real 200 KB request.
  const small = job(repo, '100000');
  const refused = await neon.messages(small, big, signal()).catch((e: unknown) => e);
  expect((refused as ModelCallFailed).detail).toMatchObject({ cause: 'budget', uncharged: true });
  expect(batch.post).not.toHaveBeenCalled();
  const record = (await readNeonRecord(data, small.id))!;
  const need = BigInt(record.needAtomic!);
  expect(need).toBeGreaterThan(100_000n);
  // The next try is asked about at the measured amount, not at the fixed allowance.
  expect(await neonNextCallNeedAtomic(data, small, TERMS)).toBe(need);
  // The yes grows the same job's room by that amount, and the call then goes out on the same job.
  await grantNeonRoom(data, small.id, need);
  await neon.messages(small, big, signal());
  expect(batch.post).toHaveBeenCalledTimes(1);
  // A call that went through spends the measured need.
  expect((await readNeonRecord(data, small.id))!.needAtomic).toBeUndefined();
});

// Failure caught by review (money): after one approval every later call kept paying past the
// per-call limit. An approval lifts the limit for the room it was given, once.
it('returns to the per-call limit once the approved room is spent', async () => {
  const { ctx, repo, data } = await fixture({ maxAutoSpend: '50000' });
  const rooms: bigint[] = [];
  const { transport: neon } = withBatch(ctx, async (_body, _signal, room) => {
    rooms.push(room);
    return batchAnswer();
  });
  const j = job(repo, '1000000');
  await neon.messages(j, MESSAGES, signal());
  // The person approved 200,000 more room: the next call may use it past the 50,000 limit.
  await grantNeonRoom(data, j.id, 200_000n);
  await neon.messages(j, MESSAGES, signal());
  expect(rooms[1]).toBeGreaterThan(50_000n);
  // Once that approval is spent, the next call is held to the limit again.
  const path = join(data, 'model-jobs', `${j.id}.neon.json`);
  const kept = JSON.parse(await readFile(path, 'utf8'));
  await writeFile(path, JSON.stringify({ ...kept, approvedSpentAtomic: kept.grantedAtomic }));
  await neon.messages(j, MESSAGES, signal());
  expect(rooms[2]).toBe(50_000n);
});

// The same rule for the day's budget: an approval lifts it for the room it was given, once, and the
// call after it is fitted to what the day has left again.
it('fits a call to the day budget again once the approved room is spent', async () => {
  const { ctx, repo, data } = await fixture({ sessionBudget: '60000' });
  const rooms: bigint[] = [];
  const { transport: neon } = withBatch(ctx, async (_body, _signal, room) => {
    rooms.push(room);
    return batchAnswer();
  });
  const j = job(repo, '1000000');
  await neon.messages(j, MESSAGES, signal());
  await grantNeonRoom(data, j.id, 200_000n);
  await neon.messages(j, MESSAGES, signal());
  expect(rooms[1]).toBeGreaterThan(60_000n);
  const path = join(data, 'model-jobs', `${j.id}.neon.json`);
  const kept = JSON.parse(await readFile(path, 'utf8'));
  await writeFile(path, JSON.stringify({ ...kept, approvedSpentAtomic: kept.grantedAtomic }));
  await neon.messages(j, MESSAGES, signal());
  expect(rooms[2]).toBeLessThanOrEqual(60_000n);
});

it('sends the effort the door saved with the job', async () => {
  const { ctx, repo } = await fixture();
  const { batch, transport: neon } = withBatch(ctx, async () => batchAnswer());
  const sent = job(repo);
  sent.decision.neonEffort = 'medium';
  await neon.messages(sent, MESSAGES, signal());
  expect(JSON.parse(batch.post.mock.calls[0]![0])).toMatchObject({ reasoning_effort: 'medium' });
});

it('steps a turn down to the daily budget that is left, and sends none when the floor does not fit', async () => {
  const { ctx, repo } = await fixture({ sessionBudget: '50000' });
  const { batch, transport: neon } = withBatch(ctx, async () => batchAnswer());
  await neon.messages(job(repo), MESSAGES, signal());
  const sent = JSON.parse(batch.post.mock.calls[0]![0]);
  // $0.05 buys under 3,200 output tokens at $15.75 per million.
  expect(sent.max_tokens).toBeLessThan(3_200);
  expect(sent.max_tokens).toBeGreaterThanOrEqual(1_024);
  await writeFile(join(ctx.dataDir, 'config.json'), JSON.stringify({ sessionBudget: '1000' }));
  const none = await neon
    .messages(
      job(repo, '1000000', TERMS, '7f2f8f0e-2b64-4b4f-9a39-6d3b2f1c0a12'),
      MESSAGES,
      signal(),
    )
    .catch((error: unknown) => error);
  expect((none as ModelCallFailed).detail).toMatchObject({ cause: 'budget', uncharged: true });
  expect(batch.post).toHaveBeenCalledTimes(1);
});

it('never sends a turn the job ceiling cannot hold, and never a job with no seller terms', async () => {
  const { ctx, repo } = await fixture();
  const { batch, transport: neon } = withBatch(ctx, async () => batchAnswer());
  const failure = await neon
    .messages(job(repo, '500'), MESSAGES, signal())
    .catch((e: unknown) => e);
  expect((failure as ModelCallFailed).detail).toMatchObject({ cause: 'budget', uncharged: true });
  const bare = await neon
    .messages(job(repo, '1000000', null), MESSAGES, signal())
    .catch((e: unknown) => e);
  expect((bare as ModelCallFailed).detail).toMatchObject({ uncharged: true });
  expect(batch.post).not.toHaveBeenCalled();
});

it('does not try a batch call again once a voucher was sent, and may where none was', async () => {
  const { ctx, repo } = await fixture();
  const sentVoucher = withBatch(ctx, async () => batchAnswer({ status: 502 }), {
    transmitted: true,
  });
  const failure = await withModelRetry(
    () => sentVoucher.transport.messages(job(repo), MESSAGES, signal()),
    signal(),
    () => undefined,
    async () => undefined,
  ).catch((error: unknown) => error);
  expect(retryableModelCall(failure)).toBe(false);
  expect(sentVoucher.batch.post).toHaveBeenCalledTimes(1);
  const unsent = withBatch(
    ctx,
    async () => {
      throw new Error('network down');
    },
    { transmitted: false },
  );
  const again = await unsent.transport
    .messages(job(repo), MESSAGES, signal())
    .catch((error: unknown) => error);
  expect((again as ModelCallFailed).detail).toMatchObject({ uncharged: true });
});

// Failure caught: a seller that names another payee than its row got the first voucher. The
// payer signs nothing, the call is proven unpaid, and it ends the job as a budget end.
it('ends the job with nothing signed when the live 402 names another payee than the row', async () => {
  const { ctx, repo } = await fixture();
  const { batch, transport: neon } = withBatch(
    ctx,
    async () => {
      throw new PayeeMismatch(TERMS.payTo, ['0x00000000000000000000000000000000DeaDBeef']);
    },
    { transmitted: false },
  );
  const failure = await withModelRetry(
    () => neon.messages(job(repo), MESSAGES, signal()),
    signal(),
    () => undefined,
    async () => undefined,
  ).catch((error: unknown) => error);
  expect((failure as ModelCallFailed).detail).toMatchObject({ cause: 'budget', uncharged: true });
  expect(batch.post).toHaveBeenCalledTimes(1);
});

// Failure caught: a turn that spent its whole cap on thought wrote nothing, and sending it again
// would spend the same again. The call stays recorded at its charge.
it('ends the job charged and with no answer, with no second try, when a turn writes nothing', async () => {
  const { ctx, repo, data } = await fixture();
  const empty = JSON.stringify({
    choices: [{ finish_reason: 'length', message: { role: 'assistant', content: null } }],
    usage: { prompt_tokens: 40, completion_tokens: 16_000 },
  });
  const { batch, transport: neon } = withBatch(ctx, async () => batchAnswer({ text: empty }));
  const sent = job(repo);
  const failure = await withModelRetry(
    () => neon.messages(sent, MESSAGES, signal()),
    signal(),
    () => undefined,
    async () => undefined,
  ).catch((error: unknown) => error);
  expect(failure).toMatchObject({ stop: { kind: 'provider_limit', reason: 'output_limit' } });
  expect(batch.post).toHaveBeenCalledTimes(1);
  // The charge counts in the job and stays recorded as a call with no answer.
  const record = await readNeonRecord(data, sent.id);
  expect(record).toMatchObject({ spentAtomic: '7321' });
  expect(record!.calls[0]).toMatchObject({ ok: false });
  // The result and the progress view say it: charged, no answer, not sent again.
  expect(workerEndText('output_limit', 'neon')).toMatch(/charged.*daily budget.*not sent again/);
});

it('keeps a call raw reply and request only when asked, and never the system prompt text', async () => {
  const { ctx, repo, data } = await fixture();
  const { transport: neon } = withBatch(ctx, async () => batchAnswer());
  const sent = job(repo);
  await neon.messages(sent, { ...MESSAGES, system: 'SECRET-SYSTEM-PROMPT' }, signal());
  await expect(
    readFile(join(data, 'model-jobs', `${sent.id}.neon-raw`, 'call-1.request.json'), 'utf8'),
  ).rejects.toThrow();
  vi.stubEnv('TENJIN_NEON_CAPTURE', '1');
  const second = job(repo, '1000000', TERMS, '7f2f8f0e-2b64-4b4f-9a39-6d3b2f1c0a12');
  await neon.messages(second, { ...MESSAGES, system: 'SECRET-SYSTEM-PROMPT' }, signal());
  const kept = join(data, 'model-jobs', `${second.id}.neon-raw`);
  const request = await readFile(join(kept, 'call-1.request.json'), 'utf8');
  expect(request).not.toContain('SECRET-SYSTEM-PROMPT');
  expect(JSON.parse(request).messages[0]).toMatchObject({ role: 'system', content: { bytes: 22 } });
});

it('keeps a deposit at the channel cap and inside the person limits', async () => {
  const admitted: bigint[] = [];
  const admit = async (amount: bigint) => void admitted.push(amount);
  // The cap sits above the quote of a full 16,000-token turn.
  expect(NEON_CHANNEL_DEPOSIT_CAP_ATOMIC).toBeGreaterThan(252_000n);
  expect(await channelDeposit({ minimumDepositAmount: '40000', currentBalance: '0' }, admit)).toBe(
    NEON_CHANNEL_DEPOSIT_CAP_ATOMIC,
  );
  expect(admitted).toEqual([NEON_CHANNEL_DEPOSIT_CAP_ATOMIC]);
  // A channel part full tops up to the cap only.
  expect(
    await channelDeposit({ minimumDepositAmount: '40000', currentBalance: '400000' }, admit),
  ).toBe(100_000n);
  // The seller's own ceiling on a deposit is kept, and a call it cannot cover is refused.
  expect(
    await channelDeposit(
      { minimumDepositAmount: '40000', currentBalance: '0', maxDeposit: '90000' },
      admit,
    ),
  ).toBe(90_000n);
  await expect(
    channelDeposit({ minimumDepositAmount: '40000', currentBalance: '480000' }, admit),
  ).rejects.toThrow(ChannelDepositRefused);
  // A deposit over the person's limits stops before it is signed.
  await expect(
    channelDeposit({ minimumDepositAmount: '1', currentBalance: '0' }, async () => {
      throw new Error('over limits');
    }),
  ).rejects.toThrow('over limits');
});

// Failure caught by the first live follow-up: a job's end refunded the channel, so its next call
// had to deposit again, but the cap was held against the channel's whole balance, which keeps what
// was charged in earlier jobs (3.93 USD in the live channel) and so sat far above the 0.50 cap
// with nothing in the channel. Every later deposit was refused and the revision never ran.
it('bounds the deposit by what is unspent in the channel, not by its whole balance', async () => {
  const drained = {
    currentBalance: '3930826',
    clientContext: { chargedCumulativeAmount: '3930826', totalClaimed: '3930826' },
  };
  expect(unspentInChannel(drained)).toBe(0n);
  const admit = async () => undefined;
  expect(
    await channelDeposit(
      { minimumDepositAmount: '40000', currentBalance: unspentInChannel(drained).toString() },
      admit,
    ),
  ).toBe(NEON_CHANNEL_DEPOSIT_CAP_ATOMIC);
  // A channel that still holds 100,000 unspent tops up to the cap only; the claimed amount never
  // counts as unspent, and a record that shows more charged than the balance reads as empty.
  expect(
    unspentInChannel({
      currentBalance: '4030826',
      clientContext: { chargedCumulativeAmount: '3930826', totalClaimed: '3900000' },
    }),
  ).toBe(100_000n);
  expect(
    unspentInChannel({ currentBalance: '1', clientContext: { chargedCumulativeAmount: '5' } }),
  ).toBe(0n);
  // The balance alone is the unspent amount for a channel with no charge on record.
  expect(unspentInChannel({ currentBalance: '90000' })).toBe(90_000n);
});

it('reads a refused deposit through the error that wraps it, and keeps why a call was not sent', async () => {
  const { ctx, repo, data } = await fixture();
  const wrapped = withBatch(
    ctx,
    async () => {
      throw new Error('Failed to create payment payload', {
        cause: new ChannelDepositRefused('The channel is at its deposit cap'),
      });
    },
    { transmitted: false },
  );
  const sent = job(repo);
  const failure = await wrapped.transport
    .messages(sent, MESSAGES, signal())
    .catch((e: unknown) => e);
  // A refused deposit is a budget end, not a failure to retry, and says why.
  expect((failure as ModelCallFailed).detail).toMatchObject({ cause: 'budget', uncharged: true });
  expect((failure as ModelCallFailed).message).toContain('deposit cap');
  expect((await readNeonRecord(data, sent.id))!.notSent[0]).toContain('call 1 not sent');
});

// Failure caught by review: the deposit always filled the channel to its 0.50 USD cap and was
// admitted as one automatic payment, so a call that fit the job was refused whenever the per-call
// limit was under 0.50, or the day's budget had less than that left (`POLICY_REFUSED deposit
// 500000`). The deposit is now the most the limits admit, never above the cap and never below what
// the call itself needs, and a call that cannot fit is refused with the reason and nothing signed.
describe('the size of a channel deposit', () => {
  const needs = (minimumDepositAmount: string) => ({ minimumDepositAmount, currentBalance: '0' });
  const admits =
    (limit: bigint | undefined, seen: bigint[] = []) =>
    async (amount: bigint) => {
      seen.push(amount);
      return limit !== undefined && amount > limit ? limit : undefined;
    };

  it('fills the channel to its cap when the limits admit it', async () => {
    const seen: bigint[] = [];
    expect(await channelDeposit(needs('40000'), admits(undefined, seen))).toBe(
      NEON_CHANNEL_DEPOSIT_CAP_ATOMIC,
    );
    expect(seen).toEqual([NEON_CHANNEL_DEPOSIT_CAP_ATOMIC]);
  });

  it('shrinks to a per-call limit under the cap, and the limits see the amount that is signed', async () => {
    const seen: bigint[] = [];
    expect(await channelDeposit(needs('40000'), admits(300_000n, seen))).toBe(300_000n);
    // The first ask is refused down to the limit, the amount that is signed is admitted again.
    expect(seen).toEqual([NEON_CHANNEL_DEPOSIT_CAP_ATOMIC, 300_000n]);
  });

  it('shrinks to what a low day budget has left', async () => {
    expect(await channelDeposit(needs('40000'), admits(200_000n))).toBe(200_000n);
  });

  it('never goes below the seller minimum for the call: it is refused, with the reason, before anything is signed', async () => {
    const seen: bigint[] = [];
    await expect(channelDeposit(needs('250000'), admits(200_000n, seen))).rejects.toThrow(
      /spend limits admit .* at most/,
    );
    await expect(channelDeposit(needs('250000'), admits(200_000n))).rejects.toBeInstanceOf(
      ChannelDepositRefused,
    );
    // Limits that keep refusing the amount they named are the same refusal, never a deposit.
    await expect(
      channelDeposit(needs('1'), async (amount) => (amount > 1n ? amount - 1n : 0n)),
    ).rejects.toBeInstanceOf(ChannelDepositRefused);
    // A limit of nothing is the same refusal.
    await expect(channelDeposit(needs('1'), admits(0n))).rejects.toBeInstanceOf(
      ChannelDepositRefused,
    );
  });
});

describe('the limits a deposit meets', () => {
  const TARGET = 'seller.example';
  const policy = (over: Record<string, unknown>) => ({
    maxAutoSpendAtomic: 1_000_000n,
    sessionBudgetAtomic: 5_000_000n,
    allowlistCreators: [],
    ...over,
  });

  it('admits a whole deposit inside the limits, and names the most the limits admit otherwise', async () => {
    const { data } = await fixture();
    const admit = depositAdmitter({ dataDir: data, policy: policy({}) as never, creator: TARGET });
    expect(await admit(500_000n)).toBeUndefined();
    // A per-call limit of 0.30 admits 0.30.
    const tight = depositAdmitter({
      dataDir: data,
      policy: policy({ maxAutoSpendAtomic: 300_000n }) as never,
      creator: TARGET,
    });
    expect(await tight(500_000n)).toBe(300_000n);
    expect(await tight(300_000n)).toBeUndefined();
    // A day's budget with 0.20 left, after 0.25 of 0.45 was spent, admits 0.20.
    const authorizer = createLocalSpendAuthorizer({ dir: data, policy: policy({}) as never });
    await authorizer.commit(undefined, 250_000n, { mode: 'automatic' });
    const low = depositAdmitter({
      dataDir: data,
      policy: policy({ sessionBudgetAtomic: 450_000n }) as never,
      creator: TARGET,
    });
    expect(await low(500_000n)).toBe(200_000n);
  });

  it('still refuses a payee the person has not allowed, for any amount', async () => {
    const { data } = await fixture();
    const admit = depositAdmitter({
      dataDir: data,
      policy: policy({ allowlistCreators: ['someone-else.example'] }) as never,
      creator: TARGET,
    });
    await expect(admit(1n)).rejects.toThrow();
  });
});

it('counts every voucher against the daily budget, a pre-funded channel included, at its real charge', async () => {
  const { data } = await fixture();
  const policy = {
    maxAutoSpendAtomic: 250_000n,
    sessionBudgetAtomic: 280_000n,
    allowlistCreators: [],
  };
  const authorizer = createLocalSpendAuthorizer({ dir: data, policy });
  const spentNow = async () => {
    const ledger = await readSpendSummary(data);
    return ledger === null ? 0n : spentOf(ledger);
  };
  const first = new VoucherSpend(authorizer, 'seller.example', 'call-1');
  expect(await first.before(40_000n)).toBeUndefined();
  await first.settle(7_321n, 40_000n, true);
  expect(await spentNow()).toBe(7_321n);
  // A call whose voucher was sent and never answered stays counted at its ceiling.
  const lost = new VoucherSpend(authorizer, 'seller.example', 'call-2');
  await lost.before(40_000n);
  await lost.settle(undefined, 40_000n, true);
  expect(await spentNow()).toBe(47_321n);
  // A call that signed nothing gives its reservation back.
  const unsent = new VoucherSpend(authorizer, 'seller.example', 'call-3');
  await unsent.before(40_000n);
  await unsent.settle(undefined, 40_000n, false);
  expect(await spentNow()).toBe(47_321n);
  expect(
    await new VoucherSpend(authorizer, 'seller.example', 'call-4').before(260_000n),
  ).toMatchObject({ abort: true });
  expect(
    await new VoucherSpend(authorizer, 'seller.example', 'call-5').before(250_000n),
  ).toMatchObject({ abort: true });
});

// ---- The job-end refund, and the refund after the provider row changes ----

it('asks the seller for the channel remainder when a run ends, and keeps a failed refund on record', async () => {
  const { ctx, repo, data } = await fixture();
  const ok = withBatch(ctx, async () => batchAnswer());
  const sent = job(repo);
  await ok.transport.withInferenceRun(sent.id, signal(), (t) =>
    t.messages(sent, MESSAGES, signal()),
  );
  expect(ok.batch.refund).toHaveBeenCalledTimes(1);
  const done = await new NeonRefunds({ dataDir: data, payer: () => ok.batch }).entries();
  expect(done).toMatchObject([{ state: 'refunded', terms: { payTo: TERMS.payTo } }]);

  // A seller that does not answer leaves the channel on record as failed, never as lost.
  const second = await fixture();
  const failing = withBatch(
    second.ctx,
    async () => batchAnswer(),
    { transmitted: false },
    async () => {
      throw new Error('Refund probe expected 402, got 503');
    },
  );
  const next = job(second.repo);
  await failing.transport.withInferenceRun(next.id, signal(), (t) =>
    t.messages(next, MESSAGES, signal()),
  );
  expect(
    await new NeonRefunds({ dataDir: second.data, payer: () => failing.batch }).entries(),
  ).toMatchObject([{ state: 'failed', note: expect.stringContaining('503') }]);
});

// Failure caught: a refund that looked the provider up again after the catalog row changed would
// go to another payee, and a failed lookup would strand the money. It uses the saved terms.
// Failure caught by review: the job's result waited for its channel refund, with no bound. The end
// of a run now gives the refund a short signal, and a refund that does not finish in it stays on
// record while the result is delivered.
it('delivers a run result even when the channel refund never answers', async () => {
  const { ctx, repo, data } = await fixture();
  const stop = new AbortController();
  const hanging = new NeonTransport({
    dataDir: ctx.dataDir,
    ctx,
    provider: {} as never,
    authorizer: {} as never,
    closeSignal: () => stop.signal,
    batch: () =>
      ({
        post: async () => batchAnswer(),
        refund: () => new Promise(() => undefined),
        transmitted: false,
      }) as never,
  });
  const sent = job(repo);
  const run = hanging.withInferenceRun(sent.id, signal(), (t) =>
    t.messages(sent, MESSAGES, signal()),
  );
  await vi.waitFor(async () => expect(await readNeonRecord(data, sent.id)).not.toBeNull());
  stop.abort();
  await expect(run).resolves.toMatchObject({ stop_reason: 'end_turn' });
  const refunds = await new NeonRefunds({
    dataDir: data,
    payer: () => ({ refund: async () => ({}) }),
  }).entries();
  expect(refunds[0]).toMatchObject({ state: 'failed' });
});

it('refunds after the provider row changes, from the terms the job was paid under, with no lookup', async () => {
  const { ctx, repo, data } = await fixture();
  const refundsAt: NeonTerms[] = [];
  const first = withBatch(
    ctx,
    async () => batchAnswer(),
    { transmitted: false },
    async () => {
      throw new Error('the seller was unreachable');
    },
  );
  const sent = job(repo);
  await first.transport.withInferenceRun(sent.id, signal(), (t) =>
    t.messages(sent, MESSAGES, signal()),
  );
  // `tenjin refund` is built from the journal alone: it never reads the catalog, so a row that
  // now names another seller changes nothing.
  const retry = new NeonRefunds({
    dataDir: data,
    payer: (terms) => {
      refundsAt.push(terms);
      return { refund: async () => ({ success: true, transaction: '0xback', amount: '9000' }) };
    },
  });
  const after = await retry.retry();
  expect(refundsAt).toEqual([TERMS]);
  expect(after).toMatchObject([
    { state: 'refunded', refundedAtomic: '9000', transaction: '0xback' },
  ]);
  // Nothing is asked twice once it is refunded.
  await retry.retry();
  expect(refundsAt).toHaveLength(1);
});

it('keeps a seller and payee that differ in separate channel records', async () => {
  const { data } = await fixture();
  const refunds = new NeonRefunds({
    dataDir: data,
    payer: () => ({ refund: async () => ({ success: true }) }),
  });
  await refunds.open('job-a', TERMS);
  await refunds.open('job-b', { ...TERMS, payTo: '0x00000000000000000000000000000000000000bb' });
  await refunds.open('job-c', TERMS);
  const entries = await refunds.entries();
  expect(entries).toHaveLength(2);
  expect(entries.find((e) => e.terms.payTo === TERMS.payTo)!.jobIds).toEqual(['job-a', 'job-c']);
});

const JOB_B = '7f2f8f0e-2b64-4b4f-9a39-6d3b2f1c0a12';

// Failure caught: the end of one job emptied a channel that another Neon job of the same payer,
// seller and payee was still paying on, so that job's next call met an empty channel. The last
// job to end does the refund, and a job whose runner is gone never holds one back.
it('sends no refund when the first of two jobs on one channel ends, and one when the second ends', async () => {
  const { ctx, repo, data } = await fixture();
  const store = new ModelJobStore(data);
  const a = job(repo);
  const b = job(repo, '1000000', TERMS, JOB_B);
  // Both runners are alive: each holds its job's runner lock, as an accepted job does.
  const lockA = await store.holdRunner(a.id);
  const lockB = await store.holdRunner(b.id);
  const first = withBatch(ctx, async () => batchAnswer());
  const second = withBatch(ctx, async () => batchAnswer());
  const secondRun = second.transport.withInferenceRun(b.id, signal(), async (t) => {
    await t.messages(b, MESSAGES, signal());
    // Job A ends while B still runs on the same channel.
    await first.transport.withInferenceRun(a.id, signal(), (t2) =>
      t2.messages(a, MESSAGES, signal()),
    );
    expect(first.batch.refund).not.toHaveBeenCalled();
  });
  await secondRun;
  lockA();
  // B was the last to end: its end sent the one refund, and A's end sent none.
  expect(first.batch.refund).not.toHaveBeenCalled();
  expect(second.batch.refund).toHaveBeenCalledTimes(1);
  lockB();
  const entries = await new NeonRefunds({ dataDir: data, payer: () => first.batch }).entries();
  expect(entries).toMatchObject([
    { state: 'refunded', ended: expect.arrayContaining([a.id, b.id]) },
  ]);
});

it('refunds at the second end even while the first job runner still holds its lock', async () => {
  const { ctx, repo, data } = await fixture();
  const store = new ModelJobStore(data);
  const a = job(repo);
  const b = job(repo, '1000000', TERMS, JOB_B);
  const lockA = await store.holdRunner(a.id);
  const lockB = await store.holdRunner(b.id);
  const one = withBatch(ctx, async () => batchAnswer());
  const two = withBatch(ctx, async () => batchAnswer());
  // A sends and ends while B runs (B has sent too, so the channel has two jobs on it).
  await two.transport.messages(b, MESSAGES, signal());
  await one.transport.withInferenceRun(a.id, signal(), (t) => t.messages(a, MESSAGES, signal()));
  expect(one.batch.refund).not.toHaveBeenCalled();
  // Both end together: A's lock is not yet released (the store releases it after the run), but A
  // is marked ended, so B's end sees no other job and refunds.
  await two.transport.withInferenceRun(b.id, signal(), (t) => t.messages(b, MESSAGES, signal()));
  expect(two.batch.refund).toHaveBeenCalledTimes(1);
  lockA();
  lockB();
});

it('does not let a stale job record hold a refund back', async () => {
  const { ctx, repo, data } = await fixture();
  const store = new ModelJobStore(data);
  const stale = '8f2f8f0e-2b64-4b4f-9a39-6d3b2f1c0a13';
  const crashed = '9f2f8f0e-2b64-4b4f-9a39-6d3b2f1c0a14';
  // One job opened the channel and never ran again, and one took its runner lock and died.
  const refunds = new NeonRefunds({ dataDir: data, payer: () => ({ refund: async () => ({}) }) });
  await refunds.open(stale, TERMS);
  await refunds.open(crashed, TERMS);
  (await store.holdRunner(crashed))();
  expect(await store.runnerLive(stale)).toBe(false);
  expect(await store.runnerLive(crashed)).toBe(false);
  const a = job(repo);
  const lockA = await store.holdRunner(a.id);
  expect(await store.runnerLive(a.id)).toBe(true);
  const live = withBatch(ctx, async () => batchAnswer());
  await live.transport.withInferenceRun(a.id, signal(), (t) => t.messages(a, MESSAGES, signal()));
  expect(live.batch.refund).toHaveBeenCalledTimes(1);
  lockA();
});

it('waits with the refund where the store cannot say whether another job runs', async () => {
  const { ctx, repo, data } = await fixture();
  const a = job(repo);
  const refunds = new NeonRefunds({ dataDir: data, payer: () => ({ refund: async () => ({}) }) });
  await refunds.open(JOB_B, TERMS);
  const unsure = new NeonTransport({
    dataDir: data,
    ctx,
    provider: {} as never,
    authorizer: {} as never,
    liveJob: async () => {
      throw new Error('the store cannot say');
    },
    batch: () =>
      ({ post: async () => batchAnswer(), refund: vi.fn(), transmitted: false }) as never,
  });
  await unsure.withInferenceRun(a.id, signal(), (t) => t.messages(a, MESSAGES, signal()));
  // Not refunded, not lost: the channel stays open for `tenjin refund`.
  expect((await refunds.entries())[0]).toMatchObject({ state: 'open' });
});

it('starts the timed withdrawal when the seller does not answer, and finishes it after the delay', async () => {
  const { data } = await fixture();
  let now = 1_000;
  const channel = { balance: 50_000n, claimed: 0n, pending: 0n, initiatedAt: 0 };
  const calls: string[] = [];
  const chain = {
    channel: async () => ({
      id: '0xchannel',
      balanceAtomic: channel.balance,
      claimedAtomic: channel.claimed,
      pendingAtomic: channel.pending,
      initiatedAt: channel.initiatedAt,
      delayS: 900,
      nowS: now,
    }),
    initiate: async (_terms: NeonTerms, amount: bigint) => {
      calls.push(`initiate ${amount}`);
      channel.pending = amount;
      channel.initiatedAt = now;
      return '0xinit';
    },
    finalize: async () => {
      calls.push('finalize');
      return '0xfinal';
    },
  };
  const refunds = new NeonRefunds({
    dataDir: data,
    payer: () => ({
      refund: async () => {
        throw new Error('Refund probe expected 402, got 503');
      },
    }),
  });
  await refunds.open('job-a', TERMS);
  expect(await refunds.retry(chain)).toMatchObject([
    { state: 'withdrawal_started', withdrawal: { amountAtomic: '50000', delayS: 900 } },
  ]);
  // Before the delay passes nothing is sent again, and the person is told it waits.
  now += 100;
  expect(await refunds.retry(chain)).toMatchObject([{ state: 'withdrawal_started' }]);
  expect(calls).toEqual(['initiate 50000']);
  now += 900;
  expect(await refunds.retry(chain)).toMatchObject([
    { state: 'withdrawn', transaction: '0xfinal', refundedAtomic: '50000' },
  ]);
  expect(calls).toEqual(['initiate 50000', 'finalize']);
});

it('runs a job with no consent record, and an old consent record left in the settings changes nothing', async () => {
  const { ctx, repo } = await fixture();
  const { transport: neon } = withBatch(ctx, async () => batchAnswer());
  await writeFile(
    join(ctx.dataDir, 'config.json'),
    JSON.stringify({
      router: { neon: true, neonConsent: { version: 1, recipients: ['Old', 'Recipients'] } },
    }),
  );
  await expect(neon.messages(job(repo), MESSAGES, signal())).resolves.toBeTruthy();
});
