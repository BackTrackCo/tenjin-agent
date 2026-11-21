import type { On } from 'claude-code';
import { expect, mock, test } from 'claude-code/testing';

/**
 * The person's settings hooks and the plugins' command hooks, as the bottom of each chain:
 * each records that it ran and answers as a guard or a context hook would.
 */
function settingsHooks(on: On, worker: boolean) {
  mock.env(on, { HOME: '/home/test', ...(worker ? { TENJIN_MODEL_WORKER: '1' } : {}) });
  const ran: string[] = [];
  on('classic.SessionStart', (_$, e) => {
    ran.push(`SessionStart:${e.source}`);
    return { additionalContext: [`context from SessionStart:${e.source}`] };
  });
  on('classic.UserPromptSubmit', () => {
    ran.push('UserPromptSubmit');
    return { additionalContext: ['context from UserPromptSubmit'] };
  });
  on('classic.Stop', () => {
    ran.push('Stop');
    return { block: 'Stop guard' };
  });
  on('classic.PostToolUse', () => {
    ran.push('PostToolUse');
    return { block: 'PostToolUse guard' };
  });
  on('classic.PermissionRequest', () => {
    ran.push('PermissionRequest');
    return {};
  });
  return ran;
}

// Failure caught: a worker running every SessionStart and UserPromptSubmit hook a
// native subagent never runs (about 4.7 s at start, and their context, such as a
// 41 KB Vercel note, in its first request), or a guard of another event lost on the way.
test("a DeepSeek worker runs no start or prompt hook a native subagent does not, and every other event's hooks", async ($, on) => {
  const ran = settingsHooks(on, true);
  expect(await $.classic.SessionStart({ source: 'startup' })).toEqual({});
  expect(await $.classic.SessionStart({ source: 'resume' })).toEqual({});
  expect(await $.classic.UserPromptSubmit({ prompt: 'Read src/a.ts.' })).toEqual({});
  expect(ran).toEqual([]);
  // A compaction's SessionStart runs, as it does in a native subagent.
  expect((await $.classic.SessionStart({ source: 'compact' })).additionalContext).toEqual([
    'context from SessionStart:compact',
  ]);
  expect(
    (await $.classic.Stop({ stop_hook_active: false, last_assistant_message: 'Done.' })).block,
  ).toBe('Stop guard');
  expect(
    (
      await $.classic.PostToolUse({
        tool_name: 'Bash',
        tool_input: { command: 'ls' },
        tool_response: 'a.ts',
        tool_use_id: 'toolu_1',
      } as never)
    ).block,
  ).toBe('PostToolUse guard');
  await $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: { command: 'ls' } } as never);
  expect(ran).toEqual(['SessionStart:compact', 'Stop', 'PostToolUse', 'PermissionRequest']);
});

test('a session that is not a worker runs its start and prompt hooks as before', async ($, on) => {
  const ran = settingsHooks(on, false);
  expect((await $.classic.SessionStart({ source: 'startup' })).additionalContext).toEqual([
    'context from SessionStart:startup',
  ]);
  expect((await $.classic.UserPromptSubmit({ prompt: 'hi' })).additionalContext).toEqual([
    'context from UserPromptSubmit',
  ]);
  expect(ran).toEqual(['SessionStart:startup', 'UserPromptSubmit']);
});
