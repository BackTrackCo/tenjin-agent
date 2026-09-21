import { parseArgs } from 'node:util';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { runClaude } from './auto-mode-headless-probe.mjs';
import { checkDemo } from './auto-mode-demo-checks.mjs';
import {
  checkBridgeDemo,
  checkBridgeRoutingDemo,
  checkBridgeNativeDemo,
  parseBridgeExpectation,
} from './auto-mode-bridge-checks.mjs';

const { values } = parseArgs({
  options: {
    config: { type: 'string' },
    model: { type: 'string' },
    transport: { type: 'string', default: 'native' },
    'session-id': { type: 'string' },
    resume: { type: 'string' },
    expectation: { type: 'string' },
    'routing-only': { type: 'boolean', default: false },
    prompt: {
      type: 'string',
      default:
        'Find two authoritative explanations of how x402 payments work. Link both sources and briefly explain what each covers.',
    },
    tool: { type: 'string', default: 'auto' },
  },
});
if (!values.config) throw new Error('--config is required');
const bridge = values.transport === 'bridge';
if (!['native', 'bridge'].includes(values.transport))
  throw new Error('Transport must be native or bridge.');
const model = values.model ?? (bridge ? 'sonnet' : 'haiku');
if (!['haiku', 'sonnet'].includes(model)) throw new Error('Demo model must be haiku or sonnet.');
if (!['WebSearch', 'WebFetch', 'auto'].includes(values.tool))
  throw new Error('Demo tool must be WebSearch, WebFetch, or auto.');
if (bridge && model !== 'sonnet')
  throw new Error('Native auto permission mode requires Sonnet; Haiku is unsupported.');
if (values['session-id'] && values.resume)
  throw new Error('Choose a new --session-id or --resume, not both.');
const configPath = resolve(values.config);
const directory = dirname(configPath);
const config = JSON.parse(await readFile(configPath, 'utf8'));
const expectation = values.expectation
  ? parseBridgeExpectation(JSON.parse(await readFile(resolve(values.expectation), 'utf8')))
  : undefined;
if ((expectation || values['routing-only']) && !bridge)
  throw new Error('Explicit expectations and routing-only validation require bridge transport.');
if (values['routing-only']) {
  if (config.mode !== 'route' || expectation?.scope !== 'routing')
    throw new Error(
      '--routing-only requires config mode route and an expectation with scope routing.',
    );
} else if (expectation?.scope === 'routing' || config.mode === 'route') {
  throw new Error('Route mode requires explicit --routing-only and a routing expectation.');
}
if (expectation?.scope === 'native' && (!config.nativeFallback || values['routing-only']))
  throw new Error(
    'Native expectations require nativeFallback enabled and a non-routing bridge run.',
  );
const sessionId = values.resume ?? values['session-id'] ?? randomUUID();
if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sessionId))
  throw new Error('Session ID must be a UUID.');
const artifacts = join(directory, 'runs', sessionId, ...(values.resume ? [randomUUID()] : []));
await mkdir(artifacts, { recursive: true, mode: 0o700 });
const routingSystemInstruction = values['routing-only']
  ? 'Validation context: This is a routing-only trial. Use the available x402 tool for the user request normally. A result with status prepared records the selected provider and arguments without executing a provider request or payment. Once you receive prepared, stop calling tools and briefly report that selection as a routing-only result. Do not retry a prepared selection, request execution, invent provider output, or claim that the user task was fulfilled.'
  : undefined;
const args = [
  '-p',
  values.prompt,
  '--model',
  model,
  values.resume ? '--resume' : '--session-id',
  sessionId,
  '--tools',
  bridge
    ? config.nativeFallback
      ? 'WebSearch,WebFetch'
      : ''
    : values.tool === 'auto'
      ? 'WebSearch,WebFetch'
      : values.tool,
  '--permission-mode',
  bridge ? 'auto' : 'dontAsk',
  ...(bridge ? ['--mcp-config', join(directory, 'mcp.json')] : []),
  '--strict-mcp-config',
  '--setting-sources',
  '',
  '--settings',
  join(directory, bridge ? 'bridge-settings.json' : 'settings.json'),
  '--disable-slash-commands',
  '--no-chrome',
  ...(routingSystemInstruction ? ['--append-system-prompt', routingSystemInstruction] : []),
  '--max-budget-usd',
  '0.50',
  '--max-turns',
  values['routing-only'] ? '2' : bridge ? '8' : '4',
  '--output-format',
  'stream-json',
  '--verbose',
  '--include-hook-events',
];
const execution = await runClaude(args, directory, bridge ? 180000 : 120000);
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
  validationScope,
  validationNote,
  observedNativeTools,
  nativeToolCalls,
} = bridge
  ? (values['routing-only']
      ? checkBridgeRoutingDemo
      : expectation?.scope === 'native'
        ? checkBridgeNativeDemo
        : checkBridgeDemo)({
      events,
      outcomes: Object.entries(outcomesByToolUseId).map(([id, outcome]) => ({
        event: { tool_use_id: id, session_id: sessionId },
        outcome,
      })),
      execution,
      model,
      sessionId,
      expectation,
    })
  : checkDemo({ events, outcomesByToolUseId, execution, model, tool: values.tool, sessionId });
const report = {
  passed: Object.values(checks).every(Boolean),
  mode: config.mode,
  requestedModel: model,
  transport: values.transport,
  nativeFallbackEnabled: bridge && config.nativeFallback === true,
  observedPermissionMode: init?.permissionMode,
  observedModel: init?.model,
  requestedTool: values.tool,
  observedTool,
  observedTools,
  observedNativeTools,
  nativeToolCalls,
  checks,
  validationScope: validationScope ?? 'research',
  validationNote,
  routingSystemInstruction,
  expectation,
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
