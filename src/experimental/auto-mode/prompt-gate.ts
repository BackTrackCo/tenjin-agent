import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { z } from 'zod';
import { writeFileAtomic } from '../../lib/atomic-json';
import { mask } from '../../lib/redact';
import { contractHash } from './contracts';
import { fingerprint, readPromptContext } from './context';
import { routeEvent } from './runtime';
import type { HookEvent, TaskContext } from './context';
import type { RouteResult } from './routing';
import type { AutoConfig, RuntimeDeps } from './runtime';

export const PromptEventSchema = z.object({
  hook_event_name: z.literal('UserPromptSubmit'),
  session_id: z.string().min(1).max(200),
  transcript_path: z.string().min(1),
  prompt: z
    .string()
    .min(1)
    .max(48_000)
    .refine((value) => Boolean(value.trim())),
});

export interface PromptGateOutput {
  hookSpecificOutput?: {
    hookEventName: 'UserPromptSubmit';
    additionalContext: string;
  };
}

export const PROMPT_BRIDGE_HINT =
  "Jev selected an external capability for the current user task. Make mcp__x402__request your next tool call, by itself, with the complete current task and its needed inputs. Wait for its result before making any other tool call; do not run native WebSearch ahead of it or in parallel. If the result fulfills the requested step, use it without duplicating that lookup. Use native tools for that step only when the bridge explicitly returns native_fallback. For a distinct later lookup, ask the request tool first again. Preserve the user's latest constraints and corrections, including references to multiple items. The tool's PreToolUse hook chooses and executes the appropriate capability under the configured policy; the bridge returns the saved result. This routing check has not made a provider request or payment.";

/** A routing-only UserPromptSubmit check. Never calls runEvent or execution
 * hooks. An uncertain decision adds no instruction and cannot initiate payment. */
export async function runPromptGate(
  raw: unknown,
  config: AutoConfig,
  deps: RuntimeDeps = {},
): Promise<PromptGateOutput> {
  const parsed = PromptEventSchema.safeParse(raw);
  if (!parsed.success) return {};
  const event = parsed.data;
  const invocationId = randomUUID();
  let context: TaskContext | undefined;
  let stage: 'context' | 'routing' = 'context';
  const record = async (
    status: RouteResult['status'] | 'error',
    selected?: Extract<RouteResult, { status: 'selected' }>,
  ) => {
    await writeFileAtomic(
      join(config.stateDir, 'prompt-decisions', `${invocationId}.json`),
      JSON.stringify({
        version: 1,
        at: new Date().toISOString(),
        invocationId,
        sessionHash: fingerprint(event.session_id),
        promptHash: fingerprint(event.prompt),
        contextHash: context?.fingerprint ?? null,
        status,
        injected: status === 'selected',
        stage,
        ...(selected
          ? {
              selectedRoute: {
                url: mask(selected.contract.url),
                method: selected.contract.method,
                contractHash: contractHash(selected.contract),
              },
            }
          : {}),
      }),
      { mode: 0o600, dirMode: 0o700 },
    );
  };
  try {
    context = await readPromptContext(event.transcript_path, event.session_id, event.prompt);
    stage = 'routing';
    // Prompt classification must not trigger remote discovery. The same local
    // catalog and live policy filters still apply when the request bridge runs.
    if (!deps.contracts && !config.catalogFile && config.mode !== 'fixture') {
      await record('unsupported');
      return {};
    }
    const pending: HookEvent = {
      hook_event_name: 'PreToolUse',
      session_id: event.session_id,
      tool_use_id: `prompt-${invocationId}`,
      transcript_path: event.transcript_path,
      tool_name: 'Request',
      tool_input: { query: mask(event.prompt) },
    };
    const route = await routeEvent(
      pending,
      { ...config, nativeFallback: true },
      { ...deps, context, hostReasoningOnly: config.nativeFallback !== true },
    );
    await record(route.status, route.status === 'selected' ? route : undefined);
    if (route.status !== 'selected') return {};
    return {
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: PROMPT_BRIDGE_HINT,
      },
    };
  } catch {
    // History/model failures and audit write failures are quiet abstentions;
    // never emit unaudited instructions or exception details into the session.
    await record(stage === 'context' ? 'needs_input' : 'error').catch(() => undefined);
    return {};
  }
}
