import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { query } from '@anthropic-ai/claude-agent-sdk/core';
import { claudeDeepSeekWorkerEnv } from './claude-model-policy';
import { claudeWorkerProcess } from './claude-worker-process';

let dir: string | undefined;
afterEach(async () => {
  vi.unstubAllEnvs();
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

// The SDK copies options.env and Node skips undefined entries, so a cleared key
// is a tombstone the parent's value cannot refill. If either hop ever merged
// process.env back, a worker would hold a provider key, a wallet or a login.
it("keeps the parent's provider, wallet and login keys out of the worker's Claude process", async () => {
  dir = await mkdtemp(join(tmpdir(), 'worker-child-env-'));
  const keys = [
    'DEEPSEEK_API_KEY',
    'OPENAI_API_KEY',
    'TYPESAFE_API_KEY',
    'TENJIN_WALLET_KEY',
    'TENJIN_WALLET_PASSPHRASE',
    'CLAUDE_CODE_OAUTH_TOKEN',
  ];
  for (const key of keys) vi.stubEnv(key, `parent-${key}`);
  const dump = join(dir, 'env.json');
  // A stand-in for the Claude Code binary: it records what arrived, then exits.
  const stub = join(dir, 'claude-stub.mjs');
  await writeFile(
    stub,
    [
      "import { writeFileSync } from 'node:fs';",
      `const keys = ${JSON.stringify([...keys, 'ANTHROPIC_BASE_URL'])};`,
      `writeFileSync(${JSON.stringify(dump)}, JSON.stringify(Object.fromEntries(keys.map((k) => [k, process.env[k] ?? 'absent']))));`,
      'process.exit(1);',
    ].join('\n'),
  );
  const run = query({
    prompt: 'probe',
    options: {
      pathToClaudeCodeExecutable: stub,
      spawnClaudeCodeProcess: claudeWorkerProcess().spawn,
      env: claudeDeepSeekWorkerEnv(process.env, 'http://127.0.0.1:9', 'worker-token'),
    },
  });
  try {
    for await (const message of run) void message;
  } catch {
    // The stand-in exits before the protocol starts.
  }
  const seen = JSON.parse(await readFile(dump, 'utf8')) as Record<string, string>;
  expect(seen.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:9');
  expect(Object.fromEntries(keys.map((key) => [key, seen[key]]))).toEqual(
    Object.fromEntries(keys.map((key) => [key, 'absent'])),
  );
});
