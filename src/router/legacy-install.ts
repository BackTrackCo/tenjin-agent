import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { writeFileAtomic } from '../lib/atomic-json';
import { inspectHooksFile } from '../lib/harness-hooks';
import { runClaude, type ClaudeBinary } from './claude-cli';
import { LEGACY_HOOK_TOOL, LEGACY_MCP_SERVER_NAME, LEGACY_REQUEST_TOOL } from './names';
import { classifyStatusLine, decomposeCommand, type StatusLineState } from './status-line-wiring';

/**
 * THE SETTINGS-BASED INSTALL, READ AND REMOVED. Releases up to alpha.26 wrote
 * seven hook entries, an allow and a deny rule and a status line into
 * settings.json, and registered an `x402` MCP server with `claude mcp add`.
 * The plugin replaces all of it. `install` and `update` remove it only once the
 * plugin has proven to load on this machine, `uninstall` removes it outright,
 * and doctor only reads it.
 *
 * EXACT SHAPES ONLY. A hook handler is Tenjin's when it is an `mcp_tool` call
 * to the `x402` server's `hook` tool, or a command that is exactly
 * `tenjin hook <leg>` (optionally with a path). Any other command that merely
 * contains `tenjin hook` is the user's, kept and reported. Removal is handler
 * by handler, so a group holding a foreign handler beside ours keeps it. The
 * rules are touched only when the `x402` server is Tenjin's or gone, and a
 * status line only in a file that still held Tenjin's hooks, and only in the
 * exact shapes Tenjin wrote. A file is written only when something was removed
 * from it, and no key is ever added to it.
 *
 * SHIM: this module goes on or after 2026-12-01, the first release cut 30 or
 * more days after the plugin PR 2 ships, and doctor keeps naming an
 * unmigrated machine after that.
 */

const LEGACY_COMMAND_RE = /^(\S*\/)?tenjin hook [a-z]+$/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** One handler, in an exact shape a settings install wrote. */
export function ownsLegacyHandler(handler: unknown): boolean {
  if (!isPlainObject(handler)) return false;
  if (handler.type === 'mcp_tool') {
    return handler.server === LEGACY_MCP_SERVER_NAME && handler.tool === 'hook';
  }
  const command = handler.command;
  return typeof command === 'string' && LEGACY_COMMAND_RE.test(command.trim());
}

/** A handler that mentions `tenjin hook` without being one of ours: reported, never removed. */
function lookalike(handler: unknown): string | null {
  if (!isPlainObject(handler) || ownsLegacyHandler(handler)) return null;
  const command = handler.command;
  return typeof command === 'string' && command.includes('tenjin hook') ? command : null;
}

export type McpEntryState = 'ok' | 'absent' | 'wrong-command' | 'unreadable';

/**
 * What an entry named `x402` actually launches. The name proves nothing: a
 * stale entry pointing at another binary would read as a working request tool.
 */
export function classifyMcpEntry(entry: unknown): McpEntryState {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return 'absent';
  const { command, args } = entry as { command?: unknown; args?: unknown };
  if (typeof command !== 'string' || command.length === 0) return 'wrong-command';
  // The basename, so `/opt/homebrew/bin/tenjin` and a bare `tenjin` both pass.
  const binary = command.split(/[\\/]/).pop();
  const runsRouter =
    binary === 'tenjin' && Array.isArray(args) && args.length === 1 && args[0] === 'mcp';
  return runsRouter ? 'ok' : 'wrong-command';
}

/**
 * The `x402` entry in one registration file: `~/.claude.json` (or the one in
 * `CLAUDE_CONFIG_DIR`) for user scope, `<project>/.mcp.json` for project scope.
 * Only "it is not there" is an absence: a file that exists and cannot be read
 * or parsed says nothing about what is registered in it.
 */
export async function readLegacyMcpEntry(path: string): Promise<McpEntryState> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === 'ENOENT' || code === 'ENOTDIR' ? 'absent' : 'unreadable';
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return 'unreadable';
  }
  const servers = (parsed as { mcpServers?: unknown } | null)?.mcpServers;
  if (servers === undefined) return 'absent';
  if (!isPlainObject(servers)) return 'unreadable';
  const entry = servers[LEGACY_MCP_SERVER_NAME];
  return entry === undefined ? 'absent' : classifyMcpEntry(entry);
}

