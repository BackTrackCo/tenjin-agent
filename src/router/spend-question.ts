import { toMoney } from '../lib/money';
import { CHANNEL_DEPOSIT_ATOMIC, ROUTING_FEE_ATOMIC, unpaidSentence, usd } from './fee';

/**
 * THE SPEND QUESTION, ONE TEXT FOR EVERY PLACE THAT ASKS IT. The selector in a
 * terminal, the question an install that could not ask hands to its agent,
 * doctor's warning and the routing notice all show the same limits, the same
 * routing-fee terms and the same one-step yes, so the agent can put to the
 * user exactly what the selector would have.
 */

/** Absent-only automatic router defaults, in atomic USDC. */
export const ROUTER_DEFAULTS = {
  maxAutoSpend: '250000',
  sessionBudget: '5000000',
} as const;

/** The automatic limits a fresh install fills in, in atomic USDC; `sessionBudget` may be `none`. */
export interface RouterLimits {
  maxAutoSpend: string;
  sessionBudget: string;
}

/** What the question shows: the file's own value where it names one, else the default. */
export function shownLimits(config: {
  maxAutoSpend?: string | undefined;
  sessionBudget?: string | undefined;
}): RouterLimits {
  return {
    maxAutoSpend: config.maxAutoSpend ?? ROUTER_DEFAULTS.maxAutoSpend,
    sessionBudget: config.sessionBudget ?? ROUTER_DEFAULTS.sessionBudget,
  };
}

/** The limits in USD, as the question shows them. */
export function limitsUsd(limits: RouterLimits): { maxAutoSpend: string; sessionBudget: string } {
  return {
    maxAutoSpend: toMoney(limits.maxAutoSpend).usd,
    sessionBudget: limits.sessionBudget === 'none' ? 'none' : toMoney(limits.sessionBudget).usd,
  };
}

/** "up to $0.25 a call and $5 a day" */
export function limitsPhrase(limits: RouterLimits): string {
  const usdOf = limitsUsd(limits);
  const daily =
    usdOf.sessionBudget === 'none' ? 'with no daily limit' : `and $${usdOf.sessionBudget} a day`;
  return `up to $${usdOf.maxAutoSpend} a call ${daily}`;
}

/** The routing fee's terms, as the selector names them. */
export const ROUTING_FEE_TERMS = `Routing costs $${usd(ROUTING_FEE_ATOMIC)} a call, paid from channel deposits of up to $${usd(CHANNEL_DEPOSIT_ATOMIC)} that stay yours until spent; each deposit counts against these limits.`;

/** The one command that answers yes to the limits shown, as the selector's "Use these limits" does. */
export function acceptCommand(project: boolean): string {
  return `tenjin install${project ? ' --project' : ''} --accept-defaults`;
}

/** The commands for limits of the user's own, each in backticks. */
export const OWN_LIMITS_COMMANDS =
  '`tenjin config set maxAutoSpend <usd>` and `tenjin config set sessionBudget <usd|none>`';

/** The question, for the agent to put to the user as written. */
export function spendQuestion(limits: RouterLimits): string {
  return `May Tenjin pay for tool calls without asking you each time, ${limitsPhrase(limits)}? ${ROUTING_FEE_TERMS} A yes also approves the routing fee.`;
}

/**
 * The routing notice for a machine whose limits nobody has answered: the
 * question and the one-step yes. The hook cannot tell a `--project` install
 * from a home one, so it names the flag rather than guess.
 */
export function unansweredNotice(limits: RouterLimits): string {
  return `Tenjin pays for nothing on its own yet: the spend limits are not answered. Ask the user: ${spendQuestion(limits)} For a yes, run \`${acceptCommand(false)}\` (add --project if Tenjin was installed with it); for other amounts, run ${OWN_LIMITS_COMMANDS}.`;
}

/**
 * The routing notice for a call that was not paid: the limits question when
 * the per-call limit is the code default's zero because nobody has answered
 * it, else the reason and fix for `why`.
 */
export function unpaidNotice(
  why: string,
  config: { maxAutoSpend?: string | undefined; sessionBudget?: string | undefined },
): string | null {
  if (why === 'limit_below_deposit' && config.maxAutoSpend === undefined) {
    return unansweredNotice(shownLimits(config));
  }
  return unpaidSentence(why);
}
