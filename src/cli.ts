import { Command, CommanderError } from 'commander';
import { z } from 'zod';
import pkg from '../package.json';
import { CliError } from './lib/errors';
import { dataDir } from './lib/paths';
import { defaultIo, emitFailure, emitSuccess } from './lib/output';
import type { Io } from './lib/output';
import type { CommandContext, CommandRun, GlobalFlags } from './context';

/**
 * Global flags, validated. The merged options object (`cmd.optsWithGlobals()`) is
 * loosely typed; parsing it through zod both gives us a typed GlobalFlags and
 * coerces `--timeout` (a string from commander) into a positive integer, so a bad
 * `--timeout abc` fails as USAGE. Unknown keys (e.g. `wallet import`'s
 * `--from-env`) are stripped by the default object parse.
 */
const GlobalOptsSchema = z.object({
  json: z.boolean().default(false),
  baseUrl: z.url().optional(),
  timeout: z.coerce.number().int().positive().default(10000),
});

/**
 * The three global flags, repeated on every leaf command so they parse in ANY
 * position: `tenjin wallet show --json` as well as `tenjin --json wallet show`.
 * commander parses an option in the scope of whatever command consumes its
 * token, so a flag after the subcommand must be declared on that subcommand;
 * `optsWithGlobals()` then merges the leaf's values over its ancestors'.
 *
 * Defaults live ONLY on the root declaration (see buildProgram), never here: a
 * leaf default would, through that leaf-wins merge, mask a value the user set at
 * the root (`tenjin --timeout 500 doctor`), so leaf flags stay default-less and a
 * flag absent from the leaf simply doesn't appear in its opts().
 */
function addGlobalFlags(cmd: Command): Command {
  return cmd
    .option('--json', 'emit machine JSON only (suppress human stderr rendering)')
    .option('--base-url <url>', 'Tenjin API base URL')
    .option('--timeout <ms>', 'request timeout in milliseconds');
}

function buildContext(cmd: Command, io: Io): CommandContext {
  const parsed = GlobalOptsSchema.safeParse(cmd.optsWithGlobals());
  if (!parsed.success) {
    throw new CliError('USAGE', 'Invalid global option', {
      fix: 'Run `tenjin --help` for usage.',
      details: parsed.error.issues,
    });
  }
  const flags: GlobalFlags = {
    json: parsed.data.json,
    timeout: parsed.data.timeout,
    baseUrl: parsed.data.baseUrl,
  };
  return { flags, dataDir: dataDir(process.env), io };
}

/**
 * Wire the whole command tree. Command bodies are loaded by lazy `import()` at
 * action time so a `doctor`/`config` invocation never parses the wallet module's
 * (eventual) viem chunk. `setExit` is how a failed command reports its exit code
 * back to main without anyone calling process.exit here.
 */
