import { queryStateReadOnly } from '../lib/state-store';
import type { CommandContext, CommandResult } from '../context';

/**
 * `tenjin state query "<sql>"` (tenjin-agent#252, docs/command-reference.md
 * "State store"): a read-only escape hatch onto `~/.tenjin/state.db` for an
 * operator debugging a pairing, a search, or a hook's own bookkeeping by hand.
 *
 * Exists because the obvious tool does not work: `sqlite3 -readonly
 * ~/.tenjin/state.db` fails from a subshell with "unable to open database file
 * (14)" — the store runs in WAL mode, and the standalone `sqlite3` binary's
 * `-readonly` open still wants to touch the `-shm` sidecar. This goes through
 * `node:sqlite`'s own `readOnly` option instead (see
 * `lib/state-store.ts#queryStateReadOnly`), which has no such failure mode, and
 * validates the statement is a single `SELECT` before it ever opens the file:
 * this verb is read-only by contract, not merely by the flag it happens to
 * pass the driver.
 *
 * Rows print as JSON either way (human or `--json`) — a query result is a
 * table an operator picked the shape of, and inventing a second, narrower
 * rendering for it would only ever be worse than the JSON they can already
 * pipe into `jq`.
 */
export async function runStateQuery(
  { sql }: { sql: string },
  ctx: CommandContext,
): Promise<CommandResult> {
  const rows = await queryStateReadOnly(ctx.dataDir, sql);
  return {
    data: { sql, rows },
    humanLines: [JSON.stringify(rows, null, 2)],
  };
}
