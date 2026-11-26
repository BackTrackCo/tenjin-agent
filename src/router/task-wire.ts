import { z } from 'zod';
import {
  acceptsFor,
  envelope,
  RefusedSchema,
  ToolResponseSchema,
  ToolSpecSchema,
} from './decision';
import type { Harness } from './names';
import { SettingsHashSchema, type WireSettings } from './settings-wire';

/**
 * THE WIRE OF A ROUTED TASK, AS THIS CLIENT READS AND SENDS IT. Three forms,
 * each read tolerantly like every answer (a field this build does not know is
 * dropped, never a failure), each field it knows held to its bounds:
 *
 * - THE TASK READ, free: `{task}` answers what a task takes, what comes back
 *   and what one run costs, with no seller, URL or payee.
 * - THE OFFER, free (`decision.ts`, `TaskOfferSchema`): the need and its tasks.
 * - THE RUN, paid: `{task, run, caps}` answers with the one seller's spec, its
 *   conversions and a fallback. It is the only answer where a seller's
 *   request, URL or payee reaches this machine, and it carries no input text:
 *   the input never leaves the machine.
 *
 * Imported by the request tool and the hook leg's offer path; zod and the
 * answer schemas only, so it stays out of the wallet's chunk.
 */

const Digits = z.string().regex(/^\d{1,18}$/);

/** One task, as the free read answers it. */
export const TaskSchema = z.object({
  id: z.string().min(1).max(200),
  label: z.string().min(1).max(120),
  does: z.string().min(1).max(500),
  /** What a call sends, as JSON Schema. */
  input: z.record(z.string(), z.unknown()),
  example: z.record(z.string(), z.unknown()).optional(),
  /** What comes back, as JSON Schema; absent where the catalog promises no shape. */
  output: z.record(z.string(), z.unknown()).optional(),
  /** The lead seller's expected price, its allowed maximum and the routing
   *  fee a run pays: one quote's three numbers, atomic USDC. */
  price: z.object({ expectedAtomic: Digits, maxAtomic: Digits, feeAtomic: Digits }),
  free: z.boolean(),
  kind: z.string().min(1).max(120),
});
export type Task = z.infer<typeof TaskSchema>;

const TaskReadSchema = z.object({
  schemaVersion: z.literal(1),
  routerVersion: z.string().min(1).max(64),
  settingsHash: SettingsHashSchema.optional(),
  task: TaskSchema,
});
export type TaskRead = z.infer<typeof TaskReadSchema>;

/** The free read answers a task, or a decision that says why not (an unknown
 *  id is `needs_input`). */
export const TaskReadResponseSchema = z.union([TaskReadSchema, ToolResponseSchema]);

/** The two conversions a routed seller carries, JMESPath each way. */
const ConvertSchema = z.object({
  input: z.string().min(1).max(2_000),
  output: z.string().min(1).max(2_000),
});
export type Convert = z.infer<typeof ConvertSchema>;

/**
 * A RUN'S ANSWER: the seller's spec with its conversions, and a fallback
 * seller where the task has a second one, used only before anything is
 * signed. `routingFeeAtomic` is what this answer charged: $0 when a re-sent
 * run id was served the answer it already paid for. It stays usable until
 * `expiresAt`.
 */
export const RunDecisionSchema = z.object({
  action: z.literal('run'),
  run: z.string().min(8).max(64),
  task: z.string().min(1).max(200),
  expiresAt: z.string().max(40),
  routingFeeAtomic: Digits,
  spec: ToolSpecSchema,
  convert: ConvertSchema.optional(),
  /** The task's output shape, which the converted result must fill. */
  output: z.record(z.string(), z.unknown()).optional(),
  fallback: z.object({ spec: ToolSpecSchema, convert: ConvertSchema.optional() }).optional(),
});
export type RunDecision = z.infer<typeof RunDecisionSchema>;

/** A run no answer was served for, at $0: a stable code and a plain reason. */
const NoRunSchema = z.object({
  action: z.literal('no_run'),
  code: z.string().min(1).max(64),
  reason: z.string().max(500),
});
export type NoRun = z.infer<typeof NoRunSchema>;

export const RunResponseSchema = envelope(
  z.discriminatedUnion('action', [
    RunDecisionSchema,
    NoRunSchema,
    RefusedSchema.extend({ action: z.literal('native') }),
    RefusedSchema.extend({ action: z.literal('needs_input') }),
  ]),
);
export type RunResponse = z.infer<typeof RunResponseSchema>;

/** The free read of one task. `accepts` carries `task`, which makes the
 *  answer a task client's. */
export function buildTaskReadBody(request: {
  task: string;
  bazaar: boolean;
  harness?: Harness;
  settings?: WireSettings;
}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    task: request.task,
    accepts: acceptsFor(request.bazaar, request.settings !== undefined, true),
    ...(request.harness !== undefined ? { harness: request.harness } : {}),
    ...(request.settings !== undefined ? { settings: request.settings } : {}),
  };
}

/**
 * THE RUN REQUEST: the task, the run id this client picked, the amounts it
 * approved, the offer it follows and, for a task whose input holds a URL, the
 * URL's bare host for page routing. It carries no input text.
 */
export function buildRunBody(request: {
  task: string;
  run: string;
  caps: { fee: bigint; seller: bigint };
  offer?: string;
  host?: string;
  choice?: string;
  bazaar: boolean;
  harness?: Harness;
  improve?: boolean;
  settings?: WireSettings;
}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    task: request.task,
    run: request.run,
    caps: { fee: request.caps.fee.toString(), seller: request.caps.seller.toString() },
    ...(request.offer !== undefined ? { offer: request.offer } : {}),
    ...(request.host !== undefined ? { host: request.host } : {}),
    ...(request.choice !== undefined ? { choice: request.choice } : {}),
    accepts: acceptsFor(request.bazaar, request.settings !== undefined, true),
    ...(request.harness !== undefined ? { harness: request.harness } : {}),
    ...(request.improve === true ? { improve: true } : {}),
    ...(request.settings !== undefined ? { settings: request.settings } : {}),
  };
}
