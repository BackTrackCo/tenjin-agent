import type { Command } from 'commander';
import { INTEGRATION, SETUP, type Registration } from './registration';

/**
 * The router product: the two hook commands, the MCP server that carries the
 * `request` tool, and the local spend readout.
 *
 * `hook` and `mcp` BYPASS the envelope. A hook writes the harness's own JSON to
 * stdout or nothing at all, and the MCP server hands stdout to its transport
 * and blocks until the client disconnects, so neither can be wrapped in the
 * success envelope every other command emits.
 */
export function registerRouter(reg: Registration): void {
  const { io, runCommand, leaf, addGlobalFlags, buildContext } = reg;

  const hook = leaf(INTEGRATION, 'hook', 'run one harness hook handler (called by Claude Code)')
    .description(
      'The handlers `tenjin install` registers in Claude Code. Each reads one hook event on stdin and writes the harness response, or nothing, on stdout. You never run these by hand.',
    )
    .helpCommand(false);
  for (const [name, summary] of [
    ['prompt', 'UserPromptSubmit: build the session packet and ask the free gate'],
    ['native', 'PreToolUse on WebSearch|WebFetch: allow the call, or redirect it'],
  ] as const) {
    addGlobalFlags(hook.command(name))
      .summary(summary)
      .action(async function (this: Command) {
        const ctx = buildContext(this);
        const { runHookCommand } = await import('../router/hook-command');
        await runHookCommand(name, io, { dataDir: ctx.dataDir });
      });
  }

  leaf(INTEGRATION, 'mcp', 'run the local stdio MCP server')
    .description(
      'Run the local stdio MCP server that carries the `request` tool: one paid routing decision per lookup, then the provider call, under your local spend policy. It speaks on stdin and stdout and runs until the client disconnects, so it prints no envelope of its own.',
    )
    .action(async function (this: Command) {
      const ctx = buildContext(this);
      const { runRouterMcpServer } = await import('../router/mcp');
      await runRouterMcpServer({ dataDir: ctx.dataDir, flags: ctx.flags });
    });

  leaf(SETUP, 'status', 'what this machine has spent, and what is still open')
    .description(
      'Report the rolling 24h spend window from spend.json: what has settled, what is reserved by a request still in flight, and the per-call and per-day caps in force.',
    )
    .action(async function (this: Command) {
      await runCommand('status', this, async (ctx) => {
        const { runRouterStatus } = await import('../router/status');
        return runRouterStatus(ctx);
      });
    });
}