export function buildProgram(io: Io, setExit: (code: number) => void): Command {
  const program = new Command();

  // The single choke point for command output: run the body, emit exactly one
  // envelope, and on any throw serialize it through the failure contract. No
  // command writes to stdout itself, so "exactly one JSON object" holds by
  // construction. `cmd` is the running leaf command (commander binds it as the
  // action's `this`); its optsWithGlobals() is what makes `--json` honor trailing
  // placement too — read raw here (not via zod) so a failing global parse still
  // suppresses stderr under --json.
  const runCommand = async (command: string, cmd: Command, run: CommandRun): Promise<void> => {
    const json = cmd.optsWithGlobals().json === true;
    try {
      const ctx = buildContext(cmd, io);
      const result = await run(ctx);
      emitSuccess(ctx.io, command, result.data, result.humanLines, { json: ctx.flags.json });
    } catch (err) {
      setExit(emitFailure(io, command, err, { json }).exitCode);
    }
  };

  program
    .name('tenjin')
    .description('Tenjin agent CLI for the x402 knowledge marketplace.')
    .version(pkg.version, '-V, --version', 'output the version number')
    // Root declarations carry the DEFAULTS (only here — see addGlobalFlags). They
    // parse flags placed before the subcommand; the per-leaf copies handle
    // trailing placement, and optsWithGlobals() merges the two.
    .option('--json', 'emit machine JSON only (suppress human stderr rendering)')
    .option('--base-url <url>', 'Tenjin API base URL')
    .option('--timeout <ms>', 'request timeout in milliseconds', '10000')
    .configureOutput({
      // --help / --version print here (stdout). Nothing else uses writeOut, so
      // stdout stays a single JSON object for every real command.
      writeOut: (str) => io.stdout.write(str),
      // Commander's usage/help text is human decoration: TTY only, never under
      // --json. This gates on the root's --json (the scope available when a parse
      // error fires before any subcommand runs); the machine contract for the same
      // failure goes to stdout via handleParseError, so the two never collide.
      writeErr: (str) => {
        if (io.isTTY && program.opts().json !== true) io.stderr.write(str);
      },
    })
    // No root action: with subcommands present, an unknown first token then
    // surfaces as "unknown command 'x'" rather than being mis-read as an excess
    // positional argument. Bare `tenjin` falls through to commander.help, which
    // handleParseError turns into the USAGE contract.
    .exitOverride();

  addGlobalFlags(program.command('doctor'))
    .description('Check the local environment and Tenjin API reachability')
    .action(async function (this: Command) {
      await runCommand('doctor', this, async (ctx) => {
        const { runDoctor } = await import('./commands/doctor');
        return runDoctor(ctx);
      });
    });

  const config = addGlobalFlags(program.command('config')).description(
    'Show or change CLI configuration',
  );
  config.action(async function (this: Command) {
    await runCommand('config', this, async (ctx) => {
      const { runConfigList } = await import('./commands/config');
      return runConfigList(ctx);
    });
  });
  addGlobalFlags(config.command('get <key>'))
    .description('Print one effective config value')
    .action(async function (this: Command, key: string) {
      await runCommand('config.get', this, async (ctx) => {
        const { runConfigGet } = await import('./commands/config');
        return runConfigGet({ key }, ctx);
      });
    });
  addGlobalFlags(config.command('set <key> <value>'))
    .description('Set a config value (decimal USD accepted for spend keys)')
    .action(async function (this: Command, key: string, value: string) {
      await runCommand('config.set', this, async (ctx) => {
        const { runConfigSet } = await import('./commands/config');
        return runConfigSet({ key, value }, ctx);
      });
    });

  // Group-level flags so `tenjin wallet --json show` parses like the config group.
  const wallet = addGlobalFlags(
    program.command('wallet').description('Manage the local x402 payment wallet'),
  );
  addGlobalFlags(wallet.command('create'))
    .description('Create a new local wallet')
    .action(async function (this: Command) {
      await runCommand('wallet.create', this, async (ctx) => {
        const { runWalletCreate } = await import('./commands/wallet');
        return runWalletCreate(ctx);
      });
    });
  addGlobalFlags(wallet.command('show'))
    .description('Show the wallet address and key source (never the key)')
    .action(async function (this: Command) {
      await runCommand('wallet.show', this, async (ctx) => {
        const { runWalletShow } = await import('./commands/wallet');
        return runWalletShow(ctx);
      });
    });
  addGlobalFlags(wallet.command('balance'))
    .description('Show the wallet USDC balance on Base')
    .action(async function (this: Command) {
      await runCommand('wallet.balance', this, async (ctx) => {
        const { runWalletBalance } = await import('./commands/wallet');
        return runWalletBalance(ctx);
      });
    });
  addGlobalFlags(wallet.command('import'))
    .description('Import a private key from stdin or --from-env')
    .option('--from-env', 'read the key from TENJIN_WALLET_KEY')
    .action(async function (this: Command, options: { fromEnv?: boolean }) {
      await runCommand('wallet.import', this, async (ctx) => {
        const { runWalletImport } = await import('./commands/wallet');
        return runWalletImport({ fromEnv: options.fromEnv === true }, ctx);
      });
    });

  return program;
}

/**
 * Run the CLI in-process and return the exit code — never calls process.exit, so
 * tests drive it with injected streams and assert on the code. The bin wrapper
 * (index.ts) is what turns the return into a real exit.
 */
export async function main(argv: string[], io: Io = defaultIo()): Promise<number> {
  let exitCode = 0;
  const program = buildProgram(io, (code) => {
    exitCode = code;
  });
  try {
    await program.parseAsync(argv, { from: 'user' });
  } catch (err) {
    return handleParseError(err, io, program);
  }
  return exitCode;
}

function handleParseError(err: unknown, io: Io, program: Command): number {
  const json = program.opts().json === true;
  if (err instanceof CommanderError) {
    // Explicit --version / --help already wrote to stdout via writeOut; success.
    if (err.code === 'commander.version' || err.code === 'commander.helpDisplayed') {
      return 0;
    }
    // commander.help (bare or incomplete command) and every usage error (unknown
    // command/option, missing/excess argument, invalid value): commander already
    // wrote its human text to writeErr (gated to TTY, non-json). Emit the machine
    // contract to STDOUT only — pass json:true so emitFailure does not re-render a
    // human line and duplicate commander's stderr text — and use usage exit 2.
    const message =
      err.code === 'commander.help'
        ? 'No command specified'
        : err.message.replace(/^error:\s*/i, '');
    const usageErr = new CliError('USAGE', message, {
      fix: 'Run `tenjin --help` for available commands.',
    });
    emitFailure(io, 'tenjin', usageErr, { json: true });
    return 2;
  }
  // Defensive: runCommand catches command errors, so a throw reaching here is
  // unexpected. Still honor the contract rather than leak a stack trace.
  return emitFailure(io, 'tenjin', err, { json }).exitCode;
}
