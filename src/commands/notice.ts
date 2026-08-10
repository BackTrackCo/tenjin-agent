import { acknowledgeInstallReceipt, pendingInstallNoticeData } from '../lib/install-receipt';
import { sanitizeForTerminal } from '../lib/output';
import type { CommandContext, CommandResult } from '../context';

export async function runNoticeAcknowledge(
  id: string,
  ctx: CommandContext,
): Promise<CommandResult> {
  const stored = await acknowledgeInstallReceipt(ctx.dataDir, id);
  return {
    data: {
      notice: pendingInstallNoticeData(stored),
      receipt: stored.receipt,
    },
    humanLines: [
      `Install notice ${stored.receipt.id} acknowledged locally.`,
      'This dismisses Tenjin reminders; it does not prove a human performed the acknowledgment.',
      `Receipt retained at ${sanitizeForTerminal(stored.path)}.`,
    ],
  };
}
