import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { accessOf, agentsWithoutRequestTool, requestToolAccess } from './agent-tools';

let root: string;
let home: string;
let project: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'agent-tools-'));
  home = join(root, 'home');
  project = join(root, 'work', 'repo');
  await mkdir(join(home, '.claude', 'agents'), { recursive: true });
  await mkdir(join(project, 'src'), { recursive: true });
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function agent(name: string, frontmatter: string): string {
  return `---\nname: ${name}\ndescription: test agent\n${frontmatter}---\n\nYou do things.\n`;
}

async function define(directory: string, file: string, text: string): Promise<void> {
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, file), text);
}

describe('what a definition says about the request tool', () => {
  it.each([
    ['no tools: at all, which inherits everything', '', 'allowed'],
    ['a comma list without it', 'tools: Read, Grep, WebFetch\n', 'excluded'],
    ['a comma list with it', 'tools: Read, mcp__x402__request\n', 'allowed'],
    ['a flow list with it quoted', 'tools: [Read, "mcp__x402__request"]\n', 'allowed'],
    ['a block list without it', 'tools:\n  - Read\n  - WebFetch\n', 'excluded'],
    ['a block list with the server', 'tools:\n  - Read\n  - mcp__x402\n', 'allowed'],
    ['the server wildcard', 'tools: mcp__x402__*\n', 'allowed'],
    ['every MCP tool', 'tools: Read, mcp__*\n', 'allowed'],
    ['a partial prefix of the server', 'tools: mcp__x4*\n', 'allowed'],
    ['every tool', 'tools: "*"\n', 'allowed'],
    ['another server only', 'tools: mcp__other__request\n', 'excluded'],
    ["another server's wildcard", 'tools: mcp__other__*\n', 'excluded'],
    ['a wildcard the name does not start with', 'tools: x402*\n', 'excluded'],
    ['a wildcard inside a list', 'tools:\n  - Read\n  - mcp__*\n', 'allowed'],
    ['an empty list', 'tools: []\n', 'excluded'],
    ['no tools: but it is disallowed', 'disallowedTools: mcp__x402__request\n', 'excluded'],
    ['every MCP tool disallowed', 'disallowedTools: mcp__*\n', 'excluded'],
    ['the server disallowed by wildcard', 'disallowedTools: mcp__x402__*\n', 'excluded'],
    ['the bare server disallowed', 'disallowedTools: mcp__x402\n', 'excluded'],
    ['another server disallowed', 'disallowedTools: mcp__other__*\n', 'allowed'],
    ['allowed by wildcard, then disallowed', 'tools: "*"\ndisallowedTools: mcp__*\n', 'excluded'],
  ] as const)('%s', (_label, frontmatter, expected) => {
    expect(accessOf(agent('a', frontmatter))).toBe(expected);
  });

  it('cannot say anything without frontmatter', () => {
    expect(accessOf('just prose')).toBe('unknown');
  });
});

describe('finding the definition an agent type names', () => {
  it('prefers the project over the user, from any depth in the project', async () => {
    await define(join(project, '.claude', 'agents'), 'reader.md', agent('reader', 'tools: Read\n'));
    await define(
      join(home, '.claude', 'agents'),
      'reader.md',
      agent('reader', 'tools: mcp__x402__request\n'),
    );
    const cwd = join(project, 'src');
    expect(await requestToolAccess('reader', { cwd, homeDir: home })).toBe('excluded');
    expect(await requestToolAccess('reader', { homeDir: home })).toBe('allowed');
  });

  it('finds a definition by its name: when the file is named otherwise', async () => {
    await define(join(home, '.claude', 'agents'), 'whatever.md', agent('reader', 'tools: Read\n'));
    expect(await requestToolAccess('reader', { cwd: project, homeDir: home })).toBe('excluded');
  });

  it('resolves a plugin agent through the installed plugin', async () => {
    const install = join(root, 'plugins', 'toolkit', '1.0.0');
    await define(join(install, 'agents'), 'fetcher.md', agent('fetcher', 'tools: WebFetch\n'));
    await define(
      join(home, '.claude', 'plugins'),
      'installed_plugins.json',
      JSON.stringify({
        version: 2,
        plugins: { 'toolkit@market': [{ scope: 'user', installPath: install }] },
      }),
    );
    expect(await requestToolAccess('toolkit:fetcher', { homeDir: home })).toBe('excluded');
  });

  /** Only the built-ins known to inherit MCP tools are known to have it. */
  it.each([['general-purpose'], ['Explore'], ['Plan']])('knows %s has it', async (type) => {
    expect(await requestToolAccess(type, { cwd: project, homeDir: home })).toBe('allowed');
  });

  it.each([
    ['claude-code-guide'],
    ['statusline-setup'],
    ['nowhere-defined'],
    ['../../etc/passwd'],
    [undefined],
  ])('knows nothing about %s', async (type) => {
    expect(await requestToolAccess(type, { cwd: project, homeDir: home })).toBe('unknown');
  });

  it('lets a definition file override a built-in of the same name', async () => {
    await define(join(home, '.claude', 'agents'), 'Explore.md', agent('Explore', 'tools: Read\n'));
    expect(await requestToolAccess('Explore', { homeDir: home })).toBe('excluded');
  });
});

describe('the agents doctor names', () => {
  it('lists the project and user agents that leave the tool out, and only those', async () => {
    await define(join(project, '.claude', 'agents'), 'reader.md', agent('reader', 'tools: Read\n'));
    await define(join(home, '.claude', 'agents'), 'scout.md', agent('scout', 'tools: Grep\n'));
    await define(join(home, '.claude', 'agents'), 'free.md', agent('free', ''));
    await define(
      join(home, '.claude', 'agents'),
      'payer.md',
      agent('payer', 'tools: Read, mcp__x402__request\n'),
    );
    expect(await agentsWithoutRequestTool({ cwd: project, homeDir: home })).toEqual([
      'reader',
      'scout',
    ]);
  });
});
