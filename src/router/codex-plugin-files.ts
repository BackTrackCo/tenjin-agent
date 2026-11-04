import { PRODUCTION_ORIGIN } from '../lib/production-origin';
import { CODEX_HOOK_KINDS, codexHookToolInput, HOOK_TOOL, type CodexHookKind } from './hook-tool';
import { renderPluginBin, type RuntimeLaunch } from './launcher-files';
import {
  CODEX_HOOK_TOOL,
  CODEX_REQUEST_TOOL,
  MARKETPLACE_NAME,
  MCP_SERVER_NAME,
  PLUGIN_NAME,
} from './names';
import {
  AFTER_CALL_TIMEOUT_SECONDS,
  jsonText,
  LOCAL_HOOK_TIMEOUT_SECONDS,
  PLUGIN_DESCRIPTION,
  PLUGIN_DIR,
  ROUTE_HOOK_TIMEOUT_SECONDS,
} from './plugin-files';

/**
 * The Codex plugin as files, shipped in `dist/hosts/codex` and pinned to the
 * checked-in `hosts/codex/` by a test. Its legs are `mcp_tool` hooks into the
 * plugin's own `router` server, so each runs in the process that holds the
 * wallet: the prompt, and a web call before and after (Codex has no
 * PostToolUseFailure). An older Codex rejects or skips `mcp_tool` hooks (see
 * {@link CODEX_MCP_HOOKS_VERSION}), so install and update leave its copy alone.
 * The server's `env_vars` passes `CODEX_HOME` through Codex's cleared MCP
 * environment, so the hook tool finds the session's rollout.
 *
 * Nothing in the package render names a release or a path, so `codex plugin
 * add` copies the same bytes from every build and the hooks' trust holds
 * across a `tenjin update`. The runtime render (`~/.tenjin/runtime/codex`)
 * differs only in `.mcp.json`, which names the `bin/` launcher by its fixed
 * absolute path; `activate` rewrites only the launcher on each switch.
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

/** The command form of a leg, which a plugin copy from an older build runs. */
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
 * The hook legs' tool is denied to the model, as `DENY_HOOK` does in Claude
 * Code (`plugin-files.ts`): a model call to it fires PreToolUse as
 * `mcp__router__hook`, while Codex's own `mcp_tool` hook calls go straight to
 * the server and fire no PreToolUse (openai/codex `core/src/hook_mcp_executor.rs`).
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
 * The request tool is allowed by the plugin itself, as `allowHook` does in
 * Claude Code. Codex runs a `PermissionRequest` hook before its approval
 * policy, `never` included, so the tool runs without a prompt once the user
 * trusts the hooks in `/hooks`. It also overrides a user's own
 * `approval_mode = "prompt"`; that user turns this hook off in `/hooks`. The
 * wallet's spend limits still bound every payment.
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

/** `.codex-plugin/plugin.json`. No version, so every build copies the same bytes. */
export function renderCodexManifest(): Record<string, unknown> {
  return {
    name: PLUGIN_NAME,
    description: PLUGIN_DESCRIPTION,
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
    '.agents/plugins/marketplace.json': jsonText(renderCodexMarketplace()),
    [`${PLUGIN_DIR}/.mcp.json`]: jsonText(renderCodexMcp(o)),
    ...Object.fromEntries(
      Object.entries(bin).map(([path, body]) => [`${PLUGIN_DIR}/${path}`, body] as const),
    ),
    [`${PLUGIN_DIR}/hooks/hooks.json`]: jsonText(renderCodexHooks()),
    [`${PLUGIN_DIR}/.codex-plugin/plugin.json`]: jsonText(renderCodexManifest()),
  };
}
