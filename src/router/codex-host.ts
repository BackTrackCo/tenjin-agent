import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { promisify } from 'node:util';
import { withAppServer } from '../lib/codex-app-server';
import { resolveCodex } from '../lib/codex-bin';
import { HOOK_TOOL } from './hook-tool';
import { MARKETPLACE_NAME, MCP_SERVER_NAME, PLUGIN_ID } from './names';
import {
  CODEX_ALLOW_HOOK_COMMAND,
  CODEX_ALLOW_HOOK_COMMAND_WINDOWS,
  CODEX_HOOK_COUNT,
  CODEX_LEGS,
} from './plugin-files';

/**
 * WHAT CODEX SAYS ABOUT THE TENJIN PLUGIN, read through Codex's own app server
 * and CLI and never from its files.
 */
export const CODEX_MARKETPLACE = MARKETPLACE_NAME;
export const CODEX_PLUGIN = PLUGIN_ID;
/** The last Codex build a `webrun` hook capture came from: a diagnostic, never a switch. */
export const WEB_VERIFIED_VERSION = '0.154.0';

const exec = promisify(execFile);

function record(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

export function at(v: unknown, ...keys: string[]): unknown {
  for (const key of keys) {
    if (!record(v)) return undefined;
    v = v[key];
  }
  return v;
}

export async function codexVersion(): Promise<string | null> {
  const codex = resolveCodex();
  if (codex === null) return null;
  try {
    const { stdout } = await exec(codex.cmd, [...codex.prefix, '--version'], {
      timeout: 2_000,
      maxBuffer: 16_384,
      windowsHide: true,
    });
    return /(?:codex-cli|codex)\s+(\d+\.\d+\.\d+(?:[-+][\w.-]+)?)/.exec(stdout)?.[1] ?? null;
  } catch {
    return null;
  }
}

/** Codex's merged config for `cwd`, or null when its app server could not be asked. */
export async function readCodexConfig(cwd: string, timeoutMs = 500): Promise<unknown> {
  return withAppServer(homedir(), process.env, timeoutMs, async (request) =>
    at(await request('config/read', { includeLayers: false, cwd }), 'config'),
  );
}

/** Codex's hook list for `cwd` (`hooks/list`), or null when it could not be asked. */
export function listCodexHooks(cwd: string, timeoutMs: number): Promise<unknown> {
  return withAppServer(homedir(), process.env, timeoutMs, (request) =>
    request('hooks/list', { cwds: [cwd] }),
  );
}

/**
 * The plugin, as Codex's one `hooks/list` shows it. Every row carries its
 * `pluginId`, `enabled` and `trustStatus`: no Tenjin row means the plugin is
 * not installed (or is off), and every row present, enabled and trusted means
 * it is installed, on and trusted.
 */
export interface CodexHookRows {
  state: 'trusted' | 'review' | 'absent' | 'unknown';
  /** The request tool's allow hook is off in `/hooks`, so the tool asks first. */
  allowOff: boolean;
  /**
   * How the routing legs reach the router: `paid` when each is an `mcp_tool`
   * hook into the plugin's server, which pays the routing fee; `free` when a
   * plugin copy from an older build still runs them as commands, which cannot
   * pay it and offer nothing once the router charges it.
   */
  routing: 'paid' | 'free' | 'unknown';
}

/** A routing leg Codex calls on the plugin's own server. */
function isMcpLeg(hook: unknown): boolean {
  return (
    at(hook, 'handlerType') === 'mcpTool' &&
    at(hook, 'server') === MCP_SERVER_NAME &&
    at(hook, 'tool') === HOOK_TOOL
  );
}

/** A routing leg an older build wrote as a command: `tenjin hook <kind> --harness codex`,
 *  or the runtime launcher's quoted path in its place. */
function isCommandLeg(hook: unknown): boolean {
  return /\btenjin(?:\.cmd)?['"]? hook (prompt|native|shortfall)\b/.test(
    String(at(hook, 'command') ?? ''),
  );
}

function routingOf(ours: unknown[]): CodexHookRows['routing'] {
  if (ours.some(isCommandLeg)) return 'free';
  return ours.filter(isMcpLeg).length === CODEX_LEGS.length ? 'paid' : 'unknown';
}

function isAllowHook(hook: unknown): boolean {
  return (
    // On Windows, Codex lists the `commandWindows` form as the command.
    [CODEX_ALLOW_HOOK_COMMAND, CODEX_ALLOW_HOOK_COMMAND_WINDOWS].includes(
      String(at(hook, 'command')),
    ) || String(at(hook, 'key')).includes(':permission_request:')
  );
}

export function codexHookRows(list: unknown): CodexHookRows {
  const groups = at(list, 'data');
  if (!Array.isArray(groups)) return { state: 'unknown', allowOff: false, routing: 'unknown' };
  const ours = groups
    .flatMap((group) => {
      const hooks = at(group, 'hooks');
      return Array.isArray(hooks) ? (hooks as unknown[]) : [];
    })
    .filter((hook) => at(hook, 'pluginId') === CODEX_PLUGIN);
  if (ours.length === 0) return { state: 'absent', allowOff: false, routing: 'unknown' };
  // Turning the allow hook off is the documented opt-out, not a broken install.
  const optedOut = (hook: unknown) => isAllowHook(hook) && at(hook, 'enabled') === false;
  const ready = ours.every(
    (hook) =>
      optedOut(hook) ||
      (at(hook, 'enabled') === true &&
        ['trusted', 'managed'].includes(String(at(hook, 'trustStatus')))),
  );
  return {
    state: ours.length === CODEX_HOOK_COUNT && ready ? 'trusted' : 'review',
    allowOff: ours.some(optedOut),
    routing: routingOf(ours),
  };
}
