import type { Command } from 'commander';
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
  registerJevgrep(reg);

  const hook = leaf(INTEGRATION, 'hook', 'run one harness hook handler (called by Claude Code)')
    .description(
      'The handlers `tenjin install` registers in Claude Code. Each reads one hook event on stdin and writes the harness response, or nothing, on stdout. You never run these by hand.',
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
      .summary(summary)
      .action(async function (this: Command) {
        const ctx = buildContext(this);
        const { runHookCommand } = await import('../router/hook-command');
        // The flag rides too, so `--base-url` reaches the gate the same way it
        // reaches every other command; the env layer is read inside.
        await runHookCommand(name, io, {
          dataDir: ctx.dataDir,
          ...(ctx.flags.baseUrl !== undefined ? { baseUrl: ctx.flags.baseUrl } : {}),
        });
      });
  }
  // A separate lazy entry keeps paid execution out of the ordinary free hooks.
  addGlobalFlags(hook.command('repository'))
    .summary('PreToolUse on Grep/Bash searches: retrieve in explicitly approved repositories')
    .action(async function (this: Command) {
      const ctx = buildContext(this);
      const { runRepositoryHookCommand } = await import('../router/repository-hook-command');
      await runRepositoryHookCommand(ctx);
    });
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
      'Run the local stdio MCP server that carries the `request` tool: free routing decisions, followed by provider calls or explicitly enabled local retrieval under your spend policy. It speaks on stdin and stdout and runs until the client disconnects, so it prints no envelope of its own.',
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

function registerJevgrep(reg: Registration): void {
  const command = reg
    .leaf(SETUP, 'jevgrep', 'configure experimental bounded repository retrieval')
    .helpCommand(false);
  reg
    .addGlobalFlags(command.command('enable'))
    .requiredOption('--root <path>', 'one canonical repository root')
    .option('--release <version>', 'qualified exact npm release (0.7.0); cached npx runtime')
    .option('--artifact <path>', 'reviewed Jevgrep npm tarball containing custom auth')
    .option('--sha256 <hex>', 'reviewed tarball SHA-256; required with --artifact')
    .option('--supplier <id>', 'reviewed source recipient: jev-x402 or maple-jev', 'jev-x402')
    .requiredOption(
      '--max-run <usd>',
      'whole-search exposure ceiling, at most 1 USD; above 0.05 opts into extended retrieval',
    )
    .requiredOption(
      '--share-source',
      'authorize committed tracked source disclosure to the selected supplier',
    )
    .requiredOption('--experimental', 'opt into the unreleased local pilot')
    .action(async function (this: Command) {
      await reg.runCommand('jevgrep enable', this, async (ctx) => {
        const { configureJevgrep } = await import('../router/jevgrep/grants');
        return configureJevgrep(ctx, this.opts());
      });
    });
  reg.addGlobalFlags(command.command('disable')).action(async function (this: Command) {
    await reg.runCommand('jevgrep disable', this, async (ctx) => {
      const { disableJevgrep } = await import('../router/jevgrep/grants');
      return disableJevgrep(ctx);
    });
  });
  reg.addGlobalFlags(command.command('status')).action(async function (this: Command) {
    await reg.runCommand('jevgrep status', this, async (ctx) => {
      const { readJevgrepGrant } = await import('../router/jevgrep/grants');
      const grant = await readJevgrepGrant(ctx.dataDir);
      return {
        data: grant ?? { enabled: false },
        humanLines: [
          grant?.enabled
            ? `Enabled for committed tracked source in ${grant.root}; supplier ${grant.supplier}; budget ${grant.maxRunAtomic} atomic USDC.`
            : 'Local repository retrieval is disabled.',
        ],
      };
    });
  });
}
