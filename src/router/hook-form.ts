/**
 * HOW CLAUDE CODE RUNS A COMMAND. With `args` (exec form) it spawns `command`
 * (from PATH unless it is a path) with no shell, and on Windows that needs a
 * real executable, never the `tenjin` `.cmd` shim. Without `args` (shell form)
 * it goes to `sh -c`, Git Bash or PowerShell, where bash syntax fails. Tenjin
 * writes exec form only.
 */

export type HookForm = 'exec' | 'shell';

/** The npm shim's names, which only a shell can start on Windows. */
const TENJIN_SHIM = /(^|[\\/])tenjin(\.cmd|\.bat|\.ps1)?$/i;
/** Characters a shell would read, which exec form passes through as written. */
const SHELL_SYNTAX = /[\s"'`$|&;<>()]/;
/**
 * A command naming a path is one executable, spaces and parentheses included
 * (`C:\Program Files (x86)\nodejs\node.exe`); only a bare name with spaces
 * means tokens meant for a shell.
 */
const PATH_SEPARATOR = /[\\/]/;
const PATH_SHELL_SYNTAX = /["'`$|&;<>]/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The form a `command` handler runs in, or null for any other handler type. */
export function commandForm(handler: unknown): HookForm | null {
  if (!isPlainObject(handler) || handler.type !== 'command') return null;
  return Array.isArray(handler.args) ? 'exec' : 'shell';
}

/** A command handler's argv: exec form as written, shell form split on whitespace. */
export function commandArgv(handler: unknown): string[] | null {
  if (!isPlainObject(handler) || typeof handler.command !== 'string') return null;
  if (Array.isArray(handler.args)) {
    return [handler.command, ...handler.args.filter((a): a is string => typeof a === 'string')];
  }
  return handler.command.trim().split(/\s+/);
}

/** Every handler in a hooks file (`{ hooks: { <Event>: [{ hooks: [...] }] } }`). */
export function handlersIn(file: unknown): unknown[] {
  const events = isPlainObject(file) ? file.hooks : undefined;
  if (!isPlainObject(events)) return [];
  return Object.values(events).flatMap((groups) =>
    Array.isArray(groups)
      ? groups.flatMap((g) => (isPlainObject(g) && Array.isArray(g.hooks) ? g.hooks : []))
      : [],
  );
}

/** Why a command handler or stdio server entry needs a shell, or null when it needs none. */
export function shellDependence(launch: unknown): string | null {
  if (!isPlainObject(launch)) return 'not an object';
  const { command, args } = launch;
  if (typeof command !== 'string' || command.length === 0) return 'no command';
  if (!Array.isArray(args)) return `\`${command}\` has no args array, so a shell runs it`;
  if (args.some((a) => typeof a !== 'string')) return `\`${command}\` has a non-string argument`;
  const syntax = PATH_SEPARATOR.test(command) ? PATH_SHELL_SYNTAX : SHELL_SYNTAX;
  if (syntax.test(command)) return `\`${command}\` holds shell syntax`;
  if (TENJIN_SHIM.test(command)) {
    return `\`${command}\` is the npm shim, which Windows cannot spawn without a shell`;
  }
  return null;
}
