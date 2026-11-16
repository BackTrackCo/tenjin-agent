import { expect, it } from 'vitest';
import { workerHardDeny } from './worker-hard-denies';

const bash = (command: string) => workerHardDeny('Bash', { command });

it.each([
  'security find-generic-password -s gh:github.com',
  'cd repo && /usr/bin/security dump-keychain',
  'printf "host=github.com\\n" | git credential fill',
  'git credential-osxkeychain get',
  'gh auth token',
  'gh auth status --show-token',
  'GH_PAGER= gh auth token | cat',
  'echo $(gh auth token)',
])('denies a credential probe a sandbox does not stop: %s', (command) => {
  expect(bash(command)).toBeDefined();
});

it.each([
  'git push origin main',
  'git push origin HEAD:main',
  'git push origin feature:refs/heads/master',
  'git -C ../tenjin push origin main',
  'git push --force origin feature',
  'git push -f origin feature',
  'git push origin +feature',
  'git push --force-with-lease origin feature',
  'git push origin :feature',
  'git push --delete origin feature',
  'git push --all origin',
  'git push',
  'git push origin',
  'git push origin HEAD',
  'gh pr merge 12 --squash',
  'gh repo delete BackTrackCo/tenjin --yes',
  'gh api -X DELETE repos/BackTrackCo/tenjin/git/refs/heads/x',
  'gh api --method PUT repos/BackTrackCo/tenjin/pulls/12/merge',
])('denies a push to main, a force push, a deletion or a merge: %s', (command) => {
  expect(bash(command)).toBeDefined();
});

it.each([
  'git push origin feature',
  'git push -u origin A1igator/fix-x',
  'git push origin HEAD:A1igator/fix-x',
  'git push --dry-run origin feature',
  'git status && git diff main...HEAD',
  'git fetch origin main',
  'gh pr view 561 -R BackTrackCo/tenjin-agent',
  'gh pr review 12 --comment -b "Looks fine"',
  'gh pr create --draft --title t --body b',
  'gh api repos/BackTrackCo/tenjin/pulls/12/comments',
  'gh auth status',
  'pnpm vitest run src/router/x.test.ts',
])('leaves ordinary reviews, branch pushes and reads to the permission flow: %s', (command) => {
  expect(bash(command)).toBeUndefined();
});

it('judges only shell commands', () => {
  expect(workerHardDeny('Read', { file_path: '/repo/security' })).toBeUndefined();
  expect(workerHardDeny('Bash', { command: 42 })).toBeUndefined();
});
