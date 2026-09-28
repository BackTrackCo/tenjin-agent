import actionFixtures from '../fixtures/review-actions.json';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildRouterMcpServer } from '../mcp';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPublicKey, verify } from 'node:crypto';
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { CommandContext } from '../../context';
import { testWalletProvider } from '../../lib/read-test-utils';
import { prepareReview } from './jobs';
import { actOnReview, quoteReview, reviewStatus, ReviewActionSchema } from './lifecycle';
import { reviewDir, savePrivate } from './store';
let ctx: CommandContext;
let id: string;
const material = {
  title: 'Checkout design review',
  material: 'Delivery address, then payment details, then order confirmation.',
  expertise: 'UX design',
};
beforeEach(async () => {
  ctx = {
    dataDir: await mkdtemp(join(tmpdir(), 'review-lifecycle-')),
    flags: { json: true, timeout: 1000 },
    io: {
      stdout: { write: () => true } as unknown as NodeJS.WritableStream,
      stderr: { write: () => true } as unknown as NodeJS.WritableStream,
      isTTY: false,
    },
  };
  id = (await prepareReview(ctx, 'A second opinion on this design', material)).envelope
    .jobId as string;
  const wallet = await testWalletProvider().describe();
  await savePrivate(join(reviewDir(ctx.dataDir), 'account.json'), {
    wallet: wallet.address,
    apiKey: 'private-provider-key',
    createdAt: new Date().toISOString(),
  });
});
afterEach(async () => {
  await rm(ctx.dataDir, { recursive: true, force: true });
});
function fake() {
  let time = Date.now();
  let body: Record<string, unknown> = {};
  let balance = 1000;
  let accepted = false;
  let approved = false;
  let paid = false;
  let delivered = false;
  let price = 5.9;
  let cap: number | null = null;
  let autoTopup = true;
  let loseCreate = false;
  let loseRelease = false;
  let wrongWorker = false;
  const counts: Record<string, number> = {};
  const application = () => ({
    id: 'app_1',
    bountyId: 'bounty_1',
    humanId: 'human_1',
    humanName: 'Reviewer',
    status: accepted ? 'accepted' : 'pending',
    termsSnapshot: { currency: 'USD', compensation: { type: 'fixed', total: 5 } },
    ...(accepted ? { currentEscrowId: 'child_1' } : {}),
    jobOverview: {
      overallState: paid
        ? 'released'
        : approved
          ? 'approved_awaiting_release'
          : delivered
            ? 'evidence_in_review'
            : 'awaiting_confirmation',
      jobState: paid
        ? 'released'
        : approved
          ? 'approved_awaiting_release'
          : delivered
            ? 'evidence_in_review'
            : 'in_progress',
    },
  });
  const submission = () => ({
    id: 'submission_1',
    bountyId: 'bounty_1',
    applicationId: 'app_1',
    doerHumanId: 'human_1',
    doerName: 'Reviewer',
    status: approved ? 'approved' : 'pending_review',
    textEvidence: 'Show progress, validate fields inline, and show the full price before payment.',
    files: [],
    links: [],
    finalizedAt: '2026-09-28T01:50:00Z',
  });
  const fetchImpl: typeof fetch = async (url, init) => {
    const u = new URL(String(url));
    expect(u.origin).toBe('https://rentahuman.ai');
    expect(init?.redirect).toBe('manual');
    const headers = new Headers(init?.headers);
    expect(headers.get('X-API-Key')).toBe('private-provider-key');
    const b = init?.body ? JSON.parse(String(init.body)) : {};
    const p = u.pathname.replace('/api', '');
    const method = init?.method ?? 'GET';
    counts[`${method} ${p}${b.dryRun ? ' dry' : ''}`] =
      (counts[`${method} ${p}${b.dryRun ? ' dry' : ''}`] ?? 0) + 1;
    if (b.agentVerification || p === '/keys/register-identity') {
      const v = b.agentVerification ?? b;
      const action =
        p === '/keys/register-identity'
          ? `${v.agentId}:register_identity`
          : p === '/bounties'
            ? 'create_bounty'
            : p.includes('/applications/')
              ? 'accept_application:bounty_1:app_1'
              : 'review_submission:bounty_1:submission_1';
      expect(
        verify(
          null,
          Buffer.from(`${v.timestamp}:${v.agentId}:${action}`),
          createPublicKey({ key: Buffer.from(v.publicKey, 'base64'), format: 'der', type: 'spki' }),
          Buffer.from(v.signature, 'base64'),
        ),
      ).toBe(true);
    }
    const ok = (value: object) => Response.json({ success: true, ...value });
    if (p === '/keys/register-identity') return ok({});
    if (p === '/wallet/balance') return ok({ balance });
    if (p === '/wallet/controls') {
      if (method === 'PATCH') {
        cap = b.spendingCapPerBountyCents;
        autoTopup = b.autoTopupEnabled;
      }
      return ok({
        controls: {
          spendingCapPerBountyCents: cap,
          spendingCapRolling24hCents: null,
          autoTopupEnabled: autoTopup,
        },
      });
    }
    if (p === '/bounties' && b.dryRun) return ok({ dryRun: true, fundingTotal: price });
    if (p === '/bounties' && method === 'POST') {
      expect(cap).toBe(590);
      expect(autoTopup).toBe(false);
      expect(b.autoAccept).toBe(false);
      expect(b.spotsAvailable).toBe(1);
      const attempt = JSON.parse(
        await readFile(
          join(
            `${join(reviewDir(ctx.dataDir), 'jobs', `${id}.json`)}.state`,
            'create-attempt.json',
          ),
          'utf8',
        ),
      );
      expect(attempt.body.idempotencyKey).toBe(b.idempotencyKey);
      body = b;
      balance -= 590;
      if (loseCreate) throw Error('lost response private-provider-key');
      return ok({ bountyId: 'bounty_1', escrowId: 'parent_1' });
    }
    if (p === '/bounties/bounty_1')
      return ok({ bounty: { ...body, id: 'bounty_1', status: paid ? 'paid' : 'open' } });
    if (p === '/bounties/bounty_1/applications') return ok({ applications: [application()] });
    if (p === '/bounties/bounty_1/applications/app_1') {
      accepted = true;
      return ok({ escrowId: 'child_1' });
    }
    if (p === '/bounties/bounty_1/submissions')
      return ok({ submissions: delivered ? [submission()] : [] });
    if (p === '/bounties/bounty_1/submissions/submission_1') {
      if (method === 'PATCH') approved = true;
      return ok({ submission: submission() });
    }
    if (p === '/escrow') {
      const base = {
        bountyId: 'bounty_1',
        amount: 590,
        humanPayout: 500,
        platformFee: 90,
        currency: 'usd',
        fundingSource: 'wallet',
      };
      return ok({
        escrows: [
          { ...base, id: 'parent_1', status: 'funded' },
          ...(accepted
            ? [
                {
                  ...base,
                  id: 'child_1',
                  applicationId: 'app_1',
                  humanId: wrongWorker ? 'other' : 'human_1',
                  status: paid ? 'released' : delivered ? 'completed' : 'locked',
                  payoutStatus: paid ? 'paid' : 'hold',
                },
              ]
            : []),
        ],
      });
    }
    if (p === '/escrow/child_1/release') {
      expect(b).toEqual({ applicationId: 'app_1', acknowledgeRelease: true });
      paid = true;
      if (loseRelease)
        return Response.json({ error: 'evidence_approval_pending' }, { status: 503 });
      return ok({ payoutStatus: 'paid' });
    }
    throw Error(`Unexpected request ${method} ${p}`);
  };
  return {
    deps: { fetchImpl, provider: testWalletProvider(), now: () => time },
    counts,
    tick: () => {
      time += 61_000;
    },
    deliver: () => {
      delivered = true;
    },
    priceChange: () => {
      price = 6;
    },
    loseCreate: () => {
      loseCreate = true;
    },
    loseRelease: () => {
      loseRelease = true;
    },
    wrongWorker: () => {
      wrongWorker = true;
    },
    insufficient: () => {
      balance = 100;
    },
    lowerCap: () => {
      cap = 1;
    },
    expire: () => {
      time += 16 * 60_000;
    },
    balance: () => balance,
  };
}
async function quoted(f: ReturnType<typeof fake>) {
  return (await quoteReview(ctx, id, '5', undefined, f.deps)).data as {
    quoteId: string;
    approval: string;
  };
}
async function submitted(f: ReturnType<typeof fake>) {
  const q = await quoted(f);
  return actOnReview(ctx, id, { action: 'submit', ...qFields(q), yes: true }, f.deps);
}
function qFields(q: { quoteId: string; approval: string }) {
  return { quoteId: q.quoteId, approval: q.approval };
}
async function selected(f: ReturnType<typeof fake>) {
  await submitted(f);
  return actOnReview(ctx, id, { action: 'select', applicationId: 'app_1', yes: true }, f.deps);
}
async function evidence(f: ReturnType<typeof fake>) {
  await selected(f);
  f.deliver();
  f.tick();
  const status = await reviewStatus(ctx, id, f.deps);
  const e = (
    status.envelope.submissions as Array<{ submissionId: string; evidenceRevision: string }>
  )[0]!;
  return { submissionId: e.submissionId, evidenceRevision: e.evidenceRevision };
}
it('runs quote → post → selection → finalized evidence → approval → release without extra funding', async () => {
  const f = fake();
  const e = await evidence(f);
  await expect(actOnReview(ctx, id, { action: 'release', yes: true }, f.deps)).rejects.toThrow(
    'approved submission',
  );
  await actOnReview(ctx, id, { action: 'approve', ...e, yes: true }, f.deps);
  const r = await actOnReview(ctx, id, { action: 'release', yes: true }, f.deps);
  expect(r.envelope.status).toBe('paid');
  expect(r.envelope.providerBalanceCents).toBe(410);
  expect(f.balance()).toBe(410);
  expect(JSON.stringify(r)).not.toContain('private-provider-key');
  expect(f.counts['POST /bounties']).toBe(1);
  expect(f.counts['POST /escrow/child_1/release']).toBe(1);
  await actOnReview(ctx, id, { action: 'release', yes: true }, f.deps);
  expect(f.counts['POST /escrow/child_1/release']).toBe(1);
});
it('races two approvals and two selections without duplicate external writes', async () => {
  const f = fake();
  const q = await quoted(f);
  await Promise.all(
    [1, 2].map(() => actOnReview(ctx, id, { action: 'submit', ...qFields(q), yes: true }, f.deps)),
  );
  await Promise.all(
    [1, 2].map(() =>
      actOnReview(ctx, id, { action: 'select', applicationId: 'app_1', yes: true }, f.deps),
    ),
  );
  expect(f.counts['POST /bounties']).toBe(1);
  expect(f.counts['PATCH /bounties/bounty_1/applications/app_1']).toBe(1);
});
it('preserves ambiguous create intent across restart and never creates again', async () => {
  const f = fake();
  f.loseCreate();
  const q = await quoted(f);
  await expect(
    actOnReview(ctx, id, { action: 'submit', ...qFields(q), yes: true }, f.deps),
  ).rejects.toThrow('reconciled');
  const resumed = await actOnReview(
    { ...ctx },
    id,
    { action: 'submit', ...qFields(q), yes: true },
    f.deps,
  );
  expect(resumed.envelope.status).toBe('reconciliation_required');
  expect(f.counts['POST /bounties']).toBe(1);
});
it('reconciles a 503 after release without paying twice', async () => {
  const f = fake();
  const e = await evidence(f);
  await actOnReview(ctx, id, { action: 'approve', ...e, yes: true }, f.deps);
  f.loseRelease();
  const r = await actOnReview(ctx, id, { action: 'release', yes: true }, f.deps);
  expect(r.envelope.status).toBe('paid');
  expect(f.counts['POST /escrow/child_1/release']).toBe(1);
});
it('refuses changed prices, forged approval and stale evidence before mutations', async () => {
  const f = fake();
  const q = await quoted(f);
  await expect(
    actOnReview(ctx, id, { action: 'submit', ...qFields(q), approval: 'wrong', yes: true }, f.deps),
  ).rejects.toThrow('Approval');
  f.priceChange();
  await expect(
    actOnReview(ctx, id, { action: 'submit', ...qFields(q), yes: true }, f.deps),
  ).rejects.toThrow('price changed');
  expect(f.counts['POST /bounties']).toBeUndefined();
});
it('refuses evidence changes and a mismatched worker escrow', async () => {
  const f = fake();
  const e = await evidence(f);
  await expect(
    actOnReview(ctx, id, { action: 'approve', ...e, evidenceRevision: 'wrong', yes: true }, f.deps),
  ).rejects.toThrow('Evidence changed');
  f.wrongWorker();
  await expect(actOnReview(ctx, id, { action: 'release', yes: true }, f.deps)).rejects.toThrow(
    'escrow',
  );
  expect(f.counts['POST /escrow/child_1/release']).toBeUndefined();
});
it('requires explicit action consent, and coalesces status checks', async () => {
  const f = fake();
  await submitted(f);
  const count = f.counts['GET /bounties/bounty_1'];
  await Promise.all([reviewStatus(ctx, id, f.deps), reviewStatus(ctx, id, f.deps)]);
  expect(f.counts['GET /bounties/bounty_1']).toBe(count);
  await expect(
    actOnReview(ctx, id, { action: 'select', applicationId: 'app_1' }, f.deps),
  ).rejects.toThrow();
  expect(f.counts['PATCH /bounties/bounty_1/applications/app_1']).toBeUndefined();
});
it('binds commitments to the current wallet', async () => {
  const f = fake();
  await submitted(f);
  const path = join(reviewDir(ctx.dataDir), 'account.json');
  const account = JSON.parse(await readFile(path, 'utf8'));
  account.wallet = '0x0000000000000000000000000000000000000001';
  await writeFile(path, JSON.stringify(account));
  f.tick();
  await expect(reviewStatus(ctx, id, f.deps)).rejects.toThrow('different wallet');
});

