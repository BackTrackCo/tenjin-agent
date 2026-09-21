import { buildRequest, contractHash, decodeResult } from './contracts';
import type { AutoContract } from './contracts';
import { executePaidRequest, NestedTargetError, validateNestedTargets } from './execution';
import type { AutoRequestIdentity, ExecutionDeps, ExecutionResult } from './execution';

/** References substitute data only. They never evaluate expressions or change endpoints. */
export type ArgumentTemplate =
  | null
  | boolean
  | number
  | string
  | ArgumentTemplate[]
  | { $input: string[] }
  | { $ref: { stepId: string; path: string[] } }
  | { [key: string]: ArgumentTemplate };

export interface WorkflowStep {
  id: string;
  contract: AutoContract;
  args: ArgumentTemplate;
  /** Explicit structured policy scope. Omission requires the operator to permit "workflow". */
  operation?: string;
}

export interface WorkflowInput {
  steps: WorkflowStep[];
  input: unknown;
  identity: Pick<AutoRequestIdentity, 'sessionId' | 'requestId' | 'contextHash'>;
}

export interface WorkflowResult {
  status: ExecutionResult['status'];
  reason?: string;
  stoppedAt?: string;
  steps: Array<{ id: string; execution: ExecutionResult; value?: unknown }>;
}

const forbidden = new Set(['__proto__', 'constructor', 'prototype']);
const MAX_STEPS = 10;
const MAX_TEMPLATE_BYTES = 64 * 1024;
const MAX_DEPTH = 16;

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Expected an object');
  return value as Record<string, unknown>;
}

function path(value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    value.length > MAX_DEPTH ||
    value.some((part) => typeof part !== 'string' || part.length > 256 || forbidden.has(part))
  )
    throw new Error('Invalid or unsafe reference path');
  return value as string[];
}

function checkTemplate(value: unknown, prior: Set<string>, depth = 0): void {
  if (depth > MAX_DEPTH) throw new Error('Argument template exceeds nesting limit');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (Array.isArray(value)) {
    for (const item of value) checkTemplate(item, prior, depth + 1);
    return;
  }
  const template = object(value);
  const keys = Object.keys(template);
  if (keys.some((key) => forbidden.has(key))) throw new Error('Unsafe template property');
  if (Object.hasOwn(template, '$input')) {
    if (keys.length !== 1) throw new Error('An input reference cannot have extra properties');
    path(template.$input);
  } else if (Object.hasOwn(template, '$ref')) {
    if (keys.length !== 1) throw new Error('A result reference cannot have extra properties');
    const reference = object(template.$ref);
    if (Object.keys(reference).sort().join(',') !== 'path,stepId')
      throw new Error('A result reference requires only stepId and path');
    if (typeof reference.stepId !== 'string' || !prior.has(reference.stepId))
      throw new Error('Result references must identify an earlier step');
    path(reference.path);
  } else {
    for (const entry of Object.values(template)) checkTemplate(entry, prior, depth + 1);
  }
}

function getPath(value: unknown, parts: string[]): unknown {
  let current = value;
  for (const part of parts) {
    if (current === null || typeof current !== 'object' || !Object.hasOwn(current, part))
      throw new Error(`Reference path does not exist: ${parts.join('.')}`);
    if (Array.isArray(current) && !/^(0|[1-9]\d*)$/.test(part))
      throw new Error('Array references require a numeric element index');
    current = (current as Record<string, unknown>)[part];
  }
  return structuredClone(current);
}

function bind(template: ArgumentTemplate, input: unknown, results: Map<string, unknown>): unknown {
  if (template === null || typeof template !== 'object') return template;
  if (Array.isArray(template)) return template.map((value) => bind(value, input, results));
  if (Object.hasOwn(template, '$input')) return getPath(input, path(object(template).$input));
  if (Object.hasOwn(template, '$ref')) {
    const reference = object(object(template).$ref);
    const stepId = reference.stepId as string;
    if (!results.has(stepId)) throw new Error(`Missing result for step ${stepId}`);
    return getPath(results.get(stepId), path(reference.path));
  }
  return Object.fromEntries(
    Object.entries(template).map(([key, value]) => [key, bind(value, input, results)]),
  );
}

/** Every step uses the same paid executor, run ledger, and fresh structured policy. */
export async function executeWorkflow(
  workflow: WorkflowInput,
  deps: ExecutionDeps,
): Promise<WorkflowResult> {
  const completed: WorkflowResult['steps'] = [];
  let workflowHash: string;
  try {
    if (
      !Array.isArray(workflow.steps) ||
      workflow.steps.length < 1 ||
      workflow.steps.length > MAX_STEPS
    )
      throw new Error('Workflow requires between one and ten ordered steps');
    const templates = JSON.stringify({
      input: workflow.input,
      steps: workflow.steps.map(({ id, args, operation }) => ({ id, args, operation })),
    });
    if (Buffer.byteLength(templates) > MAX_TEMPLATE_BYTES)
      throw new Error('Workflow inputs and templates exceed 64 KiB');
    const prior = new Set<string>();
    for (const step of workflow.steps) {
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(step.id) || prior.has(step.id))
        throw new Error('Workflow step IDs must be unique safe identifiers');
      checkTemplate(step.args, prior);
      prior.add(step.id);
    }
    workflowHash = contractHash(workflow);
  } catch (error) {
    return {
      status: 'unsupported',
      reason: error instanceof Error ? error.message : String(error),
      steps: completed,
    };
  }

  const results = new Map<string, unknown>();
  for (const step of workflow.steps) {
    try {
      const args = bind(step.args, workflow.input, results);
      // buildRequest validates the resolved values against the endpoint schema before any quote or payment.
      const request = buildRequest(step.contract, args);
      await validateNestedTargets(args, step.contract.argumentSchema, deps.nestedTargetValidation);
      const execution = await executePaidRequest(
        {
          request,
          identity: {
            ...workflow.identity,
            stepId: step.id,
            contractHash: contractHash({ workflowHash, contract: step.contract }),
          },
          operation: step.operation ?? 'workflow',
          advertisedAccepts: step.contract.accepts,
          ...(step.contract.resultSchema ? { resultSchema: step.contract.resultSchema } : {}),
        },
        deps,
      );
      const record: WorkflowResult['steps'][number] = { id: step.id, execution };
      completed.push(record);
      if (execution.status !== 'fulfilled')
        return {
          status: execution.status,
          reason: execution.reason,
          stoppedAt: step.id,
          steps: completed,
        };
      if (!execution.response) throw new Error('Fulfilled step has no response');
      const contentType =
        Object.entries(execution.response.headers).find(
          ([key]) => key.toLowerCase() === 'content-type',
        )?.[1] ?? '';
      const value = decodeResult(execution.response.body, contentType).data;
      record.value = value;
      results.set(step.id, value);
    } catch (error) {
      return {
        status: error instanceof NestedTargetError ? 'refused' : 'failed',
        reason: error instanceof Error ? error.message : String(error),
        stoppedAt: step.id,
        steps: completed,
      };
    }
  }
  return { status: 'fulfilled', steps: completed };
}
