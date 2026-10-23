import { loadRawConfig } from '../lib/config';
import { configPath } from '../lib/paths';
import { resolveContextSettings } from '../lib/settings';
import { admitByPolicy } from './admit';
import { decideSwap, outsideAutomaticUse, type HookDeps } from './hooks';
import { personalSettings, type ReplacementSetting } from './settings';
import {
  costLines,
  routeOf,
  runRequestTool,
  type RequestToolDeps,
  type RequestToolResult,
} from './tool';

/**
 * THE SWAP: a native WebSearch or WebFetch answered in place by Tenjin's pick
 * (`router.nativeReplacement: when-routed`). The Claude Code mod asks for it
 * with the request tool's `decide` form before the native call runs
 * (`hosts/claude/tenjin/hooks/register.tsx`); the answer is the lookup's own
 * result, tagged `via: "swap"`, or a hand-back, and then the native call takes
 * the host's ordinary route (the pre-call hook, which offers from the decision
 * already made: `decided.ts`).
 *
 * IT RUNS ONLY WHEN EVERY CONDITION HOLDS, each checked here or in
 * {@link decideSwap}, in this order:
 *
 * 1. The switch is `when-routed` in the global file, read now.
 * 2. The router's decision, through the hook body (the gate's confidence
 *    floor applies), names a spec and carries `bound`: the complete input it
 *    built from this call's own search or URL.
 * 3. The lead's providers fit the automatic scope (`replacementFits`).
 * 4. The user's rules admit it ({@link admitByPolicy}), read again now.
 * 5. It would run without approval within the limits and the balance.
 * 6. The switch and its scope, read again now, still let it.
 * 7. Nothing else holds this call's redirect claim (dedupe).
 *
 * Then `request({id, input: bound})` runs through the ordinary executor,
 * unchanged: `bound` is never parsed, filled, edited or merged here. A
 * hand-back after the claim (the executor refused before anything was sent)
 * lets the native call run, and its mark no longer says it was answered in
 * place; once the provider call has started, its result or error is the
 * answer, with its real payment state, and nothing is replayed.
 */

/** What the plugin's mod sends: the native call as the host is about to run it. */
export interface DecideArgs {
  tool: 'WebSearch' | 'WebFetch';
  /** The native call's own input, as the host has it. */
  input: Record<string, unknown>;
  toolUseId: string;
  sessionId: string;
  agentId?: string;
}

/** A hand-back: the native call runs its ordinary route. Nothing was run here. */
export function handBack(why: string): RequestToolResult {
  return {
    isError: false,
    summary: `Not run in place: ${why}. The search or fetch runs as usual.`,
    envelope: {
      status: 'native',
      reason: why,
      swap: 'handback',
      cost: costLines(0n),
      providerContentUntrusted: true,
    },
  };
}

/** Answers that ran nothing: the native call can still run, as it would have. */
const NOT_STARTED = new Set(['native', 'needs_input', 'needs_approval']);
const SETTINGS_CODES = new Set([
  'policy_invalid',
  'policy_unverified',
  'offer_stale',
  'policy_refused',
]);

/**
 * The swap for one native call, with its event already admitted (`mcp.ts`
 * resolved the session's transcript from the hook legs it served).
 */
export async function runSwap(
  event: Record<string, unknown>,
  hookDeps: HookDeps,
  deps: RequestToolDeps,
): Promise<RequestToolResult> {
  const notices: string[] = [];
  const decided = await decideSwap(event, {
    ...hookDeps,
    notice: (line) => notices.push(line),
  });
  if ('handback' in decided) return handBack(decided.handback);
  const { offer, spec, bound } = decided;
  const settings = await resolveContextSettings(deps.ctx);
  // THE RULES AS THEY ARE NOW: a block saved since the decision is the one
  // that counts. The spec is fresh from this very decision, so its identity
  // needs no directory call.
  const admitted = await admitByPolicy(
    [routeOf(spec.identity)],
    {
      ctx: deps.ctx,
      baseUrl: hookDeps.baseUrl ?? settings.baseUrl,
      ...(deps.fetchImpl !== undefined ? { fetchImpl: deps.fetchImpl } : {}),
    },
    { stored: false },
  );
  if ('refused' in admitted) return handBack('your settings rule it out');
  // THE SWITCH AND ITS SCOPE AS THEY ARE NOW: automatic use turned off, or
  // narrowed past this pick, while the router decided stops it here, before
  // anything is claimed or sent.
  const outside = outsideAutomaticUse(await replacementNow(hookDeps.dataDir), spec.identity);
  if (outside !== null) return handBack(outside);
  if (!(await decided.claim())) return handBack('already routed once');
  let ran: RequestToolResult;
  try {
    ran = await runRequestTool(
      { id: offer.id, input: bound },
      { ...deps, policyRun: admitted.run, via: 'swap' },
    );
  } catch (err) {
    // The caller hands the call back on a throw, so the native call runs.
    await decided.unmark().catch(() => undefined);
    throw err;
  }
  const { envelope } = ran;
  const status = String(envelope.status);
  if (
    NOT_STARTED.has(status) ||
    (typeof envelope.reasonCode === 'string' && SETTINGS_CODES.has(envelope.reasonCode))
  ) {
    await decided.unmark();
    return handBack(`it stopped before anything was sent (${status})`);
  }
  return {
    ...ran,
    summary: notices.length > 0 ? `${ran.summary}\n${notices.join('\n')}` : ran.summary,
    envelope: { ...envelope, via: 'swap' },
  };
}

/** The automatic switch and its provider scope, from the global file now. */
async function replacementNow(dataDir: string): Promise<ReplacementSetting> {
  const config = await loadRawConfig(dataDir);
  return personalSettings(config.router, configPath(dataDir)).nativeReplacement;
}
