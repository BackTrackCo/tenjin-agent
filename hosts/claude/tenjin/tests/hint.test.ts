import type { AgentInfo } from 'claude-code';
import { expect, mock, test } from 'claude-code/testing';
import { NOW } from './fixtures';

const HINT =
  'Tenjin router (installed by the user), optional if your own tools fall short: mcp__plugin_tenjin_router__request({"id":"offer-1","input":{"query":"…"}}) Your own tools are fine when they are enough.';
const CALL = {
  description: 'Find the changelog',
  prompt: 'Find the release notes of the newest version.',
  subagent_type: 'Explore',
};

// Live on alpha.73 in auto mode: the CLI's hook leg appended its hint to an Agent call's
// prompt, Claude Code refused the call ("a hook changed this call's input after auto mode
// reviewed it"), and the row read `Not run`. The hint now reaches the subagent as context.
test("the router's hint for a delegated task leaves the Agent call's input alone and reaches the started subagent as context, once", async ($, on) => {
  const clock = mock.clock(on, { now: NOW });
  mock.env(on, { HOME: '/home/test' });
  on('fs.read', (_$, e) => ({ deny: `ENOENT: ${e.path}` }));
  const agents: AgentInfo[] = [];
  on('agent.list', () => ({ value: agents }));
  const ran: Record<string, unknown>[] = [];
  on('tool.call', { tool: ['Agent', 'Task'] }, (_$, e) => {
    ran.push(e as Record<string, unknown>);
    return { result: 'native subagent result' as never };
  });
  let rewrite: (input: Record<string, unknown>) => Record<string, unknown> = (input) => ({
    ...input,
    prompt: `${String(input.prompt)}\n\n${HINT}`,
  });
  on('classic.PreToolUse', (_$, e) => {
    const input: Record<string, unknown> = { ...e };
    delete input.tool;
    delete input.tool_use_id;
    return { updatedInput: rewrite(input) };
  });
  on('classic.SubagentStart', () => ({ additionalContext: ["another hook's context"] }));
  const start = (id: string, type = 'Explore', description = CALL.description) => {
    agents.push({ id, type, description, status: 'running' } as AgentInfo);
    return $.classic.SubagentStart({ agent_id: id, agent_type: type });
  };

  await $.tool.call({ tool: 'Agent', tool_use_id: 'call_1', ...CALL });
  // The call ran with the prompt the model wrote: nothing for auto mode to refuse.
  expect(ran.at(-1)).toMatchObject({ prompt: CALL.prompt });
  // An agent of another task starts first: it gets none of this.
  expect((await start('agent_other', 'Explore', 'Another task')).additionalContext).toEqual([
    "another hook's context",
  ]);
  expect((await start('agent_1')).additionalContext).toEqual(["another hook's context", HINT]);
  expect((await start('agent_again')).additionalContext).toEqual(["another hook's context"]);

  // A hint whose call started nothing is not kept for a later agent.
  await $.tool.call({ tool: 'Agent', tool_use_id: 'call_2', ...CALL });
  await clock.advance(121_000);
  expect((await start('agent_late')).additionalContext).toEqual(["another hook's context"]);

  // Another hook's rewrite, and a call that starts a teammate, pass on as they were.
  rewrite = (input) => ({ ...input, prompt: 'Rewritten by another hook.' });
  await $.tool.call({ tool: 'Agent', tool_use_id: 'call_3', ...CALL });
  expect(ran.at(-1)).toMatchObject({ prompt: 'Rewritten by another hook.' });
  rewrite = (input) => ({ ...input, prompt: `${String(input.prompt)}\n\n${HINT}` });
  await $.tool.call({ tool: 'Agent', tool_use_id: 'call_4', ...CALL, name: 'scout' });
  expect(ran.at(-1)).toMatchObject({ prompt: `${CALL.prompt}\n\n${HINT}` });
  expect((await start('agent_after')).additionalContext).toEqual(["another hook's context"]);
});
