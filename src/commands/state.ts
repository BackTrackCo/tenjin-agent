import { DatabaseSync } from 'node:sqlite';
import { CliError } from '../lib/errors';
import { CLI_BUSY_TIMEOUT_MS } from '../lib/loop-db';
import { loopDbPath } from '../lib/paths';
import type { CommandContext, CommandResult } from '../context';

/**
 * `tenjin state query "<sql>"` (tenjin-agent#252, docs/command-reference.md
 * "State store"): a read-only escape hatch onto `~/.tenjin/loop.db` for an
 * operator debugging a fire, a pairing, a search or a fact by hand.
 *
 * Exists because the obvious tool does not work: `sqlite3 -readonly
 * ~/.tenjin/loop.db` fails from a subshell with "unable to open database file
 * (14)" — the file runs in WAL mode, and the standalone `sqlite3` binary's
 * `-readonly` open still wants to touch the `-shm` sidecar. This goes through
 * `node:sqlite`'s own `readOnly` option instead, which has no such failure
 * mode, and validates the statement is a single `SELECT` before it ever opens
 * the file: this verb is read-only by contract, not merely by the flag it
 * happens to pass the driver.
 *
 * NEVER {@link openLoopDbForCli}: that helper creates the file and runs the
 * DDL on it, neither of which a read-only inspection command may do, and
 * `readOnly: true` fails outright rather than creating a database that is not
 * there — exactly the right answer for this verb.
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
  const statement = assertSelectOnly(sql);
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(loopDbPath(ctx.dataDir), { readOnly: true });
  } catch (err) {
    throw new CliError(
      'STATE_QUERY_FAILED',
      `Could not open the loop database read-only: ${messageOf(err)}`,
      {
        fix: 'Run a command that touches it first (e.g. `tenjin push status`), or check the data dir.',
      },
    );
  }
  // Every other opener sets this first, and a read-only handle can still hit
  // BUSY racing the daemon's checkpoint: it gets the same wait rather than an
  // immediate `STATE_QUERY_FAILED`.
  db.exec(`PRAGMA busy_timeout = ${CLI_BUSY_TIMEOUT_MS}`);
  try {
    const rows = db.prepare(statement).all().filter(isRecord);
    return { data: { sql, rows }, humanLines: [JSON.stringify(rows, null, 2)] };
  } catch (err) {
    throw new CliError('STATE_QUERY_FAILED', `Query failed: ${messageOf(err)}`, {
      fix: 'Check the table/column names against docs/command-reference.md, "State store".',
    });
  } finally {
    db.close();
  }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A single `SELECT` (or `WITH ... SELECT`), with no second statement riding
 *  along after a `;`. Case-insensitive; leading/trailing whitespace, a
 *  leading comment, and one trailing `;` are tolerated. Applied to the
 *  MASKED text (see {@link maskSqlNoise}), never the raw one — a leading `--`
 *  comment reads as whitespace there, which is what lets one through. */
const SELECT_STATEMENT_RE = /^\s*(select|with)\b/i;

/**
 * Statement keywords SQLite accepts that this verb must never run, checked as
 * whole words against the MASKED text. Exists for the shape a leading-keyword
 * check alone cannot see: SQLite's grammar allows a `WITH cte AS (SELECT ...)`
 * prefix on `INSERT`/`UPDATE`/`DELETE` too, not only on `SELECT`, so
 * `WITH x AS (SELECT 1) DELETE FROM t` starts with the allowed keyword and
 * still writes. `readOnly: true` on the driver would refuse the write anyway,
 * but this is what keeps the refusal a clean `USAGE` message instead of a
 * `STATE_QUERY_FAILED` surfaced from the driver, and what keeps the contract
 * ("rejected before the file is ever opened") true for this shape too.
 * `PRAGMA`/`ATTACH` are in the list for the same reason, even though today's
 * leading-keyword check already rejects them on their own — a second layer
 * that does not depend on where in the statement they appear.
 */
const WRITE_KEYWORD_RE =
  /\b(?:INSERT|UPDATE|DELETE|REPLACE|DROP|ALTER|CREATE|ATTACH|DETACH|VACUUM|REINDEX|ANALYZE|GRANT|REVOKE|BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE|PRAGMA)\b/i;

