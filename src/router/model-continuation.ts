import { z } from 'zod';
import { MODEL_WORKER_HANDLE_PREFIX } from './model-conversations';

export type ModelNativeTool = 'Agent' | 'Task' | 'SendMessage';

/**
 * A held call's `run_in_background`, as the host may spell it: Claude Code 2.1.327 handed
 * the hook the STRING "true" for a call the model wrote that way, and a test that knew
 * only the boolean let such a job run in the foreground. True and "true" are a
 * background call, false, "false" and an absent field a foreground one; anything else is
 * `null`, a value this code does not understand, and the call stays native.
 */
export function nativeBackground(native: Record<string, unknown>): boolean | null {
  const value = native.run_in_background;
  if (value === undefined || value === false || value === 'false') return false;
  return value === true || value === 'true' ? true : null;
}

/** Reserve addresses, never mentions inside an ordinary assignment. */
export function ownedModelReference(native: Record<string, unknown>, tool: ModelNativeTool) {
  const addresses = tool === 'SendMessage' ? [native.to, native.recipient] : [native.resume];
  const values = addresses.flatMap((value) => (Array.isArray(value) ? value : [value]));
  const owned = values.some(
    (value) =>
      typeof value === 'string' &&
      [MODEL_WORKER_HANDLE_PREFIX, 'tenjin-offer-'].some((prefix) =>
        value.trim().toLowerCase().startsWith(prefix),
      ),
  );
  if (!owned) return { owned: false as const };
  const supplied = addresses.filter((value) => value !== undefined);
  const address = supplied[0];
  const targets = Array.isArray(address) ? address : [address];
  const handle = targets[0];
  const task = tool === 'SendMessage' ? (native.message ?? native.content) : native.prompt;
  const allowed =
    tool === 'SendMessage'
      ? ['to', 'recipient', 'message', 'content', 'summary', 'notify_when_idle']
      : ['resume', 'prompt', 'description', 'subagent_type'];
  if (
    supplied.length !== 1 ||
    targets.length !== 1 ||
    typeof handle !== 'string' ||
    !handle.startsWith(MODEL_WORKER_HANDLE_PREFIX) ||
    !z.uuid().safeParse(handle.slice(MODEL_WORKER_HANDLE_PREFIX.length)).success ||
    typeof task !== 'string' ||
    !task.trim() ||
    Buffer.byteLength(task) > 128_000 ||
    Object.keys(native).some((key) => !allowed.includes(key)) ||
    (native.notify_when_idle !== undefined && native.notify_when_idle !== false) ||
    (tool === 'SendMessage' && native.message !== undefined && native.content !== undefined) ||
    nativeBackground(native) !== false ||
    native.isolation ||
    native.team_name ||
    native.name
  )
    return { owned: true as const, error: 'Invalid or unsupported worker continuation call' };
  return { owned: true as const, handle, task };
}

export const continuationRefusal = (reason: string) => ({
  action: 'refused' as const,
  started: false,
  reason,
  instruction:
    'No continuation started. Do not pass a Tenjin worker handle to native tools. Cancel this continuation or explicitly create a fresh native assignment with the needed context.',
});
