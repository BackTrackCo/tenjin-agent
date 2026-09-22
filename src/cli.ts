import { Command, CommanderError, Option } from 'commander';
import { z } from 'zod';
import pkg from '../package.json';
import { CliError } from './lib/errors';
import { dataDir } from './lib/paths';
import { PERMISSIONS_DOC_URL } from './lib/permissions';
import { defaultIo, emitFailure, emitSuccess } from './lib/output';
import type { Io } from './lib/output';
import { maybeUpdate, readUpdateSignal } from './lib/update-check';
import { registerCore } from './cli/core';
import { registerRouter } from './cli/router';
import { SETUP, type Registration } from './cli/registration';
import type { CommandContext, CommandRun, GlobalFlags } from './context';

/**
 * Global flags, validated. The merged options object (`cmd.optsWithGlobals()`) is
 * loosely typed; parsing it through zod both gives us a typed GlobalFlags and
 * coerces `--timeout` (a string from commander) into a positive integer, so a bad
 * `--timeout abc` fails as USAGE. Any non-global keys a leaf command merges in via
 * optsWithGlobals() are stripped by the default object parse.
 */
const GlobalOptsSchema = z.object({
  json: z.boolean().default(false),
  baseUrl: z.url().optional(),
  timeout: z.coerce.number().int().positive().default(10000),
});

/**
 * The three global flags: flags, description, and the root's default. Each is
 * declared twice — once on the root, and again on every command so it parses in
 * ANY position (`tenjin wallet show --json` as well as `tenjin --json wallet
 * show`): commander parses an option in the scope of whatever command consumes
 * its token, and `optsWithGlobals()` merges the leaf's values over its
 * ancestors'. One table, so the two declarations cannot drift apart.
 *
 * Defaults live ONLY on the root: a leaf default would, through that leaf-wins
 * merge, mask a value the user set at the root (`tenjin --timeout 500 doctor`),
 * so leaf flags stay default-less and a flag absent from the leaf simply doesn't
 * appear in its opts().
 */
const GLOBAL_FLAGS: readonly (readonly [string, string, string?])[] = [
  ['--json', 'emit one machine JSON envelope on stdout instead of the human rendering'],
  ['--base-url <url>', 'Tenjin API base URL'],
  ['--timeout <ms>', 'request timeout in milliseconds', '10000'],
];

/**
 * The per-command copies, hidden from that command's help: a global flag belongs
 * on `tenjin --help` once, and re-listing the same three under every command
 * buries the flags the command actually has.
 */
function addGlobalFlags(cmd: Command): Command {
  for (const [flags, help] of GLOBAL_FLAGS) cmd.addOption(new Option(flags, help).hideHelp());
  return cmd;
}

/**
 * One top-level command: filed under its heading, summarized in the one line
 * `tenjin --help` shows for it, and carrying the global flags. The heading goes
 * on the command itself rather than through commander's `commandsGroup()`
 * default so commands can be declared in the order that reads best (`read`
 * before `buy`) instead of in heading order. `helpCommand(false)` drops the
 * implicit `help [command]` INSIDE a group (`tenjin hooks help enable` is a
 * third spelling of one thing); the root keeps it, see {@link rootHelpCommand}.
 */
function leaf(program: Command, group: string, nameAndArgs: string, summary: string): Command {
  return addGlobalFlags(
    program
      .command(nameAndArgs)
      .helpGroup(group)
      .summary(summary)
      .helpCommand(false)
      // Its own help option, rather than the root's: commander shares that one
      // instance with every descendant, and the root's sits in the Global
      // options block, which would leave each command a block holding `-h` alone.
      .helpOption('-h, --help', 'show this help'),
  );
}

/**
 * `tenjin help <command>`, the second way in that gh, git, cargo and docker all
 * accept beside `<command> --help`. Built here rather than left implicit so it
 * carries a heading: an ungrouped command falls into commander's `Commands:`
 * bucket, which would put a sixth list on `tenjin --help` holding one line.
 * Commander dispatches it by name, so it needs no action.
 */
