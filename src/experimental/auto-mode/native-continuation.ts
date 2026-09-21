import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { writeFileAtomic } from '../../lib/atomic-json';
import { mask } from '../../lib/redact';
import { fingerprint, HookEventSchema } from './context';
import type { HookEvent, TaskContext } from './context';
import type { AutoConfig } from './runtime';

const LIFETIME_MS = 10 * 60 * 1000;
const MAX_MARKER_BYTES = 24_576;
const MAX_REQUEST_BYTES = 16_384;
type Config = Pick<AutoConfig, 'stateDir' | 'mode' | 'nativeFallback' | 'nativeWebFetch'>;
type Clock = { now?: () => number };
type NativeRoute = { status: 'native_fallback'; reason: string; targetUrl?: string };
export type NativeContinuationFailure = {
  provider: string;
  httpStatus: number;
  originalRequest?: unknown;
};

const httpsUrl = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => {
    try {
      const url = new URL(value);
      return (
        value.trim() === value &&
        value === mask(value) &&
        url.protocol === 'https:' &&
        !url.username &&
        !url.password
      );
    } catch {
      return false;
    }
  }, 'Expected an unredacted HTTPS URL without credentials.');
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const MarkerSchema = z
  .object({
    version: z.literal(1),
    sessionHash: hash,
    userTurnHash: hash,
    mode: z.enum(['fixture', 'route', 'live']),
    nativeTool: z.enum(['WebSearch', 'WebFetch']),
    targetUrl: httpsUrl.optional(),
    createdAt: z.number().int().nonnegative(),
    expiresAt: z.number().int().nonnegative(),
    failure: z
      .object({
        provider: httpsUrl,
        httpStatus: z.number().int().min(500).max(599),
        originalRequest: z.unknown().optional(),
      })
      .strict(),
  })
  .strict()
  .refine((value) => (value.nativeTool === 'WebFetch') === (value.targetUrl !== undefined))
  .refine(
    (value) =>
      value.expiresAt > value.createdAt && value.expiresAt - value.createdAt <= LIFETIME_MS,
  );
export type NativeContinuation = z.infer<typeof MarkerSchema>;

export function userTurnFingerprint(context: TaskContext): string {
  const messages = context.messages.filter((message) => message.role === 'user');
  if (!messages.length) throw new Error('Native continuation requires a user task.');
  return fingerprint(messages);
}

function scope(config: Config, event: HookEvent, context: TaskContext, targetUrl?: string) {
  return {
    sessionHash: fingerprint(event.session_id),
    userTurnHash: userTurnFingerprint(context),
    mode: config.mode,
    nativeTool: targetUrl === undefined ? ('WebSearch' as const) : ('WebFetch' as const),
    ...(targetUrl === undefined ? {} : { targetUrl: httpsUrl.parse(targetUrl) }),
  };
}

function markerPath(config: Config, identity: ReturnType<typeof scope>) {
  return join(config.stateDir, 'native-continuations', `${fingerprint(identity)}.json`);
}

function requestEvidence(value: unknown): unknown {
  if (value === undefined) return undefined;
  const serialized = JSON.stringify(value);
  if (serialized === undefined || Buffer.byteLength(serialized) > MAX_REQUEST_BYTES)
    throw new Error('Native continuation request evidence exceeds its supported bound.');
  return JSON.parse(mask(serialized)) as unknown;
}

/** Records a native-only routing decision, never a successful provider result or payment authority. */
export async function saveNativeContinuation(
  config: Config,
  rawEvent: HookEvent,
  context: TaskContext,
  route: NativeRoute,
  failure: NativeContinuationFailure,
  clock: Clock = {},
): Promise<NativeContinuation> {
  if (config.nativeFallback !== true) throw new Error('Native continuation is disabled.');
  const event = HookEventSchema.parse(rawEvent);
  if (route.status !== 'native_fallback') throw new Error('A native routing decision is required.');
  if (route.targetUrl !== undefined && config.nativeWebFetch === false)
    throw new Error('Native page continuation is disabled.');
  if (
    event.tool_name === 'WebFetch' &&
    (route.targetUrl === undefined || route.targetUrl !== event.tool_input.url)
  )
    throw new Error('Native page continuation must preserve the exact requested URL.');
  const identity = scope(config, event, context, route.targetUrl);
  const createdAt = (clock.now ?? Date.now)();
  const marker = MarkerSchema.parse({
    version: 1,
    ...identity,
    createdAt,
    expiresAt: createdAt + LIFETIME_MS,
    failure: {
      provider: failure.provider,
      httpStatus: failure.httpStatus,
      ...(failure.originalRequest === undefined
        ? {}
        : { originalRequest: requestEvidence(failure.originalRequest) }),
    },
  });
  const serialized = JSON.stringify(marker);
  if (Buffer.byteLength(serialized) > MAX_MARKER_BYTES)
    throw new Error('Native continuation marker exceeds its supported bound.');
  await writeFileAtomic(markerPath(config, identity), serialized, { mode: 0o600, dirMode: 0o700 });
  return marker;
}

/** Evidence is scoped to this turn and native operation; the caller must still judge its semantic suitability. */
export async function readNativeContinuation(
  config: Config,
  rawEvent: HookEvent,
  context: TaskContext,
  clock: Clock = {},
): Promise<NativeContinuation | undefined> {
  if (config.nativeFallback !== true) return undefined;
  const event = HookEventSchema.parse(rawEvent);
  if (event.tool_name !== 'WebSearch' && event.tool_name !== 'WebFetch') return undefined;
  if (event.tool_name === 'WebFetch' && config.nativeWebFetch === false) return undefined;
  const targetUrl =
    event.tool_name === 'WebFetch' ? httpsUrl.parse(event.tool_input.url) : undefined;
  const identity = scope(config, event, context, targetUrl);
  let file;
  try {
    file = await open(
      markerPath(config, identity),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  let raw: string;
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > MAX_MARKER_BYTES)
      throw new Error('Native continuation marker is not a bounded regular file.');
    const buffer = Buffer.alloc(MAX_MARKER_BYTES + 1);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead > MAX_MARKER_BYTES)
      throw new Error('Native continuation marker grew beyond its bound.');
    raw = buffer.subarray(0, bytesRead).toString('utf8');
  } finally {
    await file.close();
  }
  const marker = MarkerSchema.parse(JSON.parse(raw));
  if (
    marker.sessionHash !== identity.sessionHash ||
    marker.userTurnHash !== identity.userTurnHash ||
    marker.mode !== identity.mode ||
    marker.nativeTool !== identity.nativeTool ||
    marker.targetUrl !== identity.targetUrl
  )
    throw new Error('Native continuation marker does not match the current operation.');
  const request = requestEvidence(marker.failure.originalRequest);
  if (JSON.stringify(request) !== JSON.stringify(marker.failure.originalRequest))
    throw new Error('Native continuation marker contains unredacted request evidence.');
  const now = (clock.now ?? Date.now)();
  if (!Number.isSafeInteger(now) || now < 0) throw new Error('Invalid native continuation clock.');
  if (marker.createdAt > now || marker.expiresAt <= now) return undefined;
  return marker;
}
