import { PRODUCTION_ORIGIN } from '../lib/production-origin';
import { HOOK_TOOL, hookToolInput, type HookKind } from './hook-tool';
import {
  MARKETPLACE_NAME,
  MCP_SERVER_NAME,
  PLUGIN_HOOK_TOOL,
  PLUGIN_NAME,
  PLUGIN_SERVER,
  REQUEST_TOOL,
} from './names';

/**
 * THE CLAUDE CODE PLUGIN, AS FILES. `tenjin install` registers it with Claude
 * Code's own `claude plugin` commands from the package's `dist/hosts/claude`
 * folder, which the build renders from this module, and writes the same plugin
 * folder under the config dir's `skills/` when there is no `claude` binary to
 * run. The checked-in `hosts/claude/` templates are pinned to this render by a
 * test, so the two cannot drift.
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
 * EVERY COMMAND RUNS `node` IN EXEC FORM, with no shell (see `hook-form.ts`).
 * The shipped plugin loads in place from the package's `dist/hosts/claude/tenjin`,
 * so the bundle's entry is three folders above `${CLAUDE_PLUGIN_ROOT}`, which
 * Claude Code substitutes into each argument, and the checked-in template
 * stays static. The folder fallback lives under the config dir instead, and
 * `install` renders it with the absolute entry of the CLI that wrote it.
 */
export const PLUGIN_ROOT_ENTRY = '${CLAUDE_PLUGIN_ROOT}/../../../index.js';

/** A process Claude Code spawns directly: a hook's `command` and `args`, or a stdio server's. */
export interface ExecLaunch {
  command: string;
  args: string[];
}

/** The CLI run by `node` from its entry script, never through the `tenjin` shim. */
export function cliLaunch(args: readonly string[], entry: string = PLUGIN_ROOT_ENTRY): ExecLaunch {
  return { command: 'node', args: [entry, ...args] };
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

function printed(answer: string): ExecLaunch {
  return { command: 'node', args: ['-e', PRINT_ARGUMENT, answer] };
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
export const DENY_HOOK = printed(
  permissionAnswer(
    'deny',
    `Only the Tenjin hooks call this tool. To make a lookup, call ${REQUEST_TOOL}.`,
  ),
);

/**
 * THE REQUEST TOOL IS ALLOWED BY THE PLUGIN ITSELF, replacing the settings
 * install's `permissions.allow` rule, so an install needs no rule the user
 * adds. A hook's allow never overrides the user's own `deny` or `ask` rule for
 * the tool. The tool still pays only within the local spend policy, and an
 * amount over it returns `needs_approval` with nothing paid.
 */
export const ALLOW_HOOK = printed(permissionAnswer('allow', 'Tenjin lookup'));

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
 * permission answers, and the mod's module when the folder carries it.
 */
export function renderPluginHooks(
  entry: string = PLUGIN_ROOT_ENTRY,
  withMod = false,
): {
  hooks: Record<string, unknown[]>;
  modules?: string[];
} {
  const plan = [
    { event: 'SessionStart', hooks: command(cliLaunch(ALIVE_ARGS, entry)) },
    ...routerHookPlan(),
    { event: 'PreToolUse', matcher: PLUGIN_HOOK_TOOL, hooks: command(DENY_HOOK) },
    { event: 'PreToolUse', matcher: REQUEST_TOOL, hooks: command(ALLOW_HOOK) },
  ];
  const hooks: Record<string, unknown[]> = {};
  for (const { event, hooks: handlers, ...rest } of plan) {
    (hooks[event] ??= []).push({ ...rest, hooks: handlers });
  }
  return { hooks, ...(withMod ? { modules: [MOD_MODULE] } : {}) };
}

/**
 * `.mcp.json`: the server Claude Code starts for the plugin, the CLI's entry
 * run by `node`, which Windows can spawn where it cannot spawn the shim.
 *
 * `--plugin` KEEPS IT FROM BEING SUPPRESSED. Claude Code drops a plugin's MCP
 * server whose command and arguments match a server the user configured, and
 * a settings install's `x402` entry runs `tenjin mcp`; with the same command
 * the plugin's `router` server would not start while the two coexist, its legs
 * would fail, and the old ones stay silent (checked on Claude Code 2.1.296).
 */
export const PLUGIN_MCP_ARGS = ['mcp', '--plugin'] as const;

export function renderPluginMcp(entry: string = PLUGIN_ROOT_ENTRY): {
  mcpServers: Record<string, unknown>;
} {
  return { mcpServers: { [MCP_SERVER_NAME]: cliLaunch(PLUGIN_MCP_ARGS, entry) } };
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
export function renderPluginManifest(version?: string, withMod = false): Record<string, unknown> {
  return {
    name: PLUGIN_NAME,
    ...(version !== undefined ? { version } : {}),
    description: DESCRIPTION,
    // The mod's `$.state` contract, which `claude plugin validate` checks.
    ...(withMod ? { types: `./${MOD_TYPES}` } : {}),
    author: { name: 'Tenjin', url: PRODUCTION_ORIGIN },
    homepage: `${PRODUCTION_ORIGIN}/agents`,
    repository: 'https://github.com/BackTrackCo/tenjin-agent',
    metadata: { [OWNER_MARKER]: version ?? UNBUILT },
  };
}

/** The plugin's folder inside the marketplace folder. */
export const PLUGIN_DIR = PLUGIN_NAME;

/** `.claude-plugin/marketplace.json`: one plugin, read in place from the package. */
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
 * outside the package. Without the mod's sources the folder carries the legs
 * and the server alone, and its hooks file names no module.
 */
export function renderPluginFiles(
  version?: string,
  entry?: string,
  mod?: ModSources,
): Record<string, string> {
  const withMod = mod !== undefined;
  return {
    '.mcp.json': json(renderPluginMcp(entry)),
    ...(mod ?? {}),
    'hooks/hooks.json': json(renderPluginHooks(entry, withMod)),
    '.claude-plugin/plugin.json': json(renderPluginManifest(version, withMod)),
  };
}

/** The marketplace folder's files: its catalog and the plugin under {@link PLUGIN_DIR}. */
export function renderHostFiles(version?: string, mod?: ModSources): Record<string, string> {
  const plugin = Object.entries(renderPluginFiles(version, undefined, mod)).map(
    ([path, body]) => [`${PLUGIN_DIR}/${path}`, body] as const,
  );
  return {
    '.claude-plugin/marketplace.json': json(renderMarketplace(version)),
    ...Object.fromEntries(plugin),
  };
}
