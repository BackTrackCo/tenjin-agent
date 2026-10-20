import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { promisify } from 'node:util';
import { withAppServer } from '../lib/codex-app-server';
import { MARKETPLACE_NAME, PLUGIN_ID } from './names';

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
