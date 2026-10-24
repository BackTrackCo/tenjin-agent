import { PAY_SKILL, PAY_SKILL_PATH } from './plugin-skill';
import { PRODUCTION_ORIGIN } from '../lib/production-origin';
import {
  CODEX_HOOK_KINDS,
  codexHookToolInput,
  HOOK_TOOL,
  hookToolInput,
  type CodexHookKind,
  type HookKind,
} from './hook-tool';
import {
  CODEX_HOOK_TOOL,
  CODEX_REQUEST_TOOL,
  MARKETPLACE_NAME,
  MCP_SERVER_NAME,
  PLUGIN_HOOK_TOOL,
  PLUGIN_NAME,
  PLUGIN_SERVER,
  REQUEST_TOOL,
} from './names';

/**
 * THE CLAUDE CODE PLUGIN, AS FILES, in two renders. `tenjin install` registers
 * it with Claude Code's own `claude plugin` commands from Tenjin's runtime,
 * `~/.tenjin/runtime/claude`, which `activate` renders with the runtime's
 * absolute Node and entry (the runtime render). Where there is no runtime (a
 * non-default data dir, an unsupported platform, a runtime that could not be
 * set up) it registers the package's `dist/hosts/claude` instead, which the
 * build renders from this module with `node` from PATH (the package render),
 * and writes the same plugin folder under the config dir's `skills/` when there
 * is no `claude` binary to run. The checked-in `hosts/claude/` templates are
 * pinned to the package render by a test, so the two cannot drift.
 *
 * NOTHING HERE IMPORTS MORE THAN THE NAMES AND THE PRODUCTION ORIGIN:
 * `tsup.config.ts` loads this module to render the shipped files, and its
 * import graph is the build's.
 */

/**
 * The harness's kill budget for each routing leg: a stuck server never holds a
 * prompt longer than this. Every wait inside the leg is cut from it: the gate's
 * 3.5 s, which holds the paid path's 402, the reads before a deposit and the
 * paid request, with 500 ms left for the transcript read and the reply
 * (`wire.test.ts` pins the sum). A whole leg whose call carried a deposit took
 * 2.8 to 3.3 s on Base Sepolia, so it fits; a slower one (a wallet unlock, a
 * slow settlement) loses only that prompt's hint, and the SDK recovers the
 * channel on the next call.
 */
export const ROUTE_HOOK_TIMEOUT_SECONDS = 5;
/**
 * The after-call entries' kill budget, longer than the rest for the one wait
 * a leg makes: a search the pre-call leg is fetching free docs for waits up to
 * `AUGMENT_WAIT_MS` (9 s) for them, and when none came back and the search was
 * short, the gate's 3.5 s follow, with startup to spare (`wire.test.ts` pins
 * the sum). Every other after-call event returns as fast as before, so the
 * number is a ceiling, not a cost.
 */
export const AFTER_CALL_TIMEOUT_SECONDS = 15;
/** The `alive` leg and the two permission answers do no network work. */
export const LOCAL_HOOK_TIMEOUT_SECONDS = 5;

/** The subagent tool, under its current name and its older one. */
export const DELEGATION_MATCHER = 'Agent|Task';
/** The native tools both native arms watch. */
export const NATIVE_MATCHER = 'WebSearch|WebFetch';
/** The host's question to the user, watched before it is asked and after. */
export const ASK_MATCHER = 'AskUserQuestion';

/**
 * EVERY COMMAND RUNS NODE IN EXEC FORM, with no shell (see `hook-form.ts`).
 * The package render loads in place from the package's `dist/hosts/claude/tenjin`,
 * so the bundle's entry is three folders above `${CLAUDE_PLUGIN_ROOT}`, which
 * Claude Code substitutes into each argument, and the checked-in template
 * stays static; its `node` is whichever one is on Claude Code's PATH. The
 * runtime render names an absolute Node and entry instead, so neither a Node
 * upgrade nor `npm rm -g` can take them away. The folder fallback lives under
 * the config dir, and `install` renders it with the absolute entry of the CLI
 * that wrote it.
 */
