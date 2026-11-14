import { randomUUID } from 'node:crypto';
import { lstat, mkdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { withFileLock } from '../lib/lock';
import { canonicalHash } from '../lib/request-schema';
import { modelJobSchema, type ModelJob } from './model-job';
import { readJsonFile, writePrivate } from './store-files';

export const MODEL_WORKER_HANDLE_PREFIX = 'tenjin-worker-';
const MAX_CONVERSATION_BYTES = 1_000_000;
const MAX_CONTINUATION_BYTES = 4_100_000;
const MAX_CONTINUATION_RESULT_BYTES = 2_000_000;
const identity = z.string().min(1).max(2000);
const state = z.enum(['offered', 'running', 'idle', 'cancelled', 'unknown']);
const conversationSchema = z.object({
  version: z.literal(1),
  handle: z.string(),
  parentSessionId: identity,
  root: z.string().min(1),
  configDir: z.string().min(1),
  sdkSessionId: z.uuid(),
  originalJob: modelJobSchema,
  state,
  currentContinuationId: z.uuid(),
});
const continuationSchema = z.object({
  id: z.uuid(),
  handle: z.string(),
  parentTurnId: identity,
  callId: identity,
  task: z.string().min(1),
  state: z.enum(['offered', 'running', 'completed', 'cancelled', 'unknown']),
  result: z
    .string()
    .min(1)
    .refine((value) => Buffer.byteLength(value) <= MAX_CONTINUATION_RESULT_BYTES)
    .optional(),
});
export type ModelConversation = z.infer<typeof conversationSchema>;
export type ModelContinuation = z.infer<typeof continuationSchema>;
export type ModelConversationOwner = {
  parentSessionId: string;
  root: string;
  configDir: string;
};
export type ModelContinuationInput = Pick<
  ModelContinuation,
  'id' | 'parentTurnId' | 'callId' | 'task'
>;
export type ModelConversationAcceptance =
  | { action: 'start'; conversation: ModelConversation; continuation: ModelContinuation }
  | { action: 'replay'; result: string };

function handleId(handle: string): string | null {
  if (!handle.startsWith(MODEL_WORKER_HANDLE_PREFIX)) return null;
  const id = handle.slice(MODEL_WORKER_HANDLE_PREFIX.length);
  return z.uuid().safeParse(id).success ? id : null;
}

/** Durable identity and activation selection; native history and accounting keep their own stores. */
export class ModelConversationStore {
  private dir: string;
  constructor(dataDir: string) {
    this.dir = join(dataDir, 'model-conversations');
  }
  private path(handle: string): string | null {
    const id = handleId(handle);
    return id ? join(this.dir, `${id}.json`) : null;
  }
  private continuationPath(handle: string, id: string): string | null {
    const owned = handleId(handle);
    return owned && z.uuid().safeParse(id).success ? join(this.dir, `${owned}-${id}.json`) : null;
  }
  private async locked<T>(fn: () => Promise<T>): Promise<T> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    return withFileLock(join(this.dir, 'lock'), fn);
  }
  private async owner(input: ModelConversationOwner): Promise<ModelConversationOwner | null> {
    if (!identity.safeParse(input.parentSessionId).success) return null;
    const [root, configDir] = await Promise.all([
      realpath(input.root).catch(() => null),
      realpath(input.configDir).catch(() => null),
    ]);
    return root && configDir ? { parentSessionId: input.parentSessionId, root, configDir } : null;
  }
  private async read(handle: string): Promise<ModelConversation | null> {
    const file = this.path(handle);
    if (!file) return null;
    const parsed = conversationSchema.safeParse(await readJsonFile(file, MAX_CONVERSATION_BYTES));
    return parsed.success && parsed.data.handle === handle ? parsed.data : null;
  }
  private async owned(handle: string, input: ModelConversationOwner) {
    const owner = await this.owner(input),
      conversation = await this.read(handle);
    return owner &&
      conversation?.parentSessionId === owner.parentSessionId &&
      conversation.root === owner.root &&
      conversation.configDir === owner.configDir
      ? conversation
      : null;
  }
  private async continuation(handle: string, id: string): Promise<ModelContinuation | null> {
    const file = this.continuationPath(handle, id);
    if (!file) return null;
    const parsed = continuationSchema.safeParse(await readJsonFile(file, MAX_CONTINUATION_BYTES));
    return parsed.success && parsed.data.handle === handle && parsed.data.id === id
      ? parsed.data
      : null;
  }
  private async writeConversation(conversation: ModelConversation) {
    const file = this.path(conversation.handle);
    if (!file) throw new Error('Invalid worker handle');
    await this.write(file, conversation);
  }
  private async writeContinuation(continuation: ModelContinuation) {
    const file = this.continuationPath(continuation.handle, continuation.id);
    if (!file) throw new Error('Invalid continuation');
    await this.write(file, continuation, MAX_CONTINUATION_BYTES);
  }
  private async write(file: string, value: unknown, maxBytes = MAX_CONVERSATION_BYTES) {
    const text = JSON.stringify(value);
    if (Buffer.byteLength(text) > maxBytes) throw new Error('Conversation record too large');
    await writePrivate(file, text);
  }

  /** The initial assignment is offered, never idle, until its single activation completes. */
  async create(input: {
    job: ModelJob;
    parentSessionId: string;
    sdkSessionId: string;
    configDir: string;
  }): Promise<ModelConversation> {
    return this.locked(async () => {
      const job = modelJobSchema.parse(input.job);
      const owner = await this.owner({ ...input, root: job.root });
      if (!owner || owner.root !== job.root || job.sessionId !== input.parentSessionId)
        throw new Error('Conversation owner or canonical repository is unavailable');
      const sdkSessionId = z.uuid().parse(input.sdkSessionId);
      const index = join(this.dir, `job-${job.id}.json`);
      const previous = await readJsonFile(index, 1000);
      if (previous || (await lstat(index).catch(() => null))) {
        const kept =
          typeof previous?.handle === 'string' ? await this.owned(previous.handle, owner) : null;
        if (
          !kept ||
          kept.sdkSessionId !== sdkSessionId ||
          canonicalHash(kept.originalJob) !== canonicalHash(job)
        )
          throw new Error('Existing conversation identity is unavailable or changed');
        return kept;
      }
      const handle = MODEL_WORKER_HANDLE_PREFIX + randomUUID();
      const conversation: ModelConversation = {
        version: 1,
        handle,
        ...owner,
        sdkSessionId,
        originalJob: job,
        state: 'offered',
        currentContinuationId: job.id,
      };
      const first = continuationSchema.parse({
        id: job.id,
        handle,
        parentTurnId: job.turnId,
        callId: job.callId,
        task: job.task,
        state: 'offered',
      });
      await this.writeConversation(conversation);
      await this.writeContinuation(first);
      await this.write(index, { handle });
      return conversation;
    });
  }
  async lookup(handle: string, owner: ModelConversationOwner): Promise<ModelConversation | null> {
    return this.owned(handle, owner);
  }
  async findByJob(jobId: string, owner: ModelConversationOwner): Promise<ModelConversation | null> {
    if (!z.uuid().safeParse(jobId).success) return null;
    const index = await readJsonFile(join(this.dir, `job-${jobId}.json`), 1000);
    const conversation =
      typeof index?.handle === 'string' ? await this.owned(index.handle, owner) : null;
    return conversation?.originalJob.id === jobId ? conversation : null;
  }
  /** An immutable parent-selected offer ID binds the complete follow-up and native call. */
  async offer(
    handle: string,
    owner: ModelConversationOwner,
    input: ModelContinuationInput,
  ): Promise<ModelContinuation | null> {
    return this.locked(async () => {
      const conversation = await this.owned(handle, owner);
      const parsed = continuationSchema.safeParse({ ...input, handle, state: 'offered' });
      if (!conversation || !parsed.success) return null;
      const previous = await this.continuation(handle, input.id);
      if (previous) {
        const immutable = ({ id, parentTurnId, callId, task }: ModelContinuationInput) => ({
          id,
          parentTurnId,
          callId,
          task,
        });
        return canonicalHash(immutable(previous)) === canonicalHash(immutable(input))
          ? previous
          : null;
      }
      const file = this.continuationPath(handle, input.id);
      if (!file || (await lstat(file).catch(() => null))) return null;
      if (
        conversation.state === 'offered' &&
        conversation.currentContinuationId !== conversation.originalJob.id
      ) {
        const superseded = await this.continuation(handle, conversation.currentContinuationId);
        if (superseded?.state !== 'offered') return null;
        // The old selection cannot activate once idle, including after a partial cancellation.
        await this.writeConversation({ ...conversation, state: 'idle' });
        await this.writeContinuation({ ...superseded, state: 'cancelled' });
      } else if (conversation.state !== 'idle') return null;
      // Fence the conversation first: a crash cannot leave it idle with an untracked offer.
      await this.writeConversation({
        ...conversation,
        state: 'offered',
        currentContinuationId: input.id,
      });
      await this.writeContinuation(parsed.data);
      return parsed.data;
    });
  }
  /** Start once, replay only a known completed local result, otherwise refuse uncertainty. */
  async accept(
    handle: string,
    owner: ModelConversationOwner,
    id: string,
  ): Promise<ModelConversationAcceptance | null> {
    return this.locked(async () => {
      const conversation = await this.owned(handle, owner);
      const continuation = await this.continuation(handle, id);
      if (!conversation || !continuation) return null;
      if (continuation.state === 'completed' && continuation.result) {
        if (conversation.state === 'running' && conversation.currentContinuationId === id)
          await this.writeConversation({ ...conversation, state: 'idle' });
        return { action: 'replay', result: continuation.result };
      }
      if (
        conversation.state !== 'offered' ||
        conversation.currentContinuationId !== id ||
        continuation.state !== 'offered'
      )
        return null;
      const running: ModelConversation = { ...conversation, state: 'running' };
      // A partial write leaves a non-idle record, so another process cannot start it.
      await this.writeConversation(running);
      const activated: ModelContinuation = { ...continuation, state: 'running' };
      await this.writeContinuation(activated);
      return { action: 'start', conversation: running, continuation: activated };
    });
  }
  async finish(
    handle: string,
    owner: ModelConversationOwner,
    id: string,
    state: 'completed' | 'cancelled' | 'unknown',
    result?: string,
  ): Promise<boolean> {
    return this.locked(async () => {
      const conversation = await this.owned(handle, owner);
      const continuation = await this.continuation(handle, id);
      if (!conversation || !continuation || conversation.currentContinuationId !== id) return false;
      if (continuation.state === 'completed')
        return state === 'completed' && continuation.result === result;
      if (conversation.state !== 'running' || continuation.state !== 'running') return false;
      const ended = continuationSchema.safeParse({
        ...continuation,
        state,
        ...(result !== undefined ? { result } : {}),
      });
      if (!ended.success || (state === 'completed' && !ended.data.result)) return false;
      // Record the result before reopening selection. A crash in between stays fenced.
      await this.writeContinuation(ended.data);
      await this.writeConversation({
        ...conversation,
        state: state === 'completed' ? 'idle' : state,
      });
      return true;
    });
  }
  /** Fence before draining; late completion cannot reopen a cancelled conversation. */
  async fence(handle: string, owner: ModelConversationOwner, id: string): Promise<boolean> {
    return this.locked(async () => {
      const conversation = await this.owned(handle, owner);
      const continuation = await this.continuation(handle, id);
      if (!conversation || !continuation || conversation.currentContinuationId !== id) return false;
      if (!['offered', 'running'].includes(conversation.state)) return false;
      const unstartedFollowup =
        conversation.state === 'offered' &&
        continuation.state === 'offered' &&
        id !== conversation.originalJob.id;
      await this.writeConversation({
        ...conversation,
        state: unstartedFollowup ? 'idle' : 'cancelled',
      });
      await this.writeContinuation({ ...continuation, state: 'cancelled' });
      return true;
    });
  }
}