function rootHelpCommand(): Command {
  return new Command('help')
    .argument('[command]', 'the command to show help for')
    .helpGroup(SETUP)
    .summary('show help for a command')
    .description('Show help for a command. `tenjin <command> --help` says the same thing.')
    .helpOption(false);
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
export type ProductRegistration = (registration: Registration) => void;

/** This release's products, in `--help` order. The shelf is deliberately absent:
 *  `./cli/shelf` is not imported, so it is neither bundled nor listed. */
export const PRODUCTS: readonly ProductRegistration[] = [registerCore, registerRouter];

export function buildProgram(
  io: Io,
  setExit: (code: number) => void,
  products: readonly ProductRegistration[] = PRODUCTS,
): Command {
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
    // `install --refresh` promises to converge what exists and create nothing.
    // Under `tenjin update` the child is held to that by TENJIN_NO_UPDATE_CHECK,
    // but a hand-run refresh arrives here with nothing set, and the nudge below
    // would materialize `update-check.json` under a data dir this mode was not
    // allowed to add a single file to. Read here rather than in the command
    // body: the nudge fires after the body has already thrown its refusal.
    const refreshRun = command === 'install' && cmd.optsWithGlobals().refresh === true;
    // Read BEFORE the envelope, from the last check's cache only: this is the
    // agent's copy of the nudge, and it must not cost a network call or a delay.
    // `update` is excluded for the same reason the nudge is — its own envelope
    // has just answered the question.
    const updateAvailable =
      command === 'update' ? null : await readUpdateSignal(dataDir(process.env));
    try {
      const ctx = buildContext(cmd, io);
      const result = await run(ctx);
      emitSuccess(ctx.io, command, result.data, result.humanLines, {
        json: ctx.flags.json,
        updateAvailable,
      });
    } catch (err) {
      setExit(emitFailure(io, command, err, { json, updateAvailable }).exitCode);
    }
    // AFTER the envelope, for every command and both outcomes: neither of these
    // may delay a command's output, touch stdout, or move its exit code, and
    // neither ever rejects. The nudge resolves its own data dir because a failed
    // buildContext has no ctx to read one from. Skipped for `update` itself: its
    // envelope has just answered the nudge's question, and this process still
    // runs the OLD build, so a cached "newer exists" would print the nudge in
    // the same breath as "Updated". Skipped for `install --refresh` because its
    // cache file is the one thing that mode may not create; see `refreshRun`.
    if (command !== 'update' && !refreshRun) {
      await maybeUpdate({ dir: dataDir(process.env), io, json });
    }
    // Every command but `install` is a chance to catch up a skill left stale by
    // an upgrade; `install` has just written the same bytes from the same source.
    // Lazily imported, like the command bodies, to keep it off the boot path, and
    // the import is INSIDE the guard: a chunk that is missing or corrupt (a
    // half-unpacked upgrade) would otherwise reject here, after the envelope, and
    // turn a finished command into a second envelope and a nonzero exit.
    if (command !== 'install') {
      try {
        const { healWiredSkills } = await import('./lib/skill-heal');
        // The data dir, because the skill text it writes is shaped by the machine's
        // configured mode (lib/skill-materialize). Resolved the same way the update
        // nudge above resolves it, and for the same reason: a failed buildContext
        // leaves no ctx to read one from.
        await healWiredSkills({ io, dataDir: dataDir(process.env) });
      } catch {
        // Nothing here is the command's business.
      }
    }
  };

  program
    .name('tenjin')
    .description(
      'x402 router for coding agents: one paid decision per lookup, a local wallet that pays each provider per call in USDC on Base.',
    )
    // Everything the root itself takes prints in one block, so the five command
    // groups below are the only other lists on `tenjin --help`.
    .optionsGroup('Global options:')
    .addHelpCommand(rootHelpCommand())
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

  // The root declarations carry the DEFAULTS (only here — see GLOBAL_FLAGS) and
  // are the only visible copy; they parse flags placed before the subcommand,
  // and the hidden per-command copies handle trailing placement.
  for (const [flags, help, fallback] of GLOBAL_FLAGS) {
    const option = new Option(flags, help);
    program.addOption(fallback === undefined ? option : option.default(fallback));
  }
  program
    .version(pkg.version, '-V, --version', 'output the version number')
    .helpOption('-h, --help', 'show this help');

  const registration: Registration = {
    program,
    io,
    runCommand,
    leaf: (group, nameAndArgs, summary) => leaf(program, group, nameAndArgs, summary),
    addGlobalFlags,
    buildContext: (cmd) => buildContext(cmd, io),
  };
  for (const register of products) register(registration);

  // clig.dev: show examples first and link the web documentation. Three
  // invocations, one per thing people install this for, and the pointers.
  program.addHelpText(
    'after',
    `
Examples:
  $ tenjin install
  $ tenjin wallet fund
  $ tenjin status

Learn more:
  Run \`tenjin <command> --help\` for one command.
  Permissions: ${PERMISSIONS_DOC_URL}
  Issues: ${pkg.bugs}
`,
  );

  return program;
}