export const PLUGIN_ROOT_ENTRY = '${CLAUDE_PLUGIN_ROOT}/../../../index.js';

/** A process Claude Code spawns directly: a hook's `command` and `args`, or a stdio server's. */
export interface ExecLaunch {
  command: string;
  args: string[];
}

/**
 * HOW A PLUGIN RENDER DEPARTS FROM THE PACKAGE RENDER, one optional field
 * each, passed as the last argument of every render that takes it: a render
 * that sets none is byte for byte what the build ships.
 */
export interface RenderOptions {
  /** The Node every command runs: the runtime's absolute Node, or `node` from PATH when unset. */
  node?: string;
  /**
   * The mod's sources, as written: the folder then carries them, its hooks
   * file names the module and its manifest the types. Unset, it carries none.
   */
  mod?: ModSources;
}

/**
 * The CLI run by Node from its entry script, never through the `tenjin` shim:
 * `node` from PATH, or the runtime's absolute Node.
 */
export function cliLaunch(
  args: readonly string[],
  entry: string = PLUGIN_ROOT_ENTRY,
  o: RenderOptions = {},
): ExecLaunch {
  return { command: o.node ?? 'node', args: [entry, ...args] };
}

/**
 * The `alive` leg: the plugin's `SessionStart` entry, so it runs before any
 * other event of a session. It marks the session as one the plugin serves, so
 * a settings-install leg in the same session stays silent, and stamps the
 * machine as one the plugin has loaded on, which the migration waits for. A
 * command, not an `mcp_tool` call: a session's MCP servers may still be
 * connecting when `SessionStart` fires, and a command needs nothing running.
 */
export const ALIVE_ARGS = ['hook', 'alive'] as const;

/** A PreToolUse answer, as a hook command's stdout carries it. */
function permissionAnswer(decision: 'allow' | 'deny', reason: string): string {
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: decision,
      permissionDecisionReason: reason,
    },
  });
}

/** A fixed answer `node -e` prints from its own argument: no shell, no CLI, no quoting. */
export const PRINT_ARGUMENT = 'process.stdout.write(process.argv[1])';

function printed(answer: string, node: string): ExecLaunch {
  return { command: node, args: ['-e', PRINT_ARGUMENT, answer] };
}

/**
 * THE HOOK LEGS' TOOL IS DENIED TO THE MODEL. Its event fields are plain
 * arguments, so the model calling it could forge a routing leg. This blocking
 * hook replaces the settings install's `permissions.deny` rule: a plugin cannot
 * carry permission rules, and a blocking hook takes precedence over allow rules
 * in every mode, bypass included, while Claude Code's own `mcp_tool` hook calls
 * still run (lab, Claude Code 2.1.296). The tool stays in the model's list. The
 * tool's transcript check (`admitHookEvent`) stays for a machine with hooks off.
 */
export function denyHook(o: RenderOptions = {}): ExecLaunch {
  return printed(
    permissionAnswer(
      'deny',
      `Only the Tenjin hooks call this tool. To make a lookup, call ${REQUEST_TOOL}.`,
    ),
    o.node ?? 'node',
  );
}
export const DENY_HOOK = denyHook();

/**
 * THE REQUEST TOOL IS ALLOWED BY THE PLUGIN ITSELF, replacing the settings
 * install's `permissions.allow` rule, so an install needs no rule the user
 * adds. A hook's allow never overrides the user's own `deny` or `ask` rule for
 * the tool. The tool still pays only within the local spend policy, and an
 * amount over it returns `needs_approval` with nothing paid.
 */
export function allowHook(o: RenderOptions = {}): ExecLaunch {
  return printed(permissionAnswer('allow', 'Tenjin lookup'), o.node ?? 'node');
}
export const ALLOW_HOOK = allowHook();

/** One routing leg: Claude Code calls the plugin server's `hook` tool. */
function leg(kind: HookKind, timeout = ROUTE_HOOK_TIMEOUT_SECONDS): unknown[] {
  return [
    {
      type: 'mcp_tool',
      server: PLUGIN_SERVER,
      tool: HOOK_TOOL,
      input: hookToolInput(kind),
      timeout,
    },
  ];
}

