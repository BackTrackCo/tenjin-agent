import { expect, it } from 'vitest';
import { join, resolve } from 'node:path';
import { isSecretPath, secretHomePaths } from './model-worker-privacy';

it.each([
  '.env.local',
  '.aws/config',
  '.ssh/id_ed25519',
  '.kube/config',
  '.gnupg/private-keys-v1.d/key',
  '.tenjin/config.json',
  'auth.json',
  'wallet.backup.json',
  'credentials.json',
  '.credentials.json',
  'passphrase-store.json',
  '.netrc',
  '.npmrc',
  '.git-credentials',
  'client.PEM',
  'private.p12',
  'private.key',
])('rejects an instruction read of %s independent of its disclosure anchor', (path) => {
  expect(isSecretPath(resolve('repo', path))).toBe(true);
});

it('protects an entire controller directory without rejecting a sibling sharing its prefix', () => {
  const protectedRoot = resolve('fixture', 'private');
  expect(isSecretPath(join(protectedRoot, 'AGENTS.md'), [protectedRoot])).toBe(true);
  expect(isSecretPath(protectedRoot, [protectedRoot])).toBe(true);
  expect(isSecretPath(`${protectedRoot}-public/AGENTS.md`, [protectedRoot])).toBe(false);
  expect(isSecretPath(resolve('repo', 'AGENTS.md'))).toBe(false);
});

it('includes native authentication files among private home paths', () => {
  const home = resolve('fixture', 'home');
  expect(secretHomePaths(home)).toEqual(
    expect.arrayContaining([
      join(home, '.netrc'),
      join(home, '.npmrc'),
      join(home, '.git-credentials'),
      join(home, '.claude'),
      join(home, '.claude.json'),
    ]),
  );
});
