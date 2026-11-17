import { expect, it } from 'vitest';
import { sandboxJudgesRead, unattendedDenial } from './worker-unattended';

const READ_BLOCK = 'permissions.blockReadsOutsideWorkingDirectories';
// The asks a live worker was refused, as Claude Code 2.1.326 words them.
const computed = (program: string) =>
  `${program} names a path that is computed at run time, which cannot be checked against the read block (${READ_BLOCK})`;

it("lets the sandbox judge a shell command the read block's own check cannot read", () => {
  for (const program of ['gh', 'node', 'ls'])
    expect(sandboxJudgesRead('Bash', { command: 'x' }, computed(program))).toBe(true);
});

it('answers no other ask: another tool, another reason, or a command that leaves the sandbox', () => {
  // The file tools are refused outside consent outright; an ask for one is not this one.
  expect(sandboxJudgesRead('Read', { file_path: '/etc/hosts' }, computed('Read'))).toBe(false);
  expect(sandboxJudgesRead('Bash', { command: 'x' }, 'This command needs approval')).toBe(false);
  expect(sandboxJudgesRead('Bash', { command: 'x' }, undefined)).toBe(false);
  // Outside the sandbox nothing but this check stands between the command and the read.
  expect(
    sandboxJudgesRead('Bash', { command: 'x', dangerouslyDisableSandbox: true }, computed('gh')),
  ).toBe(false);
  expect(
    sandboxJudgesRead('Bash', { command: 'x' }, `This command leaves the sandbox (${READ_BLOCK})`),
  ).toBe(false);
});

it('refuses in words that keep the tool usable for the rest of the job', () => {
  const said = unattendedDenial('needs a person');
  expect(said).toContain('needs a person');
  expect(said).toContain('Only this call was refused');
  // What made a live worker give up `gh` for a whole run after one refusal.
  expect(said).not.toMatch(/do not retry|will be denied the same way|rest of this session/);
});
