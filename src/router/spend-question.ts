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

/**
 * The yes to the limits shown, where the command install ran is not known
 * (doctor, the routing notice, the request tool): the per-call limit only.
 * The daily limit already defaults to the one shown. A bare `install --yes`
 * here would undo a `--project` or `--no-wallet` install; install's own
 * output names that command with its flags instead.
 */
export const ACCEPT_COMMAND = `tenjin config set maxAutoSpend ${toMoney(ROUTER_DEFAULTS.maxAutoSpend).usd}`;

/** The commands for limits of the user's own, each in backticks. */
export const OWN_LIMITS_COMMANDS =
  '`tenjin config set maxAutoSpend <usd>` and `tenjin config set sessionBudget <usd|none>`';

/** The selector's own line: either answer approves the fee. */
export const FEE_APPROVAL =
  'Using these limits or choosing your own also approves the routing fee.';

/** The question, for the agent to put to the user as written. */
export function spendQuestion(limits: RouterLimits): string {
  return `May Tenjin pay for tool calls without asking you each time, ${limitsPhrase(limits)}? ${ROUTING_FEE_TERMS} ${FEE_APPROVAL}`;
}

/** The question an install that could not ask hands to its agent, with {@link spendOptions}. */
export function spendChoiceQuestion(): string {
  return `How much may Tenjin pay for tool calls without asking you each time? ${ROUTING_FEE_TERMS} ${FEE_APPROVAL}`;
}

/** One answer to {@link spendChoiceQuestion}, and the one command that applies it. */
export interface SpendOption {
  id: 'default' | 'custom' | 'none';
  label: string;
  recommended: boolean;
  /** What to ask the person after they pick this option, before running `command`. */
  ask?: string[];
  /** The command the agent runs alone for this answer, or null: run nothing. */
  command: string | null;
}

/**
 * The three answers, each applied by the agent with one command and never by
 * the person: `install` is the install that was run (its `--project` and
 * `--no-wallet` kept), so the answer leaves every other choice as it was.
 */
export function spendOptions(limits: RouterLimits, install: string): SpendOption[] {
  return [
    {
      id: 'default',
      label: `Default: ${limitsPhrase(limits)}`,
      recommended: true,
      command: `${install} --yes`,
    },
    {
      id: 'custom',
      label: 'Custom limits',
      recommended: false,
      ask: [
        'The most Tenjin may pay for one call, in USD',
        'The most it may pay in a day, in USD, or none for no daily limit',
      ],
      command: `${install} --max-auto-spend <usd> --session-budget <usd|none>`,
    },
    { id: 'none', label: 'No automatic spending', recommended: false, command: null },
  ];
}

/** Who reads a notice: the user, in the hook's `systemMessage`, or the agent,
 *  in the request tool's answer. */
export type NoticeReader = 'user' | 'agent';

/**
 * The routing notice for a machine whose limits nobody has answered: the
 * question and the one-step yes, put to the user directly, or handed to the
 * agent to ask.
 */
export function unansweredNotice(limits: RouterLimits, reader: NoticeReader): string {
  const open = 'Tenjin pays for nothing on its own yet: the spend limits are not answered.';
  if (reader === 'agent') {
    return `${open} Ask the user: ${spendQuestion(limits)} For a yes, run \`${ACCEPT_COMMAND}\`; for other amounts, run ${OWN_LIMITS_COMMANDS}.`;
  }
  return `${open} It can pay for tool calls without asking you each time, ${limitsPhrase(limits)}. ${ROUTING_FEE_TERMS} ${FEE_APPROVAL} To use these limits, run \`${ACCEPT_COMMAND}\`; to choose your own, run ${OWN_LIMITS_COMMANDS}.`;
}

/**
 * The routing notice for a call that was not paid: the limits question when
 * the per-call limit is the code default's zero because nobody has answered
 * it, else the reason and fix for `why`.
 */
export function unpaidNotice(
  why: string,
  config: { maxAutoSpend?: string | undefined; sessionBudget?: string | undefined },
  reader: NoticeReader,
): string | null {
  if (why === 'limit_below_deposit' && config.maxAutoSpend === undefined) {
    return unansweredNotice(shownLimits(config), reader);
  }
  return unpaidSentence(why);
}
