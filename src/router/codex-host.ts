import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { promisify } from 'node:util';
import { withAppServer } from '../lib/codex-app-server';

export const CODEX_PLUGIN = 'tenjin@tenjin';
export const CODEX_GRANT = `plugins.${JSON.stringify(CODEX_PLUGIN)}.mcp_servers.x402.tools.request.approval_mode`;
export const WEB_QUALIFIED_VERSION = '0.154.0';
const exec = promisify(execFile);
export function record(v: unknown): v is Record<string, unknown> {
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
  try {
    const { stdout } = await exec('codex', ['--version'], { timeout: 1_000, maxBuffer: 16_384 });
    return /(?:codex-cli|codex)\s+(\d+\.\d+\.\d+(?:[-+][\w.-]+)?)/.exec(stdout)?.[1] ?? null;
  } catch {
    return null;
  }
}
export function requestConfigured(config: unknown): boolean {
  const plugin = at(config, 'plugins', CODEX_PLUGIN);
  return (
    at(plugin, 'enabled') === true &&
    at(plugin, 'mcp_servers', 'x402', 'enabled') !== false &&
    at(plugin, 'mcp_servers', 'x402', 'tools', 'request', 'enabled') !== false &&
    at(plugin, 'mcp_servers', 'x402', 'tools', 'request', 'approval_mode') === 'approve' &&
    // A direct server with the same name would obscure which one receives calls.
    at(config, 'mcp_servers', 'x402') === undefined
  );
}
export async function readCodexConfig(cwd: string, timeout = 500): Promise<unknown> {
  return withAppServer(homedir(), process.env, timeout, async (request) => {
    const result = await request('config/read', { includeLayers: false, cwd });
    return at(result, 'config');
  });
}
/** Conservative hook preflight. A missing/unknown grant never denies native web. */
export async function codexHookReadiness(cwd: string): Promise<{ prompt: boolean; web: boolean }> {
  const config = await readCodexConfig(cwd);
  const prompt = requestConfigured(config);
  return { prompt, web: prompt };
}
