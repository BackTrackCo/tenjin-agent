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
 * What a command returns on success. The CLI dispatcher (emitSuccess) turns this
 * into either the human rendering (`humanLines` to stdout at a TTY without
 * `--json`) or exactly one JSON envelope (`data`, with `--json` or when piped), so
 * no command hand-rolls output; on failure a command throws a CliError instead.
 */
export interface CommandResult {
  data: unknown;
  humanLines?: string[];
}

export type CommandRun = (ctx: CommandContext) => Promise<CommandResult>;
