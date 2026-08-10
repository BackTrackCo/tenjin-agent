import { readFile, stat } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { writeFileAtomic } from './atomic-json';
import { CliError } from './errors';
import { hasCode } from './errno';
import { writeSharedHookScripts } from './harness-hooks';

export const HERMES_MCP_MARKER = 'tenjin-cli:hermes-mcp';
export const HERMES_PLUGIN_NAME = 'tenjin';

/**
 * The Hermes tool this plugin observes. Getting this string wrong fails silently:
 * the callbacks register, never match, and the suite stays green. Pinned against
 * `tools/web_tools.py`, where `WEB_SEARCH_SCHEMA["name"] == "web_search"`.
 */
export const HERMES_WEB_SEARCH_TOOL = 'web_search';

/**
 * `~/.hermes/plugins/<name>/plugin.yaml`, pinned against the loader rather than
 * against the manifests Hermes ships.
 *
 * `hermes_cli/plugins.py::_parse_manifest` reads `data.get("provides_hooks", [])`;
 * the `hooks:` key used by the in-repo example plugins is silently dropped by that
 * same parser, so this emits the field the loader can actually consume. `kind`
 * defaults to `standalone` and is spelled out because the default is not
 * documented in the manifest examples. None of it is load-bearing: hooks are
 * registered by `register(ctx)` calling `ctx.register_hook`, which is checked
 * against a module-level VALID_HOOKS set and never against the manifest. The
 * manifest is what `hermes plugins list` shows the operator, so it still has to be
 * true. See {@link https://github.com/NousResearch/hermes-agent/blob/main/hermes_cli/plugins.py}.
 */
export const HERMES_PLUGIN_MANIFEST = [
  'name: tenjin',
  'version: "1.0.0"',
  'description: "Check Tenjin before Hermes web searches and surface unresolved searches at turn end."',
  'author: "Tenjin"',
  'kind: standalone',
  'provides_hooks:',
  '  - pre_tool_call',
  '  - transform_tool_result',
  '  - transform_llm_output',
  '',
].join('\n');

export type HermesWriteStatus =
  'installed' | 'up-to-date' | 'would-install' | 'disabled' | 'conflict';

export interface HermesWriteResult {
  path: string;
  status: HermesWriteStatus;
  warning?: string;
}

export interface HermesIntegrationResult {
  home: string;
  explicit: boolean;
  mcp: HermesWriteResult & { command?: string };
  plugin: HermesWriteResult & { manifestPath: string; scriptPaths: string[] };
  activation: HermesWriteResult;
}

export interface HermesIntegrationStatus {
  home: string;
  /** `stale` means the marker and shape are ours but the baked command no longer exists. */
  mcp: 'configured' | 'stale' | 'missing' | 'conflict';
  plugin: 'installed' | 'missing' | 'partial';
  activation: 'enabled' | 'disabled' | 'not-enabled' | 'conflict';
  /** The command Hermes would run, when one could be parsed out of a managed entry. */
  mcpCommand?: string;
  /** Set when a relative HERMES_HOME was ignored in favor of the default. */
  homeWarning?: string;
}

export interface HermesHomeResolution {
  home: string;
  /** Present when HERMES_HOME was unusable and `~/.hermes` was used instead. */
  warning?: string;
}

const RELATIVE_HERMES_HOME_FIX =
  'Set HERMES_HOME to an absolute directory, or unset it to use ~/.hermes.';

/**
 * Hermes honors HERMES_HOME; reject a relative override before writing anywhere.
 * Use this ONLY where the operator explicitly targeted Hermes, so the refusal is
 * about the thing they asked for. Every other caller wants
 * {@link resolveHermesHomeLenient}: a stray relative value in the environment is
 * not a reason to take down a command that was never going to touch Hermes.
 */
export function resolveHermesHome(home: string, env: NodeJS.ProcessEnv): string {
  const resolved = resolveHermesHomeLenient(home, env);
  if (resolved.warning !== undefined) {
    throw new CliError('CONFIG_INVALID', 'HERMES_HOME must be an absolute path', {
      fix: RELATIVE_HERMES_HOME_FIX,
    });
  }
  return resolved.home;
}