function command(launch: ExecLaunch): unknown[] {
  return [{ type: 'command', ...launch, timeout: LOCAL_HOOK_TIMEOUT_SECONDS }];
}

/**
 * The seven routing legs. The native tools are routed twice over one lookup:
 * BEFORE the call, with a line pointing to a paid lookup when one fits; and
 * AFTER it, only when it came back short and nothing was said before, or to
 * add the free docs the pre-call arm fetched to a search's results. A failed
 * call fires PostToolUseFailure rather than PostToolUse, so the second takes
 * both. The host's question to the user is routed the same two ways: before it
 * is asked, when a service could stand in for what it asks for, and after,
 * with the user's answers read as their own words.
 */
export function routerHookPlan(): { event: string; matcher?: string; hooks: unknown[] }[] {
  const afterCall = () => leg('shortfall', AFTER_CALL_TIMEOUT_SECONDS);
  return [
    { event: 'UserPromptSubmit', hooks: leg('prompt') },
    { event: 'PreToolUse', matcher: NATIVE_MATCHER, hooks: leg('native') },
    { event: 'PreToolUse', matcher: DELEGATION_MATCHER, hooks: leg('agent') },
    { event: 'PostToolUse', matcher: NATIVE_MATCHER, hooks: afterCall() },
    { event: 'PostToolUseFailure', matcher: NATIVE_MATCHER, hooks: afterCall() },
    { event: 'PreToolUse', matcher: ASK_MATCHER, hooks: leg('ask') },
    { event: 'PostToolUse', matcher: ASK_MATCHER, hooks: leg('answer') },
  ];
}

/** The mod's module, as `hooks/hooks.json` names it (relative to that file). */
export const MOD_MODULE = './register.tsx';

/**
 * `hooks/hooks.json`: the `alive` leg, the seven routing legs and the two
 * permission answers, and the mod's module when `o.mod` carries it. `o.node`
 * runs all three commands, the answers included, so the runtime render names
 * no `node` from PATH at all.
 */
export function renderPluginHooks(
  entry: string = PLUGIN_ROOT_ENTRY,
  o: RenderOptions = {},
): {
  hooks: Record<string, unknown[]>;
  modules?: string[];
} {
  const plan = [
    { event: 'SessionStart', hooks: command(cliLaunch(ALIVE_ARGS, entry, o)) },
    ...routerHookPlan(),
    { event: 'PreToolUse', matcher: PLUGIN_HOOK_TOOL, hooks: command(denyHook(o)) },
    { event: 'PreToolUse', matcher: REQUEST_TOOL, hooks: command(allowHook(o)) },
  ];
  const hooks: Record<string, unknown[]> = {};
  for (const { event, hooks: handlers, ...rest } of plan) {
    (hooks[event] ??= []).push({ ...rest, hooks: handlers });
  }
  return { hooks, ...(o.mod !== undefined ? { modules: [MOD_MODULE] } : {}) };
}

/**
 * `.mcp.json`: the server Claude Code starts for the plugin, the CLI's entry
 * run by Node (`node` from PATH, or the runtime's absolute `node.exe` on
 * Windows), which Windows can spawn where it cannot spawn the shim.
 *
 * `--plugin` KEEPS IT FROM BEING SUPPRESSED. Claude Code drops a plugin's MCP
 * server whose command and arguments match a server the user configured, and
 * a settings install's `x402` entry runs `tenjin mcp`; with the same command
 * the plugin's `router` server would not start while the two coexist, its legs
 * would fail, and the old ones stay silent (checked on Claude Code 2.1.296).
 */
export const PLUGIN_MCP_ARGS = ['mcp', '--plugin'] as const;

export function renderPluginMcp(
  entry: string = PLUGIN_ROOT_ENTRY,
  o: RenderOptions = {},
): {
  mcpServers: Record<string, unknown>;
} {
  return { mcpServers: { [MCP_SERVER_NAME]: cliLaunch(PLUGIN_MCP_ARGS, entry, o) } };
}

