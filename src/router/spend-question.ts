import { DEFAULT_MAX_AUTO_SPEND, DEFAULT_SESSION_BUDGET } from '../lib/config';
import { toMoney } from '../lib/money';
import { CHANNEL_DEPOSIT_ATOMIC, MAX_CHANNEL_DEPOSIT_ATOMIC, ROUTING_FEE_ATOMIC, usd } from './fee';

/**
 * THE SPEND QUESTION, ONE TEXT FOR EVERY PLACE THAT ASKS IT: the defaults, or
 * your own limits. The selector in a terminal and the question an install
 * that could not ask hands to its agent show the same words, so the agent puts
 * to the person exactly what the selector would have. The defaults hold
 * whether or not anyone answers.
 */

/** The automatic router defaults, in atomic USDC: $0.25 a call, $5 a day. */
export const ROUTER_DEFAULTS = {
  maxAutoSpend: DEFAULT_MAX_AUTO_SPEND,
  sessionBudget: DEFAULT_SESSION_BUDGET,
} as const;

/** The automatic limits install writes, in atomic USDC; `sessionBudget` may be `none`. */
export interface RouterLimits {
  maxAutoSpend: string;
  sessionBudget: string;
}

/** The file's own value where it names one, else the default. */
export function shownLimits(config: {
  maxAutoSpend?: string | undefined;
  sessionBudget?: string | undefined;
}): RouterLimits {
  return {
    maxAutoSpend: config.maxAutoSpend ?? ROUTER_DEFAULTS.maxAutoSpend,
    sessionBudget: config.sessionBudget ?? ROUTER_DEFAULTS.sessionBudget,
  };
}

/** The limits in USD. */
export function limitsUsd(limits: RouterLimits): { maxAutoSpend: string; sessionBudget: string } {
  return {
    maxAutoSpend: toMoney(limits.maxAutoSpend).usd,
    sessionBudget: limits.sessionBudget === 'none' ? 'none' : toMoney(limits.sessionBudget).usd,
  };
}

/** The routing fee's terms, as the selector names them. */
export const ROUTING_FEE_TERMS = `Routing costs $${usd(ROUTING_FEE_ATOMIC)} a call, paid from funds Tenjin sets aside: $${usd(MAX_CHANNEL_DEPOSIT_ATOMIC)} at a time, or $${usd(CHANNEL_DEPOSIT_ATOMIC)} while your balance is under $${usd(2n * MAX_CHANNEL_DEPOSIT_ATOMIC)}. Unused funds remain yours; each deposit counts against these limits, and fees from it are not counted again.`;

/** The selector's own line: either answer approves the fee. */
export const FEE_APPROVAL = 'Either answer also approves the routing fee.';

const DEFAULTS_USD = limitsUsd(ROUTER_DEFAULTS);

/** The question, for the agent to put to the person as written. */
export const SPEND_QUESTION = `Use the defaults ($${DEFAULTS_USD.sessionBudget} daily budget shared across chats, $${DEFAULTS_USD.maxAutoSpend} a call) or set your own limits.`;

/** The question with the fee terms either answer approves. */
export function spendChoiceQuestion(): string {
  return `${SPEND_QUESTION} ${ROUTING_FEE_TERMS} ${FEE_APPROVAL}`;
}

/** One answer to {@link spendChoiceQuestion}, and the one command that applies it. */
export interface SpendOption {
  id: 'default' | 'custom';
  label: string;
  recommended: boolean;
  /** What to ask the person after they pick this option, before running `command`. */
  ask?: string[];
  /** The command the agent runs alone for this answer. */
  command: string;
}

/**
 * The two answers, each applied by the agent with one command and never by
 * the person: `install` is the install that was run (its `--project` and
 * `--no-wallet` kept), so the answer leaves every other choice as it was.
 */
export function spendOptions(install: string): SpendOption[] {
  return [
    { id: 'default', label: 'Use the defaults', recommended: true, command: `${install} --yes` },
    {
      id: 'custom',
      label: 'Set my own limits',
      recommended: false,
      ask: [
        'Daily budget shared across chats, in USD, or none for no limit',
        'The most it may pay for one call, in USD, at least 0.25',
      ],
      command: `${install} --max-auto-spend <usd> --session-budget <usd|none>`,
    },
  ];
}
