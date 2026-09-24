/**
 * THE NAMES THE HARNESS KNOWS THE ROUTER BY, spelled once. `install` registers
 * the MCP server under {@link MCP_SERVER_NAME}, and Claude Code exposes its tool
 * as {@link REQUEST_TOOL}; the permission rule, the server's own name and every
 * hint line the hooks inject all read these, so a rename moves them together.
 *
 * A module of its own because the hooks need the tool name and must not load
 * `install` to get it: their chunk graph is the product's floor.
 */
export const MCP_SERVER_NAME = 'x402';
export const REQUEST_TOOL = `mcp__${MCP_SERVER_NAME}__request`;
