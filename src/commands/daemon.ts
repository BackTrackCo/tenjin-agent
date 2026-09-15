import type { CommandContext, CommandResult } from '../context';
import { startDaemon, stopDaemon, type DaemonDeps } from '../daemon/control';
import { STOP_GRACE_MS } from '../hooks/constants';
import { health, readPid, readToken, type Health } from '../hooks/shim';
import { hooksDir } from '../lib/paths';

/**
 * `tenjin daemon start|stop|status` (02-redesign.md §4a). Nothing here reads
 * or writes a harness settings file; wiring the hook entries is `tenjin
 * install`, which runs the same {@link startDaemon} first and only then names
 * the port it bound (lib/harness-hooks.ts).
 */

export type { DaemonDeps };

function describe(h: Health): string[] {
  return [
    `running: pid ${h.pid}, port ${h.port}, v${h.version}`,
    `uptime ${Math.round(h.uptime_ms / 1000)} s, idle ${Math.round(h.idle_ms / 1000)} s, rss ${Math.round(h.rss / 1048576)} MB`,
    `data dir ${h.data_dir}`,
  ];
}

export async function runDaemonStart(
  ctx: CommandContext,
  deps: DaemonDeps = {},
): Promise<CommandResult> {
  const { dataDir } = ctx;
  const started = await startDaemon(dataDir, deps);
  const h = started.health;
  return {
    data: {
      state: started.spawned ? 'started' : 'already-running',
      pid: h.pid,
      port: h.port,
      version: h.version,
      dataDir,
      written: started.written,
      replaced: started.replaced?.pid ?? null,
    },
    humanLines: [
      started.spawned
        ? `started daemon: pid ${h.pid}, port ${h.port}, v${h.version}`
        : `already running: pid ${h.pid}, port ${h.port}, v${h.version}`,
      ...(started.replaced ? [`stopped previous daemon pid ${started.replaced.pid}`] : []),
      ...(started.unconfirmed !== null
        ? [
            `previous daemon pid ${started.unconfirmed} did not answer /health and was left alone; run \`tenjin daemon start\` again`,
          ]
        : []),
      ...(started.written.length > 0
        ? [`wrote ${started.written.length} file(s) under ${hooksDir(dataDir)}`]
        : []),
    ],
  };
}

export async function runDaemonStop(
  ctx: CommandContext,
  deps: DaemonDeps = {},
): Promise<CommandResult> {
  const r = await stopDaemon(ctx.dataDir, deps);
  const line =
    r.state === 'not-running'
      ? 'not running'
      : r.state === 'unconfirmed'
        ? `pid ${r.pid} is alive but did not answer /health; left alone. Retry, or kill it by hand if it is hung.`
        : r.state === 'stopped'
          ? `stopped pid ${r.pid}`
          : `killed pid ${r.pid} (did not exit within ${STOP_GRACE_MS} ms)`;
  return { data: r, humanLines: [line] };
}

export async function runDaemonStatus(ctx: CommandContext): Promise<CommandResult> {
  const rec = readPid(ctx.dataDir);
  const h = rec === null ? null : await health(rec.port);
  if (h === null || h.data_dir !== ctx.dataDir) {
    return {
      data: { state: 'not-running', pidFile: rec, tokenPresent: readToken(ctx.dataDir) !== null },
      humanLines: ['not running'],
    };
  }
  return { data: { state: 'running', ...h }, humanLines: describe(h) };
}
