import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { sellerNotice, summary } from './config-neon-probe';

it('prints the same summary for a failed call as for a reply, with the seller notice', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'probe-'));
  try {
    await mkdir(join(dir, 'model-jobs'));
    const id = '6f2f8f0e-2b64-4b4f-9a39-6d3b2f1c0a11';
    await writeFile(
      join(dir, 'model-jobs', `${id}.neon.json`),
      JSON.stringify({
        version: 1,
        jobId: id,
        taskClass: 'writing',
        startedAt: 1,
        wallMs: 0,
        spentAtomic: '26600',
        settledAtomic: '26600',
        signatures: {},
        calls: [
          {
            n: 1,
            at: 1,
            inputTokens: 5678,
            cachedInputTokens: 0,
            outputTokens: 551,
            reasoningTokens: 551,
            maxTokens: 3000,
            quotedAtomic: '40000',
            settledAtomic: '26600',
            settlement: 'settled',
            ok: false,
            ms: 9000,
          },
        ],
      }),
    );
    const raw =
      '{"choices":[{"finish_reason":"length","message":{"content":""}}],"notice":"The model used the whole max_tokens budget on reasoning and stopped before writing a response. Raise max_tokens or lower the reasoning effort."}';
    const result = await summary(
      'x402inference',
      id,
      dir,
      undefined,
      new Error('Worker stopped: output_limit'),
      raw,
    );
    const lines = (result.humanLines ?? []).join('\n');
    expect(result.data).toMatchObject({ ok: false, stop: 'Worker stopped: output_limit' });
    expect(lines).toContain('failed Worker stopped: output_limit');
    expect(lines).toContain('ceiling 40000  charged 26600  output 551  reasoning 551  cached 0');
    expect(lines).toContain('seller notice The model used the whole max_tokens budget');
    expect(sellerNotice('{"a":"fine"}')).toBeUndefined();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
