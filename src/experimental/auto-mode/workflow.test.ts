import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { encodePaymentRequiredHeader } from '@x402/core/http';
import type { PaymentRequired } from '@x402/core/types';
import { compileResource } from './contracts';
import type { AutoHttpRequest, AutoHttpResponse, AutoPolicy, ExecutionDeps } from './execution';
import { executeWorkflow } from './workflow';
import type { WorkflowInput } from './workflow';

const accepts: PaymentRequired['accepts'] = [
  {
    scheme: 'exact',
    network: 'eip155:8453',
    asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    amount: '7000',
    payTo: '0x1111111111111111111111111111111111111111',
    maxTimeoutSeconds: 300,
    extra: { name: 'USD Coin', version: '2' },
  },
];

function contract(name: string) {
  const compiled = compileResource({
    resource: `https://${name}.example/search`,
    type: 'http',
    accepts,
    x402Version: 2,
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
  });
  if (compiled.status !== 'supported') throw new Error(compiled.reasons.join('; '));
  return compiled.contract;
}

function chain(): WorkflowInput {
  return {
    identity: { sessionId: 'session', requestId: 'chain-1', contextHash: 'intent-context' },
    input: { query: 'x402 discovery' },
    steps: [
      {
        id: 'exa',
        contract: contract('exa-fixture'),
        args: { body: { query: { $input: ['query'] } } },
      },
      {
        id: 'tavily',
        contract: contract('tavily-fixture'),
        args: { body: { query: { $ref: { stepId: 'exa', path: ['results', '0', 'followup'] } } } },
      },
    ],
  };
}

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function setup(options: { cap?: string; firstBody?: string; firstStatus?: number } = {}) {
  const stateDir = await mkdtemp(join(tmpdir(), 'tenjin-workflow-'));
  dirs.push(stateDir);
  const policy: AutoPolicy = {
    runId: 'chain',
    revision: '1',
    authorization: 'auto',
    expiresAtMs: 20_000,
    maxCallAtomic: '100000',
    maxRunAtomic: options.cap ?? '100000',
    allowedOperations: ['workflow'],
  };
  const signPayment = vi.fn(async (quote: PaymentRequired) => ({
    headers: { 'PAYMENT-SIGNATURE': 'fixture' },
    amountAtomic: BigInt(quote.accepts[0]!.amount),
  }));
  const paidInputs: AutoHttpRequest[] = [];
  const transport = vi.fn(
    async (
      request: AutoHttpRequest,
      paymentHeaders?: Record<string, string>,
    ): Promise<AutoHttpResponse> => {
      if (!paymentHeaders)
        return {
          status: 402,
          headers: {
            'PAYMENT-REQUIRED': encodePaymentRequiredHeader({
              x402Version: 2,
              resource: {
                url: request.url,
                description: 'Fixture search',
                mimeType: 'application/json',
              },
              accepts,
            }),
          },
          body: '{}',
        };
      paidInputs.push(request);
      const first = request.url.includes('exa-fixture');
      return {
        status: first ? (options.firstStatus ?? 200) : 200,
        headers: { 'Content-Type': 'application/json' },
        body: first
          ? (options.firstBody ?? '{"results":[{"followup":"independent followup search"}]}')
          : '{"answer":"combined evidence"}',
      };
    },
  );
  const deps: ExecutionDeps = {
    stateDir,
    readPolicy: async () => policy,
    signPayment,
    transport,
    now: () => 1000,
  };
  return { deps, signPayment, transport, paidInputs };
}

