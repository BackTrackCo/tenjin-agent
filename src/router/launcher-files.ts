import { PRODUCTION_ORIGIN } from '../lib/production-origin';

/**
 * The `tenjin` launchers as files: the sh and `.cmd` scripts the runtime writes
 * to `~/.local/bin` and each plugin's `bin/`. Imports nothing but the
 * production origin, since `tsup.config.ts` loads the plugin renders.
 */

/**
 * What the runtime render runs: the runtime's absolute Node and the version's
 * absolute `dist/index.js`. `home` is needed only for the win32 `.cmd`
 * launcher, which names both from `%USERPROFILE%`.
 */
export interface RuntimeLaunch {
  node: string;
  entry: string;
  platform?: NodeJS.Platform;
  home?: string;
}

/**
 * The line every launcher carries. A file at a launcher's path without it is
 * not Tenjin's, and is never overwritten or removed.
 */
export const LAUNCHER_MARKER = 'tenjin-runtime-launcher';
/** Official recovery instructions: the installer includes Node and needs no working launcher. */
export const RUNTIME_MISSING_FIX = `Reinstall from ${PRODUCTION_ORIGIN}/agents (no Node or npm needed), then follow the installer's activation instruction.`;

const missingSentence = (entry: string): string =>
  `tenjin: Tenjin's runtime is missing (${entry}). ${RUNTIME_MISSING_FIX}`;

/** A single-quoted sh word: everything literal, a `'` closed, escaped and reopened. */
export const shQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

/**
 * The `tenjin` launcher as sh. It bakes the absolute Node and entry, so it reads
 * no state and the file's atomic rename is the switch. When either is gone it
 * says how to restore the runtime. On win32 it is for Git Bash, so paths use
 * forward slashes.
 */
export function renderLauncherSh(launch: RuntimeLaunch): string {
  const slash = (p: string) =>
    (launch.platform ?? process.platform) === 'win32' ? p.replaceAll('\\', '/') : p;
  return [
    '#!/bin/sh',
    `# ${LAUNCHER_MARKER}`,
    `node=${shQuote(slash(launch.node))}`,
    `entry=${shQuote(slash(launch.entry))}`,
    'if [ -x "$node" ] && [ -f "$entry" ]; then exec "$node" "$entry" "$@"; fi',
    `echo "${missingSentence('$entry').replaceAll('`', '\\`')}" >&2`,
    'exit 1',
    '',
  ].join('\n');
}

/** `path` relative to `home`, both Windows paths, or null when it is not under it. */
function underHome(path: string, home: string): string | null {
  const back = (p: string) => p.replaceAll('/', '\\');
  const base = back(home).replace(/\\+$/, '');
  const full = back(path);
  if (!full.toLowerCase().startsWith(`${base.toLowerCase()}\\`)) return null;
  return full.slice(base.length + 1);
}

/**
 * `path` as cmd reads it: `%USERPROFILE%` plus its part under `home`. It throws
 * when `path` is outside `home`, or its part holds a non-ASCII character, `"`
 * or `%`, which cmd would read.
 */
function cmdPath(path: string, home: string): string {
  const part = underHome(path, home);
  if (part === null) throw new Error(`${path} is not under ${home}`);
  if (/[^\x20-\x7e]|["%]/.test(part)) {
    throw new Error(`${path} holds a character a .cmd launcher cannot carry`);
  }
  return `%USERPROFILE%\\${part}`;
}

/**
 * The `tenjin.cmd` launcher, for a Windows terminal and the Codex runtime
 * render's commands. Paths go through {@link cmdPath}, so a non-ASCII user name
 * never has to survive cmd's code page. The run line is one parenthesized
 * block, so cmd parses it whole and a rewrite mid-run cannot inject a line.
 */
export function renderLauncherCmd(launch: RuntimeLaunch & { home: string }): string {
  const node = cmdPath(launch.node, launch.home);
  const entry = cmdPath(launch.entry, launch.home);
  return [
    '@echo off',
    `rem ${LAUNCHER_MARKER}`,
    `if exist "${node}" if exist "${entry}" ( "${node}" "${entry}" %* & exit /b )`,
    `echo ${missingSentence(entry)} 1>&2`,
    'exit /b 1',
    '',
  ].join('\r\n');
}

/**
 * The plugin's `bin/`: Claude Code appends it to the END of its Bash tool's
 * PATH, so this `tenjin` answers there when nothing earlier is named `tenjin`.
 * `activate` writes these at 0o755: Claude Code never sets the exec bit, and
 * skips a file without it.
 */
export function renderPluginBin(launch: RuntimeLaunch): Record<string, string> {
  const files: Record<string, string> = { 'bin/tenjin': renderLauncherSh(launch) };
  if ((launch.platform ?? process.platform) === 'win32') {
    if (launch.home === undefined) throw new Error('the .cmd launcher needs the home folder');
    files['bin/tenjin.cmd'] = renderLauncherCmd({ ...launch, home: launch.home });
  }
  return files;
}
