import type { CommandContext } from '../context';
import { readStdin } from './hook-command';
import { runRepositoryHook } from './repository-hook';

export async function runRepositoryHookCommand(ctx: CommandContext): Promise<void> {
  const lifecycle = new AbortController();
  const abort = () => lifecycle.abort();
  process.once('SIGTERM', abort);
  process.once('SIGINT', abort);
  try {
    const outcome = await runRepositoryHook(JSON.parse(await readStdin()) as unknown, {
      ctx,
      signal: lifecycle.signal,
    });
    if (outcome.response !== null) ctx.io.stdout.write(`${JSON.stringify(outcome.response)}\n`);
    ctx.io.stderr.write(`Tenjin repository hook: ${outcome.reason}.\n`);
  } catch {
    // Fail open: a malformed event cannot block the user's native tool.
  } finally {
    process.removeListener('SIGTERM', abort);
    process.removeListener('SIGINT', abort);
  }
}
