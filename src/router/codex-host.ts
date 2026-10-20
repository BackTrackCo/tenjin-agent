import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { promisify } from 'node:util';
import { withAppServer } from '../lib/codex-app-server';
import { MARKETPLACE_NAME, PLUGIN_ID } from './names';
import { CODEX_ALLOW_HOOK_COMMAND, CODEX_HOOK_COUNT } from './plugin-files';
import { noteRequestTool, requestToolNoted } from './progress';

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
}

function isAllowHook(hook: unknown): boolean {
  return (
    at(hook, 'command') === CODEX_ALLOW_HOOK_COMMAND ||
    String(at(hook, 'key')).includes(':permission_request:')
  );
}

export function codexHookRows(list: unknown): CodexHookRows {
  const groups = at(list, 'data');
  if (!Array.isArray(groups)) return { state: 'unknown', allowOff: false };
  const ours = groups
    .flatMap((group) => {
      const hooks = at(group, 'hooks');
      return Array.isArray(hooks) ? (hooks as unknown[]) : [];
    })
    .filter((hook) => at(hook, 'pluginId') === CODEX_PLUGIN);
  if (ours.length === 0) return { state: 'absent', allowOff: false };
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
  };
}

/**
 * Does Codex let the request tool run without a prompt? Only with every Tenjin
 * hook trusted and the allow hook on. Null when the list could not be read.
 */
export function requestAllowed(list: unknown): boolean | null {
  const rows = codexHookRows(list);
  return rows.state === 'unknown' ? null : rows.state === 'trusted' && !rows.allowOff;
}

/** How long a recorded answer stands before the prompt leg asks again. */
const REQUEST_TOOL_REFRESH_MS = 5 * 60_000;
/** The prompt leg's wait for the list, run beside its routing decision. */
const REQUEST_TOOL_LIST_MS = 3_000;

/**
 * THE PROMPT LEG ASKS, THE PRE-CALL LEG READS. Codex lists its hooks only
 * through an app server, so the prompt leg, which precedes every search of a
 * turn, asks once per session (again after {@link REQUEST_TOOL_REFRESH_MS})
 * beside its own decision and records the answer; the pre-call leg reads that
 * record and starts nothing. An unread list records nothing.
 */
export async function refreshRequestTool(
  dataDir: string,
  session: string,
  cwd: string,
  list: (cwd: string, timeoutMs: number) => Promise<unknown> = listCodexHooks,
  now = Date.now(),
): Promise<void> {
  const noted = await requestToolNoted(dataDir, session, now);
  if (noted !== null && now - noted.at < REQUEST_TOOL_REFRESH_MS) return;
  const allowed = requestAllowed(await list(cwd, REQUEST_TOOL_LIST_MS));
  if (allowed !== null) await noteRequestTool(dataDir, session, allowed, now);
}

/** True only on a recorded yes: anything else lets the search run. */
export async function requestRunnable(dataDir: string, session: string): Promise<boolean> {
  return (await requestToolNoted(dataDir, session))?.runnable === true;
}
