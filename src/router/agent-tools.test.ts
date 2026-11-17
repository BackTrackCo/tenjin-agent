import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { accessOf, agentsWithoutRequestTool, requestToolAccess, workerAgent } from './agent-tools';

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

  // Valid frontmatter the older reader got wrong. A limit it missed read as `allowed`, and
  // the agent's search was then redirected to a tool it cannot call.
  it.each([
    ['a trailing comment on a list', 'tools: Read, mcp__x402__request # paid lookups\n', 'allowed'],
    ['a trailing comment on an item', 'tools:\n  - mcp__x402__request # paid\n', 'allowed'],
    ["a list at the key's own indent", 'tools:\n- Read\n- mcp__x402__request\n', 'allowed'],
    ['a rule with a comma in it', 'tools: Agent(a, b), mcp__x402__request\n', 'allowed'],
    ['a pinned model and its own servers', 'model: sonnet\nmcpServers:\n  - github\n', 'allowed'],
    ['a quoted tools key', "'tools': [Read]\n", 'unknown'],
    ['a quoted disallowedTools key', '"disallowedTools": [mcp__x402__request]\n', 'unknown'],
    ['a list over several lines', 'tools: [Read,\n  mcp__x402__request]\n', 'unknown'],
    ['a block scalar', 'tools: |\n  Read\n', 'unknown'],
    ['a repeated key', 'tools: Read\ntools: mcp__x402__request\n', 'unknown'],
    ['a comment beside a quoted value', 'tools: "Read" # only this\n', 'unknown'],
  ] as const)('reads %s exactly, or says nothing', (_label, frontmatter, expected) => {
    expect(accessOf(agent('a', frontmatter))).toBe(expected);
  });
});

/**
 * AFTER THE RENAME, for a leg the plugin runs: its tool is
 * `mcp__plugin_tenjin_router__request`. An agent that allows only the old
 * name cannot call it, so it is excluded and doctor names the new name; one
 * that disallows the old name meant to keep paid lookups out, so it stays out.
 */
