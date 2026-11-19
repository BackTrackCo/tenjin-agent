import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import {
  WorkerDiagnosticsRecord,
  writeOfferTiming,
  writeWorkerPhases,
} from './model-worker-diagnostics';

// The plan's harness section: tool and MCP inventories, root and commit, reasoning
// replay, output and context settings, stop subtype and repeat traces, kept bounded.
it('keeps how a worker ran, names and counts only, beside the job and readable by its user alone', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'tenjin-diagnostics-'));
  try {
    const record = new WorkerDiagnosticsRecord('/no/such/repo', 786_432, 65_536);
    record.init({
      model: 'deepseek-flash[1m]',
      tools: ['Bash', 'Read'],
      mcp_servers: [{ name: 'serena', status: 'connected', secret: 'PRIVATE_' }],
    });
    // Each turn's reasoning goes back, a plain-text turn's too.
    record.request({
      max_tokens: 32_000,
      thinking: { type: 'adaptive' },
      messages: [
        { role: 'user', content: 'PRIVATE_ASSIGNMENT' },
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'PRIVATE_REASONING' },
            { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } },
          ],
        },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'x' }] },
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'more' },
            { type: 'text', text: 'Done.' },
          ],
        },
      ],
    });
    record.repeat('Bash', 'the same tool and arguments have repeated 3 times consecutively.');
    record.repeat('Read', undefined);
    record.retry(1, { cause: 'provider', status: 500 });
    // Start phases, from the accept on, each the first time it is reached.
    record.accepted(1_000, { cliProcess: 400, checked: 1_020, qualified: 1_350 });
    record.mark('childReady', 2_900);
    record.mark('childReady', 9_999);
    record.stop({ subtype: 'success', num_turns: 2, stop_reason: 'end_turn' });
    await record.write(dataDir, 'job-1');
    const path = join(dataDir, 'model-jobs', 'job-1.diagnostics.json');
    const written = await readFile(path, 'utf8');
    expect(JSON.parse(written)).toEqual({
      version: 1,
      root: '/no/such/repo',
      model: 'deepseek-flash[1m]',
      tools: ['Bash', 'Read'],
      mcpServers: [{ name: 'serena', status: 'connected' }],
      settings: {
        outputCap: 65_536,
        maxOutputTokens: 32_000,
        compactWindow: 786_432,
        thinking: ['adaptive'],
        maxTurns: null,
      },
      reasoning: { turns: 2, withThinking: 2, textTurns: 1, textWithThinking: 1 },
      repeats: [{ tool: 'Bash', count: 3 }],
      retries: [{ attempt: 1, cause: 'provider', status: 500 }],
      phases: { cliProcess: -600, checked: 20, qualified: 350, childReady: 1_900 },
      start: {},
      calls: [],
      callTotals: { count: 0 },
      stop: { subtype: 'success', turns: 2, stopReason: 'end_turn' },
    });
    expect(written).not.toContain('PRIVATE_');
    if (process.platform !== 'win32') expect((await stat(path)).mode & 0o777).toBe(0o600);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

