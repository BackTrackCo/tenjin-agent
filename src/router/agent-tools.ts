import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { LEGACY_MCP_SERVER_NAME, LEGACY_REQUEST_TOOL, requestToolName } from './names';

/**
 * CAN THIS SUBAGENT CALL `request` AT ALL? An offer to an agent whose definition
 * leaves the tool out is a line it cannot act on, and a router call spent to
 * write it. Claude Code defines a custom agent in a Markdown file whose
 * frontmatter may carry `tools:` (an allowlist) and `disallowedTools:`; this
 * reads that, and nothing else, and never writes to it.
 *
 * ONLY `allowed` IS ACTED ON. A subagent is redirected or offered a lookup
 * only when this KNOWS it can make the call: a definition whose tools cover
 * the request tool (or that has no `tools:` and so inherits everything), or a
 * built-in in {@link MCP_INHERITING_BUILTINS}. Every other built-in, and any
 * type with no definition this can find or read, is `unknown`, and `unknown`
 * gets no router call: `claude-code-guide` ships with Bash, Read, WebFetch and
 * WebSearch and no MCP tools, and denying its WebFetch would strand it.
 *
 * WHERE A DEFINITION LIVES, in the harness's own precedence: the project's
 * `.claude/agents` (from `cwd` up to the filesystem root, nearest first), then
 * `~/.claude/agents`, then an installed plugin's `agents/` for a `plugin:agent`
 * type. A file is found by its name first and by its frontmatter `name:`
 * second, because the type is the `name:` and the file name only usually
 * matches it.
 */

export type RequestToolAccess = 'allowed' | 'excluded' | 'unknown';

/**
 * The built-in agent types that have no definition file and still inherit MCP
 * tools, so can call the request tool. From Claude Code's own Agent tool
 * listing (2.1.28x): `general-purpose` has every tool, and `Explore` and `Plan`
 * exclude only editing and agent tools, never MCP. Built-ins with a fixed tool
 * list, such as `claude-code-guide` (Bash, Read, WebFetch, WebSearch) and
 * `statusline-setup` (Read, Edit), are deliberately absent.
 */
export const MCP_INHERITING_BUILTINS: ReadonlySet<string> = new Set([
  'general-purpose',
  'Explore',
  'Plan',
]);

export interface AgentLookup {
  cwd?: string;
  homeDir: string;
}

const MAX_AGENT_FILE_BYTES = 256 * 1024;
const TYPE_RE = /^[A-Za-z0-9_.:-]{1,200}$/;