/** The key whose presence marks a plugin manifest as one this CLI wrote. */
export const OWNER_MARKER = 'tenjin-cli';
/** The marker's value in the checked-in templates, which carry no version. */
const UNBUILT = 'source';

const DESCRIPTION =
  'Tenjin picks the right tool when your agent needs one, and one wallet on this machine pays for every call.';

/**
 * `.claude-plugin/plugin.json`. The version is the CLI's, stamped at build time,
 * so Claude Code's plugin list names the build that runs; the checked-in
 * template carries none. `metadata[tenjin-cli]` is the ownership marker the
 * folder fallback, `update` and `uninstall` check before they touch a folder.
 */
export function renderPluginManifest(
  version?: string,
  o: RenderOptions = {},
): Record<string, unknown> {
  return {
    name: PLUGIN_NAME,
    ...(version !== undefined ? { version } : {}),
    description: DESCRIPTION,
    // The mod's `$.state` contract, which `claude plugin validate` checks.
    ...(o.mod !== undefined ? { types: `./${MOD_TYPES}` } : {}),
    author: { name: 'Tenjin', url: PRODUCTION_ORIGIN },
    homepage: `${PRODUCTION_ORIGIN}/agents`,
    repository: 'https://github.com/BackTrackCo/tenjin-agent',
    metadata: { [OWNER_MARKER]: version ?? UNBUILT },
  };
}

/** The plugin's folder inside the marketplace folder. */
export const PLUGIN_DIR = PLUGIN_NAME;

/** `.claude-plugin/marketplace.json`: one plugin, read in place from the runtime or the package. */
export function renderMarketplace(version?: string): Record<string, unknown> {
  return {
    name: MARKETPLACE_NAME,
    owner: { name: 'Tenjin', url: PRODUCTION_ORIGIN },
    description: "Tenjin's tool router for Claude Code, installed by `tenjin install`.",
    ...(version !== undefined ? { metadata: { version } } : {}),
    plugins: [
      {
        name: PLUGIN_NAME,
        source: `./${PLUGIN_DIR}`,
        description: DESCRIPTION,
        ...(version !== undefined ? { version } : {}),
      },
    ],
  };
}

/**
 * EVERY FILE THE PLUGIN FOLDER HOLDS, relative to the plugin's root, and the
 * only paths install, update and uninstall ever write or unlink in a folder.
 * The manifest is last: a crash mid-write never leaves a manifest pointing at
 * parts that are not there yet.
 */
export const PLUGIN_FILES = [
  '.mcp.json',
  'types/index.d.ts',
  'hooks/register.tsx',
  'hooks/hooks.json',
  PAY_SKILL_PATH,
  '.claude-plugin/plugin.json',
] as const;

/** The mod's `$.state` contract, shipped as written. */
export const MOD_TYPES = 'types/index.d.ts';
/**
 * THE MOD SHIPS AS WRITTEN, NOT RENDERED: `hosts/claude/tenjin/` holds its
 * source, the build copies it into `dist/hosts/claude/tenjin/`, and the folder
 * fallback copies it from there. Claude Code compiles it at load (2.1.287 or
 * later); nothing here builds or imports it.
 */
export const MOD_FILES = [MOD_TYPES, 'hooks/register.tsx'] as const;
export type ModSources = Record<(typeof MOD_FILES)[number], string>;

const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

/**
 * The plugin folder's files, by {@link PLUGIN_FILES} path. `entry` is the CLI
 * entry the commands run, {@link PLUGIN_ROOT_ENTRY} unless the folder lives
 * outside the package, `o.node` the Node that runs them (`node` from PATH
 * unless this is the runtime render), and `o.mod` the mod's sources. Without
 * them the folder carries the legs and the server alone, and its hooks file
 * names no module.
 */
export function renderPluginFiles(
  version?: string,
  entry?: string,
  o: RenderOptions = {},
): Record<string, string> {
  return {
    '.mcp.json': json(renderPluginMcp(entry, o)),
    ...(o.mod ?? {}),
    'hooks/hooks.json': json(renderPluginHooks(entry, o)),
    [PAY_SKILL_PATH]: PAY_SKILL,
    '.claude-plugin/plugin.json': json(renderPluginManifest(version, o)),
  };
}

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

