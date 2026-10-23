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
      "The handlers Tenjin's Claude Code and Codex plugins run. Each reads one hook event on stdin and writes the harness response, or nothing, on stdout. You never run these by hand.",
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
    ['prompt', 'UserPromptSubmit: build the session packet and ask the free gate'],
    ['native', 'PreToolUse on WebSearch|WebFetch: allow the call, or redirect it'],
    [
      'shortfall',
      'PostToolUse(Failure) on WebSearch|WebFetch: offer a paid lookup when the result came back short',
    ],
    ['agent', "PreToolUse on Agent|Task: append any paid offer to the subagent's task"],
    ['ask', 'PreToolUse on AskUserQuestion: allow the question, or redirect it once'],
    ['answer', "PostToolUse on AskUserQuestion: offer a paid lookup beside the user's answers"],
  ] as const) {
    addGlobalFlags(hook.command(name))
      .addOption(harnessOption())
      .summary(summary)
      .action(async function (this: Command) {
        const ctx = buildContext(this);
        const { runHookCommand } = await import('../router/hook-command');
        // The flag rides too, so `--base-url` reaches the gate the same way it
        // reaches every other command; the env layer is read inside.
        await runHookCommand(name, io, {
          dataDir: ctx.dataDir,
          harness: this.opts().harness as Harness,
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
    // The plugin's `.mcp.json` passes it so Claude Code does not take its server
    // for a duplicate of a settings install's `tenjin mcp` (see `plugin-files.ts`).
    .addOption(new Option('--plugin', 'started by the Tenjin Claude Code plugin').hideHelp())
    .addOption(harnessOption().hideHelp())
    .description(
      "Run the local stdio MCP server that carries the `request` tool: one free routing decision per lookup, then the provider call, built here from the offer's spec and your assistant's input where it has one, under your local spend policy. It speaks on stdin and stdout and runs until the client disconnects, so it prints no envelope of its own.",
    )
    .action(async function (this: Command) {
      const ctx = buildContext(this);
      const harness = this.opts().harness as Harness;
      const { runRouterMcpServer } = await import('../router/mcp');
      await runRouterMcpServer({
        dataDir: ctx.dataDir,
        flags: ctx.flags,
        harness,
      });
      // Codex has no SessionStart hook to start the daily background update
      // from (adding one would change the hooks it trusts), so its server does,
      // as the session ENDS: the switch rewrites the launcher its hooks run, so
      // starting it any earlier would move them mid-session. Hooks and server
      // then both start the next session on the new version.
      if (harness === 'codex') {
        (await import('../lib/auto-update')).maybeAutoUpdate({
          dataDir: ctx.dataDir,
          env: process.env,
        });
      }
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

  leaf(SETUP, 'status', 'whether Tenjin is on, your balance, limits, accounts and settings')
    .description(
      "Whether Tenjin is on or paused here; your Tenjin balance; today's spending against your daily limit, and your per-call limit, both on the Tenjin balance only; your connected accounts, which their own plans pay for, outside those limits; and your settings. --json adds the detail: what lookups cost, the prepaid routing credit, and requests still in flight.",
    )
    .action(async function (this: Command) {
      await runCommand('status', this, async (ctx) => {
        const { runRouterStatus } = await import('../router/status');
        return runRouterStatus(ctx);
      });
    });

  leaf(SETUP, 'usage', 'what lookups cost, by day and by who ran them')
    .description(
      "Totals from this machine's own record, by day: Tenjin's tools, paid from your Tenjin balance, and each of your connected accounts, billed to that account's own plan. --since takes 24h, 7d (the default), 30d or a date. Routing fees aren't in it: `tenjin status` shows today's.",
    )
    .option('--since <window>', 'how far back: 24h, 7d, 30d or a date such as 2026-10-01')
    .action(async function (this: Command) {
      await runCommand('usage', this, async (ctx) => {
        const opts = this.opts() as { since?: string };
        const { runRouterUsage } = await import('../router/usage');
        return runRouterUsage(ctx, opts.since !== undefined ? { since: opts.since } : {});
      });
    });

  leaf(SETUP, 'connect <name>', 'connect your own account at a provider, such as Apify or fal')
    .description(
      "Connect your own account so Tenjin can run the jobs it knows for it on that account, which your own plan pays for (not your Tenjin balance, and not counted in its limits). <name> is an account Tenjin knows, such as Apify, fal or Firecrawl, or an MCP server's https address. You approve the sign-in in your browser; where that can't work, --paste reads a key at a hidden prompt in your own terminal, or --from-env reads one from an environment variable once. Tenjin checks the account's tools for free, keeps the sign-in encrypted on this machine with its key in your OS keychain, and puts the account first for its jobs unless you say --no-prefer. Never paste a key into a chat.",
    )
    .addHelpText(
      'after',
      `
Examples:
  $ tenjin connect apify
  $ tenjin connect fal --paste
  $ tenjin connect firecrawl --from-env FIRECRAWL_API_KEY
  $ tenjin connect apify --no-prefer
  $ tenjin connect https://mcp.example.com/mcp
`,
    )
    .option('--paste', 'type or paste a key at a hidden prompt (needs your own terminal)')
    .option('--from-env <var>', 'read the key from this environment variable, once')
    .option('--no-prefer', 'connect without putting this account first for its jobs')
    .action(async function (this: Command, name: string) {
      await runCommand('connect', this, async (ctx) => {
        const opts = this.opts() as { paste?: boolean; fromEnv?: string; prefer?: boolean };
        const { runConnect } = await import('../commands/connect');
        return runConnect(name, opts, ctx);
      });
    });

  leaf(SETUP, 'disconnect <name>', 'sign out of a connected account and forget it here')
    .description(
      'Sign out of a connected account where it allows that, delete its sign-in from this machine, and take it out of your preferences. Your other settings and accounts stay as they are; `tenjin connect <name>` connects it again.',
    )
    .action(async function (this: Command, name: string) {
      await runCommand('disconnect', this, async (ctx) => {
        const { runDisconnect } = await import('../commands/connect');
        return runDisconnect(name, ctx);
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
