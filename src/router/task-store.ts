import { z } from 'zod';
import { readSidecar, writeSidecar } from './specs';
import { SettingsHashSchema } from './settings-wire';
import {
  TaskOfferChoicesSchema as TaskOfferChoices,
  TaskRowSchema,
  type TaskOffer,
} from './decision';
import { RunDecisionSchema, TaskSchema, type Task } from './task-wire';

/**
 * WHAT THIS MACHINE KEEPS OF A ROUTED TASK, for the 15 minutes the router's
 * own rows last (`SPEC_TTL_MS`), each as a sidecar beside the specs' files
 * (`writeSidecar`):
 *
 * - THE OFFER, by its id: the need, its tasks (lead first) and any bound
 *   input. The hook writes it where it shows the line, and `request({id,
 *   input})` reads it to find the task the line named. It holds no seller.
 * - THE TASK READ, by the task's id: its input schema and its price, so a
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
  need: z.string().min(1).max(64),
  tasks: z.array(TaskRowSchema).min(1).max(16),
  hint: z.string().min(1).max(2_000),
  choices: TaskOfferChoices.optional(),
  bound: z.object({ task: z.string(), input: z.record(z.string(), z.unknown()) }).optional(),
  settingsHash: SettingsHashSchema.optional(),
});
export type KeptTaskOffer = z.infer<typeof OfferSchema>;

export async function storeTaskOffer(
  dataDir: string,
  offer: TaskOffer,
  settingsHash: string | undefined,
): Promise<void> {
  await writeSidecar(dataDir, offer.id, 'offer', {
    ...offer,
    ...(settingsHash !== undefined ? { settingsHash } : {}),
  });
}

export function readTaskOffer(dataDir: string, id: string): Promise<KeptTaskOffer | null> {
  return readSidecar(dataDir, id, 'offer', OfferSchema);
}

const TaskKeptSchema = z.object({ task: TaskSchema, settingsHash: SettingsHashSchema.optional() });
export type KeptTask = z.infer<typeof TaskKeptSchema>;

const taskKey = (id: string): string => `task:${id}`;

export async function storeTaskRead(
  dataDir: string,
  task: Task,
  settingsHash: string | undefined,
): Promise<void> {
  await writeSidecar(dataDir, taskKey(task.id), 'task', {
    task,
    ...(settingsHash !== undefined ? { settingsHash } : {}),
  });
}

export function readTaskKept(dataDir: string, id: string): Promise<KeptTask | null> {
  return readSidecar(dataDir, taskKey(id), 'task', TaskKeptSchema);
}

/** The run answer as kept: what the router served, the rules it was decided
 *  under, and how many times a seller has been tried under it. */
const RunKeptSchema = z.object({
  answer: RunDecisionSchema,
  settingsHash: SettingsHashSchema.optional(),
  /** What the Tenjin fee of this run was, atomic: what the receipt names. */
  feeAtomic: z.string().regex(/^\d+$/),
  attempts: z.number().int().min(1).max(8),
});
export type KeptRun = z.infer<typeof RunKeptSchema>;

export async function storeRun(dataDir: string, kept: KeptRun): Promise<void> {
  await writeSidecar(dataDir, kept.answer.run, 'run', kept);
}

export function readRun(dataDir: string, run: string): Promise<KeptRun | null> {
  return readSidecar(dataDir, run, 'run', RunKeptSchema);
}

/**
 * THE RUN A (TASK, INPUT) PAIR LAST HELD, by a hash of both: a call repeated
 * while that run is still good and nothing was paid to a seller under it is
 * run again under the same run id, which pays no second Tenjin fee. Only the
 * run id is kept here, never the input.
 */
const RunKeySchema = z.object({ run: z.string().min(8).max(64) });

export async function storeRunKey(dataDir: string, key: string, run: string): Promise<void> {
  await writeSidecar(dataDir, `runkey:${key}`, 'runkey', { run });
}

export async function readRunKey(dataDir: string, key: string): Promise<string | null> {
  return (await readSidecar(dataDir, `runkey:${key}`, 'runkey', RunKeySchema))?.run ?? null;
}