/** How a marketplace folder render departs from the package render; see {@link RenderOptions}. */
export interface HostRenderOptions {
  /** The runtime render's Node and entry; it also adds the plugin's `bin/` launchers. */
  launch?: RuntimeLaunch;
  /** The mod's sources, as {@link RenderOptions.mod}. */
  mod?: ModSources;
}

/**
 * The marketplace folder's files: its catalog and the plugin under
 * {@link PLUGIN_DIR}. With no `o.launch`, the package render, byte for byte
 * what the build ships when `o.mod` is the mod as written; with one, the
 * runtime render, which runs `launch.node` and `launch.entry`, carries the
 * plugin's `bin/` launchers, and carries the mod when `o.mod` does.
 */
export function renderHostFiles(
  version?: string,
  o: HostRenderOptions = {},
): Record<string, string> {
  const { launch, mod } = o;
  const files =
    launch === undefined
      ? renderPluginFiles(version, undefined, { mod })
      : {
          ...renderPluginFiles(version, launch.entry, { node: launch.node, mod }),
          ...renderPluginBin(launch),
        };
  const plugin = Object.entries(files).map(
    ([path, body]) => [`${PLUGIN_DIR}/${path}`, body] as const,
  );
  return {
    '.claude-plugin/marketplace.json': json(renderMarketplace(version)),
    ...Object.fromEntries(plugin),
  };
}

/**
 * The line every launcher carries. A file at a launcher's path without it is
 * not Tenjin's, and is never overwritten or removed.
 */
export const LAUNCHER_MARKER = 'tenjin-runtime-launcher';
/** The one fix for a missing runtime: npx installs from its own cache, not the broken launcher. */
export const RUNTIME_MISSING_FIX = 'npx -y tenjin-cli@latest install';

const missingSentence = (entry: string): string =>
  `tenjin: Tenjin's runtime is missing (${entry}). Reinstall it with \`${RUNTIME_MISSING_FIX}\`, then start a new Claude Code session.`;

/** A single-quoted sh word: everything literal, a `'` closed, escaped and reopened. */
const shQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

/**
 * THE `tenjin` LAUNCHER, as sh, for `~/.local/bin` and the plugin's `bin/`.
 * It bakes the absolute Node and entry, so it reads no state and the atomic
 * rename of the file is the switch. When either is gone it says how to put the
 * runtime back instead of failing with a bare `not found`. On win32 it is for
 * Git Bash, so the paths are written with forward slashes.
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
 * THE `tenjin.cmd` LAUNCHER, for a Windows terminal and the Codex runtime
 * render's commands (never a Claude Code plugin command). Both paths are
 * `%USERPROFILE%` plus their part under the home folder, which is ASCII by
 * construction, so a non-ASCII user name never has to survive cmd's code page. It throws when a path is outside `home`, or its part
 * holds a non-ASCII character, `"` or `%`, which cmd would read. The run line is
 * one parenthesized block, so cmd parses it whole before Node starts and a
 * rewrite of the file mid-run cannot inject a stray line.
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

/**
 * THE CODEX PLUGIN, AS FILES, shipped in `dist/hosts/codex` and pinned to the
 * checked-in `hosts/codex/` by the same test. Its legs are `mcp_tool` hooks
 * into the plugin's own `router` server, as Claude Code's are, so each leg
 * runs in the process that holds the wallet and pays the routing fee: the
 * prompt, and one web call before it runs and after (Codex has no
 * PostToolUseFailure). Codex runs `mcp_tool` hooks from 0.149.0: 0.148 parses
 * them but skips them, and an older Codex rejects the file, so install and
 * update leave an older Codex's copy as it is and doctor names the build.
 * The server's `env_vars` passes `CODEX_HOME` through Codex's cleared MCP
 * environment, so the hook tool finds the session's rollout where Codex
 * wrote it.
 * Nothing in it names a release or a path, so `codex plugin add` copies the
 * same hooks from every build and their trust holds across a `tenjin update`.
 * The runtime render, `~/.tenjin/runtime/codex`, differs only in `.mcp.json`:
 * Codex starts the server through the `tenjin` launcher in its own `bin/` by
 * absolute path, which never changes, and `activate` rewrites only the
 * launcher on each switch.
 */
