import { CliError } from '../lib/errors';
import { HOOK_ARMS, loadConfig, type HookArm } from '../lib/config';
import { persistHookArm } from './config';
import { withLoopDb } from '../lib/loop-db';
import { loopDbPath } from '../lib/paths';
import { health, readPid } from '../hooks/shim';
import type { LoopDb, Row } from '../hooks/store';
import type { CommandContext, CommandResult } from '../context';

/**
 * `tenjin hooks`: the seven arms, whether each is on, the harness event it
 * answers, and what it has done in the last week. `tenjin hooks enable|disable <arm>` is the switch.
 *
 * One surface for a thing that had several: the state comes from the same
 * `hooks.<arm>` booleans `tenjin config` reads and is written through the same
 * locked merge `config set` writes with, and the counts come from the `fires`
 * rows the daemon already keeps. Nothing here is a second copy of either.
 *
 * `list` for state, `status` for a process: the daemon line at the bottom is
 * the one process fact, read exactly the way `tenjin daemon status` reads it.
 */

/** The window every count on this table covers; the ledger's report window. */
const WINDOW_DAYS = 7;
const WINDOW_MS = WINDOW_DAYS * 24 * 60 * 60 * 1000;

/** The harness event each arm answers, as the harness names it. */
const ARM_EVENTS: Record<HookArm, string> = {
  prompt: 'UserPromptSubmit',
  'web-search': 'WebSearch',
  'web-fetch': 'WebFetch',
  subagent: 'Agent, SubagentStart',
  failure: 'PostToolUse failure',
  publish: 'Stop',
  primer: 'SessionStart',
};

/**
 * The arm ids the daemon writes into `fires.arm`, per key. Two arms fire under
 * two ids each — `subagent` answers the dispatch and the child's start, and
 * `publish` asks at the lead's Stop and at each child's — and a key that
 * covers both must count both.
 *
 * The `context` arm is absent because it has no key: it asks nothing and
 * delivers nothing, and counting its bookkeeping fires under another arm's row
 * would inflate a number this table exists to report honestly.
 */
const ARM_FIRES: Record<HookArm, readonly string[]> = {
  prompt: ['prompt'],
  'web-search': ['research'],
  'web-fetch': ['fetch'],
  subagent: ['dispatch', 'subagent-start'],
  failure: ['failure'],
  publish: ['stop', 'subagent-stop'],
  primer: ['primer'],
};

export interface HooksListDeps {
  now?: () => number;
  /** Seam for the ledger read; defaults to the real query over `loop.db`. */
  fireCounts?: (dataDir: string, sinceMs: number) => FireCounts;
  /** Seam for the daemon line, so a test needs no listening process. */
  daemonLine?: (ctx: CommandContext) => Promise<DaemonState>;
}

/** Fires and hits in the window, per `fires.arm` id. */
export type FireCounts = Record<string, { fired: number; hit: number }>;

export interface DaemonState {
  running: boolean;
  pid?: number;
  port?: number;
  version?: string;
}

interface ArmRow {
  arm: HookArm;
  state: 'enabled' | 'disabled';
  event: string;
  fired: number;
  hit: number;
}

/**
 * One pass over the window's `fires`, grouped in SQL rather than in memory: the
 * table wants two numbers per arm and nothing else, so nothing else is read.
 */
export function readFireCounts(dataDir: string, sinceMs: number): FireCounts {
  return withLoopDb(dataDir, (db: LoopDb) => {
    const rows = db
      .prepare('SELECT arm, reason, COUNT(*) AS n FROM fires WHERE at >= ? GROUP BY arm, reason')
      .all(sinceMs) as Row[];
    const out: FireCounts = {};
    for (const row of rows) {
      if (typeof row.arm !== 'string') continue;
      const n = typeof row.n === 'number' ? row.n : 0;
      const entry = (out[row.arm] ??= { fired: 0, hit: 0 });
      entry.fired += n;
      if (row.reason === 'hit') entry.hit += n;
    }
    return out;
  });
}

