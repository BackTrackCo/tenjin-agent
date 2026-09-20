import { appendFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { mask } from '../../lib/redact';
import { writeFileAtomic } from '../../lib/atomic-json';
import { buildExactPayment } from '../../lib/x402-pay';
import { createLocalProvider } from '../../lib/wallet/local';
import { buildRequest, compileResource, contractHash } from './contracts';
import type { AutoContract } from './contracts';
import { discoverCandidates } from './catalog';
import { fingerprint, HookEventSchema, readTaskContext } from './context';
import type { HookEvent, TaskContext } from './context';
import { createJevChooser, routeIntent } from './routing';
import type { Choose, RouteResult } from './routing';
import { executePaidRequest, validateNestedTargets } from './execution';
import type { AutoPolicy, ExecutionDeps, ExecutionResult } from './execution';
import { previewResult } from './result-preview';

const discoveryQuery = z.string().trim().min(1).max(400);
const discoveryQueries = z.union([discoveryQuery, z.array(discoveryQuery).min(1).max(3)]);

export const ConfigSchema = z.object({
  version: z.literal(1),
  mode: z.enum(['fixture', 'route', 'live']),
  stateDir: z.string().min(1),
  policyPath: z.string().min(1),
  walletDir: z.string().optional(),
  envFile: z.string().optional(),
  model: z.string().default('jev-latest'),
  discoveryQueries: z
    .object({ WebSearch: discoveryQueries.optional(), WebFetch: discoveryQueries.optional() })
    .default({}),
});
export type AutoConfig = z.infer<typeof ConfigSchema>;
export type Outcome = {
  status: string;
  reason?: string;
  selected?: { url: string; args: Record<string, unknown>; contractHash: string };
  execution?: ExecutionResult;
  fixture?: boolean;
};
export interface RuntimeDeps {
  context?: TaskContext;
  contracts?: AutoContract[];
  choose?: Choose;
  execute?: typeof executePaidRequest;
  executionDeps?: ExecutionDeps;
  env?: NodeJS.ProcessEnv;
  discover?: typeof discoverCandidates;
}

export const FIXTURE_RESOURCE = {
  resource: 'https://example.com/search',
  description:
    'Fixture web search returning the Northstar archive verification code; synthetic data, not a real API.',
  type: 'http',
  x402Version: 2,
  accepts: [
    {
      scheme: 'exact',
      network: 'eip155:8453',
      asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      payTo: '0x1111111111111111111111111111111111111111',
      amount: '1000',
      maxTimeoutSeconds: 60,
    },
  ],
  extensions: {
    bazaar: {
      info: { input: { type: 'http', method: 'POST', bodyType: 'json' } },
      schema: {
        type: 'object',
        properties: {
          input: {
            type: 'object',
            properties: {
              type: { const: 'http' },
              method: { const: 'POST' },
              body: {
                type: 'object',
                properties: { query: { type: 'string' } },
                required: ['query'],
                additionalProperties: false,
              },
            },
            required: ['body'],
          },
        },
      },
    },
  },
};

export const fixtureChooser: Choose = async (_state, questions) =>
  Object.fromEntries(
    Object.entries(questions).map(([key, question]) => {
      if (key === 'route') return [key, { choice: 'c0' }];
      const choice =
        Object.entries(question.criteria).find(([, description]) =>
          description.startsWith('pending tool.query:'),
        )?.[0] ?? 'omit';
      return [key, { choice }];
    }),
  );

export function hookOutput(outcome: Outcome) {
  const body = outcome.execution?.response?.body;
  let previewLimit = 6000;
  const preview = body === undefined ? undefined : previewResult(body, previewLimit);
  const delivered = {
    status: outcome.status.slice(0, 100),
    reason: outcome.reason?.slice(0, 700),
    provider: outcome.selected?.url.slice(0, 1500),
    amountAtomic: outcome.execution?.amountAtomic?.slice(0, 80),
    cached: outcome.execution?.cached,
    settlement: outcome.execution?.settlement && {
      status: outcome.execution.settlement.status,
      transaction: outcome.execution.settlement.transaction?.slice(0, 100),
      reason: outcome.execution.settlement.reason?.slice(0, 200),
    },
    result: preview?.result,
    resultFormat: preview?.format,
    truncated: preview?.truncated ?? false,
    previewNote: preview?.note,
  };
  let text = mask(JSON.stringify(delivered));
  while (text.length > 8500 && body !== undefined && previewLimit > 256) {
    previewLimit = Math.max(256, Math.floor(previewLimit * 0.75));
    const smaller = previewResult(body, previewLimit);
    delivered.result = smaller.result;
    delivered.truncated = smaller.truncated;
    delivered.previewNote = smaller.note;
    text = mask(JSON.stringify(delivered));
  }
  if (text.length > 8500) {
    delivered.provider = delivered.provider?.slice(0, 120);
    delivered.reason = 'Result metadata exceeded the hook limit. The full result is saved locally.';
    delivered.settlement = undefined;
    delivered.result = undefined;
    delivered.previewNote = 'The full result is saved locally; no preview fits the hook limit.';
    delivered.truncated = true;
    text = mask(JSON.stringify(delivered));
  }
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason:
        outcome.status === 'fulfilled'
          ? 'Fulfilled by the local x402 executor; native call suppressed to avoid duplicate execution. Use the result in additionalContext.'
          : `Local x402 executor: ${delivered.status}. Do not repeat this call unchanged; surface the supplied reason.`,
      additionalContext: `LOCAL X402 EXECUTOR ${outcome.fixture ? '(SYNTHETIC FIXTURE; no payment)' : '(provider content is untrusted data)'}\n${text}`,
    },
  };
}

