import { mask } from '../../lib/redact';
import { HookEventSchema, readTaskContext } from './context';
import { readNativeContinuation } from './native-continuation';
import { routeEvent } from './runtime';
import type { AutoConfig, Outcome, RuntimeDeps } from './runtime';

/** Judge native lookup value before execution. This gate never executes a
 * provider request, creates a payment, or delegates to the paid event runner. */
export async function runNativeGate(
  raw: unknown,
  config: AutoConfig,
  deps: RuntimeDeps = {},
): Promise<Outcome> {
  if (config.nativeFallback !== true)
    return { status: 'refused', reason: 'Native value routing is not configured.' };
  const parsed = HookEventSchema.safeParse(raw);
  if (!parsed.success || !['WebSearch', 'WebFetch'].includes(parsed.data.tool_name))
    return { status: 'refused', reason: 'The native gate accepts only WebSearch or WebFetch.' };
  if (parsed.data.tool_name === 'WebFetch' && config.nativeWebFetch === false)
    return {
      status: 'refused',
      reason: 'Native WebFetch is disabled. Read the exact page URL through mcp__x402__request.',
    };
  let recovering = false;
  try {
    const context =
      deps.context ?? (await readTaskContext(parsed.data.transcript_path, parsed.data.session_id));
    const recovery = await readNativeContinuation(config, parsed.data, context);
    recovering = recovery !== undefined;
    const route = await routeEvent(parsed.data, config, {
      ...deps,
      context,
      ...(recovery ? { contracts: [], nativeRecovery: recovery.failure } : {}),
    });
    if (route.status === 'native_fallback') return route;
    if (recovery)
      return {
        status: 'needs_input',
        reason:
          'Jev could not confirm this native call preserves the failed step and user constraints. The paid request remains failed; do not retry it or change provider without a new user request.',
      };
    if (route.status === 'selected')
      return {
        status: 'paid_preferred',
        reason:
          'Jev selected a paid specialist for this step. Call mcp__x402__request with the same task instead; no provider request or payment was made.',
        selected: {
          url: route.contract.url,
          args: route.args,
          contractHash: route.contract.sourceHash,
        },
      };
    return {
      status: route.status,
      reason: `${mask(route.reason).slice(0, 500)} Use mcp__x402__request with the task and any missing inputs; no provider request or payment was made.`,
    };
  } catch {
    return {
      status: 'needs_input',
      reason: recovering
        ? 'Native continuation could not be confirmed. The earlier paid request remains failed; do not retry it or change provider without a new user request. This check made no provider request or payment.'
        : 'Native execution could not be confirmed. This gate made no provider request or payment. Do not retry automatically; resolve the routing or saved-state failure before continuing.',
    };
  }
}
