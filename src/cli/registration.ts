import type { Command } from 'commander';
import type { Io } from '../lib/output';
import type { CommandContext, CommandRun } from '../context';

/**
 * The seam the command registration modules share. `cli.ts` owns the root
 * command, the global flags and the one output choke point; a registration
 * module owns nothing but its own verbs.
 */

/** The headings `tenjin --help` files its commands under. */
export const SETUP = 'Setup:';
export const WALLET = 'Wallet:';
export const INTEGRATION = 'Integration:';

export interface Registration {
  program: Command;
  io: Io;
  /** Run one command body and emit exactly one envelope, success or failure. */
  runCommand(command: string, cmd: Command, run: CommandRun): Promise<void>;
  /** A top-level command under `group`, carrying the global flags but those in `except`. */
  leaf(group: string, nameAndArgs: string, summary: string, except?: readonly string[]): Command;
  /** The hidden per-command copies of the global flags, for a subcommand, but those in `except`. */
  addGlobalFlags(cmd: Command, except?: readonly string[]): Command;
  /** The context a command that bypasses {@link runCommand} still needs. */
  buildContext(cmd: Command): CommandContext;
}

/**
 * commander option collector for a repeatable flag. No initial value at the call
 * sites: an empty-array default prints as `(default: [])` beside every repeatable
 * flag in help, and every reader here already treats an absent flag as absent.
 */
export function collect(value: string, previous: string[] | undefined): string[] {
  return [...(previous ?? []), value];
}