export const CODEX_WEB_MATCHER = 'webrun';
export const CODEX_LEGS = CODEX_HOOK_KINDS;
/**
 * The first Codex that runs `mcp_tool` hooks: rust-v0.149.0 adds
 * `core/src/hook_mcp_executor.rs`; rust-v0.148.0 builds hooks with no MCP
 * executor and skips each one (`hooks/src/engine/mod.rs`).
 */
export const CODEX_MCP_HOOKS_VERSION = '0.149.0';

/** What the Codex runtime render runs: the launch its launchers bake, and the absolute folder they are in. */
export interface CodexRuntime {
  launch: RuntimeLaunch;
  /** `<runtime>/codex/tenjin/bin`. */
  binDir: string;
}

const onWindows = (o: CodexRuntime): boolean => (o.launch.platform ?? process.platform) === 'win32';

/** The sh launcher's absolute path. */
const codexLauncherSh = (o: CodexRuntime): string => `${o.binDir}/tenjin`;

/** The `.cmd` launcher's absolute path, for a process Codex spawns directly. */
const codexLauncherCmd = (o: CodexRuntime): string => `${o.binDir}\\tenjin.cmd`;

/** The command form of a leg: what a plugin copy from an older build still runs. */
export function codexHookCommand(kind: CodexHookKind): string {
  return `tenjin hook ${kind} --harness codex`;
}

/** One Codex routing leg: Codex calls the plugin server's `hook` tool. */
function codexLeg(kind: CodexHookKind, timeout = ROUTE_HOOK_TIMEOUT_SECONDS) {
  return [
    {
      type: 'mcp_tool',
      server: MCP_SERVER_NAME,
      tool: HOOK_TOOL,
      input: codexHookToolInput(kind),
      timeout,
    },
  ];
}

/** A fixed hook answer, echoed: `cmd.exe` takes the bare form, a POSIX shell the quoted one. */
function echoed(answer: string): { command: string; commandWindows: string } {
  return { command: `echo '${answer}'`, commandWindows: `echo ${answer}` };
}

/**
 * THE HOOK LEGS' TOOL IS DENIED TO THE MODEL, as {@link DENY_HOOK} is in
 * Claude Code: a model call to it fires PreToolUse as `mcp__router__hook`,
 * while Codex's own `mcp_tool` hook calls go straight to the server and fire
 * no PreToolUse (openai/codex `core/src/hook_mcp_executor.rs`).
 */
export const CODEX_DENY_HOOK = echoed(
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: `Only the Tenjin hooks call this tool. To make a lookup, call ${CODEX_REQUEST_TOOL}.`,
    },
  }),
);

/**
 * THE REQUEST TOOL IS ALLOWED BY THE PLUGIN ITSELF, as {@link ALLOW_HOOK_COMMAND}
 * is in Claude Code. Codex runs a `PermissionRequest` hook before its approval
 * policy, `never` included, so the tool runs without a prompt once the user
 * trusts this hook with the others in `/hooks`. It also overrides a user's own
 * `approval_mode = "prompt"` for the tool; that user turns this one hook off in
 * `/hooks`. The wallet's spend limits still bound every payment.
 */
const CODEX_ALLOW_ANSWER = JSON.stringify({
  hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } },
});
export const CODEX_ALLOW_HOOK_COMMAND = `echo '${CODEX_ALLOW_ANSWER}'`;
/**
 * The same answer under Windows' `cmd.exe /C`, through Codex's `commandWindows`
 * override: cmd's `echo` prints single quotes as written, and Codex then
 * rejects the output as JSON. The answer holds none of cmd's special
 * characters, so a bare `echo` prints it as is.
 */
export const CODEX_ALLOW_HOOK_COMMAND_WINDOWS = `echo ${CODEX_ALLOW_ANSWER}`;

