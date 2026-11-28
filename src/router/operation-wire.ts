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
 * THE WIRE OF A ROUTED OPERATION, AS THIS CLIENT READS AND SENDS IT. Three forms,
 * each read tolerantly like every answer (a field this build does not know is
 * dropped, never a failure), each field it knows held to its bounds:
 *
 * - THE OPERATION READ, free: `{operation}` answers what a operation takes, what comes back
 *   and what one run costs, with no service, URL or payee.
 * - THE OFFER, free (`decision.ts`, `TaskOfferSchema`): the need and its operations.
 * - THE RUN, paid: `{operation, run, caps}` answers with the one service's own
 *   spec. It is the only answer where a service's request, URL or payee reaches
 *   this machine, and it carries no input text: the input never leaves the
 *   machine.
 *
 * Imported by the request tool and the hook leg's offer path; zod and the
 * answer schemas only, so it stays out of the wallet's chunk.
 */

const Digits = z.string().regex(/^\d{1,18}$/);

/** One operation, as the free read answers it. */
export const OperationSchema = z.object({
  id: z.string().min(1).max(200),
  label: z.string().min(1).max(120),
  does: z.string().min(1).max(500),
  /** What a call sends, as JSON Schema. */
  input: z.record(z.string(), z.unknown()),
  /** The lead service's expected price, its allowed maximum and the routing
   *  fee a run pays: one quote's three numbers, atomic USDC. */
  price: z.object({ expectedAtomic: Digits, maxAtomic: Digits, feeAtomic: Digits }),
  free: z.boolean(),
  kind: z.string().min(1).max(120),
});
export type Operation = z.infer<typeof OperationSchema>;

const OperationReadSchema = z.object({
  schemaVersion: z.literal(1),
  routerVersion: z.string().min(1).max(64),
  settingsHash: SettingsHashSchema.optional(),
  operation: OperationSchema,
});
export type OperationRead = z.infer<typeof OperationReadSchema>;

/** The free read answers a operation, or a decision that says why not (an unknown
 *  id is `needs_input`). */
export const OperationReadResponseSchema = z.union([OperationReadSchema, ToolResponseSchema]);

/**
 * A RUN'S ANSWER: the one service's own spec, as a manual call gets it. There
 * is no second service and no conversion: the caller's input fills the spec's
 * own fields, and the result is the service's own. `routingFeeAtomic` is what
 * this answer charged: $0 when a re-sent run id was served the answer it
 * already paid for. It stays usable until `expiresAt`, for the CLI's recovery
 * of the same call.
 */
export const RunDecisionSchema = z.object({
  action: z.literal('run'),
  run: z.string().min(8).max(64),
  operation: z.string().min(1).max(200),
  expiresAt: z.string().max(40),
  routingFeeAtomic: Digits,
  spec: ToolSpecSchema,
});
export type RunDecision = z.infer<typeof RunDecisionSchema>;

/**
 * A RUN OF SEVERAL CALLS: every member of a compare group (`choice: "all"`) or
 * takes of one call (`count`). One answer, one spec per call; the routing fee
 * is the sum of each call's.
 */
export const RunSetDecisionSchema = z.object({
  action: z.literal('run_set'),
  run: z.string().min(8).max(64),
  operation: z.string().min(1).max(200),
  expiresAt: z.string().max(40),
  routingFeeAtomic: Digits,
  calls: z
    .array(
      z.object({
        key: z.string().min(1).max(32).optional(),
        label: z.string().min(1).max(120),
        spec: ToolSpecSchema,
      }),
    )
    .min(1)
    .max(5),
});
export type RunSetDecision = z.infer<typeof RunSetDecisionSchema>;

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
    RunSetDecisionSchema,
    NoRunSchema,
    RefusedSchema.extend({ action: z.literal('native') }),
    RefusedSchema.extend({ action: z.literal('needs_input') }),
  ]),
);
export type RunResponse = z.infer<typeof RunResponseSchema>;

/** The free read of one operation. `accepts` carries `operation`, which makes the
 *  answer a operation client's. */
export function buildOperationReadBody(request: {
  operation: string;
  bazaar: boolean;
  harness?: Harness;
  settings?: WireSettings;
}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    operation: request.operation,
    accepts: acceptsFor(request.bazaar, request.settings !== undefined, true),
    ...(request.harness !== undefined ? { harness: request.harness } : {}),
    ...(request.settings !== undefined ? { settings: request.settings } : {}),
  };
}

/**
 * THE RUN REQUEST: the operation, the run id this client picked, the amounts it
 * approved, the offer it follows and, for a operation whose input holds a URL, the
 * URL's bare host for page routing. It carries no input text.
 */
export function buildRunBody(request: {
  operation: string;
  run: string;
  caps: { fee: bigint; service: bigint };
  offer?: string;
  host?: string;
  choice?: string;
  count?: number;
  bazaar: boolean;
  harness?: Harness;
  improve?: boolean;
  settings?: WireSettings;
}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    operation: request.operation,
    run: request.run,
    caps: { fee: request.caps.fee.toString(), service: request.caps.service.toString() },
    ...(request.offer !== undefined ? { offer: request.offer } : {}),
    ...(request.host !== undefined ? { host: request.host } : {}),
    ...(request.choice !== undefined ? { choice: request.choice } : {}),
    ...(request.count !== undefined ? { count: request.count } : {}),
    accepts: acceptsFor(request.bazaar, request.settings !== undefined, true),
    ...(request.harness !== undefined ? { harness: request.harness } : {}),
    ...(request.improve === true ? { improve: true } : {}),
    ...(request.settings !== undefined ? { settings: request.settings } : {}),
  };
}
