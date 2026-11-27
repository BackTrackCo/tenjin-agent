import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { CommandContext } from '../context';
import type { ModelJob } from './model-job';
import type { ModelCallFailed } from './model-worker-control';
import { isNeonRevisionQuote, neonRevisionApproval, runNeonApprove } from './neon-approve';
import { neonMinimumJobAtomic } from './neon-chat';
import type { NeonTerms } from './neon-terms';
import { neonRoomLeftAtomic, NeonTransport } from './neon-transport';
import { readQuote } from '../lib/spend-quotes';

let dir: string;
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

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
const REPLY = {
  choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'Draft.' } }],
  usage: { prompt_tokens: 40, completion_tokens: 12 },
};
const MESSAGES = {
  max_tokens: 65_536,
  messages: [{ role: 'user', content: [{ type: 'text', text: 'Write it.' }] }],
};

// Failure caught: a revision past the job ceiling was refused at its next call, with the parent
// holding no way on but a new worker, which loses the history. It is asked about before anything
// is sent, and the person's yes puts one more ceiling on the SAME job.
it('asks about a revision past the job ceiling before anything is sent, and the yes keeps the same job', async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), 'neon-approve-')));
  const data = join(dir, 'data');
  const repo = join(dir, 'repo');
  await mkdir(data);
  await mkdir(join(repo, '.git'), { recursive: true });
  await writeFile(join(data, 'config.json'), '{}');
  const ctx = {
    flags: { json: true, timeout: 30_000 },
    dataDir: data,
    io: { stdout: process.stdout, stderr: process.stderr, isTTY: false },
  } as CommandContext;
  const post = vi.fn(async () => ({
    status: 200,
    text: JSON.stringify(REPLY),
    ceilingAtomic: 40_000n,
    costAtomic: 7_321n,
    depositedAtomic: 0n,
  }));
  const neon = new NeonTransport({
    dataDir: data,
    ctx,
    provider: {} as never,
    authorizer: {} as never,
    batch: () => ({ post, refund: async () => ({ success: true }), transmitted: false }) as never,
  });
  const job = {
    id: '6f2f8f0e-2b64-4b4f-9a39-6d3b2f1c0a11',
    sessionId: 's',
    turnId: 't',
    callId: 'c',
    root: repo,
    task: 'Write',
    native: { prompt: 'Write', subagent_type: 'general-purpose' },
    decision: { provider: 'neon', neonTerms: TERMS },
    // Room for the first draft and not for a second call.
    capAtomic: '20000',
    state: 'running',
    expiresAt: Date.now() + 60_000,
  } as unknown as ModelJob;
  const signal = new AbortController().signal;
  await neon.messages(job, MESSAGES, signal);
  const maxJob = 1_000_000n;
  const left = await neonRoomLeftAtomic(data, job, maxJob);
  expect(left).toBeLessThan(neonMinimumJobAtomic(TERMS));

  // The revision is asked about: nothing sent, nothing paid, the quote named in the answer.
  const ask = await neonRevisionApproval(data, job, 'worker-handle', TERMS, maxJob, left);
  expect(ask).toMatchObject({ status: 'needs_approval', action: 'refused', started: false });
  expect(ask.instruction).toContain(`approve({quote: "${ask.quote.id}"`);
  expect(ask.quote.total).toBe('$1');
  const quote = (await readQuote(data, ask.quote.id))!;
  expect(isNeonRevisionQuote(quote)).toBe(true);
  expect(quote.payments).toEqual([{ amountAtomic: '1000000', creator: 'seller.example' }]);
  const refused = await neon.messages(job, MESSAGES, signal).catch((e: unknown) => e);
  expect((refused as ModelCallFailed).detail).toMatchObject({ cause: 'budget', uncharged: true });
  expect(post).toHaveBeenCalledTimes(1);

  // A yes that shows the person other numbers than the quote's grants nothing.
  expect(
    await runNeonApprove({ quote: quote.id, total: '$0.10', what: quote.what }, { dataDir: data }),
  ).toMatchObject({ ok: false });
  expect(await neonRoomLeftAtomic(data, job, maxJob)).toBe(left);
  // The yes puts one more ceiling on the same job, once.
  const yes = await runNeonApprove(
    { quote: quote.id, total: ask.quote.total, what: quote.what },
    { dataDir: data },
  );
  expect(yes).toMatchObject({ ok: true });
  expect(await neonRoomLeftAtomic(data, job, maxJob)).toBe(left + 1_000_000n);
  expect(
    await runNeonApprove(
      { quote: quote.id, total: ask.quote.total, what: quote.what },
      { dataDir: data },
    ),
  ).toMatchObject({ ok: false, reason: expect.stringContaining('already ran') });
  expect(await neonRoomLeftAtomic(data, job, maxJob)).toBe(left + 1_000_000n);
  // The same worker's next call now goes out, on the same record.
  await neon.messages(job, MESSAGES, signal);
  expect(post).toHaveBeenCalledTimes(2);
  // A quote that is not a Neon revision's is none of this module's.
  expect(await runNeonApprove({ quote: 'q_unknown00000' }, { dataDir: data })).toBeNull();
});
