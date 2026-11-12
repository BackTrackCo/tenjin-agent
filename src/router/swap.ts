import { toMoney } from '../lib/money';
import { savedAccount } from './accounts/saved';
import { isAccountSpec } from './decision';
import { decideSwap, type HookDeps } from './hooks';
import { personalSettingsAt } from './settings';
import { costLines, runRequestTool, type RequestToolDeps, type RequestToolResult } from './tool';

/**
 * THE SWAP (plan 36, Plan 25 PR 3): "Run Tenjin's picks automatically". With
 * `router.nativeReplacement: when-routed`, the Claude Code mod asks the
 * request tool's `decide` form about a native WebSearch or WebFetch before it
 * runs (`hosts/claude/tenjin/hooks/register.tsx`). The answer is the lookup's
 * own result, marked `via: "swap"`, or a hand-back, after which the native
 * call takes the host's ordinary route (the pre-call hook, which offers from
 * the answer already got: `decided.ts`).
 *
 * IT RUNS ONLY WHEN EVERY CONDITION HOLDS, in this order:
 *
 * 1. The switch is `when-routed` in the global file, read now.
 * 2. The router's answer, through the hook body (the gate's confidence floor
 *    applies), carries `bound`: the offer id and the complete input built
 *    from this call's own search or URL, which the server sends only while
 *    automatic use is on and the pick fits its provider scope.
 * 3. It would run without approval within the limits and the balance; an
 *    over-limit price hands back, and its offer asks as usual.
 * 4. The switch, read again now, is still on.
 * 5. Nothing else holds this call's redirect claim (dedupe).
 *
 * Then `request({id, input})` runs `bound` unchanged through the ordinary
 * executor: the check before every call (the settings hash, so a scope or
 * rule changed since the decision refuses), the spend limits and the claim.
 * `bound` is never parsed, filled, edited or merged here. A hand-back after
 * the claim (the executor refused before anything was sent) lets the native
 * call run, and its mark no longer says it was answered in place; once the
 * provider call has started, its result or error is the answer, with its real
 * payment state, and nothing is replayed.
 *
 * A PICK ON THE USER'S CONNECTED ACCOUNT runs the same way (plan 37): only a
 * map Tenjin has checked comes with `bound`, the account's plan pays, and the
 * map's own caps hold where the Tenjin limits do not. An account that refuses
 * before anything ran (its sign-in expired, its plan ran out) stops this one
 * call with the reason and Tenjin's own tool for the job and its price, and
 * the agent's retry runs natively; Tenjin's tool never runs in its place here,
 * since it has not met the automatic-use checks.
 */

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

/** How a person reads the native tool a pick ran in place of. */
const NATIVE_NAMES = { WebSearch: 'web search', WebFetch: 'page fetch' } as const;

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
  const decided = await decideSwap(event, { ...hookDeps, notice: (line) => notices.push(line) });
  if ('handback' in decided) return handBack(decided.handback);
  const { bound, spec, tool } = decided;
  // THE SWITCH AS IT IS NOW: turned off while the router decided, it stops
  // here, before anything is claimed or sent. A changed provider scope or
  // rule is the settings hash's to refuse, in the executor.
  const now = await personalSettingsAt(hookDeps.dataDir).catch(() => undefined);
  if (now?.nativeReplacement.mode !== 'when-routed') return handBack('automatic use is off');
  if (!(await decided.claim())) return handBack('already routed once');
  let ran: RequestToolResult;
  try {
    ran = await runRequestTool({ id: bound.id, input: bound.input }, { ...deps, via: 'swap' });
  } catch (err) {
    // The caller hands the call back on a throw, so the native call runs.
    await decided.unmark().catch(() => undefined);
    throw err;
  }
  const { envelope } = ran;
  const status = String(envelope.status);
  if (NOT_STARTED.has(status) && envelope.refused === undefined) {
    await decided.unmark();
    return handBack(`it stopped before anything was sent (${String(envelope.reason ?? status)})`);
  }
  // THE VISIBLE LINE: the service, its price or the account that pays, and
  // the native tool it answered.
  const label = spec.label ?? spec.provider;
  let line: string;
  if (isAccountSpec(spec)) {
    const account = (await savedAccount(hookDeps.dataDir, spec.source))?.label ?? spec.provider;
    line =
      envelope.refused !== undefined
        ? `Your ${account} account refused ${label}, which Tenjin picked in place of this ${NATIVE_NAMES[tool]}, so the ${NATIVE_NAMES[tool]} did not run this time; the user's next one runs as usual.`
        : `${account} · your account · instead of ${tool}: Tenjin ran ${label} on the user's own ${account} account in place of this ${NATIVE_NAMES[tool]}, because the user turned on "Run Tenjin's picks automatically". Their ${account} plan pays, not the Tenjin balance.`;
  } else {
    const price = `$${toMoney(spec.priceVaries ? spec.maxAmountAtomic : spec.priceAtomic).usd}`;
    line = `Tenjin ran ${label} (${spec.priceVaries ? 'up to ' : ''}${price}) in place of this ${NATIVE_NAMES[tool]}, because the user turned on "Run Tenjin's picks automatically".`;
  }
  return {
    ...ran,
    summary: [line, ran.summary, ...notices].join('\n'),
    envelope: { ...envelope, via: 'swap', inPlaceOf: tool },
  };
}