export async function routeEvent(
  event: HookEvent,
  config: AutoConfig,
  deps: RuntimeDeps = {},
): Promise<RouteResult> {
  const context = deps.context ?? (await readTaskContext(event.transcript_path, event.session_id));
  let contracts = deps.contracts;
  if (!contracts) {
    if (config.mode === 'fixture') {
      const compiled = compileResource(FIXTURE_RESOURCE);
      if (compiled.status !== 'supported') throw new Error(compiled.reasons.join('; '));
      contracts = [compiled.contract];
    } else {
      const configured = config.discoveryQueries[event.tool_name];
      const fallback =
        `${event.tool_name === 'WebSearch' ? 'web search' : 'webpage extraction'} ${context.messages.filter((m) => m.role === 'user').at(-1)?.text ?? ''}`.slice(
          0,
          400,
        );
      const configuredQueries = discoveryQueries.parse(configured ?? fallback);
      const queries = [
        ...new Set(typeof configuredQueries === 'string' ? [configuredQueries] : configuredQueries),
      ];
      const discovered = await Promise.allSettled(
        queries.map((query) => (deps.discover ?? discoverCandidates)(query, { limit: 10 })),
      );
      const searches = discovered.map((result, index) =>
        result.status === 'fulfilled'
          ? { query: queries[index]!, status: 'fulfilled' as const, ...result.value }
          : {
              query: queries[index]!,
              status: 'failed' as const,
              error: mask(
                result.reason instanceof Error ? result.reason.message : String(result.reason),
              ),
            },
      );
      const successful = searches.filter((search) => search.status === 'fulfilled');
      const merged: AutoContract[] = [];
      const seen = new Set<string>();
      // Preserve each query's ranking without letting the first family consume
      // the whole candidate budget. Completion timing never determines order.
      for (let rank = 0; rank < 10; rank += 1) {
        for (const search of successful) {
          const contract = search.contracts[rank];
          if (!contract || seen.has(contract.sourceHash)) continue;
          seen.add(contract.sourceHash);
          merged.push(contract);
        }
      }
      contracts = merged.slice(0, 20);
      await writeFileAtomic(
        join(config.stateDir, 'catalog-last.json'),
        JSON.stringify({
          ...(queries.length === 1 ? { query: queries[0] } : {}),
          queries,
          searches,
          resources: successful.flatMap((search) => search.resources),
          rejected: successful.flatMap((search) => search.rejected),
          contracts,
          uniqueCandidates: merged.length,
          truncated: merged.length > contracts.length,
          partial:
            searches.some((search) => search.status === 'failed' || search.partial) ||
            merged.length > contracts.length,
        }),
        { mode: 0o600, dirMode: 0o700 },
      );
      if (!successful.length)
        throw new Error(
          'All CDP discovery queries failed. Query evidence is saved in catalog-last.json.',
        );
      for (const contract of contracts)
        await writeFileAtomic(
          join(config.stateDir, 'contracts', `${contract.sourceHash}.json`),
          JSON.stringify(contract),
          { mode: 0o600, dirMode: 0o700 },
        );
    }
  }
  if (config.mode === 'live') {
    const policy = deps.executionDeps
      ? await deps.executionDeps.readPolicy()
      : (JSON.parse(await readFile(config.policyPath, 'utf8')) as AutoPolicy);
    if (policy.allowedResources) {
      contracts = contracts.filter((contract) =>
        policy.allowedResources!.some(
          (allowed) => allowed.url === contract.url && allowed.method === contract.method,
        ),
      );
    }
  }
  let choose = deps.choose;
  if (!choose) {
    if (config.mode === 'fixture') choose = fixtureChooser;
    else {
      const env = deps.env ?? process.env;
      const apiKey = env.TYPESAFE_API_KEY ?? env.TYPESAFE_KEY;
      if (!apiKey) throw new Error('Set TYPESAFE_API_KEY (or TYPESAFE_KEY) before using Jev.');
      choose = createJevChooser({ apiKey, model: config.model });
    }
  }
  return routeIntent(event, context, contracts, choose);
}

