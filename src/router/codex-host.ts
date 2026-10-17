import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { promisify } from 'node:util';
import { withAppServer } from '../lib/codex-app-server';
import { MARKETPLACE_NAME, MCP_SERVER_NAME, PLUGIN_ID } from './names';

/**
 * WHAT CODEX SAYS ABOUT THE TENJIN PLUGIN, read through Codex's own app server
 * and CLI and never from its files. The grant is per tool on the plugin's own
 * server, so it lifts nothing else, and the wallet's spend limits still apply.
 */
export const CODEX_MARKETPLACE = MARKETPLACE_NAME;
export const CODEX_PLUGIN = PLUGIN_ID;
const GRANT_PATH = ['mcp_servers', MCP_SERVER_NAME, 'tools', 'request', 'approval_mode'];
export const CODEX_GRANT = ['plugins', JSON.stringify(CODEX_PLUGIN), ...GRANT_PATH].join('.');
export const GRANT_VALUE = 'approve';
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

/** The request tool's `approval_mode` under the plugin, or undefined when unset. */
export function grantOf(config: unknown): unknown {
  return at(config, 'plugins', CODEX_PLUGIN, ...GRANT_PATH);
}

/** The plugin is enabled, its request tool is not switched off, and it is granted. */
export function requestConfigured(config: unknown): boolean {
  const plugin = at(config, 'plugins', CODEX_PLUGIN);
  const server = at(plugin, 'mcp_servers', MCP_SERVER_NAME);
  return (
    at(plugin, 'enabled') === true &&
    at(server, 'enabled') !== false &&
    at(server, 'tools', 'request', 'enabled') !== false &&
    grantOf(config) === GRANT_VALUE
  );
}

export async function codexVersion(): Promise<string | null> {
  try {
    const { stdout } = await exec('codex', ['--version'], { timeout: 2_000, maxBuffer: 16_384 });
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

/**
 * THE HOOKS SPEAK ONLY WHERE THE LINE CAN BE ACTED ON. An offer names the
 * request tool, and under `approval_policy = "never"` an ungranted tool call is
 * refused, so a line without the grant would strand the turn. A config that
 * cannot be read counts as no grant.
 */
export async function codexHookReady(cwd: string): Promise<boolean> {
  return requestConfigured(await readCodexConfig(cwd));
}