/** Every hook the Codex plugin carries: the three legs, the deny and the allow answer. */
export const CODEX_HOOK_COUNT = CODEX_LEGS.length + 2;

/** `hooks/hooks.json`: the same for the package and the runtime render. */
export function renderCodexHooks(): { hooks: Record<string, unknown[]> } {
  return {
    hooks: {
      UserPromptSubmit: [{ hooks: codexLeg('prompt') }],
      PreToolUse: [
        { matcher: CODEX_WEB_MATCHER, hooks: codexLeg('native') },
        {
          matcher: CODEX_HOOK_TOOL,
          hooks: [{ type: 'command', ...CODEX_DENY_HOOK, timeout: LOCAL_HOOK_TIMEOUT_SECONDS }],
        },
      ],
      PostToolUse: [
        {
          matcher: CODEX_WEB_MATCHER,
          hooks: codexLeg('shortfall', AFTER_CALL_TIMEOUT_SECONDS),
        },
      ],
      PermissionRequest: [
        {
          matcher: CODEX_REQUEST_TOOL,
          hooks: [
            {
              type: 'command',
              command: CODEX_ALLOW_HOOK_COMMAND,
              commandWindows: CODEX_ALLOW_HOOK_COMMAND_WINDOWS,
              timeout: LOCAL_HOOK_TIMEOUT_SECONDS,
            },
          ],
        },
      ],
    },
  };
}

export const CODEX_MCP_ARGS = ['mcp', '--harness', 'codex'] as const;

/**
 * `.mcp.json`. Codex spawns the server directly, with no shell: the runtime
 * render names the sh launcher, or on win32 the `.cmd` one, which Codex starts
 * through cmd.exe.
 */
export function renderCodexMcp(o?: CodexRuntime): { mcpServers: Record<string, unknown> } {
  const command =
    o === undefined ? 'tenjin' : onWindows(o) ? codexLauncherCmd(o) : codexLauncherSh(o);
  return {
    mcpServers: {
      [MCP_SERVER_NAME]: { command, args: [...CODEX_MCP_ARGS], env_vars: ['CODEX_HOME'] },
    },
  };
}

/** `.codex-plugin/plugin.json`. No version: see {@link renderCodexHostFiles}. */
export function renderCodexManifest(): Record<string, unknown> {
  return {
    name: PLUGIN_NAME,
    description: DESCRIPTION,
    author: { name: 'Tenjin', url: PRODUCTION_ORIGIN },
    homepage: `${PRODUCTION_ORIGIN}/agents`,
    repository: 'https://github.com/BackTrackCo/tenjin-agent',
    interface: { displayName: 'Tenjin', developerName: 'Tenjin', category: 'Productivity' },
    mcpServers: './.mcp.json',
  };
}

/** `.agents/plugins/marketplace.json`: one local plugin, copied by `codex plugin add`. */
export function renderCodexMarketplace(): Record<string, unknown> {
  return {
    name: MARKETPLACE_NAME,
    interface: { displayName: 'Tenjin' },
    plugins: [
      {
        name: PLUGIN_NAME,
        source: { source: 'local', path: `./${PLUGIN_DIR}` },
        policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
        category: 'Productivity',
      },
    ],
  };
}

/**
 * The Codex marketplace folder's files: its catalog and the plugin under
 * {@link PLUGIN_DIR}. With no `o`, the package render; with one, the runtime
 * render, whose commands run the launchers it carries in `bin/`.
 */
export function renderCodexHostFiles(o?: CodexRuntime): Record<string, string> {
  const bin = o === undefined ? {} : renderPluginBin(o.launch);
  return {
    '.agents/plugins/marketplace.json': json(renderCodexMarketplace()),
    [`${PLUGIN_DIR}/.mcp.json`]: json(renderCodexMcp(o)),
    ...Object.fromEntries(
      Object.entries(bin).map(([path, body]) => [`${PLUGIN_DIR}/${path}`, body] as const),
    ),
    [`${PLUGIN_DIR}/hooks/hooks.json`]: json(renderCodexHooks()),
    [`${PLUGIN_DIR}/.codex-plugin/plugin.json`]: json(renderCodexManifest()),
  };
}
