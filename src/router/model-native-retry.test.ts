import { expect, it } from 'vitest';
import { nativeRetryReference } from './model-native-retry';

const id = '11aabbcc-22dd-4eef-8aab-000000000001';
const prompt = `tenjin-native:${id}`;
const resume = `tenjin-offer-${id}`;
const subagent_type = `tenjin-native-${id}`;

it('recognizes only exact whole-prompt initial native retry references', () => {
  expect(nativeRetryReference({ prompt, subagent_type }, 'Agent')).toEqual({ owned: true, id });
  expect(
    nativeRetryReference({ prompt, subagent_type, run_in_background: false }, 'Agent'),
  ).toEqual({
    owned: true,
    id,
  });
  expect(
    nativeRetryReference({ prompt, subagent_type, description: 'Keep native' }, 'Task'),
  ).toMatchObject({ owned: true, error: expect.any(String) });
  expect(nativeRetryReference({ prompt: `Read the literal string ${prompt}.` }, 'Agent')).toEqual({
    owned: false,
  });
});

it.each([
  { prompt },
  { subagent_type },
  { resume },
  { prompt, resume },
  { prompt, resume, subagent_type },
  { prompt, resume: 'tenjin-offer-00000000-0000-4000-8000-000000000002' },
  { prompt, resume: `TENJIN-OFFER-${id}` },
  { prompt: 'Not a shortcut', resume },
  { prompt: 'tenjin-native:missing' },
  { prompt: ` tenjin-native:${id}` },
  { prompt: `tenjin-native: ${id}` },
  { prompt: `TENJIN-NATIVE:${id}` },
  { prompt: `tenjin-native:${id.toUpperCase()}` },
  { prompt: `${prompt}\nThen run another task.` },
  { prompt, subagent_type, model: 'opus' },
  { prompt, subagent_type, run_in_background: true },
  { prompt, subagent_type, run_in_background: null },
  { prompt, subagent_type, run_in_background: 0 },
  { prompt, subagent_type, run_in_background: 'false' },
  { prompt, subagent_type, run_in_background: {} },
  { prompt, subagent_type, run_in_background: undefined },
  { prompt, resume: 'owned-worker' },
  { prompt, subagent_type, agentId: 'child' },
  { prompt, subagent_type, tool_use_id: 'foreign' },
  { prompt, subagent_type, description: 1 },
  { prompt, subagent_type: 'Explore' },
  { prompt, subagent_type: 'Plan' },
  { prompt, subagent_type: [subagent_type] },
  { prompt, subagent_type: `tenjin-native-00000000-0000-4000-8000-000000000002` },
  { prompt, subagent_type: `TENJIN-NATIVE-${id}` },
  { prompt: 'Not a shortcut', subagent_type },
  { prompt, subagent_type, name: 'teammate' },
  { prompt, subagent_type, team_name: 'team' },
  { prompt, subagent_type, isolation: 'worktree' },
  { prompt, subagent_type, run_in_background: false, name: 'teammate' },
  { prompt, subagent_type, run_in_background: false, team_name: 'team' },
  { prompt, subagent_type, run_in_background: false, resume },
])(
  'refuses malformed or mixed reserved inputs instead of treating them as assignments: %j',
  (native) => {
    expect(nativeRetryReference(native, 'Agent')).toMatchObject({
      owned: true,
      error: expect.any(String),
    });
  },
);

it('never interprets a SendMessage prompt as an initial native retry', () => {
  expect(nativeRetryReference({ prompt, subagent_type }, 'SendMessage')).toMatchObject({
    owned: true,
    error: expect.any(String),
  });
});
