import { expect, it } from 'vitest';
import { readBlockUnchecked, sandboxJudgesRead, unattendedDenial } from './worker-unattended';

// What Claude Code 2.1.326 passes `canUseTool` for each ask, as a live worker and the
// real CLI under a scripted model received them.
const inside = {
  command:
    'cd /repo/.worktrees/b && git rev-parse HEAD && git status --short | head -20 && echo "---DIFF---" && git diff origin/main...HEAD --stat',
};
const unchecked = { decisionReasonType: 'safetyCheck' };
const outside = {
  decisionReasonType: 'safetyCheck',
  decisionReasonCode: 'outside_reads_blocked',
  blockedPath: '/private/tmp/claude-501/other-session/log1',
};

it("lets the sandbox judge a shell command the read block's own check cannot read, in bypass mode only", () => {
  // A live worker's review of a worktree inside consent was refused for this ask.
  expect(readBlockUnchecked('Bash', inside, unchecked)).toBe(true);
  expect(sandboxJudgesRead('Bash', inside, unchecked, 'bypassPermissions')).toBe(true);
  // In auto mode a yes would run the call with no classifier verdict, and the same ask
  // comes for this command with a push on its end. It is refused, with a form that runs.
  const pushed = { command: `${inside.command} && git push origin feature` };
  for (const call of [inside, pushed])
    expect(sandboxJudgesRead('Bash', call, unchecked, 'auto')).toBe(false);
  const said = unattendedDenial(unchecked, true);
  expect(said).toContain('git -C <path>');
  expect(said).toContain('Only this call was refused');
});

it('answers no other ask: a path outside consent, a compound, a rule, another tool or reason, or no sandbox', () => {
  expect(readBlockUnchecked('Bash', { command: 'cat /private/tmp/claude-501/x' }, outside)).toBe(
    false,
  );
  // `cat /etc/hosts | head -1`: the compound names a path outside consent.
  expect(
    readBlockUnchecked(
      'Bash',
      { command: 'x' },
      { decisionReasonType: 'subcommandResults', decisionReasonCode: 'outside_reads_blocked' },
    ),
  ).toBe(false);
  // `echo hi && git log -1 && echo b | xargs cat` under an ask rule on `git log` sends this
  // too: a compound's ask can stand for a person's own rule.
  expect(
    readBlockUnchecked('Bash', { command: 'x' }, { decisionReasonType: 'subcommandResults' }),
  ).toBe(false);
  expect(
    readBlockUnchecked('Bash', inside, {
      ...unchecked,
      matchedAskRule: { source: 'projectSettings', toolName: 'Bash', ruleContent: 'git log:*' },
    }),
  ).toBe(false);
  // Every other safety check keeps its text.
  expect(
    readBlockUnchecked('Bash', { command: 'x' }, { ...unchecked, decisionReason: 'Dangerous rm' }),
  ).toBe(false);
  expect(
    readBlockUnchecked(
      'Bash',
      { command: 'x' },
      { decisionReasonType: 'classifier', decisionReason: 'Blocked by classifier' },
    ),
  ).toBe(false);
  expect(readBlockUnchecked('Bash', { command: 'x' }, {})).toBe(false);
  // The file tools are refused outside consent outright; an ask for one is not this one.
  expect(readBlockUnchecked('Read', { file_path: '/etc/hosts' }, unchecked)).toBe(false);
  // Outside the sandbox nothing but this check stands between the command and the read.
  expect(
    readBlockUnchecked('Bash', { ...inside, dangerouslyDisableSandbox: true }, unchecked),
  ).toBe(false);
});

it('refuses in words that keep the tool usable for the rest of the job', () => {
  const said = unattendedDenial({ decisionReason: 'needs a person' });
  expect(said).toContain('needs a person');
  expect(said).toContain('Only this call was refused');
  // What made a live worker give up `gh` for a whole run after one refusal.
  expect(said).not.toMatch(/do not retry|will be denied the same way|rest of this session/);
  // The read block sends no text for a path outside consent; the path says why.
  expect(unattendedDenial(outside)).toContain(outside.blockedPath);
});
