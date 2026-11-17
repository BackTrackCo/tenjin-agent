import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, expect, it, vi } from 'vitest';
import { query } from '@anthropic-ai/claude-agent-sdk/core';
import {
  NativeAgentPromptUnavailable,
  readNativeAgentPrompt,
  readNativeAgentPromptCached,
} from './model-worker-agent-prompt';

vi.mock('@anthropic-ai/claude-agent-sdk/core', () => ({ query: vi.fn() }));
beforeEach(() => vi.clearAllMocks());

// Blocks as Claude Code 2.1.326 sends them: its own billing and identity blocks, the
// environment as a trailing system-role message, and the subagent's git status first.
const IDENTITY = {
  type: 'text',
  text: "You are a Claude agent, built on Anthropic's Claude Agent SDK.",
};
const ATTRIBUTION = { type: 'text', text: '<system-reminder>\nAttribution...\n</system-reminder>' };
const GIT_STATUS = {
  type: 'text',
  text: '<system-reminder>\n# gitStatus\nmain\n</system-reminder>',
};
const ENVIRONMENT = { role: 'system', content: [{ type: 'text', text: '# Environment\n...' }] };
// The person's CLAUDE.md files, in one block of the first message, each under its path.
const CLAUDE_MD = {
  type: 'text',
  text: "<system-reminder>\nCodebase and user instructions are shown below. Be sure to adhere to these instructions.\n\nContents of /home/me/.claude/CLAUDE.md (user's private global instructions for all projects):\n\nBe brief.\n\nContents of /repo/CLAUDE.md (project instructions, checked into the codebase):\n\nUse pnpm.\n</system-reminder>\n",
};
const AGENT_PROMPT = 'You are a file search specialist.\n\nNotes:\n- Use absolute paths.';
const tool = (name: string) => ({ name, input_schema: { type: 'object' } });

/**
 * Plays Claude Code: its main thread's request, then, if `launch`, the subagent's, which
 * gets the person's CLAUDE.md files as the main thread does only with `instructions`
 * (general-purpose does; Explore does not).
 */
function claudeCode(launch: boolean, { instructions = false } = {}) {
  const asked: unknown[] = [];
  settingsRead.length = 0;
  vi.mocked(query).mockImplementation((call) => {
    const env = call.options!.env!;
    // Read while it is there: the file is removed when the read ends.
    settingsRead.push(JSON.parse(readFileSync(String(call.options!.settings), 'utf8')));
    const post = async (body: unknown) =>
      (
        await fetch(`${env.ANTHROPIC_BASE_URL}/v1/messages`, {
          method: 'POST',
          headers: { 'x-api-key': env.ANTHROPIC_API_KEY!, 'content-type': 'application/json' },
          body: JSON.stringify(body),
        })
      ).json() as Promise<{ content: { type: string; input?: { prompt: string } }[] }>;
    const run = (async function* () {
      const reply = await post({
        model: 'deepseek-flash',
        system: [
          { type: 'text', text: 'x-anthropic-billing-header: cc_version=2.1.326.79b;' },
          IDENTITY,
        ],
        tools: [tool('Agent'), tool('Bash'), tool('ScheduleWakeup')],
        messages: [
          { role: 'user', content: [CLAUDE_MD, ATTRIBUTION, { type: 'text', text: 'Start.' }] },
          ENVIRONMENT,
        ],
      });
      const agent = reply.content.find((block) => block.type === 'tool_use');
      asked.push(agent?.input);
      if (launch && agent?.input)
        await post({
          model: 'deepseek-flash',
          system: [
            {
              type: 'text',
              text: 'x-anthropic-billing-header: cc_version=2.1.326.3d8; cc_is_subagent=true;',
            },
            IDENTITY,
            { type: 'text', text: AGENT_PROMPT },
          ],
          tools: [tool('Agent'), tool('Bash')],
          messages: [
            {
              role: 'user',
              content: [
                GIT_STATUS,
                ...(instructions ? [CLAUDE_MD] : []),
                ATTRIBUTION,
                { type: 'text', text: agent.input.prompt },
              ],
            },
            ENVIRONMENT,
          ],
        });
      yield { type: 'result', subtype: 'success' };
    })();
    return Object.assign(run, { close: vi.fn() }) as unknown as ReturnType<typeof query>;
  });
  return asked;
}
const settingsRead: unknown[] = [];

it("reads a native subagent's prompt, context and tools from the Claude Code that runs the worker", async () => {
  // Failure caught: a worker running with the main thread's prompt and tools, not its agent's.
  const asked = claudeCode(true);
  const native = await readNativeAgentPrompt({
    binary: '/native/claude',
    cwd: '/repo',
    agentType: 'Explore',
    signal: new AbortController().signal,
  });
  expect(asked).toEqual([expect.objectContaining({ subagent_type: 'Explore' })]);
  // Only the agent's prompt: Claude Code adds its own billing and identity blocks.
  expect(native).toEqual({
    prompt: [AGENT_PROMPT],
    context: [GIT_STATUS.text],
    withheldTools: ['ScheduleWakeup'],
    // A native Explore subagent starts without the person's CLAUDE.md files.
    withheldInstructions: ['/home/me/.claude/CLAUDE.md', '/repo/CLAUDE.md'],
  });
  // The read runs none of the person's hooks or MCP servers, and its settings, which hold
  // its token, reach the SDK as a file.
  const options = vi.mocked(query).mock.calls[0]![0].options!;
  expect(options.strictMcpConfig).toBe(true);
  expect(settingsRead).toEqual([expect.objectContaining({ disableAllHooks: true })]);
  expect(JSON.stringify({ ...options, env: undefined })).not.toContain(
    options.env!.ANTHROPIC_API_KEY!,
  );
});