export interface LegacyInstall {
  settingsPath: string;
  /** The registration file the `x402` entry would be in. */
  mcpFile: string;
  /** Anything of the settings install left on this machine. */
  present: boolean;
  /** The events holding a handler of ours. */
  events: string[];
  allowRule: boolean;
  denyRule: boolean;
  statusLine: StatusLineState;
  mcp: McpEntryState;
  /** Commands that mention `tenjin hook` but are not ours, left in place. */
  lookalikes: string[];
  /** Set when the settings file could not be read; nothing is then known or removed. */
  unreadable?: string;
}

/** What the settings install left in one scope. Reads only. */
export async function inspectLegacyInstall(
  settingsPath: string,
  mcpFile: string,
): Promise<LegacyInstall> {
  const mcp = await readLegacyMcpEntry(mcpFile);
  const base = {
    settingsPath,
    mcpFile,
    events: [] as string[],
    allowRule: false,
    denyRule: false,
    statusLine: 'absent' as StatusLineState,
    mcp,
    lookalikes: [] as string[],
  };
  const found = await inspectHooksFile(settingsPath);
  if ('refusal' in found) {
    return { ...base, present: mcp === 'ok', unreadable: found.refusal.message };
  }
  const events = Object.entries(found.hooks)
    .filter(([, list]) => list.some((entry) => handlersOf(entry).some(ownsLegacyHandler)))
    .map(([event]) => event);
  const lookalikes = Object.values(found.hooks).flatMap((list) =>
    list.flatMap((entry) =>
      handlersOf(entry)
        .map(lookalike)
        .filter((c) => c !== null),
    ),
  );
  const rulesOurs = mcp === 'ok' || (mcp === 'absent' && events.length > 0);
  const allowRule = rulesOurs && listOf(found.settings, 'allow').includes(LEGACY_REQUEST_TOOL);
  const denyRule = rulesOurs && listOf(found.settings, 'deny').includes(LEGACY_HOOK_TOOL);
  const statusLine = events.length > 0 ? classifyStatusLine(found.settings.statusLine) : 'absent';
  const statusOurs = statusLine === 'ours' || statusLine === 'composed';
  return {
    ...base,
    present: events.length > 0 || allowRule || denyRule || statusOurs || mcp === 'ok',
    events,
    allowRule,
    denyRule,
    statusLine,
    lookalikes,
  };
}

function handlersOf(entry: unknown): unknown[] {
  return isPlainObject(entry) && Array.isArray(entry.hooks) ? entry.hooks : [];
}

function listOf(settings: Record<string, unknown>, key: 'allow' | 'deny'): unknown[] {
  const permissions = settings.permissions;
  if (!isPlainObject(permissions)) return [];
  const list = permissions[key];
  return Array.isArray(list) ? list : [];
}

export interface LegacyRemoval {
  /** The events a handler of ours was taken out of. */
  events: string[];
  allowRule: boolean;
  denyRule: boolean;
  /** `removed` (ours alone), `restored` (the user's own command put back), or untouched. */
  statusLine: 'removed' | 'restored' | 'kept';
  /** The `x402` registration: removed, not there, or kept with the reason. */
  mcp: 'removed' | 'absent' | 'kept';
  wroteSettings: boolean;
  warnings: string[];
}

export interface RemoveLegacyOptions {
  binary: ClaudeBinary | null;
  env: NodeJS.ProcessEnv;
  cwd: string;
  /** The `claude mcp` scope the `x402` entry was registered at. */
  mcpScope: 'user' | 'project';
}

/** Take out what {@link inspectLegacyInstall} found, under the exact-shape rules above. */
export async function removeLegacyInstall(
  found: LegacyInstall,
  opts: RemoveLegacyOptions,
): Promise<LegacyRemoval> {
  const out: LegacyRemoval = {
    events: [],
    allowRule: false,
    denyRule: false,
    statusLine: 'kept',
    mcp: found.mcp === 'absent' ? 'absent' : 'kept',
    wroteSettings: false,
    warnings: [],
  };
  if (found.unreadable === undefined) await removeFromSettings(found, out);
  else out.warnings.push(found.unreadable);
  if (found.mcp === 'ok') await removeMcpEntry(opts, out);
  else if (found.mcp === 'wrong-command') {
    out.warnings.push(
      `an MCP server named ${LEGACY_MCP_SERVER_NAME} launches something else, so it is not Tenjin's and was left in place`,
    );
  } else if (found.mcp === 'unreadable') {
    out.warnings.push(`${found.mcpFile} could not be read, so nothing was removed from it`);
  }
  return out;
}

