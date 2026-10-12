/**
 * THE NAMES THE HARNESS KNOWS THE ROUTER BY, spelled once. `install` registers
 * the Claude Code plugin {@link PLUGIN_NAME}, whose MCP server is
 * {@link MCP_SERVER_NAME}, and Claude Code names a plugin's tools
 * `mcp__plugin_<plugin>_<server>__<tool>`. The plugin's hooks, the server's own
 * name and every hint line the hooks inject read these, so a rename moves them
 * together.
 *
 * A module of its own because the hooks need the tool name and must not load
 * `install` to get it: their chunk graph is the product's floor.
 */
export const PLUGIN_NAME = 'tenjin';
export const MCP_SERVER_NAME = 'router';
/** The marketplace `install` adds from the package, so the plugin id is `tenjin@tenjin`. */
export const MARKETPLACE_NAME = 'tenjin';
export const PLUGIN_ID = `${PLUGIN_NAME}@${MARKETPLACE_NAME}`;
/** The id Claude Code gives the same plugin loaded from a skills-directory folder. */
export const SKILLS_DIR_PLUGIN_ID = `${PLUGIN_NAME}@skills-dir`;
/** How a plugin's `hooks.json` and `claude mcp` name the plugin's own server. */
export const PLUGIN_SERVER = `plugin:${PLUGIN_NAME}:${MCP_SERVER_NAME}`;
const TOOL_PREFIX = `mcp__plugin_${PLUGIN_NAME}_${MCP_SERVER_NAME}`;
export const REQUEST_TOOL = `${TOOL_PREFIX}__request`;
/** The tool the plugin's hook legs call, which its own deny hook keeps from the model. */
export const PLUGIN_HOOK_TOOL = `${TOOL_PREFIX}__hook`;

/**
 * THE SETTINGS-BASED INSTALL'S NAMES, for its migration and nothing else.
 * Releases up to alpha.26 registered the server as `x402` through `claude mcp
 * add` and wrote seven hook entries and two permission rules into settings.json.
 *
 * SHIM: remove on or after 2026-12-01, the first release cut 30 or more days
 * after the plugin PR 2 ships. Doctor keeps naming an unmigrated machine after.
 */
export const LEGACY_MCP_SERVER_NAME = 'x402';
export const LEGACY_REQUEST_TOOL = `mcp__${LEGACY_MCP_SERVER_NAME}__request`;
export const LEGACY_HOOK_TOOL = `mcp__${LEGACY_MCP_SERVER_NAME}__hook`;

/**
 * Is this process one Claude Code launched from the plugin? Claude Code sets
 * `CLAUDE_PLUGIN_ROOT` for a plugin's MCP server and its command hooks
 * (checked on 2.1.296), and not for a server registered in `~/.claude.json`.
 */
export function launchedByPlugin(env: NodeJS.ProcessEnv = process.env): boolean {
  const root = env.CLAUDE_PLUGIN_ROOT;
  return typeof root === 'string' && root.length > 0;
}

/**
 * The request tool's name as THIS process's harness exposes it: the plugin's
 * tool for a server the plugin launched, and the `x402` server's tool for one a
 * settings install launched, so an offer line never names a tool the model
 * does not have.
 *
 * SHIM: the second branch goes on or after 2026-12-01 (see
 * {@link LEGACY_MCP_SERVER_NAME}); the name is then always {@link REQUEST_TOOL}.
 */
export function requestToolName(env: NodeJS.ProcessEnv = process.env): string {
  return launchedByPlugin(env) ? REQUEST_TOOL : LEGACY_REQUEST_TOOL;
}