// Operator item of 2026-11-18: say where a 99 s job of four tool uses spent its time, and
// whether two jobs waited on each other. Numbers only, bounded.
it('keeps each model call: its wait for the lane, its round trips, its tokens and the tool time before it', () => {
  const record = new WorkerDiagnosticsRecord('/no/such/repo', 786_432, 65_536);
  record.accepted(1_000);
  const first = record.call(1_500);
  first.prepared(1_520);
  // A second request of the same worker while the first is in flight.
  const side = record.call(1_600);
  first.done(
    {
      usage: {
        input_tokens: 27_000,
        cache_read_input_tokens: 640,
        output_tokens: 200,
        output_tokens_details: { thinking_tokens: 16 },
        text: 'PRIVATE_',
      },
      tries: 1,
      timing: {
        slot: 1,
        quoteMs: 180.4,
        laneWaitMs: 12_000,
        signMs: 40,
        answerMs: 2_900,
        laneMoved: true,
        waitedOn: 'other_process',
        paceWaitMs: 41_250,
      },
    },
    17_000,
  );
  side.done({ tries: 2 }, 17_100);
  // A web search the bridge answered is no model call.
  record.call(17_150).drop();
  const next = record.call(19_100);
  next.done(
    {
      usage: { output_tokens: 5 },
      // Fixed codes only: any other value is left out.
      timing: { slot: 1, laneWaitMs: 3, waitedOn: 'PRIVATE_' as never, laneMoved: 1 as never },
    },
    20_000,
  );
  const { calls, callTotals, phases } = record.snapshot();
  expect(calls).toEqual([
    {
      at: 500,
      live: 0,
      prepMs: 20,
      ms: 15_500,
      inputTokens: 27_000,
      cachedTokens: 640,
      outputTokens: 200,
      thinkingTokens: 16,
      slot: 1,
      quoteMs: 180,
      laneWaitMs: 12_000,
      signMs: 40,
      answerMs: 2_900,
      laneMoved: true,
      waitedOn: 'other_process',
      paceWaitMs: 41_250,
    },
    { at: 600, live: 1, ms: 15_500, tries: 2, failed: true },
    { at: 18_100, live: 0, gapMs: 2_000, ms: 900, outputTokens: 5, slot: 1, laneWaitMs: 3 },
  ]);
  expect(callTotals).toEqual({
    count: 3,
    ms: 31_900,
    gapMs: 2_000,
    prepMs: 20,
    outputTokens: 205,
    quoteMs: 180,
    laneWaitMs: 12_003,
    signMs: 40,
    answerMs: 2_900,
    paceWaitMs: 41_250,
    failed: 1,
  });
  expect(phases.lastAnswer).toBe(19_000);
  expect(JSON.stringify(record.snapshot())).not.toContain('PRIVATE_');
  // Past the kept calls, only the sums grow.
  for (let i = 0; i < 100; i++) record.call(30_000).done({ usage: {} }, 30_010);
  expect(record.snapshot().calls).toHaveLength(64);
  expect(record.snapshot().callTotals.count).toBe(103);
});

it('keeps the time before an offer, also for an offer nobody accepts, and the ends of the accept call', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'tenjin-diagnostics-'));
  try {
    const path = join(dataDir, 'model-jobs', 'job-2.diagnostics.json');
    await writeOfferTiming(dataDir, 'job-2', {
      at: 10_000,
      action: 'offer',
      marks: {
        job: 10_150,
        routeSent: 10_300,
        routeAnswered: 12_400,
        decided: 12_410,
        warm: 12_420,
        returned: 12_421,
        other: 99,
      },
      routeFetchMs: [200.2, 1_900],
    });
    const offer = {
      at: 10_000,
      action: 'offer',
      marks: {
        job: 150,
        routeSent: 300,
        routeAnswered: 2_400,
        decided: 2_410,
        warm: 2_420,
        returned: 2_421,
      },
      routeFetchMs: [200, 1_900],
    };
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ version: 1, offer });
    // The worker's own record keeps it, and counts its two ends from the accept.
    const record = new WorkerDiagnosticsRecord('/no/such/repo', 786_432, 65_536);
    record.accepted(15_000);
    record.fact('envKept', true);
    record.fact('promptReadMs', 3.6);
    await record.write(dataDir, 'job-2');
    await writeWorkerPhases(dataDir, 'job-2', 15_000, {
      workerReturned: 40_000,
      refundClosed: 40_100,
      handbackStored: 40_150,
      answered: 40_160,
    });
    const kept = JSON.parse(await readFile(path, 'utf8'));
    expect(kept.offer).toEqual(offer);
    expect(kept.start).toEqual({ envKept: true, promptReadMs: 4 });
    expect(kept.phases).toEqual({
      offerCaptured: -5_000,
      offerReturned: -2_579,
      workerReturned: 25_000,
      refundClosed: 25_100,
      handbackStored: 25_150,
      answered: 25_160,
    });
    if (process.platform !== 'win32') expect((await stat(path)).mode & 0o777).toBe(0o600);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
