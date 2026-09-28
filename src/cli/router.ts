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
  registerReviewJobs(reg);
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

function registerReviewJobs(reg: Registration): void {
  const jobs = reg
    .leaf(INTEGRATION, 'jobs', 'prepare and resume human second opinions')
    .helpCommand(false);
  reg.addGlobalFlags(jobs.command('status <jobId>')).action(async function (
    this: Command,
    jobId: string,
  ) {
    await reg.runCommand('jobs status', this, async (ctx) => {
      const { readReview } = await import('../router/review/jobs');
      const result = await readReview(ctx, jobId);
      return { data: result.envelope, humanLines: [JSON.stringify(result.envelope)] };
    });
  });
  for (const action of ['submit', 'select', 'approve', 'release'] as const) {
    const command = reg
      .addGlobalFlags(jobs.command(`${action} <jobId>`))
      .requiredOption('--yes', 'record explicit prior user approval of this action');
    if (action === 'submit')
      command
        .requiredOption('--quote-id <id>', 'saved quote ID')
        .requiredOption('--approval <digest>', 'exact approved quote digest');
    if (action === 'select') command.requiredOption('--application-id <id>', 'approved applicant');
    if (action === 'approve')
      command
        .requiredOption('--submission-id <id>', 'reviewed submission')
        .requiredOption('--evidence-revision <digest>', 'exact reviewed evidence revision');
    command.action(async function (this: Command, jobId: string) {
      await reg.runCommand(`jobs ${action}`, this, async (ctx) => {
        const { actOnReview } = await import('../router/review/lifecycle');
        const result = await actOnReview(ctx, jobId, {
          action,
          yes: this.opts().yes,
          ...(action === 'submit'
            ? { quoteId: this.opts().quoteId, approval: this.opts().approval }
            : {}),
          ...(action === 'select' ? { applicationId: this.opts().applicationId } : {}),
          ...(action === 'approve'
            ? {
                submissionId: this.opts().submissionId,
                evidenceRevision: this.opts().evidenceRevision,
              }
            : {}),
        });
        return { data: result.envelope, humanLines: [JSON.stringify(result.envelope)] };
      });
    });
  }
  reg
    .addGlobalFlags(jobs.command('connect'))
    .option('--yes', 'record prior consent to $10 signup credit')
    .option('--country <code>', 'your explicitly provided two-letter country')
    .action(async function (this: Command) {
      await reg.runCommand('jobs connect', this, async (ctx) => {
        const { connectReviewAccount } = await import('../router/review/account');
        return connectReviewAccount(ctx, this.opts());
      });
    });
  reg
    .addGlobalFlags(jobs.command('quote <jobId>'))
    .requiredOption('--price <usd>', 'worker compensation in USD; does not hire')
    .requiredOption('--share', 'approve sending this draft material to RentAHuman for a quote')
    .action(async function (this: Command, jobId: string) {
      await reg.runCommand('jobs quote', this, async (ctx) => {
        const { quoteReview } = await import('../router/review/jobs');
        return quoteReview(ctx, jobId, this.opts().price as string);
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
    .requiredOption('--artifact <path>', 'reviewed Jevgrep npm tarball containing custom auth')
    .requiredOption('--sha256 <hex>', 'reviewed tarball SHA-256')
    .requiredOption('--max-run <usd>', 'whole-search exposure ceiling, at most 0.05 USD')
    .requiredOption('--share-source', 'authorize committed tracked source disclosure to jev-x402')
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
            ? `Enabled for committed tracked source in ${grant.root}; supplier jev-x402; budget ${grant.maxRunAtomic} atomic USDC.`
            : 'Local repository retrieval is disabled.',
        ],
      };
    });
  });
}