export async function requestToolAccess(
  agentType: string | undefined,
  lookup: AgentLookup,
  tool: string = requestToolName(),
): Promise<RequestToolAccess> {
  if (agentType === undefined || !TYPE_RE.test(agentType)) return 'unknown';
  try {
    const text = await findDefinition(agentType, lookup);
    if (text !== null) return accessOf(text, tool);
    return MCP_INHERITING_BUILTINS.has(agentType) ? 'allowed' : 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * What one definition's frontmatter says about the request tool, named as the
 * leg's harness exposes it (`tool`).
 *
 * THE OLD NAME, AFTER THE RENAME. An agent whose `tools:` names only
 * `mcp__x402__request` cannot call the plugin's tool, so it counts as excluded
 * and doctor names the new name to add. One whose `disallowedTools:` names the
 * old tool or server meant to keep paid lookups out, so it stays excluded.
 * SHIM: the old-name branch goes on or after 2026-12-01.
 */
export function accessOf(definition: string, tool: string = requestToolName()): RequestToolAccess {
  const frontmatter = frontmatterOf(definition);
  if (frontmatter === null) return 'unknown';
  const disallowed = listField(frontmatter, 'disallowedTools');
  if (
    disallowed !== undefined &&
    disallowed.some((entry) => namesRequestTool(entry, tool) || namesLegacyTool(entry))
  ) {
    return 'excluded';
  }
  const tools = listField(frontmatter, 'tools');
  if (tools === undefined) return 'allowed';
  return tools.some((entry) => namesRequestTool(entry, tool)) ? 'allowed' : 'excluded';
}

/**
 * Does one `tools:` or `disallowedTools:` entry cover the request tool? The
 * tool itself, its bare server (`mcp__plugin_tenjin_router`), or any
 * `*`-suffixed pattern the tool's name starts with: `*`, `mcp__*`,
 * `mcp__plugin_tenjin_router__*` and every prefix between.
 */
function namesRequestTool(entry: string, tool: string): boolean {
  if (entry === tool || entry === tool.replace(/__request$/, '')) return true;
  return entry.endsWith('*') && tool.startsWith(entry.slice(0, -1));
}

/** The settings install's tool or server, by literal or wildcard. */
function namesLegacyTool(entry: string): boolean {
  return namesRequestTool(entry, LEGACY_REQUEST_TOOL) || entry === `mcp__${LEGACY_MCP_SERVER_NAME}`;
}

/**
 * Every custom agent this project and this user define whose tools leave the
 * request tool out, for `doctor` to name. Plugin agents are not listed: their
 * files are not the user's to edit.
 */
export async function agentsWithoutRequestTool(
  lookup: AgentLookup,
  tool: string = requestToolName(),
): Promise<string[]> {
  const found: string[] = [];
  const seen = new Set<string>();
  for (const directory of agentDirs(lookup)) {
    for (const { name, text } of await definitionsIn(directory)) {
      const type = nameOf(text) ?? name;
      if (seen.has(type)) continue;
      seen.add(type);
      if (accessOf(text, tool) === 'excluded') found.push(type);
    }
  }
  return found.sort();
}

/** Frontmatter a worker honours or that changes nothing about how the agent runs. */
const WORKER_MATCHED_KEYS = new Set([
  'name',
  'description',
  'tools',
  'disallowedTools',
  'color',
  'effort',
]);

/** A tool entry as agent files write one: a name, with an optional rule in parentheses. */
const TOOL_ENTRY = /^[A-Za-z_][\w*.:-]*(\([^()]*\))?$/;

/**
 * What a custom agent's frontmatter says, for a worker that will run as it:
 * its tool lists, or the first thing a worker cannot match. A worker runs the
 * agent's prompt and tools on its own model, in the accepted session's
 * permission mode, in the foreground: a definition that pins a model, a mode,
 * isolation, background running, memory, or its own hooks, servers or skills
 * runs natively. `model: inherit` pins nothing.
 *
 * READ STRICTLY, NOT AS YAML. This reads plain top-level `key: value` lines, a
 * one-line or `- item` tool list, and indented text under a plain key. Any
 * other syntax (a quoted key such as `'tools': [Read]`, a list over several
 * lines in brackets, a repeated key, a tool entry that is not a plain name) is
 * `frontmatter`: Claude Code would read it and this would not, and a tool list
 * missed here would give the worker every tool.
 */
function workerFrontmatter(
  frontmatter: string[],
): { tools?: string[]; disallowedTools?: string[] } | { unmatched: string } {
  const lists: { tools?: string[]; disallowedTools?: string[] } = {};
  const seen = new Set<string>();
  /** The key the indented lines below belong to, and whether it is an open tool list. */
  let under: { key: string; list: boolean } | undefined;
  for (const line of frontmatter) {
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue;
    if (/^\s/.test(line)) {
      if (!under) return { unmatched: 'frontmatter' };
      if (!under.list) continue;
      const item = /^\s+-\s+(.+)$/.exec(line);
      const entry = item === null ? '' : unquote(item[1]!.trim());
      if (!TOOL_ENTRY.test(entry)) return { unmatched: 'frontmatter' };
      lists[under.key as 'tools' | 'disallowedTools']!.push(entry);
      continue;
    }
    const field = /^([A-Za-z][\w-]*)\s*:(.*)$/.exec(line);
    if (field === null) return { unmatched: 'frontmatter' };
    const [, key, raw] = field as unknown as [string, string, string];
    const value = raw.trim();
    if (seen.has(key)) return { unmatched: 'frontmatter' };
    seen.add(key);
    if (key === 'model' ? !['', 'inherit'].includes(unquote(value)) : !WORKER_MATCHED_KEYS.has(key))
      return { unmatched: key };
    const list = key === 'tools' || key === 'disallowedTools';
    // Text may run on under a plain key, items under an open list, nothing under a one-line list.
    under = list && value !== '' ? undefined : { key, list };
    if (!list) continue;
    const bracketed = value.startsWith('[');
    if (bracketed && !value.endsWith(']')) return { unmatched: 'frontmatter' };
    const entries = (bracketed ? value.slice(1, -1) : value)
      .split(',')
      .map((part) => unquote(part.trim()))
      .filter((part) => part.length > 0);
    if (entries.some((entry) => !TOOL_ENTRY.test(entry))) return { unmatched: 'frontmatter' };
    lists[key] = entries;
  }
  // A list with nothing in it has no one reading: all tools to some readers, none to others.
  if ([lists.tools, lists.disallowedTools].some((list) => list?.length === 0))
    return { unmatched: 'frontmatter' };
  return lists;
}

/** The agent types Claude Code ships that a worker runs as, with no definition file. */
export const WORKER_BUILTIN_AGENTS: ReadonlySet<string> = new Set(['general-purpose', 'Explore']);

export type WorkerAgent = {
  description: string;
  prompt: string;
  tools?: string[];
  disallowedTools?: string[];
};

/**
 * Whether a type can be one a person or a project defines in an agent file.
 * A plugin's agent is namespaced (`codex:codex-rescue`) and never is: its
 * prompt and tool wiring are the plugin's, not the person's to send to another
 * model, and a worker cannot stand in for one that wraps another tool.
 */
export const isCustomAgentType = (agentType: string): boolean =>
  TYPE_RE.test(agentType) && !agentType.includes(':') && !WORKER_BUILTIN_AGENTS.has(agentType);

/**
 * What a worker runs a custom agent as: the definition's own prompt and tools,
 * handed to its Claude Code by value. Its Claude Code does not find every
 * definition the session's does (one in a folder above the job's root is
 * missed, and it then runs with every tool and no agent prompt, seen on
 * 2.1.326), so the worker never looks one up by name.
 *
 * ONLY A DEFINITION THE PROJECT OR THE PERSON WROTE: the job root's own
 * `.claude/agents`, then `~/.claude/agents`. No folder above the root is read,
 * since it is outside what the job's consent names, and no plugin's. `unmatched`
 * says why a type has no worker form: no such file (a plugin's agent and the
 * host's other built-ins included), or the definition's first key a worker
 * cannot match.
 */
export async function workerAgent(
  agentType: string,
  lookup: { root: string; homeDir: string },
): Promise<{ agent: WorkerAgent } | { unmatched: string }> {
  let text: string | null = null;
  if (isCustomAgentType(agentType))
    for (const base of [lookup.root, lookup.homeDir]) {
      text = await definitionIn(join(resolve(base), '.claude', 'agents'), agentType).catch(
        () => null,
      );
      if (text !== null) break;
    }
  const frontmatter = text === null ? null : frontmatterOf(text);
  if (text === null || frontmatter === null) return { unmatched: 'subagent_type' };
  const read = workerFrontmatter(frontmatter);
  if ('unmatched' in read) return { unmatched: `definition:${read.unmatched}` };
  const lines = text.split(/\r?\n/);
  const open = lines.findIndex((line) => line.trim() === '---');
  const prompt = lines
    .slice(lines.findIndex((line, i) => i > open && line.trim() === '---') + 1)
    .join('\n')
    .trim();
  if (!prompt) return { unmatched: 'definition:prompt' };
  return { agent: { description: agentType, prompt, ...read } };
}

export async function findDefinition(
  agentType: string,
  lookup: AgentLookup,
): Promise<string | null> {
  for (const directory of agentDirs(lookup)) {
    const text = await definitionIn(directory, agentType);
    if (text !== null) return text;
  }
  const colon = agentType.indexOf(':');
  if (colon > 0) {
    const plugin = agentType.slice(0, colon);
    const agent = agentType.slice(colon + 1);
    for (const root of await pluginRoots(plugin, lookup.homeDir)) {
      const text = await definitionIn(join(root, 'agents'), agent);
      if (text !== null) return text;
    }
  }
  return null;
}

function agentDirs(lookup: AgentLookup): string[] {
  const dirs: string[] = [];
  if (lookup.cwd !== undefined && lookup.cwd.length > 0) {
    let current = resolve(lookup.cwd);
    for (;;) {
      dirs.push(join(current, '.claude', 'agents'));
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }
  const user = join(resolve(lookup.homeDir), '.claude', 'agents');
  // The user's directory is also an ancestor of most projects; it counts once,
  // in its own place in the order.
  return [...dirs.filter((d) => d !== user), user];
}

async function definitionIn(directory: string, agentType: string): Promise<string | null> {
  const direct = await readBounded(join(directory, `${agentType}.md`));
  if (direct !== null && (nameOf(direct) ?? agentType) === agentType) return direct;
  for (const { text } of await definitionsIn(directory)) {
    if (nameOf(text) === agentType) return text;
  }
  return null;
}

async function definitionsIn(directory: string): Promise<{ name: string; text: string }[]> {
  let names: string[];
  try {
    names = (await readdir(directory)).filter((n) => n.endsWith('.md')).slice(0, 200);
  } catch {
    return [];
  }
  const out: { name: string; text: string }[] = [];
  for (const file of names) {
    const text = await readBounded(join(directory, file));
    if (text !== null) out.push({ name: file.slice(0, -3), text });
  }
  return out;
}

/** Install paths `installed_plugins.json` records for `<plugin>@<marketplace>`. */
async function pluginRoots(plugin: string, homeDir: string): Promise<string[]> {
  const raw = await readBounded(join(homeDir, '.claude', 'plugins', 'installed_plugins.json'));
  if (raw === null) return [];
  const parsed = JSON.parse(raw) as { plugins?: Record<string, unknown> };
  const roots: string[] = [];
  for (const [key, entries] of Object.entries(parsed.plugins ?? {})) {
    if (key.split('@')[0] !== plugin || !Array.isArray(entries)) continue;
    for (const entry of entries) {
      const path = (entry as { installPath?: unknown }).installPath;
      if (typeof path === 'string' && path.length > 0) roots.push(path);
    }
  }
  return roots;
}

async function readBounded(path: string): Promise<string | null> {
  try {
    const text = await readFile(path, 'utf8');
    return text.length > MAX_AGENT_FILE_BYTES ? null : text;
  } catch {
    return null;
  }
}

function frontmatterOf(text: string): string[] | null {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  const open = lines.findIndex((l) => l.trim().length > 0);
  if (open === -1 || lines[open]?.trim() !== '---') return null;
  const end = lines.findIndex((l, i) => i > open && l.trim() === '---');
  return end === -1 ? null : lines.slice(open + 1, end);
}

function nameOf(text: string): string | null {
  const frontmatter = frontmatterOf(text);
  if (frontmatter === null) return null;
  const line = frontmatter.find((l) => /^name\s*:/.test(l));
  const value = line === undefined ? '' : unquote(line.slice(line.indexOf(':') + 1).trim());
  return value.length > 0 ? value : null;
}

/**
 * A top-level list field in the three spellings agent files use: `a, b, c`,
 * `[a, b]`, or a block of `- a` lines. `undefined` when the key is absent.
 */
function listField(frontmatter: string[], key: string): string[] | undefined {
  const index = frontmatter.findIndex((l) => new RegExp(`^${key}\\s*:`).test(l));
  if (index === -1) return undefined;
  const line = frontmatter[index]!;
  const inline = line.slice(line.indexOf(':') + 1).trim();
  if (inline.length > 0) {
    const body = inline.startsWith('[') && inline.endsWith(']') ? inline.slice(1, -1) : inline;
    return body
      .split(',')
      .map((part) => unquote(part.trim()))
      .filter((part) => part.length > 0);
  }
  const items: string[] = [];
  for (const next of frontmatter.slice(index + 1)) {
    const item = /^\s+-\s*(.*)$/.exec(next);
    if (item === null) {
      if (next.trim().length === 0) continue;
      break;
    }
    const value = unquote(item[1]!.trim());
    if (value.length > 0) items.push(value);
  }
  return items;
}

function unquote(value: string): string {
  const quoted = /^(['"])(.*)\1$/.exec(value);
  return quoted === null ? value : quoted[2]!;
}
