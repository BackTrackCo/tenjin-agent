import type { Command } from 'commander';
import type { Io } from '../lib/output';
import type { CommandContext, CommandRun } from '../context';

/**
 * The seam the three product registration modules share.
 *
 * ONE PROGRAM, SEVERAL PRODUCTS. `cli.ts` owns the root command, the global
 * flags and the one output choke point; a product module owns nothing but its
 * own verbs, and is registered or not registered by a single call. That is what
 * makes "this release ships core plus router" a line of code rather than a
 * comb through a thousand-line file.
 */

/** The headings `tenjin --help` files its commands under. */
export const SETUP = 'Setup:';
export const SEARCH = 'Search and read:';
export const PUBLISH = 'Publish:';
export const WALLET = 'Wallet:';
export const INTEGRATION = 'Integration:';

export interface Registration {
  program: Command;
  io: Io;
  /** Run one command body and emit exactly one envelope, success or failure. */
  runCommand(command: string, cmd: Command, run: CommandRun): Promise<void>;
  /** A top-level command under `group`, carrying the global flags. */
  leaf(group: string, nameAndArgs: string, summary: string): Command;
  /** The hidden per-command copies of the global flags, for a subcommand. */
  addGlobalFlags(cmd: Command): Command;
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