/** The daemon behind the entries, the way `tenjin daemon status` asks. */
async function readDaemonState(ctx: CommandContext): Promise<DaemonState> {
  const rec = readPid(ctx.dataDir);
  const h = rec === null ? null : await health(rec.port);
  if (h === null || h.data_dir !== ctx.dataDir) return { running: false };
  return { running: true, pid: h.pid, port: h.port, version: h.version };
}

export async function runHooksList(
  ctx: CommandContext,
  deps: HooksListDeps = {},
): Promise<CommandResult> {
  const config = await loadConfig(ctx.dataDir);
  const now = (deps.now ?? Date.now)();
  const counts = (deps.fireCounts ?? readFireCounts)(ctx.dataDir, now - WINDOW_MS);
  const daemon = await (deps.daemonLine ?? readDaemonState)(ctx);
  const rows: ArmRow[] = HOOK_ARMS.map((arm) => {
    let fired = 0;
    let hit = 0;
    for (const id of ARM_FIRES[arm]) {
      fired += counts[id]?.fired ?? 0;
      hit += counts[id]?.hit ?? 0;
    }
    return {
      arm,
      state: config.hooks[arm] ? 'enabled' : 'disabled',
      event: ARM_EVENTS[arm],
      fired,
      hit,
    };
  });
  const ledger = loopDbPath(ctx.dataDir);
  return {
    data: { windowDays: WINDOW_DAYS, arms: rows, daemon, ledger },
    humanLines: [...tableLines(rows), daemonSummary(daemon, ledger)],
  };
}

/** The table, every column padded to its widest cell so the numbers line up. */
function tableLines(rows: ArmRow[]): string[] {
  const header = ['ARM', 'STATE', 'EVENT', `FIRED ${WINDOW_DAYS}d`, `HIT ${WINDOW_DAYS}d`];
  const cells = [
    header,
    ...rows.map((r) => [r.arm, r.state, r.event, String(r.fired), String(r.hit)]),
  ];
  const width = header.map((_, i) => Math.max(...cells.map((row) => (row[i] ?? '').length)));
  return cells.map((row) =>
    row
      .map((cell, i) => cell.padEnd(width[i] ?? 0))
      .join('  ')
      .trimEnd(),
  );
}

/** The daemon behind the arms, and the file every count above was read from —
 *  the one place the ledger's path is printed, so `sqlite3` needs no doc. */
function daemonSummary(d: DaemonState, ledger: string): string {
  const line = d.running
    ? `daemon: 127.0.0.1:${d.port}, pid ${d.pid}, v${d.version}`
    : 'daemon: not running (it starts on the next hook fire)';
  return `${line}; ledger ${ledger}`;
}

/**
 * `tenjin hooks enable|disable <arm>`. The write goes through
 * {@link persistHookArm}, which is the same locked read-modify-write
 * `config set hooks.<arm>` uses — one writer, so a subkey a newer CLI wrote
 * survives either spelling of the change.
 */
export async function runHooksToggle(
  arm: string,
  enabled: boolean,
  ctx: CommandContext,
): Promise<CommandResult> {
  const known = assertArm(arm);
  await persistHookArm(ctx.dataDir, known, enabled);
  const state = enabled ? 'enabled' : 'disabled';
  return {
    data: { arm: known, state },
    // The daemon re-reads config.json per fire, so there is nothing to restart
    // and nothing to re-install: the next fire already obeys this.
    humanLines: [
      `hooks.${known} ${state} (${ARM_EVENTS[known]}); it takes effect on the next fire`,
    ],
  };
}

function assertArm(arm: string): HookArm {
  if ((HOOK_ARMS as readonly string[]).includes(arm)) return arm as HookArm;
  throw new CliError('USAGE', `Unknown hook arm: ${JSON.stringify(arm)}`, {
    fix: `The arms are ${HOOK_ARMS.join(', ')}; \`tenjin hooks\` lists them with their state.`,
  });
}
