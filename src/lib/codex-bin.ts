import { accessSync, constants, statSync } from 'node:fs';
import { join, posix, win32 } from 'node:path';

/**
 * WHAT TO START TO RUN `codex`, WITH NO SHELL. The PATH walk tries the PATHEXT
 * extensions on win32, as `findClaudeBinary` does for `claude`. A native
 * `codex.exe` runs as found. npm's `codex.cmd` shim cannot be started without
 * a shell, so the script it points at, `@openai/codex/bin/codex.js` beside it,
 * runs under this Node instead.
 */
export interface CodexCommand {
  cmd: string;
  /** Arguments that go before Codex's own: the script, for an npm shim. */
  prefix: string[];
}

const NPM_SCRIPT = ['node_modules', '@openai', 'codex', 'bin', 'codex.js'];

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** The host's Codex executable, otherwise the first runnable Codex on PATH. */
export function resolveCodex(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  execPath: string = process.execPath,
): CodexCommand | null {
  const win = platform === 'win32';
  // Desktop can run a newer bundled Codex than the user's terminal PATH.
  // This is only a host hint: callers still qualify the initialized version.
  const runtime = env.CODEX_APP_RUNTIME_CLI_PATH;
  if (
    runtime &&
    (win ? win32 : posix).isAbsolute(runtime) &&
    !/\.(cmd|bat)$/i.test(runtime) &&
    isFile(runtime)
  ) {
    try {
      accessSync(runtime, win ? constants.F_OK : constants.X_OK);
      return { cmd: runtime, prefix: [] };
    } catch {
      // An invalid host hint must not prevent ordinary CLI discovery.
    }
  }
  const exts = win
    ? (env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';').filter((e) => e.length > 0)
    : [''];
  for (const part of (env.PATH ?? '').split(win ? ';' : ':')) {
    if (part.length === 0) continue;
    for (const ext of exts) {
      // PATHEXT is upper case; Windows matches names in any case, so try both.
      const candidate = [ext, ext.toLowerCase()].map((e) => join(part, `codex${e}`)).find(isFile);
      if (candidate === undefined) continue;
      if (/^\.(cmd|bat)$/i.test(ext)) {
        const script = join(part, ...NPM_SCRIPT);
        if (isFile(script)) return { cmd: execPath, prefix: [script] };
        continue;
      }
      return { cmd: candidate, prefix: [] };
    }
  }
  return null;
}
