import { join } from 'node:path';

/** `$CODEX_HOME`, else `~/.codex`: the same root the CLI reads its config from. */
export function codexHome(home: string, env: NodeJS.ProcessEnv = process.env): string {
  const override = env.CODEX_HOME;
  return override !== undefined && override.length > 0 ? override : join(home, '.codex');
}
