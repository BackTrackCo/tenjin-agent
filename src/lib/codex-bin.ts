import { statSync } from 'node:fs';
import { join } from 'node:path';

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

/** The `codex` this machine runs, or null when PATH holds none that can start. */
export function resolveCodex(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  execPath: string = process.execPath,
): CodexCommand | null {
  const win = platform === 'win32';
  const exts = win
    ? (env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';').filter((e) => e.length > 0)
    : [''];
  for (const part of (env.PATH ?? '').split(win ? ';' : ':')) {
    if (part.length === 0) continue;
    for (const ext of exts) {
      const candidate = join(part, `codex${ext}`);
      if (!isFile(candidate)) continue;
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
