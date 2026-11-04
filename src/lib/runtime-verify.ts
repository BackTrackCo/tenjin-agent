import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handlersIn } from '../router/hook-form';
import { renderPluginHooks, renderPluginMcp } from '../router/plugin-files';
import { type RuntimeLaunch } from '../router/launcher-files';

// ---------------------------------------------------------------------------
// Verifying a build before anything points at it
// ---------------------------------------------------------------------------

/** One process run the way Claude Code runs it: exec form, no shell. A seam for tests. */
export type VerifySpawn = (
  command: string,
  args: string[],
  o: {
    env: NodeJS.ProcessEnv;
    input: string;
    timeoutMs: number;
    /** Keep stdin open and stop (killing it) once stdout satisfies this. */
    until?: (stdout: string) => boolean;
  },
) => Promise<{ code: number | null; stdout: string; stderr: string; matched: boolean }>;

const spawnVerify: VerifySpawn = (command, args, o) =>
  new Promise((done) => {
    const child = spawn(command, args, {
      env: o.env,
      shell: false,
      stdio: 'pipe',
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (code: number | null, matched: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (child.exitCode === null) child.kill();
      done({ code, stdout, stderr, matched });
    };
    const timer = setTimeout(() => finish(null, false), o.timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
      if (o.until?.(stdout) === true) finish(0, true);
    });
    child.stderr.on('data', (chunk: string) => {
      if (stderr.length < 4096) stderr += chunk;
    });
    child.stdin.on('error', () => undefined);
    child.on('error', (err) => {
      stderr += err.message;
      finish(null, false);
    });
    child.on('close', (code) => finish(code, false));
    child.stdin.write(o.input);
    if (o.until === undefined) child.stdin.end();
  });

const VERIFY_VERSION_MS = 10_000;
const VERIFY_HOOKS_MS = 10_000;
const VERIFY_MCP_MS = 15_000;

const said = (run: { code: number | null; stderr: string }): string => {
  const text = run.stderr.trim().slice(0, 200);
  return `${run.code === null ? 'no exit in time' : `exit ${run.code}`}${text ? `: ${text}` : ''}`;
};

/**
 * Does this build run the way Claude Code will run it? Before anything points at
 * a version: `--version` prints it, every command hook of its runtime render
 * exits 0 with empty or JSON output, and its MCP server answers `initialize`.
 * The same checks as `scripts/plugin-spawn-smoke.mjs`, against a throwaway
 * data dir; `timeoutMs` bounds all three together.
 */
export async function verifyBuild(
  launch: RuntimeLaunch,
  version: string,
  o: { timeoutMs?: number; spawnImpl?: VerifySpawn } = {},
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const run = o.spawnImpl ?? spawnVerify;
  const deadline =
    Date.now() + (o.timeoutMs ?? VERIFY_VERSION_MS + VERIFY_HOOKS_MS + VERIFY_MCP_MS);
  const budget = (own: number) => Math.min(own, deadline - Date.now());
  const outOfTime = { ok: false as const, reason: `tenjin-cli ${version} was not checked in time` };
  const data = await mkdtemp(join(tmpdir(), 'tenjin-verify-'));
  const env = {
    ...process.env,
    TENJIN_DATA_DIR: data,
    TENJIN_NO_UPDATE_CHECK: '1',
    TENJIN_HANDOFF: '1',
  };
  /** A spawn bounded by the step's time even when the spawn itself never returns. */
  const bounded = (
    command: string,
    args: string[],
    input: string,
    ms: number,
    until?: (s: string) => boolean,
  ) => {
    let timer: NodeJS.Timeout | undefined;
    return Promise.race([
      run(command, args, { env, input, timeoutMs: ms, until }),
      new Promise<null>((done) => (timer = setTimeout(() => done(null), ms + 250))),
    ]).finally(() => clearTimeout(timer));
  };
  try {
    let ms = budget(VERIFY_VERSION_MS);
    if (ms <= 0) return outOfTime;
    const shown = await bounded(launch.node, [launch.entry, '--version'], '', ms);
    if (shown === null) return outOfTime;
    if (shown.code !== 0 || shown.stdout.trim() !== version) {
      return {
        ok: false,
        reason: `tenjin-cli ${version} did not start (${shown.code === 0 ? `it printed ${shown.stdout.trim().slice(0, 50) || 'nothing'}` : said(shown)})`,
      };
    }

    ms = budget(VERIFY_HOOKS_MS);
    if (ms <= 0) return outOfTime;
    const { hooks } = renderPluginHooks(launch.entry, { node: launch.node });
    const commands = Object.entries(hooks).flatMap(([event, groups]) =>
      (
        handlersIn({ hooks: { [event]: groups } }) as {
          type: string;
          command: string;
          args: string[];
        }[]
      )
        .filter((h) => h.type === 'command')
        .map((h) => ({ event, command: h.command, args: h.args })),
    );
    const results = await Promise.all(
      commands.map(async (c) => ({
        ...c,
        out: await bounded(
          c.command,
          c.args,
          JSON.stringify({ session_id: 'verify', hook_event_name: c.event }),
          ms,
        ),
      })),
    );
    for (const { event, out } of results) {
      if (out === null) return outOfTime;
      if (out.code !== 0) return { ok: false, reason: `its ${event} hook failed (${said(out)})` };
      if (out.stdout.trim().length > 0) {
        try {
          JSON.parse(out.stdout);
        } catch {
          return { ok: false, reason: `its ${event} hook printed something other than JSON` };
        }
      }
    }

    ms = budget(VERIFY_MCP_MS);
    if (ms <= 0) return outOfTime;
    const server = renderPluginMcp(launch.entry, { node: launch.node }).mcpServers.router as {
      command: string;
      args: string[];
    };
    const initialize = `${JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'tenjin-verify', version },
      },
    })}\n`;
    const answered = await bounded(server.command, server.args, initialize, ms, (stdout) =>
      stdout.split('\n').some((line) => line.includes('"id":1') && line.includes('"result"')),
    );
    if (answered === null || !answered.matched) {
      return {
        ok: false,
        reason: `its MCP server did not answer initialize (${answered === null ? 'no answer in time' : said(answered)})`,
      };
    }
    return { ok: true };
  } finally {
    await rm(data, { recursive: true, force: true }).catch(() => undefined);
  }
}
