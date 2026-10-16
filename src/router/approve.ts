import { CliError } from '../lib/errors';
import { toMoney } from '../lib/money';
import { sanitizeForTerminal } from '../lib/output';
import { promptYesNo } from '../lib/prompt';
import { approveQuote, quoteClosed, readQuote } from '../lib/spend-quotes';
import type { CommandContext, CommandResult } from '../context';

/**
 * `tenjin approve <quote>`: A PERSON'S YES AT A TERMINAL, for a host that can
 * neither prompt before `approve` nor ask mid-call. It shows the quote's own
 * sentence and asks; a yes is kept on the quote, and the agent's next
 * `approve({quote})` runs it. Nothing is paid here.
 *
 * ONLY A PERSON ANSWERS IT. It asks at an interactive terminal and refuses
 * anywhere else, with no flag that skips the question, so an agent's shell
 * cannot approve its own quote.
 */
export async function runApproveCommand(
  args: { quote: string },
  ctx: CommandContext,
  deps: { ask?: (prompt: string) => Promise<boolean>; now?: () => number } = {},
): Promise<CommandResult> {
  const now = deps.now ?? Date.now;
  const quote = await readQuote(ctx.dataDir, args.quote.trim());
  if (quote === null) {
    throw new CliError('USAGE', 'No quote is kept on this machine under that id.', {
      fix: 'Copy the id from the `tenjin approve` line your assistant gave you.',
    });
  }
  const closed = quoteClosed(quote, now());
  if (closed !== null) {
    throw new CliError(
      'REFUSED',
      closed === 'used' ? 'That quote already ran.' : 'That quote expired; nothing was paid.',
      {
        fix:
          closed === 'used'
            ? 'A quote pays once.'
            : 'Ask your assistant to run the call again for a fresh quote.',
      },
    );
  }
  const ask =
    deps.ask ??
    (ctx.io.isTTY && process.stdin.isTTY === true ? (prompt: string) => promptYesNo(prompt) : null);
  if (ask === null) {
    throw new CliError('REFUSED', 'tenjin approve asks you at an interactive terminal.', {
      fix: `Run \`tenjin approve ${quote.id}\` yourself, in a terminal.`,
    });
  }
  const total = `$${toMoney(quote.totalAtomic).usd}`;
  if (!(await ask(`${sanitizeForTerminal(quote.sentence)} Go ahead? [y/N] `))) {
    return {
      data: { quote: quote.id, approved: false },
      humanLines: ['Not approved; nothing was paid.'],
    };
  }
  const approved = await approveQuote(ctx.dataDir, quote.id, now);
  if ('refused' in approved) {
    throw new CliError('REFUSED', `That quote can no longer run (${approved.refused}).`, {
      fix: 'Ask your assistant to run the call again for a fresh quote.',
    });
  }
  return {
    data: { quote: quote.id, approved: true, total, expiresAt: quote.expiresAt },
    humanLines: [
      `Approved ${sanitizeForTerminal(quote.what)}, ${total} in total. Tell your assistant: it runs it with approve({quote: "${quote.id}"}).`,
    ],
  };
}
