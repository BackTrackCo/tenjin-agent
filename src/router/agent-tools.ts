import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { MCP_SERVER_NAME, REQUEST_TOOL } from './names';

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
 * WebSearch and no MCP tools, and denying its WebFetch would strand it exactly
 * as #377 reported.
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
 * tools, so can call `mcp__x402__request`. From Claude Code's own Agent tool
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
): Promise<RequestToolAccess> {
  if (agentType === undefined || !TYPE_RE.test(agentType)) return 'unknown';
  try {
    const text = await findDefinition(agentType, lookup);
    if (text !== null) return accessOf(text);
    return MCP_INHERITING_BUILTINS.has(agentType) ? 'allowed' : 'unknown';
  } catch {
    return 'unknown';
  }
}

/** What one definition's frontmatter says about the request tool. */
export function accessOf(definition: string): RequestToolAccess {
  const frontmatter = frontmatterOf(definition);
  if (frontmatter === null) return 'unknown';
  const disallowed = listField(frontmatter, 'disallowedTools');
  if (disallowed !== undefined && disallowed.some(namesRequestTool)) return 'excluded';
  const tools = listField(frontmatter, 'tools');
  if (tools === undefined) return 'allowed';
  return tools.some(namesRequestTool) ? 'allowed' : 'excluded';
}

/**
 * Does one `tools:` or `disallowedTools:` entry cover the request tool? The
 * tool itself, the bare server, or any `*`-suffixed pattern the tool's name
 * starts with: `*`, `mcp__*`, `mcp__x402__*` and every prefix between.
 */
function namesRequestTool(tool: string): boolean {
  if (tool === REQUEST_TOOL || tool === `mcp__${MCP_SERVER_NAME}`) return true;
  return tool.endsWith('*') && REQUEST_TOOL.startsWith(tool.slice(0, -1));
}

/**
 * Every custom agent this project and this user define whose tools leave the
 * request tool out, for `doctor` to name. Plugin agents are not listed: their
 * files are not the user's to edit.
 */
export async function agentsWithoutRequestTool(lookup: AgentLookup): Promise<string[]> {
  const found: string[] = [];
  const seen = new Set<string>();
  for (const directory of agentDirs(lookup)) {
    for (const { name, text } of await definitionsIn(directory)) {
      const type = nameOf(text) ?? name;
      if (seen.has(type)) continue;
      seen.add(type);
      if (accessOf(text) === 'excluded') found.push(type);
    }
  }
  return found.sort();
}

async function findDefinition(agentType: string, lookup: AgentLookup): Promise<string | null> {
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