it('exposes quote, submit and applicant selection through the one public MCP tool', async () => {
  const f = fake();
  const server = buildRouterMcpServer({
    dataDir: ctx.dataDir,
    handlerDeps: { cwd: ctx.dataDir, ...f.deps },
  });
  const client = new Client({ name: 'review-test', version: '1' });
  const [c, s] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(c), server.connect(s)]);
  const call = async (jobAction: Record<string, unknown>) => {
    const response = await client.callTool({
      name: 'request',
      arguments: { jobId: id, jobAction },
    });
    expect(response.isError).toBe(false);
    const blocks = response.content as Array<{ text: string }>;
    return JSON.parse(blocks[1]!.text);
  };
  try {
    expect((await client.listTools()).tools.map((t) => t.name)).toEqual(['request']);
    const q = await call({ action: 'quote', price: '5', share: true });
    const posted = await call({ action: 'submit', ...qFields(q), yes: true });
    expect(posted.status).toBe('open');
    const selected = await call({ action: 'select', applicationId: 'app_1', yes: true });
    expect(selected.status).toBe('awaiting_confirmation');
    const bad = await client.callTool({
      name: 'request',
      arguments: { jobId: id, jobAction: { action: 'release' } },
    });
    expect(bad.isError).toBe(true);
    expect(f.counts['POST /escrow/child_1/release']).toBeUndefined();
  } finally {
    await client.close();
    await server.close();
  }
});
it('honors Retry-After without repeating status requests or exposing provider errors', async () => {
  const f = fake();
  await submitted(f);
  f.tick();
  let requests = 0;
  const deps = {
    ...f.deps,
    fetchImpl: (async () => {
      requests++;
      return Response.json(
        { error: 'private-provider-key' },
        { status: 429, headers: { 'Retry-After': '300' } },
      );
    }) as typeof fetch,
  };
  const unavailable = await reviewStatus(ctx, id, deps);
  expect(unavailable.envelope.status).toBe('status_unavailable');
  expect(JSON.stringify(unavailable)).not.toContain('private-provider-key');
  f.tick();
  await reviewStatus(ctx, id, deps);
  expect(requests).toBe(1);
});