/**
 * Blank out everything a semicolon or keyword check must not see INSIDE: `'…'`
 * and `"…"` literals (with the standard doubled-quote escape), `` `…` `` and
 * `[…]` quoted identifiers, and both comment styles (line and block) —
 * replaced character-for-character with spaces so positions and length are
 * preserved and every other check keeps running against the same offsets.
 *
 * WHY THIS EXISTS: `body.includes(';')` on the raw string rejected a valid
 * single statement whose only `;` sat inside a string literal or a comment
 * (`SELECT * FROM t WHERE msg = 'a;b'`), and a bare leading-keyword regex has
 * no way to see a write keyword that a `WITH` clause's parenthesized CTEs
 * push later in the string. Masking first makes both checks blind to noise
 * they were never supposed to be reading.
 */
function maskSqlNoise(sql: string): string {
  let out = '';
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const c = sql[i];
    const c2 = i + 1 < n ? sql[i + 1] : '';
    if (c === '-' && c2 === '-') {
      // The loop condition already excludes '\n', so every character masked
      // here is a non-newline; a per-character `=== '\n'` check on top of
      // that can never take its true branch.
      while (i < n && sql[i] !== '\n') {
        out += ' ';
        i++;
      }
      continue;
    }
    if (c === '/' && c2 === '*') {
      out += '  ';
      i += 2;
      while (i < n && !(sql[i] === '*' && i + 1 < n && sql[i + 1] === '/')) {
        out += sql[i] === '\n' ? sql[i] : ' ';
        i++;
      }
      if (i < n) {
        out += '  ';
        i += 2;
      }
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      const quote = c;
      out += ' ';
      i++;
      while (i < n) {
        if (sql[i] === quote) {
          if (i + 1 < n && sql[i + 1] === quote) {
            out += '  ';
            i += 2;
            continue;
          }
          out += ' ';
          i++;
          break;
        }
        out += sql[i] === '\n' ? sql[i] : ' ';
        i++;
      }
      continue;
    }
    if (c === '[') {
      // An UNTERMINATED `[` is not a quoted identifier — it is one stray
      // character. Masking it through to end-of-input (as a naive "consume
      // until ']' or EOF" would) blanks out everything after it, INCLUDING
      // any `;` that followed, which is exactly the separator the caller
      // relies on this function to preserve (PR 277 review). Looked up with
      // `indexOf` first so an unmatched `[` falls through to the plain-char
      // append below instead.
      const close = sql.indexOf(']', i + 1);
      if (close === -1) {
        out += c;
        i++;
        continue;
      }
      out += ' ';
      i++;
      while (i < close) {
        out += sql[i] === '\n' ? sql[i] : ' ';
        i++;
      }
      out += ' ';
      i = close + 1;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/**
 * Validate `sql` is exactly one read statement, or throw USAGE. Its own
 * function so the statement is rejected before the filesystem is ever touched.
 */
export function assertSelectOnly(sql: string): string {
  const trimmed = sql.trim();
  if (trimmed.length === 0) {
    throw new CliError('USAGE', 'A SQL statement is required.', {
      fix: 'Pass a SELECT statement, e.g. `tenjin state query "SELECT key, at FROM facts LIMIT 5"`.',
    });
  }
  // `trimmed` has no trailing whitespace, so `masked` is the same length and
  // stays index-aligned with it for every check below.
  const masked = maskSqlNoise(trimmed);
  // Exactly one trailing `;` is stripped before the chaining check, so
  // `SELECT 1;` is not mistaken for two statements; `SELECT 1; DROP TABLE x`
  // still is. Checked on the MASKED tail so a `;` that is the last character
  // of a string literal (`SELECT ';'`) is not mistaken for a statement
  // terminator.
  const strip = masked.endsWith(';');
  const body = strip ? trimmed.slice(0, -1) : trimmed;
  const bodyMasked = strip ? masked.slice(0, -1) : masked;
  if (bodyMasked.includes(';')) {
    throw new CliError('USAGE', 'Only one statement is allowed.', {
      fix: 'Pass exactly one SELECT statement — drop everything after the first `;`.',
    });
  }
  if (!SELECT_STATEMENT_RE.test(bodyMasked)) {
    throw new CliError('USAGE', 'Only a SELECT statement is allowed.', {
      fix: '`tenjin state query` is read-only: pass a `SELECT ...` or `WITH ... SELECT ...` statement.',
    });
  }
  if (WRITE_KEYWORD_RE.test(bodyMasked)) {
    throw new CliError('USAGE', 'Only a read-only SELECT statement is allowed.', {
      fix: 'Remove the write keyword (INSERT/UPDATE/DELETE/DROP/ALTER/PRAGMA/...) — a `WITH` clause may not lead into one.',
    });
  }
  return body;
}
