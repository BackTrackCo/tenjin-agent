import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { WorkerDiagnosticsRecord } from './model-worker-diagnostics';

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
      stop: { subtype: 'success', turns: 2, stopReason: 'end_turn' },
    });
    expect(written).not.toContain('PRIVATE_');
    if (process.platform !== 'win32') expect((await stat(path)).mode & 0o777).toBe(0o600);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
