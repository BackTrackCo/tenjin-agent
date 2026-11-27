import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { CommandContext } from '../context';
import { ModelJobStore, type ModelJob } from './model-job';
import {
  ModelCallFailed,
  retryableModelCall,
  withModelRetry,
  workerEndText,
} from './model-worker-control';
import { NEON_TURN_MAX_TOKENS } from './neon-chat';
import { NeonTransport, readNeonRecord } from './neon-transport';
import { createLocalSpendAuthorizer } from '../lib/wallet/spend';
import { readSpendSummary, spentOf } from '../lib/spend-ledger';
import {
  VoucherSpend,
  channelDeposit,
  ChannelDepositRefused,
  NEON_CHANNEL_DEPOSIT_CAP_ATOMIC,
  PayeeMismatch,
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
  // The paid ledger names the seller of the saved terms.
  expect(await readFile(join(data, 'paid', 'ledger.jsonl'), 'utf8')).toContain('seller.example');
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
