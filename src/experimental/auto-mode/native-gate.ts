import { mask } from '../../lib/redact';
import { HookEventSchema } from './context';
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
  try {
    const route = await routeEvent(parsed.data, config, deps);
    if (route.status === 'native_fallback') return route;
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
      reason:
        'The native routing check could not complete. Use mcp__x402__request with the task and current inputs; no provider request or payment was made.',
    };
  }
}