describe('bounded workflow execution', () => {
  it('stops chaining after a paid application failure even when the next binding exists', async () => {
    const body = '{"success":false,"results":[{"followup":"do not execute this step"}]}';
    const { deps, signPayment, paidInputs } = await setup({ firstBody: body });
    const workflow = chain();
    workflow.steps[0]!.contract.resultSchema = {
      type: 'object',
      properties: { success: { const: true } },
      required: ['success'],
    };
    const result = await executeWorkflow(workflow, deps);
    expect(result).toMatchObject({ status: 'failed', stoppedAt: 'exa' });
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0]!.execution).toMatchObject({
      status: 'failed',
      amountAtomic: '7000',
      response: { status: 200, body },
    });
    expect(result.steps[0]!.value).toBeUndefined();
    expect(paidInputs).toHaveLength(1);
    expect(signPayment).toHaveBeenCalledOnce();
  });

  it('binds Exa-style output to Tavily-style input and replays both without another signature', async () => {
    const { deps, signPayment, transport, paidInputs } = await setup();
    const workflow = chain();
    const result = await executeWorkflow(workflow, deps);
    expect(result.status).toBe('fulfilled');
    expect(paidInputs.map((request) => JSON.parse(request.body!))).toEqual([
      { query: 'x402 discovery' },
      { query: 'independent followup search' },
    ]);
    expect(signPayment).toHaveBeenCalledTimes(2);
    const replay = await executeWorkflow(workflow, deps);
    expect(replay.status).toBe('fulfilled');
    expect(replay.steps.every((step) => step.execution.cached)).toBe(true);
    expect(signPayment).toHaveBeenCalledTimes(2);
    expect(transport).toHaveBeenCalledTimes(4);
  });

  it('retains one cumulative run cap across steps', async () => {
    const { deps, signPayment, paidInputs } = await setup({ cap: '10000' });
    const result = await executeWorkflow(chain(), deps);
    expect(result).toMatchObject({ status: 'refused', stoppedAt: 'tavily' });
    expect(result.reason).toContain('remaining run cap');
    expect(signPayment).toHaveBeenCalledOnce();
    expect(paidInputs).toHaveLength(1);
  });

  it.each([
    ['missing output', '{}'],
    ['wrong output type', '{"results":[{"followup":17}]}'],
  ])('stops before the next quote on %s', async (_name, firstBody) => {
    const { deps, signPayment, transport } = await setup({ firstBody });
    const result = await executeWorkflow(chain(), deps);
    expect(result).toMatchObject({ status: 'failed', stoppedAt: 'tavily' });
    expect(signPayment).toHaveBeenCalledOnce();
    expect(transport).toHaveBeenCalledTimes(2);
  });

  it('does not execute dependent work after a failed paid response', async () => {
    const { deps, signPayment, transport } = await setup({ firstStatus: 500 });
    const result = await executeWorkflow(chain(), deps);
    expect(result).toMatchObject({ status: 'failed', stoppedAt: 'exa' });
    expect(signPayment).toHaveBeenCalledOnce();
    expect(transport).toHaveBeenCalledTimes(2);
  });

  it.each([
    { $ref: { stepId: 'tavily', path: ['query'] } },
    { $ref: { stepId: 'missing', path: [] } },
    { $input: ['__proto__', 'query'] },
    { $input: ['query'], extra: true },
  ])('rejects invalid or future references before executing any step', async (invalid) => {
    const { deps, signPayment, transport } = await setup();
    const workflow = chain();
    workflow.steps[0]!.args = { body: { query: invalid } };
    expect((await executeWorkflow(workflow, deps)).status).toBe('unsupported');
    expect(signPayment).not.toHaveBeenCalled();
    expect(transport).not.toHaveBeenCalled();
  });

  it('binds cached identity to the full workflow, including later step changes', async () => {
    const { deps, signPayment } = await setup();
    const workflow = chain();
    expect((await executeWorkflow(workflow, deps)).status).toBe('fulfilled');
    workflow.steps[1]!.args = { body: { query: 'changed later request' } };
    expect((await executeWorkflow(workflow, deps)).status).toBe('refused');
    expect(signPayment).toHaveBeenCalledTimes(2);
  });

  it('refuses an unsafe nested target introduced by an earlier paid result before the next quote', async () => {
    const { deps, signPayment, transport } = await setup({
      firstBody: '{"results":[{"followup":"file:///etc/passwd"}]}',
    });
    const result = await executeWorkflow(chain(), deps);
    expect(result).toMatchObject({ status: 'refused', stoppedAt: 'tavily' });
    expect(result.reason).toContain('public HTTPS');
    expect(signPayment).toHaveBeenCalledOnce();
    expect(transport).toHaveBeenCalledTimes(2);
  });

  it('checks nested hostname resolution before any provider request or signing', async () => {
    const { deps, signPayment, transport } = await setup();
    const resolveHostname = vi.fn(async () => [{ address: '10.0.0.7', family: 4 }]);
    deps.nestedTargetValidation = { resolveHostname };
    const workflow = chain();
    workflow.input = { query: 'https://apparently-public.example/page' };
    const result = await executeWorkflow(workflow, deps);
    expect(result).toMatchObject({ status: 'refused', stoppedAt: 'exa' });
    expect(resolveHostname).toHaveBeenCalledWith('apparently-public.example');
    expect(signPayment).not.toHaveBeenCalled();
    expect(transport).not.toHaveBeenCalled();
  });

  it('permits a public nested URL through an injected resolver without real network access', async () => {
    const { deps, signPayment } = await setup();
    const resolveHostname = vi.fn(async () => [{ address: '8.8.8.8', family: 4 }]);
    deps.nestedTargetValidation = { resolveHostname };
    const workflow = chain();
    workflow.input = { query: 'https://public-fixture.example/page' };
    expect((await executeWorkflow(workflow, deps)).status).toBe('fulfilled');
    expect(resolveHostname).toHaveBeenCalledWith('public-fixture.example');
    expect(signPayment).toHaveBeenCalledTimes(2);
  });
});