it('withholds no CLAUDE.md file from a worker whose native subagent gets them all', async () => {
  // Failure caught: a general-purpose worker losing the person's instructions that a
  // native general-purpose subagent is given.
  claudeCode(true, { instructions: true });
  const native = await readNativeAgentPrompt({
    binary: '/native/claude',
    cwd: '/repo',
    additionalDirectories: ['/repo-feature'],
    agentType: 'general-purpose',
    signal: new AbortController().signal,
  });
  expect(native.withheldInstructions).toEqual([]);
  expect(native.context).toEqual([GIT_STATUS.text]);
  // Read with the worker's working directories, whose CLAUDE.md files it may start with.
  expect(vi.mocked(query).mock.calls[0]![0].options!.additionalDirectories).toEqual([
    '/repo-feature',
  ]);
});

it('says why when Claude Code never starts the subagent, so the worker starts without it', async () => {
  claudeCode(false);
  const read = readNativeAgentPrompt({
    binary: '/native/claude',
    cwd: '/repo',
    agentType: 'general-purpose',
    signal: new AbortController().signal,
  });
  await expect(read).rejects.toBeInstanceOf(NativeAgentPromptUnavailable);
  await expect(read).rejects.toMatchObject({ reason: 'not_captured' });
});

it('reads a native prompt once per binary, agent type and root, and again when an agent definition changes', async () => {
  // Failure caught: every accept spending about 11 s starting a Claude Code to read the same
  // prompt, or a held read reaching another agent type, root or a changed definition.
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'tenjin-prompt-cache-')));
  const [root, other, home, temp] = ['repo', 'other', 'home', 'tmp-job'].map((name) => {
    mkdirSync(join(base, name, '.claude', 'agents'), { recursive: true });
    return join(base, name);
  });
  const binary = join(base, 'claude');
  writeFileSync(binary, 'binary one');
  const definition = join(root!, '.claude', 'agents', 'reviewer.md');
  writeFileSync(definition, '---\nname: reviewer\n---\nReview.');
  let reads = 0;
  const read = vi.fn(async (input: Parameters<typeof readNativeAgentPrompt>[0]) => ({
    prompt: [`${input.agentType} in ${input.cwd} #${++reads}`],
    context: [],
    withheldTools: [],
    withheldInstructions: [],
  }));
  let clock = 0;
  const deps = { env: { CLAUDE_CONFIG_DIR: join(home!, '.claude') }, home, now: () => clock, read };
  const agent = { description: 'reviewer', prompt: 'Review.' };
  const ask = (over: Partial<Parameters<typeof readNativeAgentPromptCached>[0]> = {}) =>
    readNativeAgentPromptCached(
      {
        binary,
        cwd: root!,
        agentType: 'reviewer',
        customAgent: agent,
        additionalDirectories: [temp!],
        ephemeralDirectories: [temp!],
        signal: new AbortController().signal,
        ...over,
      },
      deps,
    ).then((native) => native.prompt[0]);
  expect(await ask()).toBe(`reviewer in ${root} #1`);
  // The same read, though the job's temp folder is a new one.
  expect(
    await ask({
      additionalDirectories: [join(base, 'tmp-two')],
      ephemeralDirectories: [join(base, 'tmp-two')],
    }),
  ).toBe(`reviewer in ${root} #1`);
  expect(read).toHaveBeenCalledTimes(1);
  // Never another agent type's or root's read.
  expect(await ask({ agentType: 'Explore', customAgent: undefined })).toBe(`Explore in ${root} #2`);
  expect(await ask({ cwd: other! })).toBe(`reviewer in ${other} #3`);
  // A changed agent definition misses: as handed over, and as the file under the root.
  expect(await ask({ customAgent: { ...agent, prompt: 'Review twice.' } })).toBe(
    `reviewer in ${root} #4`,
  );
  utimesSync(definition, 1_000, 1_000);
  expect(await ask()).toBe(`reviewer in ${root} #5`);
  expect(await ask()).toBe(`reviewer in ${root} #5`);
  // So does a new CLAUDE.md, a changed settings file or plugin list, and a new binary.
  writeFileSync(join(root!, 'CLAUDE.md'), 'Use pnpm.');
  expect(await ask()).toBe(`reviewer in ${root} #6`);
  mkdirSync(join(home!, '.claude', 'plugins'), { recursive: true });
  writeFileSync(join(home!, '.claude', 'plugins', 'installed_plugins.json'), '{}');
  expect(await ask()).toBe(`reviewer in ${root} #7`);
  writeFileSync(binary, 'binary two, longer');
  expect(await ask()).toBe(`reviewer in ${root} #8`);
  // And a read older than ten minutes, whose git status is then read again.
  clock = 10 * 60_000;
  expect(await ask()).toBe(`reviewer in ${root} #9`);
  // A read that names the job's temp folder is not kept.
  read.mockImplementationOnce(async () => ({
    prompt: [`in ${temp}`],
    context: [],
    withheldTools: [],
    withheldInstructions: [],
  }));
  expect(await ask({ cwd: home! })).toBe(`in ${temp}`);
  expect(await ask({ cwd: home! })).toBe(`reviewer in ${home} #10`);
});
