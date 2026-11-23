/**
 * THE NEON WORKER'S LEAN WRITING PROFILE. The worker pays by the token and Neon thinks in
 * proportion to what it is given, so its Claude Code child starts without what a writing job does
 * not use: the person's own output style, every MCP server (and so the deferred-tools list of
 * their names), and every tool but the five that read and write files (and so the Bash sandbox
 * rules). The person's CLAUDE.md files still load, as a native subagent loads them. The DeepSeek
 * worker is not changed by any of it.
 */
export const NEON_WORKER_TOOLS = ['Read', 'Glob', 'Grep', 'Edit', 'Write'] as const;

/** Where the profile sits in the child's start-up: its options and the one setting it writes. */
export function neonProfile() {
  return {
    options: {
      // Only these built-in tools, so Bash and its sandbox rules are never described.
      tools: [...NEON_WORKER_TOOLS] as string[],
      // No MCP server from any settings file or plugin, so no deferred-tools list.
      mcpServers: {} as Record<string, never>,
      strictMcpConfig: true,
    },
    // Above the person's own `outputStyle`: the flag layer outranks their settings files.
    settings: { outputStyle: 'default' },
  };
}
