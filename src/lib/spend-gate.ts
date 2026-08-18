import { CliError } from './errors';
import { toMoney } from './money';
import { promptYesNo } from './prompt';
import type { SpendAuthorizer } from './wallet';
import type { CommandContext } from '../context';

/**
 * The one money gate `buy` and `pay` share: policy authorization, the confirm
 * ceremony, and the refusal shapes. Both verbs run EXACTLY this sequence
 * between seeing a price and building a signature, so the two cannot drift on
 * what `--yes` clears (the confirm only), what a deny looks like, or when a
 * reservation is released. The caller still owns everything around it: the
 * challenge it priced, the payment build, and settling the reservation after a
 * failure: releasing only while no signature has left the process, committing
 * once one has (pay.ts), because a transmitted authorization can still settle.
 */

export interface SpendGateInput {
  ctx: CommandContext;
  authorizer: SpendAuthorizer;
  amountAtomic: bigint;
  /** The policy's creator identity (a handle for buy, the target host for pay). */
  creator: string;
  maxPriceAtomic?: bigint;
  /** --yes: bypasses the interactive confirm only, never a cap or a deny. */
  yes: boolean;
  /** Interactive-confirm seam; defaults to a TTY y/n prompt. */
  confirm?: (prompt: string) => Promise<boolean>;
  /**
   * Who the human is told they are paying, PRE-SANITIZED by the caller (it
   * knows which parts are external input). Rendered before the price so escape
   * sequences could never repaint the amount being approved.
   */
  payeeLabel: string;
  /** "Add the creator" (buy) vs "Add this host" (pay) in the allowlist fix. */
  allowlistSubject: string;
  /** "Purchase not confirmed." (buy) vs "Payment not confirmed." (pay). */
  notConfirmedMessage: string;
}

/** Runs the gate; returns the reservation to commit or release (undefined
 *  mirrors the authorizer's own optionality, same as before the extraction).
 *  Throws POLICY_REFUSED (deny, or confirm declined), releasing first. */
export async function gateSpend(input: SpendGateInput): Promise<string | undefined> {
  const { authorizer, amountAtomic } = input;
  const authorization = await authorizer.authorize({
    amountAtomic,
    creator: input.creator,
    ...(input.maxPriceAtomic !== undefined ? { maxPriceAtomic: input.maxPriceAtomic } : {}),
  });
  if (authorization.decision === 'deny') {
    throw new CliError('POLICY_REFUSED', authorization.message, {
      fix: policyFix(authorization.reason, input.allowlistSubject),
      details: { reason: authorization.reason, amountAtomic: amountAtomic.toString() },
    });
  }
  const reservationId = authorization.reservationId;
  if (authorization.decision === 'confirm') {
    const approved = await confirmSpend(input);
    if (!approved) {
      await authorizer.release(reservationId);
      throw new CliError('POLICY_REFUSED', input.notConfirmedMessage, {
        fix: 'Re-run with --yes, or set a policy that auto-approves this spend.',
        details: { reason: authorization.reason, amountAtomic: amountAtomic.toString() },
      });
    }
  }
  return reservationId;
}

function policyFix(reason: string, allowlistSubject: string): string {
  switch (reason) {
    case 'price_cap_exceeded':
      return 'Raise --max-price if this price is acceptable.';
    case 'not_allowlisted':
      return `Add ${allowlistSubject} to allowlistCreators, or clear the allowlist.`;
    case 'session_budget_exceeded':
      return 'Raise sessionBudget with `tenjin config set sessionBudget <usd>`, or wait for the window to roll over.';
    default:
      return 'Adjust your spend policy with `tenjin config set`.';
  }
}

async function confirmSpend(input: SpendGateInput): Promise<boolean> {
  if (input.yes) return true;
  const prompt = `Pay ${toMoney(input.amountAtomic.toString()).usd} USD to ${input.payeeLabel}? [y/N] `;
  if (input.confirm !== undefined) return input.confirm(prompt);
  if (!input.ctx.io.isTTY) return false; // non-interactive without --yes: refuse (exit 3)
  // The real prompt reads stdin, so stdin must be interactive too: at EOF the
  // question could never be answered and the process would exit with no answer.
  if (!process.stdin.isTTY) return false;
  return promptYesNo(prompt); // default-no: only an explicit y/yes approves
}
