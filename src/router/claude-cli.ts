import { execFile } from 'node:child_process';
import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, isAbsolute, join } from 'node:path';

/**
 * CLAUDE CODE'S OWN COMMANDS, AND WHERE ITS CONFIG LIVES. Install, update,
 * uninstall and doctor register and read the plugin through `claude plugin`
 * and `claude mcp` rather than editing Claude Code's files, so every write is
 * Claude Code's and lands where it would put it. This module finds the binary,
 * runs it without a shell, and reads its `--json` answers. It never throws on a
 * failed command: each caller decides what a failure means.
 */

/** The oldest Claude Code the plugin is built for: `mcp_tool` legs on a plugin server. */
export const CLAUDE_CODE_FLOOR = '2.1.287';

/**
 * Claude Code's config directory: `CLAUDE_CONFIG_DIR` when set, else
 * `~/.claude`. Every path this CLI reads or writes for Claude Code goes through
 * here, so the plugin, the migration and doctor see the config the `claude`
 * commands they run see.
 */
export function claudeConfigDir(env: NodeJS.ProcessEnv, home: string = homedir()): string {
  const dir = env.CLAUDE_CONFIG_DIR;
  return dir !== undefined && dir.length > 0 ? dir : join(home, '.claude');
}

/** The user settings file, under {@link claudeConfigDir}. */
export function userSettingsPath(env: NodeJS.ProcessEnv, home: string = homedir()): string {
  return join(claudeConfigDir(env, home), 'settings.json');
}

/**
 * Where `claude mcp add -s user` writes: `.claude.json` inside
 * `CLAUDE_CONFIG_DIR` when it is set, else `~/.claude.json` beside `~/.claude`.
 */
export function userMcpFile(env: NodeJS.ProcessEnv, home: string = homedir()): string {
  const dir = env.CLAUDE_CONFIG_DIR;
  return dir !== undefined && dir.length > 0
    ? join(dir, '.claude.json')
    : join(home, '.claude.json');
}

export interface ClaudeBinary {
  /** The absolute path this run executes. */
  path: string;
  /** `path` when found on PATH, `execpath` when it came from `CLAUDE_CODE_EXECPATH`. */
  source: 'path' | 'execpath';
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * THE BINARY, WITHOUT ASKING ANYONE TO INSTALL IT: `claude` on PATH first,
 * then `CLAUDE_CODE_EXECPATH`, which Claude Code exports to the commands its
 * Bash tool runs (so an agent's install finds it even where PATH does not, as
 * in Claude Desktop). Null when neither exists; the caller then writes the
 * plugin folder, which needs no binary.
 */
export function findClaudeBinary(env: NodeJS.ProcessEnv): ClaudeBinary | null {
  const exts =
    process.platform === 'win32'
      ? ['', ...(env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';').filter((e) => e.length > 0)]
      : [''];
  for (const part of (env.PATH ?? '').split(delimiter)) {
    if (part.length === 0) continue;
    for (const ext of exts) {
      const candidate = join(part, `claude${ext}`);
      if (isFile(candidate)) return { path: candidate, source: 'path' };
    }
  }
  const exec = env.CLAUDE_CODE_EXECPATH;
  if (exec !== undefined && isAbsolute(exec) && isFile(exec)) {
    return { path: exec, source: 'execpath' };
  }
  return null;
}

export interface ClaudeRun {
  /** The exit code, or null when the binary could not be started or was killed. */
  code: number | null;
  stdout: string;
  stderr: string;
}

export interface ClaudeRunOptions {
  env: NodeJS.ProcessEnv;
  cwd: string;
  timeoutMs?: number;
}

/** One `claude` command, no shell. Never rejects. */
export function runClaude(
  bin: ClaudeBinary,
  args: string[],
  opts: ClaudeRunOptions,
): Promise<ClaudeRun> {
  return new Promise((resolve) => {
    execFile(
      bin.path,
      args,
      {
        env: opts.env,
        cwd: opts.cwd,
        timeout: opts.timeoutMs ?? 30_000,
        maxBuffer: 4 * 1024 * 1024,
        windowsHide: true,
      },
      (err, stdout, stderr) => {
        const code =
          err === null
            ? 0
            : typeof (err as { code?: unknown }).code === 'number'
              ? (err as { code: number }).code
              : null;
        resolve({ code, stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });
}

/**
 * The one result line a `--json` plugin command prints: the last stdout line
 * that parses as an object. Failures also print a human line on stderr, which
 * is ignored here.
 */
export function jsonResult(stdout: string): Record<string, unknown> | null {
  const lines = stdout.split('\n').map((l) => l.trim());
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i]!;
    if (!line.startsWith('{')) continue;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      continue;
    }
  }
  return null;
}

/** A `--json` list (`plugin list`, `marketplace list`), or null when it is not one. */
export function jsonList(stdout: string): Record<string, unknown>[] | null {
  const start = stdout.indexOf('[');
  if (start === -1) return null;
  try {
    const parsed = JSON.parse(stdout.slice(start)) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter(
          (row): row is Record<string, unknown> =>
            row !== null && typeof row === 'object' && !Array.isArray(row),
        )
      : null;
  } catch {
    return null;
  }
}

/** `2.1.296 (Claude Code)` to `2.1.296`. */
export function parseClaudeVersion(text: string): string | null {
  return /(\d+)\.(\d+)\.(\d+)/.exec(text)?.[0] ?? null;
}

/** Is `version` at or above {@link CLAUDE_CODE_FLOOR}? */
export function meetsFloor(version: string, floor: string = CLAUDE_CODE_FLOOR): boolean {
  const a = version.split('.').map(Number);
  const b = floor.split('.').map(Number);
  for (let i = 0; i < 3; i += 1) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return true;
}

export interface ClaudeCodeState {
  binary: ClaudeBinary | null;
  /** The version `claude --version` printed, or null when it could not be read. */
  version: string | null;
  /** False only for a version read and found below the floor. */
  meetsFloor: boolean;
  /** What to do about it, worded for the session the agent runs in. */
  fix?: string;
}

/**
 * THE FLOOR'S FIX IS ONE THE AGENT RUNS: `claude update` updates the binary in
 * place, and a new session picks it up. Nobody is sent out of the session to
 * do it.
 */
export const CLAUDE_UPDATE_FIX =
  'Run `claude update` in this session, then start a new Claude Code session so the newer version loads.';

/** The binary and its version, read once per command. */
export async function readClaudeCode(
  env: NodeJS.ProcessEnv,
  cwd: string,
  find: (env: NodeJS.ProcessEnv) => ClaudeBinary | null = findClaudeBinary,
): Promise<ClaudeCodeState> {
  const binary = find(env);
  if (binary === null) return { binary, version: null, meetsFloor: true };
  const run = await runClaude(binary, ['--version'], { env, cwd, timeoutMs: 15_000 });
  const version = run.code === 0 ? parseClaudeVersion(run.stdout) : null;
  const ok = version === null || meetsFloor(version);
  return {
    binary,
    version,
    meetsFloor: ok,
    ...(ok ? {} : { fix: CLAUDE_UPDATE_FIX }),
  };
}