async function removeFromSettings(found: LegacyInstall, out: LegacyRemoval): Promise<void> {
  const read = await inspectHooksFile(found.settingsPath);
  if ('refusal' in read) {
    out.warnings.push(read.refusal.message);
    return;
  }
  if (read.raw === null) return;
  const next: Record<string, unknown> = { ...read.settings };
  if (isPlainObject(read.settings.hooks)) {
    const hooks: Record<string, unknown> = {};
    for (const [event, list] of Object.entries(read.hooks)) {
      const kept: unknown[] = [];
      for (const entry of list) {
        const handlers = handlersOf(entry);
        const left = handlers.filter((h) => !ownsLegacyHandler(h));
        if (left.length === handlers.length) kept.push(entry);
        else if (left.length > 0) kept.push({ ...(entry as Record<string, unknown>), hooks: left });
      }
      if (kept.length !== list.length || kept.some((e, i) => e !== list[i])) out.events.push(event);
      // An event WE emptied loses its key; one that was already empty stays.
      if (kept.length > 0 || list.length === 0) hooks[event] = kept;
    }
    next.hooks = hooks;
  }
  if ((found.allowRule || found.denyRule) && isPlainObject(read.settings.permissions)) {
    const permissions = { ...read.settings.permissions };
    if (found.allowRule && Array.isArray(permissions.allow)) {
      permissions.allow = permissions.allow.filter((r) => r !== LEGACY_REQUEST_TOOL);
      out.allowRule = true;
    }
    if (found.denyRule && Array.isArray(permissions.deny)) {
      permissions.deny = permissions.deny.filter((r) => r !== LEGACY_HOOK_TOOL);
      out.denyRule = true;
    }
    next.permissions = permissions;
  }
  if (found.statusLine === 'ours') {
    delete next.statusLine;
    out.statusLine = 'removed';
  } else if (found.statusLine === 'composed' && isPlainObject(read.settings.statusLine)) {
    const command = read.settings.statusLine.command;
    const original = typeof command === 'string' ? decomposeCommand(command) : null;
    if (original !== null) {
      next.statusLine = { ...read.settings.statusLine, command: original };
      out.statusLine = 'restored';
    }
  }
  // Only a removal writes: a file holding nothing of ours keeps its bytes,
  // whatever its formatting.
  const removed =
    out.events.length > 0 || out.allowRule || out.denyRule || out.statusLine !== 'kept';
  if (!removed) return;
  const body = `${JSON.stringify(next, null, 2)}\n`;
  const mode = await stat(read.path)
    .then((s) => ({ mode: s.mode & 0o777 }))
    .catch(() => ({}));
  // Compared again just before the rename: a concurrent edit is refused, not lost.
  if ((await readFile(read.path, 'utf8').catch(() => null)) !== read.raw) {
    out.warnings.push(`${read.path} changed while it was read, so it was left as it is`);
    Object.assign(out, { events: [], allowRule: false, denyRule: false, statusLine: 'kept' });
    return;
  }
  try {
    await writeFileAtomic(read.path, body, mode);
    out.wroteSettings = true;
  } catch (err) {
    out.warnings.push(err instanceof Error ? err.message : String(err));
    Object.assign(out, { events: [], allowRule: false, denyRule: false, statusLine: 'kept' });
  }
}

/**
 * THE `x402` REGISTRATION GOES THROUGH CLAUDE'S OWN COMMAND, and only after
 * this CLI's own read of that file found it launching `tenjin mcp`: a server
 * the read did not find is never removed by name, because another tool may
 * own one called `x402`. With no binary it is left and reported; the plugin's
 * server is namespaced and does not collide with it.
 */
async function removeMcpEntry(opts: RemoveLegacyOptions, out: LegacyRemoval): Promise<void> {
  if (opts.binary === null) {
    out.warnings.push(
      `the ${LEGACY_MCP_SERVER_NAME} MCP registration stays until a run with the claude binary removes it`,
    );
    return;
  }
  const run = await runClaude(
    opts.binary,
    ['mcp', 'remove', LEGACY_MCP_SERVER_NAME, '-s', opts.mcpScope],
    { env: opts.env, cwd: opts.cwd },
  );
  if (run.code === 0) out.mcp = 'removed';
  else {
    out.warnings.push(
      `claude mcp remove ${LEGACY_MCP_SERVER_NAME} did not succeed: ${(run.stderr || run.stdout).trim().slice(0, 200) || 'no output'}`,
    );
  }
}

/** The project-scope registration file. */
export function projectMcpFile(cwd: string): string {
  return join(cwd, '.mcp.json');
}