it('respects insufficient credit, existing lower caps and expired quotes without posting', async () => {
  const f = fake();
  const q = await quoted(f);
  f.insufficient();
  await expect(
    actOnReview(ctx, id, { action: 'submit', ...qFields(q), yes: true }, f.deps),
  ).rejects.toThrow('insufficient');
  expect(f.counts['POST /bounties']).toBeUndefined();
  const capped = fake();
  const cq = await quoted(capped);
  capped.lowerCap();
  await expect(
    actOnReview(ctx, id, { action: 'submit', ...qFields(cq), yes: true }, capped.deps),
  ).rejects.toThrow('cap is below');
  expect(capped.counts['PATCH /wallet/controls']).toBeUndefined();
  const expired = fake();
  const eq = await quoted(expired);
  expired.expire();
  await expect(
    actOnReview(ctx, id, { action: 'submit', ...qFields(eq), yes: true }, expired.deps),
  ).rejects.toThrow('expired');
  expect(expired.counts['POST /bounties']).toBeUndefined();
});
it('serializes concurrent approval, release and status with one payment', async () => {
  const f = fake();
  const e = await evidence(f);
  await Promise.all(
    [1, 2].map(() => actOnReview(ctx, id, { action: 'approve', ...e, yes: true }, f.deps)),
  );
  const results = await Promise.all([
    actOnReview(ctx, id, { action: 'release', yes: true }, f.deps),
    reviewStatus(ctx, id, f.deps),
    actOnReview(ctx, id, { action: 'release', yes: true }, f.deps),
  ]);
  expect(results[0]!.envelope.status).toBe('paid');
  expect(results[2]!.envelope.status).toBe('paid');
  expect(['approved_awaiting_release', 'paid']).toContain(results[1]!.envelope.status);
  expect((await reviewStatus(ctx, id, f.deps)).envelope.status).toBe('paid');
  expect(f.counts['PATCH /bounties/bounty_1/submissions/submission_1']).toBe(1);
  expect(f.counts['POST /escrow/child_1/release']).toBe(1);
});

it('pins the public request action variants without permitting arbitrary provider operations', () => {
  for (const fixture of actionFixtures)
    expect(ReviewActionSchema.parse(fixture.jobAction)).toEqual(fixture.jobAction);
  expect(
    ReviewActionSchema.safeParse({ action: 'release', yes: true, url: 'https://elsewhere.example' })
      .success,
  ).toBe(false);
});