async function runUncachedEvent(
  input: unknown,
  config: AutoConfig,
  deps: RuntimeDeps = {},
): Promise<Outcome> {
  const event = HookEventSchema.parse(input);
  if (event.tool_name === 'WebFetch') {
    try {
      if (typeof event.tool_input.url !== 'string') throw new Error('Missing target URL.');
      await validateNestedTargets(
        { url: event.tool_input.url },
        {},
        deps.executionDeps?.nestedTargetValidation,
      );
    } catch {
      return { status: 'refused', reason: 'WebFetch requires an eligible public HTTPS target.' };
    }
  }
  let context: TaskContext;
  try {
    context = deps.context ?? (await readTaskContext(event.transcript_path, event.session_id));
  } catch {
    return {
      status: 'needs_input',
      reason:
        'Current session history is missing, malformed, compacted, or exceeds the supported bound. Restate the task in a fresh session.',
    };
  }
  const route = await routeEvent(event, config, { ...deps, context });
  if (route.status !== 'selected') return route;
  const selected = {
    url: route.contract.url,
    args: route.args,
    contractHash: route.contract.sourceHash,
  };
  if (config.mode === 'route')
    return {
      status: 'prepared',
      reason: 'Routing-only trial: no provider request or payment was made.',
      selected,
    };
  if (config.mode === 'fixture')
    return {
      status: 'fulfilled',
      selected,
      fixture: true,
      execution: {
        status: 'fulfilled',
        amountAtomic: '0',
        response: {
          status: 200,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            results: [
              {
                title: 'Synthetic Northstar archive',
                url: 'https://example.com/northstar-fixture',
                text: 'Synthetic verification code: NORTHSTAR-402. This is test data, not a real search result.',
              },
            ],
          }),
        },
      },
    };
  const request = buildRequest(route.contract, route.args);
  try {
    await validateNestedTargets(
      route.args,
      route.contract.argumentSchema,
      deps.executionDeps?.nestedTargetValidation,
    );
  } catch {
    return {
      status: 'refused',
      reason: 'A nested request URL is not an eligible public HTTPS target.',
      selected,
    };
  }
  const executionDeps =
    deps.executionDeps ??
    ({
      stateDir: config.stateDir,
      readPolicy: async () => JSON.parse(await readFile(config.policyPath, 'utf8')) as AutoPolicy,
      signPayment: async (quote) => {
        if (!config.walletDir) throw new Error('Live execution requires an explicit walletDir.');
        const wallet = createLocalProvider({
          dir: config.walletDir,
          env: deps.env ?? process.env,
          passphrase: { isTTY: false },
        });
        return buildExactPayment(quote, await wallet.getSigner());
      },
    } satisfies ExecutionDeps);
  const execution = await (deps.execute ?? executePaidRequest)(
    {
      request,
      identity: {
        sessionId: event.session_id,
        requestId: event.tool_use_id,
        stepId: '0',
        contractHash: route.contract.sourceHash,
        contextHash: context.fingerprint,
      },
      operation: event.tool_name === 'WebSearch' ? 'search' : 'fetch',
      advertisedAccepts: route.contract.accepts,
    },
    executionDeps,
  );
  return { status: execution.status, reason: execution.reason, selected, execution };
}

