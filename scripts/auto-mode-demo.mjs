import { parseArgs } from 'node:util';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { runClaude } from './auto-mode-headless-probe.mjs';
import { checkDemo } from './auto-mode-demo-checks.mjs';

const { values } = parseArgs({
  options: {
    config: { type: 'string' },
    model: { type: 'string', default: 'haiku' },
    prompt: {
      type: 'string',
      default:
        'Use WebSearch to find official x402 protocol documentation. Give two source links with a one-sentence description of each.',
    },
    tool: { type: 'string', default: 'WebSearch' },
  },
});
if (!values.config) throw new Error('--config is required');
if (!['haiku', 'sonnet'].includes(values.model))
  throw new Error('Demo model must be haiku or sonnet.');
if (!['WebSearch', 'WebFetch', 'auto'].includes(values.tool))
  throw new Error('Demo tool must be WebSearch, WebFetch, or auto.');
const configPath = resolve(values.config);
const directory = dirname(configPath);
const config = JSON.parse(await readFile(configPath, 'utf8'));
const sessionId = randomUUID();
const artifacts = join(directory, 'runs', sessionId);
await mkdir(artifacts, { recursive: true, mode: 0o700 });
const args = [
  '-p',
  values.prompt,
  '--model',
  values.model,
  '--session-id',
  sessionId,
  '--tools',
  values.tool === 'auto' ? 'WebSearch,WebFetch' : values.tool,
  '--permission-mode',
  'dontAsk',
  '--strict-mcp-config',
  '--setting-sources',
  '',
  '--settings',
  join(directory, 'settings.json'),
  '--disable-slash-commands',
  '--no-chrome',
  '--max-budget-usd',
  '0.50',
  '--max-turns',
  '4',
  '--output-format',
  'stream-json',
  '--verbose',
  '--include-hook-events',
];
const execution = await runClaude(args, directory, 120000);
await writeFile(join(artifacts, 'stream.jsonl'), execution.stdout, { mode: 0o600 });
await writeFile(join(artifacts, 'stderr.txt'), execution.stderr, { mode: 0o600 });
const events = execution.stdout
  .split('\n')
  .filter(Boolean)
  .flatMap((line) => {
    try {
      return [JSON.parse(line)];
    } catch {
      return [];
    }
  });
const init = events.find((e) => e.type === 'system' && e.subtype === 'init');
const result = events.findLast((e) => e.type === 'result');
const calls = events.flatMap((e) =>
  e.type === 'assistant' ? (e.message?.content ?? []).filter((b) => b.type === 'tool_use') : [],
);
const outcomesByToolUseId = Object.create(null);
for (const id of new Set(calls.map((call) => call.id))) {
  if (typeof id !== 'string' || !id) continue;
  const key = createHash('sha256')
    .update(JSON.stringify({ session: sessionId, request: id, mode: config.mode }))
    .digest('hex');
  try {
    outcomesByToolUseId[id] = JSON.parse(
      await readFile(join(config.stateDir, 'outcomes', `${key}.json`), 'utf8'),
    );
  } catch {
    // A missing or malformed per-event outcome must fail validation.
  }
}
const outcome = calls.length === 1 ? outcomesByToolUseId[calls[0].id] : undefined;
const {
  checks,
  citedReturnedUrls,
  observedTool,
  observedTools,
  perCallOutcomes,
  totalAmountAtomic,
} = checkDemo({
  events,
  outcomesByToolUseId,
  execution,
  model: values.model,
  tool: values.tool,
  sessionId,
});
const report = {
  passed: Object.values(checks).every(Boolean),
  mode: config.mode,
  requestedModel: values.model,
  observedModel: init?.model,
  requestedTool: values.tool,
  observedTool,
  observedTools,
  checks,
  citedReturnedUrls,
  sessionId,
  artifacts,
  provider: outcome?.selected?.url,
  executorStatus: outcome?.status,
  executorReason: outcome?.reason,
  amountAtomic: outcome?.execution?.amountAtomic,
  settlement: outcome?.execution?.settlement,
  perCallOutcomes,
  totalAmountAtomic,
  inferenceCostUsd: result?.total_cost_usd,
  finalText: result?.result,
  process: { exitCode: execution.code, timedOut: execution.timedOut },
};
await writeFile(join(artifacts, 'report.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
process.exitCode = report.passed ? 0 : 1;
