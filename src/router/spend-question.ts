import { DEFAULT_MAX_AUTO_SPEND, DEFAULT_SESSION_BUDGET } from '../lib/config';
import { toMoney } from '../lib/money';
import { usd } from './fee';

/**
 * THE SPEND QUESTION, ONE TEXT FOR EVERY PLACE THAT ASKS IT: how much the
 * agent may spend, the defaults or your own limits. The selector in a terminal and the question an install
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

/** `$0.25 a call · $5.00 a day`: the limits a policy holds, as a person reads them. */
export function limitsLine(policy: {
  maxAutoSpendAtomic: bigint;
  sessionBudgetAtomic: bigint | null;
}): string {
  const daily =
    policy.sessionBudgetAtomic === null
      ? 'no daily limit'
      : `$${usd(policy.sessionBudgetAtomic)} a day`;
  return `$${usd(policy.maxAutoSpendAtomic)} a call · ${daily}`;
}

/** The limits in USD. */
export function limitsUsd(limits: RouterLimits): { maxAutoSpend: string; sessionBudget: string } {
  return {
    maxAutoSpend: toMoney(limits.maxAutoSpend).usd,
    sessionBudget: limits.sessionBudget === 'none' ? 'none' : toMoney(limits.sessionBudget).usd,
  };
}

/** The fee terms approved with either spending-limit choice. */
export const ROUTING_FEE_TERMS =
  'Tenjin charges 15% of the estimated tool cost for paid recommendations, up to 25¢. Tool use is billed separately. Routing top-ups count toward your limits.';

/** The selector's own line: either answer approves the fee. */
export const FEE_APPROVAL = 'Either choice approves this.';

const DEFAULTS_USD = limitsUsd(ROUTER_DEFAULTS);

/** The question, for the agent to put to the person as written. */
export const SPEND_QUESTION = 'How much can your agent spend from its balance?';

/** The recommended answer: the defaults, as amounts. */
export const DEFAULTS_LABEL = `Up to $${DEFAULTS_USD.maxAutoSpend} a call and $${DEFAULTS_USD.sessionBudget} a day`;

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
    { id: 'default', label: DEFAULTS_LABEL, recommended: true, command: `${install} --yes` },
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