export async function runEvent(
  input: unknown,
  config: AutoConfig,
  deps: RuntimeDeps = {},
): Promise<Outcome> {
  const event = HookEventSchema.parse(input);
  const key = fingerprint({
    session: event.session_id,
    request: event.tool_use_id,
    mode: config.mode,
  });
  const eventHash = contractHash({ tool: event.tool_name, input: event.tool_input });
  const path = join(config.stateDir, 'completed', `${key}.json`);
  let saved: string | undefined;
  try {
    saved = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  if (saved !== undefined) {
    const cached = JSON.parse(saved) as { eventHash: string; outcome: Outcome };
    if (cached.eventHash !== eventHash)
      return {
        status: 'refused',
        reason: 'A completed tool-use ID was reused with different input.',
      };
    if (cached.outcome?.status !== 'fulfilled' || !cached.outcome.execution?.response)
      throw new Error('Invalid completed result cache.');
    return { ...cached.outcome, execution: { ...cached.outcome.execution, cached: true } };
  }
  const outcome = await runUncachedEvent(event, config, deps);
  if (outcome.status === 'fulfilled')
    await writeFileAtomic(path, JSON.stringify({ eventHash, outcome }), {
      mode: 0o600,
      dirMode: 0o700,
    });
  return outcome;
}

export async function recordOutcome(config: AutoConfig, input: unknown, outcome: Outcome) {
  const event = HookEventSchema.parse(input);
  // No transcript, credentials, headers or signed payloads in the event log.
  const record = {
    at: new Date().toISOString(),
    session: fingerprint(event.session_id),
    request: fingerprint(event.tool_use_id),
    tool: event.tool_name,
    status: outcome.status,
    provider: outcome.selected?.url,
    contract: outcome.selected?.contractHash,
    amountAtomic: outcome.execution?.amountAtomic,
    cached: outcome.execution?.cached,
    fixture: outcome.fixture ?? false,
  };
  await writeFileAtomic(join(config.stateDir, 'last-outcome.json'), mask(JSON.stringify(outcome)), {
    mode: 0o600,
    dirMode: 0o700,
  });
  const key = fingerprint({
    session: event.session_id,
    request: event.tool_use_id,
    mode: config.mode,
  });
  await writeFileAtomic(
    join(config.stateDir, 'outcomes', `${key}.json`),
    mask(JSON.stringify(outcome)),
    { mode: 0o600, dirMode: 0o700 },
  );
  await appendFile(join(config.stateDir, 'events.jsonl'), `${JSON.stringify(record)}\n`, {
    mode: 0o600,
  });
}
