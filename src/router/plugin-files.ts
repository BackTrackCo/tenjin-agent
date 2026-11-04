import { PAY_SKILL, PAY_SKILL_PATH } from './plugin-skill';
import { PRODUCTION_ORIGIN } from '../lib/production-origin';
import { HOOK_TOOL, hookToolInput, type HookKind } from './hook-tool';
import { renderPluginBin, type RuntimeLaunch } from './launcher-files';
import {
  MARKETPLACE_NAME,
  MCP_SERVER_NAME,
  PLUGIN_HOOK_TOOL,
  PLUGIN_NAME,
  PLUGIN_SERVER,
  REQUEST_TOOL,
} from './names';

/**
 * The Claude Code plugin as files, in two renders. The runtime render lives in
 * `~/.tenjin/runtime/claude`, which `activate` renders with the runtime's
 * absolute Node and entry, and `tenjin install` registers with `claude plugin`.
 * The package render is the build's `dist/hosts/claude`, with `node` from PATH,
 * for source development. With no `claude` binary, install writes the runtime
 * render under the config dir's `skills/`. A test pins the checked-in
 * `hosts/claude/` templates to the package render.
 *
 * Imports stay limited to the names, the launchers and the production origin:
 * `tsup.config.ts` loads this module and `codex-plugin-files.ts`, so their
 * import graph is the build's.
 */

/**
 * The harness's kill budget for each routing leg, so a stuck server never holds
 * a prompt longer. `gate.ts` splits it and `wire.test.ts` pins the sum. A
 * slower leg (a wallet unlock, a slow settlement) loses only that prompt's
 * hint, and the SDK recovers the channel on the next call.
 */
export const ROUTE_HOOK_TIMEOUT_SECONDS = 5;
/**
 * The after-call entries' kill budget: a ceiling, not a cost, that covers one
 * paid decision with a deposit (`wire.test.ts` pins it). Lowering it would
 * rewrite both hosts' hook entries and make Codex re-trust them for nothing.
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
 * Every command runs Node in exec form, with no shell (see `hook-form.ts`). The
 * package render loads in place from `dist/hosts/claude/tenjin`, so the entry
 * is three folders above `${CLAUDE_PLUGIN_ROOT}`, which Claude Code substitutes
 * into each argument, and the checked-in template stays static. The runtime
 * render names an absolute Node and entry instead, so neither a Node upgrade
 * nor `npm rm -g` can take them away.
 */
export const PLUGIN_ROOT_ENTRY = '${CLAUDE_PLUGIN_ROOT}/../../../index.js';

/** A process Claude Code spawns directly: a hook's `command` and `args`, or a stdio server's. */
export interface ExecLaunch {
  command: string;
  args: string[];
}

/**
 * How a plugin render departs from the package render. A render that sets
 * none of these is byte for byte what the build ships.
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
 * The `alive` leg, the plugin's `SessionStart` entry. It marks the session as
 * one the plugin serves, so a settings-install leg stays silent, and stamps the
 * machine for the migration. A command, not an `mcp_tool` call: MCP servers may
 * still be connecting when `SessionStart` fires.
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
 * The hook legs' tool is denied to the model: its event fields are plain
 * arguments, so the model could forge a routing leg. A plugin cannot carry
 * permission rules, and a blocking hook beats allow rules in every mode, bypass
 * included, while Claude Code's own `mcp_tool` hook calls still run (checked on
 * Claude Code 2.1.296). `admitHookEvent` still covers a machine with hooks off.
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
 * The request tool is allowed by the plugin itself, so an install needs no rule
 * the user adds. A hook's allow never overrides the user's own `deny` or `ask`
 * rule, and the tool still pays only within the local spend policy.
 */
export function allowHook(o: RenderOptions = {}): ExecLaunch {
  return printed(permissionAnswer('allow', 'Tenjin lookup'), o.node ?? 'node');
}

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
 * The seven routing legs. The native tools are routed before the call, when a
 * paid lookup fits, and after it, when it came back short or to add the free
 * docs the pre-call arm fetched. A failed call fires PostToolUseFailure, not
 * PostToolUse, so the after leg takes both. The host's question to the user is
 * routed before it is asked and after, with the answers read as the user's.
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
 * `.mcp.json`: the CLI's entry run by Node, which Windows can spawn where it
 * cannot spawn the shim.
 *
 * `--plugin` keeps the server from being suppressed: Claude Code drops a
 * plugin's MCP server whose command matches one the user configured, and a
 * settings install's `x402` entry runs `tenjin mcp` (checked on Claude Code
 * 2.1.296).
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

export const PLUGIN_DESCRIPTION =
  'Tenjin picks the right tool when your agent needs one, and one wallet on this machine pays for every call.';

/**
 * `.claude-plugin/plugin.json`. The version is the CLI's, stamped at build
 * time, so the plugin list names the build that runs. `metadata[tenjin-cli]` is
 * the ownership marker checked before anything touches a folder.
 */
export function renderPluginManifest(
  version?: string,
  o: RenderOptions = {},
): Record<string, unknown> {
  return {
    name: PLUGIN_NAME,
    ...(version !== undefined ? { version } : {}),
    description: PLUGIN_DESCRIPTION,
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
        description: PLUGIN_DESCRIPTION,
        ...(version !== undefined ? { version } : {}),
      },
    ],
  };
}

/**
 * Every file the plugin folder holds, and the only paths install, update and
 * uninstall write or unlink there. The manifest is last, so a crash mid-write
 * never leaves a manifest pointing at missing parts.
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
 * The mod ships as written, not rendered: the build copies its source from
 * `hosts/claude/tenjin/` into `dist/hosts/claude/tenjin/`. Claude Code compiles
 * it at load (2.1.287 or later); nothing here builds or imports it.
 */
export const MOD_FILES = [MOD_TYPES, 'hooks/register.tsx'] as const;
export type ModSources = Record<(typeof MOD_FILES)[number], string>;

/** A JSON file's text as the plugin renders write it. */
export const jsonText = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

/**
 * The plugin folder's files, by {@link PLUGIN_FILES} path. `entry` is the CLI
 * entry the commands run, {@link PLUGIN_ROOT_ENTRY} unless the folder lives
 * outside the package.
 */
export function renderPluginFiles(
  version?: string,
  entry?: string,
  o: RenderOptions = {},
): Record<string, string> {
  return {
    '.mcp.json': jsonText(renderPluginMcp(entry, o)),
    ...(o.mod ?? {}),
    'hooks/hooks.json': jsonText(renderPluginHooks(entry, o)),
    [PAY_SKILL_PATH]: PAY_SKILL,
    '.claude-plugin/plugin.json': jsonText(renderPluginManifest(version, o)),
  };
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
 * {@link PLUGIN_DIR}. With no `o.launch`, the package render; with one, the
 * runtime render, which also carries the plugin's `bin/` launchers.
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
    '.claude-plugin/marketplace.json': jsonText(renderMarketplace(version)),
    ...Object.fromEntries(plugin),
  };
}