/**
 * Run the CLI in-process and return the exit code — never calls process.exit, so
 * tests drive it with injected streams and assert on the code. The bin wrapper
 * (index.ts) is what turns the return into a real exit.
 */
export async function main(
  argv: string[],
  io: Io = defaultIo(),
  products: readonly ProductRegistration[] = PRODUCTS,
): Promise<number> {
  let exitCode = 0;
  const program = buildProgram(
    io,
    (code) => {
      exitCode = code;
    },
    products,
  );
  try {
    await program.parseAsync(argv, { from: 'user' });
  } catch (err) {
    return handleParseError(err, io, program);
  }
  return exitCode;
}

function handleParseError(err: unknown, io: Io, program: Command): number {
  const json = program.opts().json === true;
  // Human-first: at a real TTY without --json, commander already wrote its usage
  // text to stderr (see the writeErr gate). In that mode the stderr line stands
  // alone — stdout stays empty. Only machine mode (piped or --json) gets an
  // envelope on stdout, so the two surfaces never both render the same failure.
  const humanFirst = io.isTTY && !json;
  if (err instanceof CommanderError) {
    // Explicit --version / --help already wrote to stdout via writeOut; success.
    if (err.code === 'commander.version' || err.code === 'commander.helpDisplayed') {
      return 0;
    }
    // `tenjin help [command]` asked for that text and got it on stdout. It
    // reports `commander.help` like a bare `tenjin` does, and the exit code is
    // what tells them apart: commander raises the bare case to 1 by writing its
    // help to stderr as an error, and the help command's stays 0.
    if (err.code === 'commander.help' && err.exitCode === 0) return 0;
    // commander.help (bare or incomplete command) and every usage error (unknown
    // command/option, missing/excess argument, invalid value) are usage exit 2.
    // In machine mode emit the machine contract to STDOUT — json:true so
    // emitFailure renders the envelope, not a human line — matching commander's
    // silence there. In human mode emit nothing; commander's stderr line already
    // covered it, and a stdout envelope or second human line would double-render.
    if (!humanFirst) {
      const message =
        err.code === 'commander.help'
          ? 'No command specified'
          : err.message.replace(/^error:\s*/i, '');
      const usageErr = new CliError('USAGE', message, {
        fix: 'Run `tenjin --help` for available commands.',
      });
      emitFailure(io, 'tenjin', usageErr, { json: true });
    }
    return 2;
  }
  // Defensive: runCommand catches command errors, so a throw reaching here is
  // unexpected. Still honor the contract rather than leak a stack trace.
  return emitFailure(io, 'tenjin', err, { json }).exitCode;
}