describe('the plugin tool, with the old name still in a definition', () => {
  const PLUGIN_TOOL = 'mcp__plugin_tenjin_router__request';
  it.each([
    ['the plugin tool', 'tools: Read, mcp__plugin_tenjin_router__request\n', 'allowed'],
    ['the plugin server', 'tools: mcp__plugin_tenjin_router\n', 'allowed'],
    ['the plugin server wildcard', 'tools: mcp__plugin_tenjin_router__*\n', 'allowed'],
    ['every plugin tool', 'tools: mcp__plugin_*\n', 'allowed'],
    ['only the old tool', 'tools: Read, mcp__x402__request\n', 'excluded'],
    ['only the old server wildcard', 'tools: mcp__x402__*\n', 'excluded'],
    ['the old tool disallowed', 'disallowedTools: mcp__x402__request\n', 'excluded'],
    ['the old server disallowed', 'disallowedTools: mcp__x402\n', 'excluded'],
    ['the old server wildcard disallowed', 'disallowedTools: mcp__x402__*\n', 'excluded'],
    [
      'the plugin tool disallowed',
      'disallowedTools: mcp__plugin_tenjin_router__request\n',
      'excluded',
    ],
  ] as const)('%s', (_label, frontmatter, expected) => {
    expect(accessOf(agent('a', frontmatter), PLUGIN_TOOL)).toBe(expected);
  });

  it('doctor names an agent that allows only the old name', async () => {
    await define(
      join(home, '.claude', 'agents'),
      'old.md',
      agent('old', 'tools: mcp__x402__request\n'),
    );
    expect(await agentsWithoutRequestTool({ homeDir: home }, PLUGIN_TOOL)).toEqual(['old']);
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

  it('reads a name with a comment, and says nothing of a file whose name it cannot read', async () => {
    const agents = join(project, '.claude', 'agents');
    await define(agents, 'a.md', '---\nname: reader # reads\ntools: Read\n---\n\nReads.\n');
    expect(await requestToolAccess('reader', { cwd: project, homeDir: home })).toBe('excluded');
    // The type is `fetcher` to Claude Code: this is no definition of `b`, nor a listed agent.
    await define(agents, 'b.md', "---\n'name': fetcher\ntools: Read\n---\n\nFetches.\n");
    expect(await requestToolAccess('b', { cwd: project, homeDir: home })).toBe('unknown');
    expect(await agentsWithoutRequestTool({ cwd: project, homeDir: home })).toEqual(['reader']);
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

describe('the custom agents a DeepSeek worker can run as', () => {
  const lookup = () => ({ root: project, homeDir: home });
  const defined = (frontmatter: string) =>
    define(join(project, '.claude', 'agents'), 'worker.md', agent('worker', frontmatter));

  it('takes the prompt and tools of a definition that pins no model', async () => {
    await defined('model: inherit\neffort: high\ntools: Read, Bash\ndisallowedTools: [Write]\n');
    expect(await workerAgent('worker', lookup())).toEqual({
      agent: {
        description: 'worker',
        prompt: 'You do things.',
        tools: ['Read', 'Bash'],
        disallowedTools: ['Write'],
      },
    });
  });

  it.each([
    ['model: sonnet\n', 'definition:model'],
    ['permissionMode: bypassPermissions\n', 'definition:permissionMode'],
    ['isolation: worktree\n', 'definition:isolation'],
    ['background: true\n', 'definition:background'],
    ['hooks:\n  PreToolUse: []\n', 'definition:hooks'],
  ])('keeps a definition with %j native, naming the key', async (frontmatter, unmatched) => {
    await defined(frontmatter);
    expect(await workerAgent('worker', lookup())).toEqual({ unmatched });
  });

  it('reads a block list of tools, and text that runs on under a plain key', async () => {
    await defined(
      'color: >\n  blue\n  tools: every one, it says here\ntools:\n  - Read\n  - "Bash(git status:*)"\n',
    );
    expect(await workerAgent('worker', lookup())).toMatchObject({
      agent: { tools: ['Read', 'Bash(git status:*)'] },
    });
  });

  // Each is YAML that Claude Code reads and this reader does not: with the tool list
  // missed, the worker would have run with every tool; with the model missed, on DeepSeek.
  it.each([
    ["'tools': [Read]\n"],
    ['"disallowedTools": [Bash]\n'],
    ["'model': opus\n"],
    ['"permissionMode": bypassPermissions\n'],
    ['tools: [Read,\n  Bash]\n'],
    ['tools: Read\ntools: Bash\n'],
    ['tools: Read\n  - Bash\n'],
    ['tools: Agent(worker, researcher), Read\n'],
    ['tools: &all [Read]\n'],
    ['tools:\n'],
    ['tools:\n  - {name: Read}\n'],
    ['? tools\n: [Read]\n'],
  ])(
    'keeps a definition whose frontmatter it cannot read exactly native: %j',
    async (frontmatter) => {
      await defined(frontmatter);
      expect(await workerAgent('worker', lookup())).toEqual({
        unmatched: 'definition:frontmatter',
      });
    },
  );

  it("reads the job root's own agents and the person's, never a folder above the root", async () => {
    await define(join(home, '.claude', 'agents'), 'mine.md', agent('mine', 'tools: Read\n'));
    expect(await workerAgent('mine', lookup())).toMatchObject({ agent: { tools: ['Read'] } });
    // Above the root is outside what the job's consent names.
    await define(join(root, 'work', '.claude', 'agents'), 'above.md', agent('above', ''));
    expect(await workerAgent('above', lookup())).toEqual({ unmatched: 'subagent_type' });
  });

  // Claude Code runs the project's definition of a name before the person's. One this
  // cannot read must keep the call native, not hand the name on to another file.
  it.each([
    [
      'a pinned model and a list over several lines',
      'model: opus\ntools: [Read,\n  Bash]\n',
      'name: worker',
    ],
    ['a quoted name key', 'tools: Read\n', "'name': worker"],
  ])(
    "stays with the project's definition of a name it cannot read: %s",
    async (_label, rest, name) => {
      await define(
        join(project, '.claude', 'agents'),
        'reviewer.md',
        `---\n${name}\ndescription: reviews\n${rest}---\n\nReview on Opus.\n`,
      );
      await define(join(home, '.claude', 'agents'), 'worker.md', agent('worker', ''));
      expect(await workerAgent('worker', lookup())).toMatchObject({
        unmatched: expect.stringMatching(/^definition:/),
      });
    },
  );

  it("never takes a plugin's agent, installed and matching or redefined in the project", async () => {
    const install = join(root, 'plugins', 'codex', '1.0.0');
    await define(
      join(install, 'agents'),
      'codex-rescue.md',
      agent('codex-rescue', 'tools: Bash\n'),
    );
    await define(
      join(home, '.claude', 'plugins'),
      'installed_plugins.json',
      JSON.stringify({
        version: 2,
        plugins: { 'codex@market': [{ scope: 'user', installPath: install }] },
      }),
    );
    // A project file that claims the plugin's own name changes nothing.
    await define(
      join(project, '.claude', 'agents'),
      'rescue.md',
      agent('codex:codex-rescue', 'tools: Bash\n'),
    );
    for (const type of [
      'codex:codex-rescue',
      'vercel:deployment-expert',
      'stripe:Company Researcher',
    ])
      expect(await workerAgent(type, lookup())).toEqual({ unmatched: 'subagent_type' });
  });

  it.each([['general-purpose'], ['Explore']])(
    'has no custom form for the built-in %s, which runs as itself',
    async (type) => {
      await define(join(project, '.claude', 'agents'), `${type}.md`, agent(type, 'tools: Read\n'));
      expect(await workerAgent(type, lookup())).toEqual({ unmatched: 'subagent_type' });
    },
  );

  it('has no worker form for a type with no definition file, a plugin agent or an empty prompt', async () => {
    for (const type of ['Plan', 'claude', 'claude-code-guide', 'web-fetch', 'statusline-setup'])
      expect(await workerAgent(type, lookup())).toEqual({ unmatched: 'subagent_type' });
    await define(
      join(project, '.claude', 'agents'),
      'empty.md',
      '---\nname: empty\ndescription: nothing\n---\n\n',
    );
    expect(await workerAgent('empty', lookup())).toEqual({ unmatched: 'definition:prompt' });
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
