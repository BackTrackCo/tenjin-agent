import { expect, it } from 'vitest';
import { workerCredentialProbe } from './worker-credential-probes';

const bash = (command: string) => workerCredentialProbe('Bash', { command });

it.each([
  'security find-generic-password -s gh:github.com',
  'cd repo && /usr/bin/security dump-keychain',
  'printf "host=github.com\\n" | git credential fill',
  'git credential-osxkeychain get',
  'gh auth token',
  'gh auth status --show-token',
  'GH_PAGER= gh auth token | cat',
  'echo $(gh auth token)',
  // With a per-job GH_TOKEN this prints it, just as gh auth token does.
  'printf "protocol=https\\nhost=github.com\\n" | gh auth git-credential get',
])('denies a credential probe a sandbox does not stop: %s', (command) => {
  expect(bash(command)).toBeDefined();
});

it.each([
  // Actions are the accepted mode's to judge, as for a native subagent: never refused here.
  'git push origin main',
  'git push --force origin feature',
  'git push origin :feature',
  'git push',
  'gh pr merge 12 --squash',
  'gh repo delete BackTrackCo/tenjin --yes',
  'gh api -X DELETE repos/BackTrackCo/tenjin/git/refs/heads/x',
  'git push origin feature',
  'git status && git diff main...HEAD',
  'git fetch origin main',
  'gh pr view 561 -R BackTrackCo/tenjin-agent',
  'gh pr review 12 --comment -b "Looks fine"',
  'gh pr create --draft --title t --body b',
  'gh api repos/BackTrackCo/tenjin/pulls/12/comments',
  'gh auth status',
  'pnpm vitest run src/router/x.test.ts',
])('leaves every action that is not a credential probe to the permission flow: %s', (command) => {
  expect(bash(command)).toBeUndefined();
});

it('judges only shell commands', () => {
  expect(workerCredentialProbe('Read', { file_path: '/repo/security' })).toBeUndefined();
  expect(workerCredentialProbe('Bash', { command: 42 })).toBeUndefined();
});
