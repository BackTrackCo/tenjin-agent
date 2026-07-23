import type { Io } from './lib/output';

/**
 * Global flags resolved once from the root command, threaded to every command.
 * `baseUrl` is the raw `--base-url` value (config/env precedence is applied later
 * by resolveSettings, not here); `timeout` is the request timeout in ms.
 */
export interface GlobalFlags {
  json: boolean;
  baseUrl?: string;
  timeout: number;
}

/** Everything a command run function receives. The frozen seam feature agents build against. */
export interface CommandContext {
  flags: GlobalFlags;
  dataDir: string;
  io: Io;
}

/**
 * What a command returns on success. The CLI dispatcher turns this into the one
 * stdout envelope (emitSuccess) so no command hand-rolls output; on failure a
 * command throws a CliError instead of returning.
 *
 * `suppressEnvelope` is the one documented exception to "exactly one JSON object":
 * a human-first command (interactive `install`) renders its own walkthrough to
 * stdout and sets this so the dispatcher emits no envelope. It is only ever set on
 * an interactive TTY without `--json`; the machine paths always emit the envelope.
 */
export interface CommandResult {
  data: unknown;
  humanLines?: string[];
  suppressEnvelope?: boolean;
}

export type CommandRun = (ctx: CommandContext) => Promise<CommandResult>;
