import { Option, type Command } from 'commander';
import { HARNESSES, type Harness } from '../router/names';
import { INTEGRATION, SETUP, type Registration } from './registration';

/** `--harness`: the agent host this command serves. */
export function harnessOption(): Option {
  return new Option('--harness <host>', 'the agent host').choices(HARNESSES).default('claude');
}

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

  const hook = leaf(INTEGRATION, 'hook', 'run one harness hook handler (called by your agent host)')
    .description(
      "The handlers Tenjin's plugins run, and the ones an older setup wrote. `alive` marks a session the Claude Code plugin serves. `prompt`, `native`, `shortfall`, `agent`, `ask` and `answer` are left from older setups: the plugins route through `tenjin mcp`, which pays the routing fee, so each of these reads one hook event on stdin, routes nothing, and tells the person once per session to run `tenjin install`. You never run these by hand.",
    )
    .helpCommand(false);
  // Normally answered by the fast path in `index.ts`, before the command tree
  // loads; registered here too so `--help` names it and a flag still lands.
  addGlobalFlags(hook.command('alive'))
    .summary('SessionStart: mark this session and machine as ones the plugin serves')
    .action(async function (this: Command) {
      const ctx = buildContext(this);
      const [{ aliveMain }, { default: pkg }] = await Promise.all([
        import('../router/alive'),
        import('../../package.json'),
      ]);
      await aliveMain({ dataDir: ctx.dataDir, version: pkg.version });
    });
  for (const [name, summary] of [
    ['prompt', 'UserPromptSubmit, from an older setup: tell the person to run `tenjin install`'],
    ['native', 'PreToolUse on WebSearch|WebFetch, from an older setup: the same'],
    ['shortfall', 'PostToolUse(Failure) on WebSearch|WebFetch, from an older setup: the same'],
    ['agent', 'PreToolUse on Agent|Task, from an older setup: the same'],
    ['ask', 'PreToolUse on AskUserQuestion, from an older setup: the same'],
    ['answer', 'PostToolUse on AskUserQuestion, from an older setup: the same'],
  ] as const) {
    addGlobalFlags(hook.command(name))
      .addOption(harnessOption())
      .summary(summary)
      .action(async function (this: Command) {
        const ctx = buildContext(this);
        const { runHookCommand } = await import('../router/hook-command');
        await runHookCommand(io, {
          dataDir: ctx.dataDir,
          harness: this.opts().harness as Harness,
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
    // The plugin's `.mcp.json` passes it so Claude Code does not take its server
    // for a duplicate of a settings install's `tenjin mcp` (see `plugin-files.ts`).
    .addOption(new Option('--plugin', 'started by the Tenjin Claude Code plugin').hideHelp())
    .addOption(harnessOption().hideHelp())
    .description(
      "Run the local stdio MCP server that carries the `request` tool: one routing decision per lookup, paid with a small routing fee, then the provider call, built here from the offer's spec and your assistant's input where it has one, under your local spend policy. It speaks on stdin and stdout and runs until the client disconnects, so it prints no envelope of its own.",
    )
    .action(async function (this: Command) {
      const ctx = buildContext(this);
      const harness = this.opts().harness as Harness;
      // Codex has no SessionStart hook to start the daily background update
      // from, so its server does, as it starts. Code after the server's
      // `await` never runs: Codex ends the server with a signal. Claude Code's
      // starts from its SessionStart leg, never from here.
      if (harness === 'codex') {
        (await import('../lib/auto-update')).maybeAutoUpdate({
          dataDir: ctx.dataDir,
          env: process.env,
        });
      }
      const { runRouterMcpServer } = await import('../router/mcp');
      await runRouterMcpServer({
        dataDir: ctx.dataDir,
        flags: ctx.flags,
        harness,
      });
    });

  leaf(INTEGRATION, 'status-line', "the live footer, for Claude Code's status line")
    .description(
      "Print one line naming what this session is looking up right now: the provider actually being called, its bounded parameters, and what it cost. It reads Claude Code's status event on stdin for the session identity, reads that session's own progress records, writes nothing, and prints `x402 · ready` when this session has no activity. Opt-in: set it as your Claude Code status line command yourself.",
    )
    .action(async function (this: Command) {
      const ctx = buildContext(this);
      const { runStatusLine } = await import('../router/status-line');
      await runStatusLine(io, { dataDir: ctx.dataDir });
    });

  leaf(SETUP, 'status', 'what this machine has spent, and what is still open')
    .description(
      'Report the daily budget shared across chats: what has settled, what is reserved by a request still in flight, and the per-call and budget caps in force.',
    )
    .action(async function (this: Command) {
      await runCommand('status', this, async (ctx) => {
        const { runRouterStatus } = await import('../router/status');
        return runRouterStatus(ctx);
      });
    });

  const payments = leaf(SETUP, 'payments', 'the paid lookups this machine made').description(
    'The local record of paid router lookups, in `~/.tenjin/paid/ledger.jsonl`. A bare `tenjin payments` lists the newest: when, who was paid, how much, whether it settled, and the transaction.',
  );
  payments.action(async function (this: Command) {
    await runCommand('payments', this, async (ctx) => {
      const { runPaymentsList } = await import('../router/payments');
      return runPaymentsList(ctx);
    });
  });
  addGlobalFlags(payments.command('reconcile'))
    .summary('resolve paid lookups whose settlement is unknown')
    .description(
      'For each paid lookup whose seller never confirmed settlement and whose authorization has expired, ask USDC on Base (through the configured rpcUrl) whether it was used: used means it was charged, unused means it never can be. Nothing is signed or sent but that one read.',
    )
    .action(async function (this: Command) {
      await runCommand('payments.reconcile', this, async (ctx) => {
        const { runPaymentsReconcile } = await import('../router/payments');
        return runPaymentsReconcile(ctx);
      });
    });
}
