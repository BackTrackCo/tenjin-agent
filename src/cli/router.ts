import { Option, type Command } from 'commander';
import { INTEGRATION, SETUP, type Registration } from './registration';

/**
 * The router product: the hook commands, the MCP server that carries the
 * `request` tool, and the local spend readout.
 *
 * `hook` and `mcp` BYPASS the envelope. A hook writes the harness's own JSON to
 * stdout or nothing at all, and the MCP server hands stdout to its transport
 * and blocks until the client disconnects, so neither can be wrapped in the
 * success envelope every other command emits.
 */
export function registerRouter(reg: Registration): void {
  const { io, runCommand, leaf, addGlobalFlags, buildContext } = reg;

  const hook = leaf(INTEGRATION, 'hook', 'run one harness hook handler')
    .description(
      'The handlers installed for Claude Code or the Codex plugin. Each reads one hook event on stdin and writes the harness response, or nothing, on stdout. You never run these by hand.',
    )
    .helpCommand(false);
  for (const [name, summary] of [
    ['prompt', 'UserPromptSubmit: build the session packet and ask the free gate'],
    ['native', 'PreToolUse on WebSearch|WebFetch: allow the call, or redirect it'],
    [
      'shortfall',
      'PostToolUse(Failure) on WebSearch|WebFetch: offer a paid lookup when the result came back short',
    ],
    ['agent', "PreToolUse on Agent|Task: append any paid offer to the subagent's task"],
  ] as const) {
    addGlobalFlags(hook.command(name))
      .addOption(
        new Option('--harness <host>', 'hook host').choices(['claude', 'codex']).default('claude'),
      )
      .summary(summary)
      .action(async function (this: Command) {
        const ctx = buildContext(this);
        const { runHookCommand } = await import('../router/hook-command');
        // The flag rides too, so `--base-url` reaches the gate the same way it
        // reaches every other command; the env layer is read inside.
        await runHookCommand(name, io, {
          dataDir: ctx.dataDir,
          harness: this.opts().harness as 'claude' | 'codex',
          ...(ctx.flags.baseUrl !== undefined ? { baseUrl: ctx.flags.baseUrl } : {}),
        });
      });
  }
  // A hook name this binary does not know exits 0 with nothing on stdout, the
  // same "no opinion" every handler gives on a bad event. The alternative is
  // commander's USAGE exit 2, which Claude Code reads as a blocking hook
  // failure: a settings file written by a newer `tenjin install` (a new hook
  // arm, or a source build ahead of the npm release) then fails EVERY call of
  // the tool it matches, on every session, until the binary catches up. Seen
  // 2026-09-23 when #387's `Agent|Task` arm met an alpha.16 binary.
  hook
    .command('unknown', { hidden: true, isDefault: true })
    .argument('[args...]')
    .allowUnknownOption()
    .allowExcessArguments()
    .action(() => {});

  leaf(INTEGRATION, 'mcp', 'run the local stdio MCP server')
    .description(
      'Run the local stdio MCP server that carries the `request` tool: one paid routing decision per lookup, then the provider call, under your local spend policy. It speaks on stdin and stdout and runs until the client disconnects, so it prints no envelope of its own.',
    )
    .action(async function (this: Command) {
      const ctx = buildContext(this);
      const { runRouterMcpServer } = await import('../router/mcp');
      await runRouterMcpServer({ dataDir: ctx.dataDir, flags: ctx.flags });
    });

  leaf(INTEGRATION, 'status-line', "the live footer, for Claude Code's status line")
    .description(
      "Print one line naming what this session is looking up right now: the provider actually being called, its bounded parameters, and what it cost. It reads Claude Code's status event on stdin for the session identity, reads that session's own progress records, writes nothing, and prints `x402 · ready` when this session has no activity. `tenjin install` registers it; you never run it by hand.",
    )
    .action(async function (this: Command) {
      const ctx = buildContext(this);
      const { runStatusLine } = await import('../router/status-line');
      await runStatusLine(io, { dataDir: ctx.dataDir });
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
