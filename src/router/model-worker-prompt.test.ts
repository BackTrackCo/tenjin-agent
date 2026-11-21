import { expect, it } from 'vitest';
import {
  jobScopedRules,
  workerPermissionAnswer,
  workerPermissionForm,
} from './model-worker-prompt';

it('shows the command and why it asks instead of the raw tool input JSON', () => {
  const form = workerPermissionForm(
    'Bash',
    { command: 'gh pr view 561', description: 'Read the PR' },
    { reason: 'This command requires approval' },
  );
  expect(form.message).toContain('gh pr view 561');
  expect(form.message).toContain('Why it asks: This command requires approval');
  expect(form.message).not.toContain('{"command"');
  expect(form.requestedSchema.properties.decision.enum).toEqual(['once', 'job', 'deny']);
});

it('offers no job-wide allow where the host keeps none', () => {
  const form = workerPermissionForm('Bash', { command: 'ls' }, {}, { jobChoice: false });
  expect(form.requestedSchema.properties.decision.enum).toEqual(['once', 'deny']);
});

it.each([
  [{ action: 'accept', content: { decision: 'once' } }, true],
  [{ action: 'accept', content: { decision: 'job' } }, 'job'],
  [{ action: 'accept', content: { decision: 'deny' } }, false],
  [{ action: 'accept', content: { allow: true } }, false],
  [{ action: 'decline' }, false],
  [{ action: 'cancel' }, false],
])('reads a person answer %j as %s and treats anything else as a denial', (response, answer) => {
  expect(workerPermissionAnswer(response)).toBe(answer);
});

it('never lets a job-wide allow add directories or change the mode, and keeps it in the session', () => {
  expect(
    jobScopedRules([
      {
        type: 'addRules',
        rules: [{ toolName: 'Bash', ruleContent: 'pnpm vitest run:*' }],
        destination: 'localSettings',
      },
      { type: 'addDirectories', directories: ['/elsewhere'], destination: 'session' },
      { type: 'setMode', mode: 'bypassPermissions', destination: 'session' },
    ]),
  ).toEqual([
    {
      type: 'addRules',
      rules: [{ toolName: 'Bash', ruleContent: 'pnpm vitest run:*' }],
      destination: 'session',
    },
  ]);
  expect(jobScopedRules(undefined)).toEqual([]);
});