/** The same resolution, downgraded to a warning plus the `~/.hermes` fallback. */
export function resolveHermesHomeLenient(
  home: string,
  env: NodeJS.ProcessEnv,
): HermesHomeResolution {
  const configured = env.HERMES_HOME?.trim();
  if (configured === undefined || configured.length === 0) return { home: join(home, '.hermes') };
  if (isAbsolute(configured)) return { home: configured };
  return {
    home: join(home, '.hermes'),
    warning: `HERMES_HOME is set to a relative path (${configured}) and was ignored; using ~/.hermes. ${RELATIVE_HERMES_HOME_FIX}`,
  };
}

export function hermesSkillsDir(hermesHome: string): string {
  return join(hermesHome, 'skills');
}

export function hermesConfigPath(hermesHome: string): string {
  return join(hermesHome, 'config.yaml');
}

export function hermesPluginDir(hermesHome: string): string {
  return join(hermesHome, 'plugins', HERMES_PLUGIN_NAME);
}

/** Read-only status used by doctor; it never normalizes or writes user YAML. */
export async function readHermesIntegrationStatus(
  hermesHome: string,
): Promise<HermesIntegrationStatus> {
  const config = await readOptional(hermesConfigPath(hermesHome));
  const lines = config === null ? [] : normalizedLines(config);
  const mcpRoot = rootIndexes(lines, 'mcp_servers')[0];
  let mcp: HermesIntegrationStatus['mcp'] = 'missing';
  let mcpCommand: string | undefined;
  if (mcpRoot !== undefined) {
    const end = topLevelEnd(lines, mcpRoot + 1);
    const tenjin = lines.findIndex(
      (line, i) => i > mcpRoot && i < end && /^ {2}tenjin:\s*(?:#.*)?$/.test(line),
    );
    if (tenjin >= 0) {
      const childEnd = blockEnd(lines, tenjin + 1, end, 2);
      const managed = lines[tenjin - 1]?.trim() === `# ${HERMES_MCP_MARKER}`;
      mcpCommand = managed
        ? managedMcpCommand(lines.slice(tenjin, childEnd).join('\n'))
        : undefined;
      // A managed entry whose baked command has since been deleted is worse than a
      // missing one: Hermes fails to start the server and doctor would otherwise
      // report green. `command` is `process.argv[1]`, so an npx/dlx cache path or a
      // node version switch makes this an ordinary outcome, not an exotic one.
      mcp =
        mcpCommand === undefined ? 'conflict' : (await exists(mcpCommand)) ? 'configured' : 'stale';
    }
  }
  const pluginPath = join(hermesPluginDir(hermesHome), '__init__.py');
  const manifestPath = join(hermesPluginDir(hermesHome), 'plugin.yaml');
  const [pluginSource, manifest] = await Promise.all([
    readOptional(pluginPath),
    readOptional(manifestPath),
  ]);
  const plugin =
    pluginSource !== null && manifest !== null
      ? 'installed'
      : pluginSource === null && manifest === null
        ? 'missing'
        : 'partial';
  const lists = inspectPluginLists(config);
  // The conflict verdict comes from the WRITER's planner, not a second, narrower
  // model of the same YAML. Doctor used to call `not-enabled` on shapes the
  // installer then refused (an inline `plugins.enabled: [x]`, for one), so its fix
  // string sent the operator into a conflict it had not predicted.
  const activation: HermesIntegrationStatus['activation'] = lists.disabled
    ? 'disabled'
    : lists.enabled
      ? 'enabled'
      : planPluginEnable(config).kind === 'conflict'
        ? 'conflict'
        : 'not-enabled';
  return {
    home: hermesHome,
    mcp,
    plugin,
    activation,
    ...(mcpCommand !== undefined ? { mcpCommand } : {}),
  };
}

/**
 * Install Hermes' native plugin and additive MCP entry.
 *
 * TWO independent decisions gate this, and folding them together is the bug this
 * signature exists to prevent. `hooks` is whether the operator consented to hook
 * code at all this run: it is the SAME decision that gates Claude's settings.json
 * write, so `--no-hooks` must leave the scripts and the plugin unwritten here too,
 * exactly as the README's row promises. `explicit` is narrower and is only about
 * ACTIVATION: auto-detection may put inert files on disk, but never opts the
 * operator into executing third-party code.
 *
 * The MCP entry is deliberately outside both. It is a server registration, not a
 * hook, and it is what `--no-hooks` users still want.
 */
export async function wireHermesIntegration(opts: {
  hermesHome: string;
  dataDir: string;
  tenjinCommand: string;
  nodeCommand: string;
  dryRun: boolean;
  explicit: boolean;
  hooks: { enabled: boolean; fix?: string };
}): Promise<HermesIntegrationResult> {
  const { hermesHome, dataDir, tenjinCommand, nodeCommand, dryRun, explicit, hooks } = opts;
  const mcp = await wireHermesMcp(hermesHome, dryRun, tenjinCommand);
  const websearchPath = join(dataDir, 'hooks', 'tenjin-websearch.mjs');
  const stopPath = join(dataDir, 'hooks', 'tenjin-stop.mjs');
  if (!hooks.enabled) {
    const pluginDir = hermesPluginDir(hermesHome);
    return {
      home: hermesHome,
      explicit,
      mcp,
      plugin: {
        path: join(pluginDir, '__init__.py'),
        manifestPath: join(pluginDir, 'plugin.yaml'),
        status: 'disabled',
        scriptPaths: [],
        warning: `No Hermes hook code was written this run.${hooks.fix === undefined ? '' : ` ${hooks.fix}`}`,
      },
      activation: { path: hermesConfigPath(hermesHome), status: 'disabled' },
    };
  }
  const shared = dryRun
    ? { written: [websearchPath, stopPath], websearchPath, stopPath }
    : await writeSharedHookScripts(dataDir);
  const plugin = await wireHermesPlugin({
    hermesHome,
    nodeCommand,
    websearchPath: shared.websearchPath,
    stopPath: shared.stopPath,
    dryRun,
    scriptPaths: shared.written,
  });
  const activation = await wireHermesPluginActivation(hermesHome, dryRun, explicit);
  return { home: hermesHome, explicit, mcp, plugin, activation };
}

export async function wireHermesMcp(
  hermesHome: string,
  dryRun: boolean,
  command: string,
): Promise<HermesWriteResult & { command?: string }> {
  const path = hermesConfigPath(hermesHome);
  const existing = await readOptional(path);
  const plan = planHermesMcp(existing, command);
  if (plan.kind === 'same') return { path, status: 'up-to-date', command: plan.command };
  if (plan.kind === 'conflict') return { path, status: 'conflict', warning: plan.warning };
  if (dryRun) return { path, status: 'would-install', command };
  await writeFileAtomic(path, plan.content, { mode: 0o600, dirMode: 0o700 });
  return { path, status: 'installed', command };
}

async function wireHermesPlugin(opts: {
  hermesHome: string;
  nodeCommand: string;
  websearchPath: string;
  stopPath: string;
  dryRun: boolean;
  scriptPaths: string[];
}): Promise<HermesWriteResult & { manifestPath: string; scriptPaths: string[] }> {
  const dir = hermesPluginDir(opts.hermesHome);
  const path = join(dir, '__init__.py');
  const manifestPath = join(dir, 'plugin.yaml');
  const source = hermesPluginSource(opts.nodeCommand, opts.websearchPath, opts.stopPath);
  const manifest = HERMES_PLUGIN_MANIFEST;
  const currentSource = await readOptional(path);
  const currentManifest = await readOptional(manifestPath);
  if (currentSource === source && currentManifest === manifest) {
    return { path, manifestPath, status: 'up-to-date', scriptPaths: opts.scriptPaths };
  }
  if (opts.dryRun) {
    return { path, manifestPath, status: 'would-install', scriptPaths: opts.scriptPaths };
  }
  await writeFileAtomic(path, source, { mode: 0o600, dirMode: 0o700 });
  await writeFileAtomic(manifestPath, manifest, { mode: 0o600, dirMode: 0o700 });
  return { path, manifestPath, status: 'installed', scriptPaths: opts.scriptPaths };
}

async function wireHermesPluginActivation(
  hermesHome: string,
  dryRun: boolean,
  explicit: boolean,
): Promise<HermesWriteResult> {
  const path = hermesConfigPath(hermesHome);
  const existing = await readOptional(path);
  const state = inspectPluginLists(existing);
  if (state.disabled) {
    return {
      path,
      status: 'disabled',
      warning:
        'Hermes config explicitly disables the Tenjin plugin; that choice was left untouched.',
    };
  }
  if (state.enabled) return { path, status: 'up-to-date' };
  if (!explicit) {
    return {
      path,
      status: 'disabled',
      warning:
        'The native Hermes plugin was installed but not enabled. Enable it with `tenjin install --harness hermes`.',
    };
  }
  const plan = planPluginEnable(existing);
  if (plan.kind === 'conflict') return { path, status: 'conflict', warning: plan.warning };
  if (dryRun) return { path, status: 'would-install' };
  await writeFileAtomic(path, plan.content, { mode: 0o600, dirMode: 0o700 });
  return { path, status: 'installed' };
}

type TextPlan =
  | { kind: 'same'; command: string }
  | { kind: 'write'; content: string }
  | { kind: 'conflict'; warning: string };

function planHermesMcp(existing: string | null, command: string): TextPlan {
  if (existing === null || existing.trim().length === 0) {
    return { kind: 'write', content: `mcp_servers:\n${mcpEntry(command)}\n` };
  }
  const lines = normalizedLines(existing);
  const roots = rootIndexes(lines, 'mcp_servers');
  if (roots.length > 1) return conflict('config.yaml contains duplicate mcp_servers mappings');
  if (roots.length === 0) {
    if (lines.some((line) => /^mcp_servers\s*:/.test(line))) {
      return conflict('config.yaml uses an unsupported inline mcp_servers value');
    }
    return { kind: 'write', content: appendBlock(existing, `mcp_servers:\n${mcpEntry(command)}`) };
  }
  const root = roots[0]!;
  const end = topLevelEnd(lines, root + 1);
  if (!supportedChildren(lines, root + 1, end)) {
    return conflict(
      'config.yaml uses unsupported indentation or sequence syntax under mcp_servers',
    );
  }
  const tenjin = lines.findIndex(
    (line, i) => i > root && i < end && /^ {2}tenjin:\s*(?:#.*)?$/.test(line),
  );
  if (tenjin < 0 && lines.some((line, i) => i > root && i < end && /^ {2}tenjin\s*:/.test(line))) {
    return conflict('config.yaml uses an unsupported inline mcp_servers.tenjin value');
  }
  if (tenjin >= 0) {
    const childEnd = blockEnd(lines, tenjin + 1, end, 2);
    const block = lines.slice(tenjin, childEnd).join('\n');
    const managed = lines[tenjin - 1]?.trim() === `# ${HERMES_MCP_MARKER}`;
    const current = managed ? managedMcpCommand(block) : undefined;
    if (current === command) return { kind: 'same', command };
    if (current === undefined) {
      return conflict('config.yaml already defines mcp_servers.tenjin; it was left untouched');
    }
    // Splice FROM the marker, because `mcpEntry` re-emits it: starting at `tenjin`
    // left the old marker in place and appended a second one on every re-point.
    // `command` is `process.argv[1]`, so an nvm switch or a pnpm-vs-npm global
    // makes re-pointing routine rather than rare.
    const next = [...lines.slice(0, tenjin - 1), mcpEntry(command), ...lines.slice(childEnd)].join(
      '\n',
    );
    return { kind: 'write', content: withFinalNewline(next) };
  }
  const next = [...lines.slice(0, end), mcpEntry(command), ...lines.slice(end)].join('\n');
  return { kind: 'write', content: withFinalNewline(next) };
}

function planPluginEnable(existing: string | null): Exclude<TextPlan, { kind: 'same' }> {
  if (existing === null || existing.trim().length === 0) {
    return { kind: 'write', content: 'plugins:\n  enabled:\n    - tenjin\n' };
  }
  const lines = normalizedLines(existing);
  const roots = rootIndexes(lines, 'plugins');
  if (roots.length > 1) return conflict('config.yaml contains duplicate plugins mappings');
  if (roots.length === 0) {
    if (lines.some((line) => /^plugins\s*:/.test(line))) {
      return conflict('config.yaml uses an unsupported inline plugins value');
    }
    return { kind: 'write', content: appendBlock(existing, 'plugins:\n  enabled:\n    - tenjin') };
  }
  const root = roots[0]!;
  const end = topLevelEnd(lines, root + 1);
  if (!supportedChildren(lines, root + 1, end)) {
    return conflict('config.yaml uses unsupported indentation or sequence syntax under plugins');
  }
  const enabled = lines.findIndex(
    (line, i) => i > root && i < end && /^ {2}enabled:\s*(?:#.*)?$/.test(line),
  );
  if (enabled < 0) {
    if (lines.some((line, i) => i > root && i < end && /^ {2}enabled\s*:/.test(line))) {
      return conflict('config.yaml uses unsupported inline syntax under plugins.enabled');
    }
    const next = [
      ...lines.slice(0, root + 1),
      '  enabled:',
      '    - tenjin',
      ...lines.slice(root + 1),
    ].join('\n');
    return { kind: 'write', content: withFinalNewline(next) };
  }
  const listEnd = blockEnd(lines, enabled + 1, end, 2);
  const entries = lines
    .slice(enabled + 1, listEnd)
    .filter((line) => line.trim() && !/^\s*#/.test(line));
  if (entries.some((line) => !/^ {4}-\s+[^\s].*$/.test(line))) {
    return conflict('config.yaml uses unsupported syntax under plugins.enabled');
  }
  const next = [...lines.slice(0, listEnd), '    - tenjin', ...lines.slice(listEnd)].join('\n');
  return { kind: 'write', content: withFinalNewline(next) };
}

function inspectPluginLists(existing: string | null): { enabled: boolean; disabled: boolean } {
  if (existing === null) return { enabled: false, disabled: false };
  const lines = normalizedLines(existing);
  const root = rootIndexes(lines, 'plugins')[0];
  if (root === undefined) return { enabled: false, disabled: false };
  const end = topLevelEnd(lines, root + 1);
  const has = (key: string): boolean => {
    const inline = lines.find(
      (line, i) =>
        i > root && i < end && new RegExp(`^ {2}${key}:\\s*\\[(.*)\\]\\s*(?:#.*)?$`).test(line),
    );
    if (inline !== undefined) {
      const body = inline.match(/\[(.*)\]/)?.[1] ?? '';
      return body
        .split(',')
        .map((value) => value.trim().replace(/^["']|["']$/g, ''))
        .includes('tenjin');
    }
    const start = lines.findIndex(
      (line, i) => i > root && i < end && new RegExp(`^ {2}${key}:\\s*(?:#.*)?$`).test(line),
    );
    if (start < 0) return false;
    const stop = blockEnd(lines, start + 1, end, 2);
    return lines
      .slice(start + 1, stop)
      .some((line) => /^ {4}-\s+["']?tenjin["']?\s*(?:#.*)?$/.test(line));
  };
  return { enabled: has('enabled'), disabled: has('disabled') };
}

function hermesPluginSource(nodeCommand: string, websearchPath: string, stopPath: string): string {
  return `"""Tenjin native Hermes hooks. Generated by \`tenjin install\`; safe to delete."""
from __future__ import annotations

import json
import subprocess
import threading
import time
from collections import OrderedDict

NODE = ${JSON.stringify(nodeCommand)}
WEBSEARCH_SCRIPT = ${JSON.stringify(websearchPath)}
STOP_SCRIPT = ${JSON.stringify(stopPath)}
_HINTS = OrderedDict()
_LOCK = threading.Lock()
_MAX_HINTS = 128
_MAX_AGE_SECONDS = 300


def _key(kwargs):
    call_id = kwargs.get("tool_call_id")
    if call_id:
        return "call:" + str(call_id)
    return "turn:" + str(kwargs.get("session_id", "")) + ":" + str(kwargs.get("turn_id", ""))


def _run(script, payload, timeout):
    try:
        completed = subprocess.run(
            [NODE, script, "--hermes"],
            input=json.dumps(payload),
            text=True,
            capture_output=True,
            timeout=timeout,
            check=False,
        )
        if completed.returncode != 0 or not completed.stdout or len(completed.stdout) > 65536:
            return None
        parsed = json.loads(completed.stdout)
        context = parsed.get("context") if isinstance(parsed, dict) else None
        return context if isinstance(context, str) and context else None
    except Exception:
        return None


def _prune(now):
    stale = [key for key, (at, _) in _HINTS.items() if now - at > _MAX_AGE_SECONDS]
    for key in stale:
        _HINTS.pop(key, None)
    while len(_HINTS) > _MAX_HINTS:
        _HINTS.popitem(last=False)


def _pre_tool_call(tool_name="", args=None, **kwargs):
    if tool_name != ${JSON.stringify(HERMES_WEB_SEARCH_TOOL)} or not isinstance(args, dict):
        return None
    context = _run(WEBSEARCH_SCRIPT, {"tool_name": tool_name, "args": args}, 3.0)
    if context:
        now = time.monotonic()
        with _LOCK:
            _prune(now)
            _HINTS[_key(kwargs)] = (now, context)
    return None


def _transform_tool_result(tool_name="", result=None, **kwargs):
    if tool_name != ${JSON.stringify(HERMES_WEB_SEARCH_TOOL)} or not isinstance(result, str):
        return None
    with _LOCK:
        item = _HINTS.pop(_key(kwargs), None)
    if item is None:
        return None
    return result + "\\n\\n--- Tenjin marketplace context ---\\n" + item[1] + "\\n--- end Tenjin context ---"


def _transform_llm_output(response_text="", **_kwargs):
    if not isinstance(response_text, str):
        return None
    context = _run(STOP_SCRIPT, {}, 2.0)
    if not context:
        return None
    return response_text + "\\n\\n--- Tenjin publish-back reminder ---\\n" + context


def register(ctx):
    ctx.register_hook("pre_tool_call", _pre_tool_call)
    ctx.register_hook("transform_tool_result", _transform_tool_result)
    ctx.register_hook("transform_llm_output", _transform_llm_output)
`;
}

function mcpEntry(command: string): string {
  return [
    `  # ${HERMES_MCP_MARKER}`,
    '  tenjin:',
    `    command: ${JSON.stringify(command)}`,
    '    args: ["mcp"]',
  ].join('\n');
}

function managedMcpCommand(block: string): string | undefined {
  const wrapped = `\n${block}\n`;
  if (!/\n {4}args:\s*\[\s*["']mcp["']\s*\]\s*(?:#.*)?(?:\n|$)/.test(wrapped)) return undefined;
  return wrapped.match(/\n {4}command:\s*["']([^"']+)["']\s*(?:#.*)?(?:\n|$)/)?.[1];
}

async function readOptional(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch (err) {
    if (hasCode(err, 'ENOENT')) return null;
    throw new CliError('CONFIG_INVALID', `Could not read Hermes file at ${path}`, {
      fix: `Check that ${path} is a readable regular file.`,
      cause: err,
    });
  }
}

function normalizedLines(text: string): string[] {
  return text.replace(/\r\n/g, '\n').split('\n');
}

function rootIndexes(lines: string[], key: string): number[] {
  return lines.flatMap((line, i) => (new RegExp(`^${key}:\\s*(?:#.*)?$`).test(line) ? [i] : []));
}

function topLevelEnd(lines: string[], start: number): number {
  for (let i = start; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    if (!line.trim() || /^\s*#/.test(line)) continue;
    if (!/^\s/.test(line)) return i;
  }
  return lines.length;
}

/**
 * One past the last line that belongs to the mapping opened at `start - 1`.
 *
 * Membership is INDENT, not a sibling-key regex: the old probe (`^ {2}\S[^:]*:`)
 * only recognized a sibling that contained a colon, so a plain comment written for
 * the next server counted as part of this block and a re-point splice deleted it.
 * Blank lines and comments are ambiguous by nature, so they belong only when a
 * deeper line still follows; trailing ones stay with whatever comes next.
 */
function blockEnd(lines: string[], start: number, limit: number, indent: number): number {
  let end = start;
  for (let i = start; i < limit; i += 1) {
    const line = lines[i] ?? '';
    if (!line.trim() || /^\s*#/.test(line)) continue;
    if (line.length - line.trimStart().length <= indent) return end;
    end = i + 1;
  }
  return end;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function supportedChildren(lines: string[], start: number, end: number): boolean {
  const first = lines.slice(start, end).find((line) => line.trim() && !/^\s*#/.test(line));
  return first === undefined || (/^ {2}\S/.test(first) && !/^ {2}-/.test(first));
}

function appendBlock(existing: string, block: string): string {
  const prefix = existing.endsWith('\n') ? existing : `${existing}\n`;
  return `${prefix}\n${block}\n`;
}

function withFinalNewline(text: string): string {
  return text.endsWith('\n') ? text : `${text}\n`;
}

function conflict(warning: string): { kind: 'conflict'; warning: string } {
  return { kind: 'conflict', warning };
}
