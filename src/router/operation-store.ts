import { z } from 'zod';
import { readSidecar, writeSidecar } from './specs';
import { SettingsHashSchema } from './settings-wire';
import {
  OfferChoicesSchema as TaskOfferChoices,
  OperationRowSchema,
  type TaskOffer,
} from './decision';
import { RunDecisionSchema, OperationSchema, type Operation } from './operation-wire';

/**
 * WHAT THIS MACHINE KEEPS OF A ROUTED OPERATION, for the 15 minutes the router's
 * own rows last (`SPEC_TTL_MS`), each as a sidecar beside the specs' files
 * (`writeSidecar`):
 *
 * - THE OFFER, by its id: the need, its operations (lead first) and any bound
 *   input. The hook writes it where it shows the line, and `request({id,
 *   input})` reads it to find the operation the line named. It holds no seller.
 * - THE OPERATION READ, by the operation's id: its input schema and its price, so a
 *   wrong input is refused before anything is sent.
 * - THE RUN, by its run id: the router's whole run answer, which a retry after
 *   a lost seller reply runs from, and the count of seller attempts it has
 *   made. The run id is what keeps a retry from paying the Tenjin fee again.
 *
 * Best effort on every write, like every record the hooks keep. A record that
 * cannot be read is absent, and the call asks the router again.
 */

const OfferSchema = z.object({
  id: z.string().min(1).max(64),
  task: z.string().min(1).max(64),
  operations: z.array(OperationRowSchema).min(1).max(16),
  hint: z.string().min(1).max(2_000),
  choices: TaskOfferChoices.optional(),
  bound: z.object({ operation: z.string(), input: z.record(z.string(), z.unknown()) }).optional(),
  settingsHash: SettingsHashSchema.optional(),
});
export type KeptOffer = z.infer<typeof OfferSchema>;

export async function storeOffer(
  dataDir: string,
  offer: TaskOffer,
  settingsHash: string | undefined,
): Promise<void> {
  await writeSidecar(dataDir, offer.id, 'offer', {
    ...offer,
    ...(settingsHash !== undefined ? { settingsHash } : {}),
  });
}

export function readOffer(dataDir: string, id: string): Promise<KeptOffer | null> {
  return readSidecar(dataDir, id, 'offer', OfferSchema);
}

const OperationKeptSchema = z.object({
  operation: OperationSchema,
  settingsHash: SettingsHashSchema.optional(),
});
export type KeptOperation = z.infer<typeof OperationKeptSchema>;

const operationKey = (id: string): string => `operation:${id}`;

export async function storeOperationRead(
  dataDir: string,
  operation: Operation,
  settingsHash: string | undefined,
): Promise<void> {
  await writeSidecar(dataDir, operationKey(operation.id), 'operation', {
    operation,
    ...(settingsHash !== undefined ? { settingsHash } : {}),
  });
}

export function readOperationKept(dataDir: string, id: string): Promise<KeptOperation | null> {
  return readSidecar(dataDir, operationKey(id), 'operation', OperationKeptSchema);
}

/** The run answer as kept: what the router served, the rules it was decided
 *  under, and how many times a seller has been tried under it. */
const RunKeptSchema = z.object({
  answer: RunDecisionSchema,
  settingsHash: SettingsHashSchema.optional(),
  /** What the Tenjin fee of this run was, atomic: what the receipt names. */
  feeAtomic: z.string().regex(/^\d+$/),
  attempts: z.number().int().min(1).max(8),
  /** The run's result was delivered: it is closed, and nothing serves it again. */
  closedAt: z.string().max(40).optional(),
});
export type KeptRun = z.infer<typeof RunKeptSchema>;

export async function storeRun(dataDir: string, kept: KeptRun): Promise<void> {
  await writeSidecar(dataDir, kept.answer.run, 'run', kept);
}

export function readRun(dataDir: string, run: string): Promise<KeptRun | null> {
  return readSidecar(dataDir, run, 'run', RunKeptSchema);
}

/** Close a run whose result was delivered. Never throws. */
export async function closeRun(dataDir: string, run: string): Promise<void> {
  const kept = await readRun(dataDir, run);
  if (kept === null) return;
  await storeRun(dataDir, { ...kept, closedAt: new Date().toISOString() });
}
