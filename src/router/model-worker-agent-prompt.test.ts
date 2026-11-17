import { beforeEach, expect, it, vi } from 'vitest';
import { query } from '@anthropic-ai/claude-agent-sdk/core';
import { NativeAgentPromptUnavailable, readNativeAgentPrompt } from './model-worker-agent-prompt';

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
const AGENT_PROMPT = 'You are a file search specialist.\n\nNotes:\n- Use absolute paths.';
const tool = (name: string) => ({ name, input_schema: { type: 'object' } });

/** Plays Claude Code: its main thread's request, then, if `launch`, the subagent's. */
function claudeCode(launch: boolean) {
  const asked: unknown[] = [];
  vi.mocked(query).mockImplementation((call) => {
    const env = call.options!.env!;
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
          { role: 'user', content: [ATTRIBUTION, { type: 'text', text: 'Start.' }] },
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
              content: [GIT_STATUS, ATTRIBUTION, { type: 'text', text: agent.input.prompt }],
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
  });
  // The read runs none of the person's hooks or MCP servers.
  expect(vi.mocked(query).mock.calls[0]![0].options).toMatchObject({
    strictMcpConfig: true,
    settings: { disableAllHooks: true },
  });
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
